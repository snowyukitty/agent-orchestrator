// ============================================================
// Session Manager (renderer)
//
// Owns one xterm instance per live PTY session, a tab strip to switch
// between them, and the quick-send bar. Every session keeps rendering in the
// background — switching tabs only changes which terminal is visible, so a
// long-running agent never loses output while you watch another one.
//
// Assurance labels come from the main process and are shown verbatim. An
// env-only (L2) session is never presented as account-isolated; see AGENTS.md.
// ============================================================

import { typeInto } from './typing.js';

/** Quick-send target selectors that are not a single session id. */
export const TARGET_ACTIVE = '@active';
export const TARGET_ALL = '@all';
export const AGENT_TARGET_PREFIX = '@agent:';

// A PTY can emit output and lifecycle events before createSession's IPC reply
// reaches the renderer and gives us metadata to adopt. Keep that race window
// lossless for normal startup, but strictly bounded so stale/unknown ids cannot
// grow renderer memory forever.
export const PRE_ADOPT_MAX_UNKNOWN_IDS = 32;
export const PRE_ADOPT_MAX_EVENTS_PER_SESSION = 128;
export const PRE_ADOPT_MAX_EVENTS_TOTAL = 512;
export const PRE_ADOPT_MAX_OUTPUT_CHARS_PER_SESSION = 64 * 1024;
export const PRE_ADOPT_MAX_OUTPUT_CHARS_TOTAL = 256 * 1024;

const ASSURANCE_SHORT = {
  'L1-routed': 'routed',
  'L2-env': 'env-only',
  'L0-native': 'native',
};

export class SessionManager {
  /**
   * @param {object} opts
   * @param {function} opts.onLog          (message, type) => void
   * @param {function} [opts.onActiveChange] (sessionId|null) => void
   * @param {object} [opts.api]            window.api (injectable for tests)
   * @param {function} [opts.typeIntoFn]    human-paced sender (injectable for tests)
   * @param {function} [opts.terminalCtor]  xterm constructor (injectable for tests)
   * @param {function} [opts.fitAddonCtor]  fit-addon constructor (injectable for tests)
   */
  constructor({
    onLog,
    onActiveChange,
    api,
    typeIntoFn = typeInto,
    terminalCtor,
    fitAddonCtor,
  } = {}) {
    this._onLog = onLog || (() => {});
    this._onActiveChange = onActiveChange || (() => {});
    this._api = api || window.api;
    this._typeInto = typeIntoFn;
    this._Terminal = terminalCtor || globalThis.Terminal;
    this._FitAddon = fitAddonCtor || globalThis.FitAddon?.FitAddon;
    /** @type {Map<string, object>} sessionId → { meta, term, fitAddon, el } */
    this._sessions = new Map();
    /** @type {Map<string, { events: object[], outputChars: number }>} */
    this._pendingEvents = new Map();
    this._pendingEventOrder = [];
    this._pendingEventCount = 0;
    this._pendingOutputChars = 0;
    this._activeId = null;
    this._theme = null;
    this._els = {};
  }

  // ── Wiring ───────────────────────────────────────────────

  /**
   * @param {object} els
   * @param {HTMLElement} els.stack    container for the per-session terminals
   * @param {HTMLElement} els.tabs     tab strip
   * @param {HTMLElement} [els.empty]  placeholder shown with no sessions
   */
  mount(els) {
    this._els = els;

    els.tabs?.addEventListener('click', (e) => {
      const closeBtn = e.target.closest('[data-close-session]');
      if (closeBtn) {
        e.stopPropagation();
        this.close(closeBtn.dataset.closeSession);
        return;
      }
      const tab = e.target.closest('[data-session-id]');
      if (tab) this.activate(tab.dataset.sessionId);
    });

    window.addEventListener('resize', () => this.fitActive());
    this.renderTabs();
  }

  get activeId() { return this._activeId; }

  /** The active session's xterm, or null. Engine/app read cols/rows from this. */
  get activeTerm() {
    const s = this._sessions.get(this._activeId);
    return s ? s.term : null;
  }

  get activeFitAddon() {
    const s = this._sessions.get(this._activeId);
    return s ? s.fitAddon : null;
  }

