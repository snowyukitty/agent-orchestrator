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
   */
  constructor({ onLog, onActiveChange, api } = {}) {
    this._onLog = onLog || (() => {});
    this._onActiveChange = onActiveChange || (() => {});
    this._api = api || window.api;
    /** @type {Map<string, object>} sessionId → { meta, term, fitAddon, el } */
    this._sessions = new Map();
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
      this.renderTabs();
      if (activate) this.activate(meta.id);
      return existing;
    }

    const el = document.createElement('div');
    el.className = 'term-pane hidden';
    el.dataset.sessionId = meta.id;
    this._els.stack?.appendChild(el);

    const term = new Terminal({
      fontFamily: "'Cascadia Mono', 'Cascadia Code', 'Consolas', monospace",
      fontSize: 14,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 5000,
      disableStdin: false,
    });
    if (this._theme) term.options.theme = this._theme;

    const fitAddon = new FitAddon.FitAddon();
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

    const record = { meta: { ...meta }, term, fitAddon, el };
    this._sessions.set(meta.id, record);
    this.renderTabs();
    if (activate || !this._activeId) this.activate(meta.id);
    return record;
  }

  // ── PTY event routing ────────────────────────────────────
  // Output is written to its own session's terminal whether or not that tab
  // is visible, so background agents keep their scrollback intact.

  handleOutput({ id, data }) {
    const s = this._sessions.get(id);
    if (!s) return false;
    s.term.write(data);
    if (id !== this._activeId) this._markUnread(id);
    return true;
  }

  handleExit({ id, code }) {
    const s = this._sessions.get(id);
    if (!s) return false;
    s.term.write(`\r\n\x1b[90m⬡ Session ended (exit code ${code})\x1b[0m\r\n`);
    s.meta.status = 'exited';
    s.meta.exitCode = code;
    this.renderTabs();
    return true;
  }

  handleStatus(meta) {
    if (!meta || !meta.id) return;
    const s = this._sessions.get(meta.id);
    if (!s) return;
    s.meta = { ...s.meta, ...meta };
    this.renderTabs();
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
    this._sessions.get(id)?.term.focus();
    this._onActiveChange(id);
    return true;
  }

  /** Kill (if live) and forget a session, disposing its terminal. */
  close(id) {
    const s = this._sessions.get(id);
    if (!s) return false;
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
    const delivered = [];
    for (const id of ids) {
      try {
        await typeInto({
          sessionId: id,
          text,
          pressEnter,
          send: (sid, chunk) => this._api.sendInput({ id: sid, text: chunk }),
        });
        delivered.push(this._sessions.get(id)?.meta.label || id);
      } catch (err) {
        this._onLog(`❌ Send failed for ${this._sessions.get(id)?.meta.label || id}: ${err.message}`, 'stderr');
      }
    }
    return delivered;
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