  /** Metadata for every session, in tab order. */
  list() {
    return [...this._sessions.values()].map(s => ({ ...s.meta }));
  }

  has(id) { return this._sessions.has(id); }

  get size() { return this._sessions.size; }

  // ── Creating sessions ────────────────────────────────────

  /**
   * Start a session for an agent profile.
   * Returns the new session id, or null when the launch was refused — a
   * routed profile whose account cannot be resolved fails closed rather than
   * silently starting a native login.
   */
  async startProfile(profileId, { cwd, activate = true } = {}) {
    const geometry = this._geometry();
    const result = await this._api.createSession({ profileId, cwd, ...geometry });
    if (!result || result.error) {
      if (result?.id) this._dropPendingId(result.id);
      this._onLog(`❌ Could not start "${profileId}": ${result?.error || 'unknown error'}`, 'stderr');
      return null;
    }
    const meta = result.session || { id: result.id, label: profileId, agent: 'shell', assurance: 'L0-native', status: 'running' };
    this.adopt(meta, { activate });
    this._onLog(`⬡ Session started: ${meta.label} (${ASSURANCE_SHORT[meta.assurance] || meta.assurance})`, 'system');
    return meta.id;
  }

  /**
   * Register a session that already exists in the main process — either one
   * we just started, or one the workflow engine spawned through the legacy
   * execute-command path.
   */
  adopt(meta, { activate = true } = {}) {
    if (!meta || !meta.id) return null;
    const existing = this._sessions.get(meta.id);
    if (existing) {
      existing.meta = { ...existing.meta, ...meta };
      this._replayPending(meta.id);
      this.renderTabs();
      if (activate) this.activate(meta.id);
      return existing;
    }

    const el = document.createElement('div');
    el.className = 'term-pane hidden';
    el.dataset.sessionId = meta.id;
    this._els.stack?.appendChild(el);

    const term = new this._Terminal({
      fontFamily: "'Cascadia Mono', 'Cascadia Code', 'Consolas', monospace",
      fontSize: 14,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 5000,
      disableStdin: false,
    });
    if (this._theme) term.options.theme = this._theme;

    const fitAddon = new this._FitAddon();
    term.loadAddon(fitAddon);
    term.open(el);

    // Copy on Ctrl+C when there is a selection; otherwise let SIGINT through.
    term.attachCustomKeyEventHandler((e) => {
      if (e.ctrlKey && e.code === 'KeyC' && e.type === 'keydown') {
        const selection = term.getSelection();
        if (selection) {
          navigator.clipboard.writeText(selection);
          term.clearSelection();
          return false;
        }
      }
      return true;
    });

    term.onData((data) => {
      this._api.sendInput({ id: meta.id, text: data }).catch(() => {});
    });

    term.onResize(({ cols, rows }) => {
      this._api.resizeProcess({ id: meta.id, cols, rows }).catch(() => {});
    });

    // Install the input bridge and publish the record before replay. xterm can
    // synchronously answer terminal queries (for example ESC[6n → a DSR
    // response) while processing an early output chunk, and that response must
    // already have a live session route back to main.
    const record = { meta: { ...meta }, term, fitAddon, el };
    this._sessions.set(meta.id, record);
    this._replayPending(meta.id);
    this.renderTabs();
    if (activate || !this._activeId) this.activate(meta.id);
    return record;
  }

  // ── PTY event routing ────────────────────────────────────
  // Output is written to its own session's terminal whether or not that tab
  // is visible, so background agents keep their scrollback intact.

  handleOutput({ id, data, stream }) {
    const s = this._sessions.get(id);
    if (!s) {
      return this._bufferPending(id, 'output', {
        id,
        data: String(data ?? ''),
        ...(stream ? { stream } : {}),
      });
    }
    s.term.write(data);
    if (id !== this._activeId) this._markUnread(id);
    return true;
  }

  handleExit({ id, code }) {
    const s = this._sessions.get(id);
    if (!s) return this._bufferPending(id, 'exit', { id, code });
    s.term.write(`\r\n\x1b[90m⬡ Session ended (exit code ${code})\x1b[0m\r\n`);
    s.meta.status = 'exited';
    s.meta.exitCode = code;
    this.renderTabs();
    return true;
  }

  handleStatus(meta) {
    if (!meta || !meta.id) return false;
    const s = this._sessions.get(meta.id);
    if (!s) return this._bufferPending(meta.id, 'status', { ...meta });
    s.meta = { ...s.meta, ...meta };
    this.renderTabs();
    return true;
  }

  _bufferPending(id, type, payload) {
    if (typeof id !== 'string' || !id) return false;

    let bucket = this._pendingEvents.get(id);
    let createdBucket = false;
    if (!bucket) {
      while (this._pendingEvents.size >= PRE_ADOPT_MAX_UNKNOWN_IDS) {
        const oldest = this._oldestPendingEvent();
        if (!oldest) break;
        this._dropPendingId(oldest.id);
      }
      bucket = { events: [], outputChars: 0 };
      this._pendingEvents.set(id, bucket);
      createdBucket = true;
    }

    // Within one id, the earliest startup/control traffic is the most
    // important: it can contain a DSR query that the just-created shell is
    // synchronously waiting for. Once its budget is full, drop newer events
    // instead of turning this into a tail buffer. Lifecycle tail is the one
    // exception: make room for the newest status/exit so a fast failure does
    // not replay as a permanently running ghost.
    if (bucket.events.length >= PRE_ADOPT_MAX_EVENTS_PER_SESSION) {
      if (type !== 'status' && type !== 'exit') return false;
      const reverse = [...bucket.events].reverse();
      const victim = reverse.find(event => event.type === type)
        || reverse.find(event => (
          event.type === 'output'
          && !hasCursorPositionQuery(event.payload?.data)
        ))
        || bucket.events.find(event => event.type === 'status' || event.type === 'exit')
        || reverse.find(event => event.type === 'output');
      if (!victim) return false;
      this._removePendingEvent(victim);
    }

    let retainedPayload = payload;
    let outputChars = 0;
    if (type === 'output') {
      const remaining = PRE_ADOPT_MAX_OUTPUT_CHARS_PER_SESSION - bucket.outputChars;
      const original = String(payload?.data ?? '');
      const retained = boundedOutput(original, remaining);
      if (original && !retained) return false;
      retainedPayload = { ...payload, data: retained };
      outputChars = retained.length;
    }

    // Under global pressure, evict the oldest unknown session as one unit.
    // This keeps every retained session's prefix internally coherent.
    while (
      this._pendingEventCount + 1 > PRE_ADOPT_MAX_EVENTS_TOTAL
      || this._pendingOutputChars + outputChars > PRE_ADOPT_MAX_OUTPUT_CHARS_TOTAL
    ) {
      const oldestOther = this._oldestPendingEvent(candidate => candidate.id !== id);
      if (!oldestOther) {
        if (createdBucket && bucket.events.length === 0) this._pendingEvents.delete(id);
        return false;
      }
      this._dropPendingId(oldestOther.id);
    }

    const event = {
      id,
      type,
      payload: retainedPayload,
      outputChars,
      active: true,
    };
    bucket.events.push(event);
    bucket.outputChars += outputChars;
    this._pendingEventOrder.push(event);
    this._pendingEventCount++;
    this._pendingOutputChars += outputChars;

    if (this._pendingEventOrder.length > PRE_ADOPT_MAX_EVENTS_TOTAL * 2) {
      this._compactPendingOrder();
    }
    return event.active;
  }

  _oldestPendingEvent(predicate = () => true) {
    return this._pendingEventOrder.find(event => event.active && predicate(event)) || null;
  }

  _removePendingEvent(event) {
    if (!event?.active) return false;
    event.active = false;
    this._pendingEventCount--;
    this._pendingOutputChars -= event.outputChars;
    const bucket = this._pendingEvents.get(event.id);
    if (bucket) {
      const index = bucket.events.indexOf(event);
      if (index !== -1) bucket.events.splice(index, 1);
      bucket.outputChars -= event.outputChars;
      if (bucket.events.length === 0) this._pendingEvents.delete(event.id);
    }
    return true;
  }

  _dropPendingId(id) {
    const bucket = this._pendingEvents.get(id);
    if (!bucket) return false;
    for (const event of bucket.events) {
      if (!event.active) continue;
      event.active = false;
      this._pendingEventCount--;
      this._pendingOutputChars -= event.outputChars;
    }
    this._pendingEvents.delete(id);
    this._compactPendingOrder();
    return true;
  }

  _clearPending() {
    this._pendingEvents.clear();
    this._pendingEventOrder = [];
    this._pendingEventCount = 0;
    this._pendingOutputChars = 0;
  }

  _compactPendingOrder() {
    this._pendingEventOrder = this._pendingEventOrder.filter(event => event.active);
  }

  _replayPending(id) {
    if (!this._sessions.has(id)) return false;
    const bucket = this._pendingEvents.get(id);
    if (!bucket) return false;
    const events = bucket.events.filter(event => event.active);
    try {
      for (const event of events) {
        if (event.type === 'output') this.handleOutput(event.payload);
        else if (event.type === 'status') this.handleStatus(event.payload);
        else if (event.type === 'exit') this.handleExit(event.payload);
      }
    } finally {
      this._dropPendingId(id);
    }
    return events.length > 0;
  }

  // ── Switching / closing ──────────────────────────────────

  activate(id) {
    if (!this._sessions.has(id)) return false;
    this._activeId = id;
    for (const [sid, s] of this._sessions) {
      const isActive = sid === id;
      s.el.classList.toggle('hidden', !isActive);
      if (isActive) s.unread = false;
    }
    this.renderTabs();
    this.fitActive();
    this._els.tabs
      ?.querySelector(`[data-session-id="${cssEsc(id)}"]`)
      ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    this._sessions.get(id)?.term.focus();
    this._onActiveChange(id);
    return true;
  }

  /** Kill (if live) and forget a session, disposing its terminal. */
  close(id) {
    const s = this._sessions.get(id);
    const clearedPending = this._dropPendingId(id);
    if (!s) return clearedPending;
    this._api.killProcess({ id }).catch(() => {});
    try { s.term.dispose(); } catch (_e) { /* already gone */ }
    s.el.remove();
    this._sessions.delete(id);

    if (this._activeId === id) {
      const next = [...this._sessions.keys()].pop() || null;
      this._activeId = null;
      if (next) this.activate(next);
      else this._onActiveChange(null);
    }
    this.renderTabs();
    return true;
  }

  /** Close every session. Used when a run starts from a clean slate. */
  closeAll() {
    for (const id of [...this._sessions.keys()]) this.close(id);
    this._clearPending();
  }

  /** Drop sessions that have exited, keeping live ones. */
  closeExited() {
    let removed = 0;
    for (const [id, s] of [...this._sessions]) {
      if (s.meta.status === 'exited') { this.close(id); removed++; }
    }
    return removed;
  }

  // ── Sending ──────────────────────────────────────────────

  /**
   * Resolve a quick-send target selector into concrete session ids.
   * Exits are excluded — sending into a dead PTY is silently lost otherwise.
   */
  resolveTargets(selector) {
    const live = [...this._sessions.values()].filter(s => s.meta.status !== 'exited');
    if (!selector || selector === TARGET_ACTIVE) {
      const active = live.find(s => s.meta.id === this._activeId);
      return active ? [active.meta.id] : [];
    }
    if (selector === TARGET_ALL) return live.map(s => s.meta.id);
    if (selector.startsWith(AGENT_TARGET_PREFIX)) {
      const agent = selector.slice(AGENT_TARGET_PREFIX.length);
      return live.filter(s => s.meta.agent === agent).map(s => s.meta.id);
    }
    return live.filter(s => s.meta.id === selector).map(s => s.meta.id);
  }

  /**
   * Type text into every session matching a selector.
   * Returns the labels actually written to, so the caller can log the targets
   * (never the profile's env, which may contain machine-local paths).
   */
  async sendTo(selector, text, { pressEnter = true } = {}) {
    const ids = this.resolveTargets(selector);
    const attempts = await Promise.all(ids.map(async id => {
      try {
        await this._typeInto({
          sessionId: id,
          text,
          pressEnter,
          send: (sid, chunk) => this._api.sendInput({ id: sid, text: chunk }),
        });
        return this._sessions.get(id)?.meta.label || id;
      } catch (err) {
        this._onLog(`❌ Send failed for ${this._sessions.get(id)?.meta.label || id}: ${err.message}`, 'stderr');
        return null;
      }
    }));
    return attempts.filter(Boolean);
  }

  // ── Presentation ─────────────────────────────────────────

  setTheme(theme) {
    this._theme = theme;
    for (const s of this._sessions.values()) s.term.options.theme = theme;
  }

  fitActive() {
    const s = this._sessions.get(this._activeId);
    if (!s) return;
    try { s.fitAddon.fit(); } catch (_e) { /* pane not laid out yet */ }
  }

  clearActive() {
    this._sessions.get(this._activeId)?.term.clear();
  }

  _markUnread(id) {
    const s = this._sessions.get(id);
    if (!s || s.unread) return;
    s.unread = true;
    this.renderTabs();
  }

  _geometry() {
    const term = this.activeTerm;
    return { cols: term?.cols ?? 80, rows: term?.rows ?? 24 };
  }

  renderTabs() {
    const strip = this._els.tabs;
    if (!strip) return;

    if (this._sessions.size === 0) {
      strip.innerHTML = `<span class="session-tabs-empty">No agent sessions — open <strong>🤖 Agents</strong> to start one.</span>`;
      this._renderTargets();
      return;
    }

    strip.innerHTML = [...this._sessions.values()].map(s => {
      const m = s.meta;
      const active = m.id === this._activeId;
      const exited = m.status === 'exited';
      const cls = [
        'session-tab',
        active ? 'active' : '',
        exited ? 'exited' : '',
        s.unread ? 'unread' : '',
      ].filter(Boolean).join(' ');
      const assurance = ASSURANCE_SHORT[m.assurance] || m.assurance || '';
      const title = `${m.label} · ${m.assurance || 'unknown assurance'}${exited ? ` · exited (${m.exitCode})` : ''}`;
      return `
        <div class="${cls}" data-session-id="${esc(m.id)}" title="${esc(title)}">
          <span class="session-dot"></span>
          <span class="session-tab-label">${esc(m.label)}</span>
          <span class="session-assurance ${esc(m.assurance || '')}">${esc(assurance)}</span>
          <button class="session-close" data-close-session="${esc(m.id)}" title="Close session">✕</button>
        </div>`;
    }).join('');

    this._renderTargets();
  }

  /** Keep the quick-send target dropdown in step with the live sessions. */
  _renderTargets() {
    const select = this._els.target;
    if (!select) return;
    const previous = select.value;

    const agents = [...new Set([...this._sessions.values()]
      .filter(s => s.meta.status !== 'exited')
      .map(s => s.meta.agent))];

    const options = [
      `<option value="${TARGET_ACTIVE}">▸ Current session</option>`,
      ...(this._sessions.size > 1 ? [`<option value="${TARGET_ALL}">⇉ All sessions</option>`] : []),
      ...(agents.length > 1
        ? agents.map(a => `<option value="${AGENT_TARGET_PREFIX}${esc(a)}">⇉ All ${esc(a)} sessions</option>`)
        : []),
      ...[...this._sessions.values()]
        .filter(s => s.meta.status !== 'exited')
        .map(s => `<option value="${esc(s.meta.id)}">${esc(s.meta.label)}</option>`),
    ];
    select.innerHTML = options.join('');
    if ([...select.options].some(o => o.value === previous)) select.value = previous;
  }
}

function esc(str) {
  const el = document.createElement('span');
  el.textContent = String(str ?? '');
  return el.innerHTML;
}

function cssEsc(str) {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(String(str));
  return String(str).replace(/["\\]/g, '\\$&');
}

function hasCursorPositionQuery(value) {
  const text = String(value ?? '');
  return text.includes('\x1b[6n') || text.includes('\x9b6n');
}

function boundedOutput(value, maxChars = PRE_ADOPT_MAX_OUTPUT_CHARS_PER_SESSION) {
  const text = String(value ?? '');
  const limit = Math.max(0, Math.floor(Number(maxChars) || 0));
  if (text.length <= limit) return text;
  let end = limit;
  if (end === 0) return '';
  const last = text.charCodeAt(end - 1);
  const next = text.charCodeAt(end);
  if (
    last >= 0xD800 && last <= 0xDBFF
    && next >= 0xDC00 && next <= 0xDFFF
  ) {
    end--;
  }
  return text.slice(0, end);
}
