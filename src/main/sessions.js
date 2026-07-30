// ============================================================
// PTY Session Registry (main process)
//
// Replaces the single `activeProcesses` map that main.js used to own. The
// app can now hold several concurrent PTYs — one per agent account — so a
// session is a first-class thing with an identity, a launch spec, a status,
// and an assurance level.
//
// Assurance is carried through from the launch spec and never invented
// here. See AGENTS.md: an L2 env-only session must never be presented as
// account-isolated.
//
// `pty` is injected so the registry can be unit-tested with a fake.
// ============================================================
const { asCols, asRows } = require('./validate');

/** How long to wait for a graceful exit before force-killing the tree. */
const KILL_GRACE_MS = 1500;

/** Enough rolling output to match text that straddles PTY chunks. Main-only. */
const OUTPUT_HISTORY_CHARS = 64 * 1024;
const MAX_WAIT_PATTERN_CHARS = 1000;
const MATCH_WINDOW_CHARS = 8 * 1024;
const MAX_CAPTURE_MARKER_CHARS = 200;
const MAX_CAPTURE_BYTES = 64 * 1024;
const MAX_IDLE_MS = 60 * 60 * 1000;
const MAX_WAIT_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const TERMINATION_TIMEOUT_MS = 5000;
const VISIBILITY_BOUNDARY = '\uFFFC';

let seq = 0;
let waitSeq = 0;

/** Mint a session id that satisfies validate.ID_PATTERN. */
function nextSessionId(prefix = 'sess') {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq}`;
}

function nextWaitId() {
  waitSeq += 1;
  return `wait-${Date.now().toString(36)}-${waitSeq}`;
}

function asWaitMs(value, { name, allowZero, max }) {
  const n = Number(value);
  const min = allowZero ? 0 : 1;
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max} ms`);
  }
  return n;
}

/** Strip terminal control sequences before user-visible text matching. */
function textForMatch(value) {
  return String(value)
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B(?:[@-_]|\[[0-?]*[ -/]*[@-~])/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .toLowerCase();
}

function asCaptureConfig(value) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('capture must be an object');
  }

  const asMarker = (marker, name) => {
    if (typeof marker !== 'string' || !marker || !/^[\x21-\x7E]+$/.test(marker)) {
      throw new Error(`capture.${name} must be a non-empty tight printable ASCII token`);
    }
    if (marker.length > MAX_CAPTURE_MARKER_CHARS) {
      throw new Error(`capture.${name} exceeds ${MAX_CAPTURE_MARKER_CHARS} characters`);
    }
    return marker;
  };

  const startMarker = asMarker(value.startMarker, 'startMarker');
  const endMarker = asMarker(value.endMarker, 'endMarker');
  if (startMarker === endMarker) {
    throw new Error('capture markers must be distinct');
  }

  const maxBytes = value.maxBytes;
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_CAPTURE_BYTES) {
    throw new Error(`capture.maxBytes must be an integer from 1 to ${MAX_CAPTURE_BYTES}`);
  }
  return { startMarker, endMarker, maxBytes };
}

function createTextCollector(maxBytes) {
  return {
    maxBytes,
    text: '',
    byteLength: 0,
    truncated: false,
    pendingHighSurrogate: '',
  };
}

function createTerminalSanitizer() {
  return {
    mode: 'text',
    concealed: false,
    concealSeen: false,
    displayBreakSeen: false,
    pendingCR: false,
    csi: '',
    csiOverflow: false,
  };
}

function snapshotTerminalSanitizer(state) {
  return {
    mode: state.mode,
    concealed: state.concealed === true,
    pendingCR: state.pendingCR === true,
    csi: typeof state.csi === 'string' ? state.csi : '',
    csiOverflow: state.csiOverflow === true,
  };
}

function restoreTerminalSanitizer(target, source, { uncertain = false } = {}) {
  if (uncertain || !source || typeof source.mode !== 'string') {
    target.mode = 'unknown';
    target.concealed = true;
    target.concealSeen = true;
    target.displayBreakSeen = true;
    target.pendingCR = false;
    target.csi = '';
    target.csiOverflow = false;
    return;
  }
  target.mode = source.mode;
  target.concealed = source.concealed === true;
  target.concealSeen = source.concealed === true;
  target.displayBreakSeen = source.concealed === true
    || source.pendingCR === true
    || source.mode !== 'text';
  target.pendingCR = source.pendingCR === true;
  target.csi = typeof source.csi === 'string' ? source.csi : '';
  target.csiOverflow = source.csiOverflow === true;
}

function applySgrState(state) {
  if (state.csiOverflow) {
    // An unbounded/invalid SGR cannot be interpreted safely. Suppress text
    // until a later explicit reset or reveal.
    state.concealed = true;
    state.concealSeen = true;
    return;
  }
  const fields = state.csi === '' ? ['0'] : state.csi.split(';');
  for (const field of fields) {
    const primary = field.split(':', 1)[0];
    if (!/^\d*$/.test(primary)) continue;
    const code = primary === '' ? 0 : Number(primary);
    if (code === 0 || code === 28) {
      state.concealed = false;
    } else if (code === 8) {
      state.concealed = true;
      state.concealSeen = true;
    }
  }
}

function appendUtf8Prefix(collector, value) {
  if (collector.truncated || !value) return;
  const byteLength = Buffer.byteLength(value, 'utf8');
  if (collector.byteLength + byteLength > collector.maxBytes) {
    collector.truncated = true;
    return;
  }
  collector.text += value;
  collector.byteLength += byteLength;
}

function flushPendingSurrogate(collector) {
  if (!collector.pendingHighSurrogate) return;
  collector.pendingHighSurrogate = '';
  appendUtf8Prefix(collector, '\uFFFD');
}

function appendVisibleCodeUnit(collector, value) {
  const code = value.charCodeAt(0);
  if (code >= 0xD800 && code <= 0xDBFF) {
    flushPendingSurrogate(collector);
    collector.pendingHighSurrogate = value;
    return;
  }
  if (code >= 0xDC00 && code <= 0xDFFF) {
    if (collector.pendingHighSurrogate) {
      const pair = collector.pendingHighSurrogate + value;
      collector.pendingHighSurrogate = '';
      appendUtf8Prefix(collector, pair);
    } else {
      appendUtf8Prefix(collector, '\uFFFD');
    }
    return;
  }
  flushPendingSurrogate(collector);
  appendUtf8Prefix(collector, value);
}

/**
 * Incrementally project raw PTY traffic onto visible text. Framing consumes
 * this stream, not the raw bytes: marker-shaped OSC/DCS/CSI payloads therefore
 * cannot forge a boundary, while styling inserted inside a visible marker is
 * harmless. State crosses PTY chunks so split control sequences stay hidden.
 * CR, backspace, cursor movement, and similar redraw controls are omitted; LF
 * and horizontal tab remain useful result formatting.
 */
function visibleTerminalText(state, value, emitVisible = true) {
  if (!value) return '';
  if (typeof state.concealed !== 'boolean') state.concealed = false;
  if (typeof state.concealSeen !== 'boolean') state.concealSeen = false;
  if (typeof state.displayBreakSeen !== 'boolean') state.displayBreakSeen = false;
  if (typeof state.pendingCR !== 'boolean') state.pendingCR = false;
  if (typeof state.csi !== 'string') state.csi = '';
  if (typeof state.csiOverflow !== 'boolean') state.csiOverflow = false;
  const visible = emitVisible ? [] : null;
  const pushBoundary = () => {
    state.displayBreakSeen = true;
    if (
      emitVisible
      && visible.length > 0
      && visible[visible.length - 1] !== VISIBILITY_BOUNDARY
    ) {
      visible.push(VISIBILITY_BOUNDARY);
    } else if (emitVisible && visible.length === 0) {
      visible.push(VISIBILITY_BOUNDARY);
    }
  };
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    const code = char.charCodeAt(0);

    if (state.mode === 'text' && state.pendingCR) {
      state.pendingCR = false;
      if (char === '\n') {
        if (emitVisible && !state.concealed) visible.push(char);
        continue;
      }
      pushBoundary();
    }

    // A raced waiter can begin inside the retained suffix of one oversized
    // chunk. Its prior mode is unknowable, so suppress text until a control
    // string terminator (or CAN/SUB) gives us a trustworthy text boundary.
    if (state.mode === 'unknown') {
      if (code === 0x9C || code === 0x18 || code === 0x1A) {
        state.mode = 'text';
        pushBoundary();
      }
      else if (char === '\x1B') state.mode = 'unknown-escape';
      continue;
    }
    if (state.mode === 'unknown-escape') {
      if (char === '\\') {
        state.mode = 'text';
        pushBoundary();
      }
      else if (char !== '\x1B') state.mode = 'unknown';
      continue;
    }
    if (state.mode === 'osc' || state.mode === 'string') {
      if ((state.mode === 'osc' && char === '\x07') || code === 0x9C) {
        state.mode = 'text';
        pushBoundary();
      } else if (char === '\x1B') {
        state.mode += '-escape';
      }
      continue;
    }
    if (state.mode === 'osc-escape' || state.mode === 'string-escape') {
      if (char === '\\' || code === 0x9C) {
        state.mode = 'text';
        pushBoundary();
      } else if (char !== '\x1B') {
        state.mode = state.mode.slice(0, -'-escape'.length);
      }
      continue;
    }
    if (state.mode === 'csi') {
      if (code >= 0x40 && code <= 0x7E) {
        const resumedAcrossBoundary = emitVisible
          && state.displayBreakSeen
          && visible.length === 0;
        if (char === 'm') {
          const wasConcealed = state.concealed;
          applySgrState(state);
          if (wasConcealed !== state.concealed) {
            // Keep printable fragments on opposite sides of SGR conceal from
            // joining into one apparent marker.
            pushBoundary();
          }
        } else {
          pushBoundary();
        }
        if (resumedAcrossBoundary) pushBoundary();
        state.csi = '';
        state.csiOverflow = false;
        state.mode = 'text';
      } else if (char === '\x1B') {
        state.csi = '';
        state.csiOverflow = false;
        state.mode = 'escape';
      } else if (state.csi.length < 256) {
        state.csi += char;
      } else {
        state.csiOverflow = true;
      }
      continue;
    }
    if (state.mode === 'escape-intermediate') {
      if (code >= 0x30 && code <= 0x7E) {
        state.mode = 'text';
        pushBoundary();
      }
      else if (char === '\x1B') state.mode = 'escape';
      continue;
    }
    if (state.mode === 'escape') {
      if (char === '[') {
        state.csi = '';
        state.csiOverflow = false;
        state.mode = 'csi';
      }
      else if (char === ']') {
        state.mode = 'osc';
        pushBoundary();
      }
      else if ('PX^_'.includes(char)) {
        state.mode = 'string';
        pushBoundary();
      }
      else if (code >= 0x20 && code <= 0x2F) state.mode = 'escape-intermediate';
      else if (char !== '\x1B') {
        state.mode = 'text';
        pushBoundary();
      }
      continue;
    }

    if (char === '\x1B') {
      state.mode = 'escape';
    } else if (code === 0x9B) {
      state.csi = '';
      state.csiOverflow = false;
      state.mode = 'csi';
    } else if (code === 0x9D) {
      state.mode = 'osc';
      pushBoundary();
    } else if ([0x90, 0x98, 0x9E, 0x9F].includes(code)) {
      state.mode = 'string';
      pushBoundary();
    } else if (char === '\r') {
      state.pendingCR = true;
    } else if (char === '\n' || char === '\t') {
      if (emitVisible && !state.concealed) visible.push(char);
    } else if (code < 0x20 || code === 0x7F || (code >= 0x80 && code <= 0x9F)) {
      // Redraw/control traffic is not result text.
      pushBoundary();
    } else {
      if (emitVisible && !state.concealed) visible.push(char);
    }
  }
  return emitVisible ? visible.join('') : '';
}

function collectVisibleText(collector, value) {
  if (collector.truncated || !value) return;
  for (let i = 0; i < value.length && !collector.truncated; i++) {
    if (value[i] === VISIBILITY_BOUNDARY) continue;
    appendVisibleCodeUnit(collector, value[i]);
  }
}

function finishTextCollector(collector) {
  flushPendingSurrogate(collector);
  return collector.text;
}

function emptyCaptureReport() {
  return {
    complete: false,
    missingStart: true,
    missingEnd: true,
    truncatedBefore: false,
    truncatedAfter: false,
    fromSeq: null,
    throughSeq: null,
    byteLength: 0,
    text: '',
  };
}

class SessionRegistry {
  /**
   * @param {object} deps
   * @param {object} deps.pty            node-pty (or a test double)
   * @param {function} [deps.onOutput]   ({ id, data }) => void
   * @param {function} [deps.onExit]     ({ id, code }) => void
   * @param {function} [deps.onStatus]   (sessionMeta) => void
   * @param {function} [deps.terminateTree] (pid) => void, request whole-tree
   *                                            termination while root is alive
   * @param {function} [deps.killTree]   (pid) => void, force-kill a process tree
   * @param {function} [deps.log]        (message) => void
   */
  constructor({
    pty,
    onOutput,
    onExit,
    onStatus,
    terminateTree,
    killTree,
    log,
    terminationTimeoutMs = TERMINATION_TIMEOUT_MS,
  } = {}) {
    this._pty = pty;
    this._onOutput = onOutput || (() => {});
    this._onExit = onExit || (() => {});
    this._onStatus = onStatus || (() => {});
    this._terminateTree = typeof terminateTree === 'function' ? terminateTree : null;
    this._killTree = killTree || (() => {});
    this._log = log || (() => {});
    this._terminationTimeoutMs = terminationTimeoutMs;
    /** @type {Map<string, object>} id → session record */
    this._sessions = new Map();
    /** IDs removed while their old PTY is still delivering an exit event. */
    this._retiringIds = new Set();
    this._admissionClosed = false;
    this._admissionReason = 'session admission is closed';
    // node-pty's Windows ConPTY addon removes process batons from native exit
    // threads without a lock. Serializing requested exits avoids racing those
    // threads when several tabs are closed or the app quits at once.
    this._terminationQueue = Promise.resolve();
    this._pendingTerminations = 0;
  }

  /**
   * Spawn a PTY for a launch spec.
   *
   * @param {object} spec  from agents.buildLaunchSpec(): { file, args, env, cwd,
   *                       profileId, agent, label, assurance,
   *                       resultInputCapable }
   * @param {object} opts  { id, cols, rows }
   * @returns {{ id: string, pid: number }}
   */
  create(spec, { id, cols, rows } = {}) {
    if (this._admissionClosed) {
      throw new Error(`Cannot create a session: ${this._admissionReason}`);
    }
    if (!spec || typeof spec.file !== 'string' || !spec.file) {
      throw new Error('Launch spec is missing an executable');
    }

    const sessionId = id || nextSessionId();

    // A duplicate cannot be made safe by killing and immediately replacing the
    // old entry: its eventual exit event would carry the same id and could mark
    // the new PTY as exited (an ABA race). Wait for explicit removal instead.
    if (this._sessions.has(sessionId) || this._retiringIds.has(sessionId)) {
      throw new Error(`Session id "${sessionId}" is already in use`);
    }

    const proc = this._pty.spawn(spec.file, spec.args || [], {
      name: 'xterm-color',
      cols: asCols(cols),
      rows: asRows(rows),
      cwd: spec.cwd,
      env: spec.env,
      useConpty: true,
      conptyInheritCursor: true,
    });

    let resolveExit;
    const exitPromise = new Promise(resolve => { resolveExit = resolve; });
    const session = {
      id: sessionId,
      pid: proc.pid,
      proc,
      profileId: spec.profileId || null,
      agent: spec.agent || 'shell',
      label: spec.label || 'Session',
      assurance: spec.assurance || 'L0-native',
      resultInputCapable: spec.resultInputCapable === true,
      cwd: spec.cwd || null,
      startedAt: Date.now(),
      status: 'running',
      exitCode: null,
      killTimer: null,
      outputSeq: 0,
      outputChunks: [],
      outputChars: 0,
      terminalSanitizer: createTerminalSanitizer(),
      waiters: new Map(),
      exitPromise,
      resolveExit,
    };
    this._sessions.set(sessionId, session);

    proc.onData((data) => {
      const text = data.toString();
      this._recordOutput(session, text);
      this._onOutput({ id: sessionId, data: text, stream: 'stdout' });
    });

    proc.onExit(({ exitCode }) => {
      if (session.status === 'exited') return;
      // Update the captured record, not a map lookup: remove() may already
      // have dropped the entry, and the pending kill escalation reads this
      // status to decide whether the tree still needs force-killing.
      if (session.killTimer) { clearTimeout(session.killTimer); session.killTimer = null; }
      session.status = 'exited';
      session.exitCode = exitCode;
      session.proc = null;
      this._retiringIds.delete(sessionId);
      session.resolveExit();
      this._settleAllWaiters(session, 'exit');
      if (this._sessions.has(sessionId)) this._onStatus(this.describe(sessionId));
      this._onExit({ id: sessionId, code: exitCode });
    });

    this._log(`[Sessions] started ${sessionId} (${session.label}, ${session.assurance}) pid=${proc.pid}`);
    this._onStatus(this.describe(sessionId));
    return { id: sessionId, pid: proc.pid };
  }

  has(id) {
    return this._sessions.has(id);
  }

  /** Permanently stop this registry from accepting new PTYs. */
  closeAdmission(reason = 'session admission is closed') {
    this._admissionClosed = true;
    this._admissionReason = String(reason || 'session admission is closed');
  }

  /** True when the session exists and its PTY is still alive. */
  isRunning(id) {
    const s = this._sessions.get(id);
    return !!(s && s.status === 'running' && s.proc);
  }

  /**
   * Return an opaque output position. The renderer may hand this number back
   * to waitForOutput, but never receives the buffered PTY text itself.
   */
  checkpoint(id) {
    const s = this._sessions.get(id);
    if (!s) return null;
    return { outputSeq: s.outputSeq };
  }

  /**
   * Wait until new output goes idle, contains a literal text pattern, the
   * optional capture frame reaches its end marker, the session exits, or the
   * timeout backstop fires. Idle never completes before at least one output
   * chunk after `afterSeq`; an already-quiet terminal is not evidence that an
   * agent finished the prompt just sent. A capture is opt-in and adds its
   * bounded result to the completion object; ordinary waits never expose PTY
   * text or gain a new response field.
   *
   * @returns {Promise<{reason, elapsedMs, outputSeq, capture?: object}>}
   */
  waitForOutput(id, {
    waitId = nextWaitId(),
    afterSeq,
    idleMs = 2000,
    pattern = '',
    timeoutMs = 120_000,
    capture,
  } = {}) {
    const s = this._sessions.get(id);
    if (!s) throw new Error(`No session named "${id}"`);

    const normalizedIdleMs = asWaitMs(idleMs, {
      name: 'idleMs', allowZero: true, max: MAX_IDLE_MS,
    });
    const normalizedTimeoutMs = asWaitMs(timeoutMs, {
      name: 'timeoutMs', allowZero: false, max: MAX_WAIT_TIMEOUT_MS,
    });
    if (typeof pattern !== 'string') throw new Error('pattern must be a string');
    if (pattern.length > MAX_WAIT_PATTERN_CHARS) {
      throw new Error(`pattern exceeds ${MAX_WAIT_PATTERN_CHARS} characters`);
    }
    const normalizedCapture = asCaptureConfig(capture);
    if (!normalizedIdleMs && !pattern && !normalizedCapture) {
      throw new Error('Wait for agent needs idleMs or an output pattern');
    }
    if (typeof waitId !== 'string' || !waitId) throw new Error('waitId must be a non-empty string');
    if (s.waiters.has(waitId)) throw new Error(`Wait "${waitId}" already exists`);

    const requestedSeq = afterSeq === undefined || afterSeq === null
      ? s.outputSeq
      : Number(afterSeq);
    if (!Number.isInteger(requestedSeq) || requestedSeq < 0) {
      throw new Error('afterSeq must be a non-negative integer');
    }
    const startSeq = Math.min(requestedSeq, s.outputSeq);

    if (s.status !== 'running' || !s.proc) {
      const result = { reason: 'exit', elapsedMs: 0, outputSeq: s.outputSeq };
      if (normalizedCapture) result.capture = emptyCaptureReport();
      return Promise.resolve(result);
    }

    return new Promise((resolve) => {
      const waiter = {
        id: waitId,
        afterSeq: startSeq,
        // A framed result is complete only at its end marker. Timeout, exit,
        // removal, and explicit cancellation remain failure backstops.
        idleMs: normalizedCapture ? 0 : normalizedIdleMs,
        pattern: textForMatch(pattern),
        timeoutMs: normalizedTimeoutMs,
        startedAt: Date.now(),
        matchBuffer: '',
        sawOutput: false,
        lastOutputAt: null,
        idleTimer: null,
        timeoutTimer: null,
        resolve,
      };
      if (normalizedCapture) {
        waiter.capture = {
          ...normalizedCapture,
          startSeen: false,
          endSeen: false,
          historyGap: false,
          availableFromSeq: null,
          fromSeq: null,
          throughSeq: null,
          searchTail: '',
          searchTailSeqs: [],
          endTail: '',
          frameInvalid: false,
          terminalSanitizer: createTerminalSanitizer(),
          bodyCollector: null,
          partialCollector: createTextCollector(normalizedCapture.maxBytes),
        };
      }
      s.waiters.set(waitId, waiter);

      waiter.timeoutTimer = setTimeout(() => {
        this._settleWaiter(s, waiter, 'timeout');
      }, normalizedTimeoutMs);

      // Include output that raced between the renderer's checkpoint and this
      // IPC call. That is why the registry keeps a small bounded history.
      const relevantChunks = s.outputChunks.filter(chunk => chunk.seq > startSeq);
      if (waiter.capture && s.outputSeq > startSeq) {
        const first = relevantChunks[0];
        waiter.capture.historyGap = !first
          || first.seq > startSeq + 1
          || !!first.truncatedBefore;
      }
      if (waiter.capture) {
        const first = relevantChunks[0];
        if (first?.terminalStateBefore) {
          // This mode was recorded from the complete raw stream, so it remains
          // exact even when whole older chunks or this chunk's prefix have
          // been evicted.
          restoreTerminalSanitizer(
            waiter.capture.terminalSanitizer,
            first.terminalStateBefore
          );
        } else if (!first && s.outputSeq === startSeq) {
          // No output raced the waiter registration; continue from the live
          // session parser's exact checkpoint state.
          restoreTerminalSanitizer(
            waiter.capture.terminalSanitizer,
            snapshotTerminalSanitizer(s.terminalSanitizer)
          );
        } else {
          // No retained boundary has trustworthy parser state. Fail closed
          // until an ST/CAN/SUB resync.
          restoreTerminalSanitizer(
            waiter.capture.terminalSanitizer,
            null,
            { uncertain: true }
          );
        }
      }
      for (const chunk of relevantChunks) {
        if (chunk.seq > startSeq) this._consumeWaiterOutput(s, waiter, chunk);
        if (!s.waiters.has(waitId)) break;
      }
    });
  }

  /** Cancel one pending wait, normally because the workflow was stopped. */
  cancelWait(id, waitId) {
    const s = this._sessions.get(id);
    const waiter = s?.waiters.get(waitId);
    if (!s || !waiter) return false;
    this._settleWaiter(s, waiter, 'cancelled');
    return true;
  }

  write(id, text) {
    const s = this._sessions.get(id);
    if (!s || !s.proc) return false;
    // A workflow's "\n" means submit; a real terminal sends CR.
    s.proc.write(text.replace(/\n/g, '\r'));
    return true;
  }

  /**
   * Privileged input path for generated result contracts and handoffs.
   *
   * Capability is fixed by the main-owned launch spec and cannot be upgraded
   * by renderer metadata. Throwing before proc.write gives the workflow a
   * clear failure and proves that rejected text never reached a shell.
   */
  writeStructured(id, text) {
    const s = this._sessions.get(id);
    if (!s || s.status !== 'running' || !s.proc) {
      throw new Error(`No live session named "${id}"`);
    }
    if (s.resultInputCapable !== true) {
      throw new Error('Session is not capable of structured result input');
    }
    s.proc.write(text.replace(/\n/g, '\r'));
    return true;
  }

  resize(id, cols, rows) {
    const s = this._sessions.get(id);
    if (!s || !s.proc || typeof s.proc.resize !== 'function') return false;
    try {
      s.proc.resize(asCols(cols), asRows(rows));
      return true;
    } catch (err) {
      this._log(`[Sessions] resize failed for ${id}: ${err.message}`);
      return false;
    }
  }

  _recordOutput(s, data) {
    const terminalStateBefore = snapshotTerminalSanitizer(s.terminalSanitizer);
    visibleTerminalText(s.terminalSanitizer, data, false);
    const chunk = {
      seq: ++s.outputSeq,
      data,
      at: Date.now(),
      truncatedBefore: false,
      terminalStateBefore,
    };
    s.outputChunks.push(chunk);
    s.outputChars += data.length;

    // Active waiters see the complete chunk even when it is larger than the
    // rolling history retained for a later checkpoint-based wait.
    for (const waiter of [...s.waiters.values()]) {
      if (chunk.seq > waiter.afterSeq) this._consumeWaiterOutput(s, waiter, chunk);
    }

    while (s.outputChars > OUTPUT_HISTORY_CHARS && s.outputChunks.length > 1) {
      const removed = s.outputChunks.shift();
      s.outputChars -= removed.data.length;
    }
    if (s.outputChars > OUTPUT_HISTORY_CHARS && s.outputChunks.length === 1) {
      const only = s.outputChunks[0];
      const removedChars = only.data.length - OUTPUT_HISTORY_CHARS;
      const retainedState = createTerminalSanitizer();
      restoreTerminalSanitizer(retainedState, only.terminalStateBefore);
      visibleTerminalText(retainedState, only.data.slice(0, removedChars), false);
      only.data = only.data.slice(-OUTPUT_HISTORY_CHARS);
      only.truncatedBefore = true;
      // Preserve exact parser state at the new retained suffix boundary. A
      // later raced capture can safely inspect that suffix while still marking
      // its missing prefix via `truncatedBefore`.
      only.terminalStateBefore = snapshotTerminalSanitizer(retainedState);
      s.outputChars = only.data.length;
    }
  }

  _consumeWaiterOutput(s, waiter, chunk) {
    if (!s.waiters.has(waiter.id)) return;
    waiter.sawOutput = true;
    waiter.lastOutputAt = chunk.at;

    if (waiter.capture) {
      if (this._consumeCaptureOutput(waiter, chunk)) {
        this._settleWaiter(s, waiter, 'match');
        return;
      }
    } else if (waiter.pattern) {
      const candidate = waiter.matchBuffer + chunk.data;
      if (textForMatch(candidate).includes(waiter.pattern)) {
        this._settleWaiter(s, waiter, 'match');
        return;
      }
      // Keep enough raw overlap for a literal match (and its ANSI dressing)
      // across the next PTY chunk without re-scanning the full 64 KiB history
      // for every spinner redraw.
      waiter.matchBuffer = candidate.slice(-MATCH_WINDOW_CHARS);
    }
    if (waiter.idleMs) this._armIdleTimer(s, waiter);
  }

  _consumeCaptureOutput(waiter, chunk) {
    const capture = waiter.capture;
    if (capture.availableFromSeq === null) capture.availableFromSeq = chunk.seq;
    const visible = visibleTerminalText(capture.terminalSanitizer, chunk.data);
    if (!visible) return false;

    if (capture.startSeen) {
      return this._consumeCaptureBody(capture, visible, chunk.seq);
    }

    const previousTailLength = capture.searchTail.length;
    const candidate = capture.searchTail + visible;
    const startIndex = candidate.indexOf(capture.startMarker);
    const endIndex = candidate.indexOf(capture.endMarker);

    // The end marker is the atomic completion boundary. If the rolling
    // history lost the start, return only the surviving bounded prefix and
    // mark it partial. Without evidence of eviction, an unframed end marker
    // carries diagnostics but no body.
    if (endIndex >= 0 && (startIndex < 0 || endIndex < startIndex)) {
      if (capture.historyGap) {
        collectVisibleText(capture.partialCollector, candidate.slice(0, endIndex));
      }
      capture.endSeen = true;
      capture.throughSeq = chunk.seq;
      capture.searchTail = '';
      capture.searchTailSeqs = [];
      return true;
    }

    if (startIndex >= 0) {
      if (
        capture.terminalSanitizer.concealSeen
        || capture.terminalSanitizer.displayBreakSeen
      ) {
        const lastBoundary = candidate.lastIndexOf(VISIBILITY_BOUNDARY);
        const markerEnd = startIndex + capture.startMarker.length;
        if (lastBoundary >= startIndex && lastBoundary < markerEnd) {
          // Printable fragments separated by SGR conceal/reveal must not be
          // concatenated into an apparently visible marker. Drop this
          // candidate and allow a later wholly visible marker to establish it.
          capture.terminalSanitizer.concealSeen = false;
          capture.terminalSanitizer.displayBreakSeen = false;
          capture.searchTail = '';
          capture.searchTailSeqs = [];
          return false;
        }
        // All conceal transitions preceded this wholly visible marker.
        capture.terminalSanitizer.concealSeen = false;
        capture.terminalSanitizer.displayBreakSeen = false;
      }
      capture.startSeen = true;
      capture.fromSeq = startIndex < previousTailLength
        ? capture.searchTailSeqs[startIndex]
        : chunk.seq;
      capture.searchTail = '';
      capture.searchTailSeqs = [];
      capture.bodyCollector = createTextCollector(capture.maxBytes);
      return this._consumeCaptureBody(
        capture,
        candidate.slice(startIndex + capture.startMarker.length),
        chunk.seq
      );
    }

    const keepLength = Math.min(
      candidate.length,
      Math.max(capture.startMarker.length, capture.endMarker.length) - 1
    );
    const safeLength = candidate.length - keepLength;
    if (capture.historyGap && safeLength > 0) {
      collectVisibleText(capture.partialCollector, candidate.slice(0, safeLength));
    }

    const nextTailSeqs = [];
    for (let i = safeLength; i < candidate.length; i++) {
      nextTailSeqs.push(i < previousTailLength ? capture.searchTailSeqs[i] : chunk.seq);
    }
    capture.searchTail = candidate.slice(safeLength);
    capture.searchTailSeqs = nextTailSeqs;
    return false;
  }

  _consumeCaptureBody(capture, value, seq) {
    const candidate = capture.endTail + value;
    const endIndex = candidate.indexOf(capture.endMarker);
    if (endIndex >= 0) {
      const body = candidate.slice(0, endIndex);
      if (body.includes(VISIBILITY_BOUNDARY)) capture.frameInvalid = true;
      collectVisibleText(capture.bodyCollector, body);
      capture.endTail = '';
      capture.endSeen = true;
      capture.throughSeq = seq;
      return true;
    }

    const keepLength = Math.min(candidate.length, capture.endMarker.length - 1);
    const safeLength = candidate.length - keepLength;
    if (safeLength > 0) {
      const body = candidate.slice(0, safeLength);
      if (body.includes(VISIBILITY_BOUNDARY)) capture.frameInvalid = true;
      collectVisibleText(capture.bodyCollector, body);
    }
    capture.endTail = candidate.slice(safeLength);
    return false;
  }

  _armIdleTimer(s, waiter) {
    if (!s.waiters.has(waiter.id) || !waiter.sawOutput || !waiter.idleMs) return;
    if (waiter.idleTimer) clearTimeout(waiter.idleTimer);
    const delay = Math.max(0, waiter.lastOutputAt + waiter.idleMs - Date.now());
    waiter.idleTimer = setTimeout(() => {
      this._settleWaiter(s, waiter, 'idle');
    }, delay);
  }

  _settleWaiter(s, waiter, reason) {
    if (!s.waiters.has(waiter.id)) return false;
    s.waiters.delete(waiter.id);
    if (waiter.idleTimer) clearTimeout(waiter.idleTimer);
    if (waiter.timeoutTimer) clearTimeout(waiter.timeoutTimer);
    const result = {
      reason,
      elapsedMs: Math.max(0, Date.now() - waiter.startedAt),
      outputSeq: s.outputSeq,
    };
    if (waiter.capture) result.capture = this._captureReport(waiter.capture, reason);
    waiter.resolve(result);
    return true;
  }

  _captureReport(capture, reason) {
    const missingStart = !capture.startSeen;
    const missingEnd = !capture.endSeen;
    const truncatedBefore = missingStart && capture.historyGap;
    const collector = capture.startSeen ? capture.bodyCollector : capture.partialCollector;
    const mayExposeBody = reason === 'match' && capture.endSeen
      && (capture.startSeen || capture.historyGap);
    const text = mayExposeBody && collector ? finishTextCollector(collector) : '';
    const truncatedAfter = !!collector?.truncated || capture.frameInvalid === true;

    return {
      complete: reason === 'match'
        && !missingStart
        && !missingEnd
        && !truncatedBefore
        && !truncatedAfter,
      missingStart,
      missingEnd,
      truncatedBefore,
      truncatedAfter,
      fromSeq: capture.startSeen
        ? capture.fromSeq
        : (mayExposeBody ? capture.availableFromSeq : null),
      throughSeq: capture.endSeen ? capture.throughSeq : null,
      byteLength: Buffer.byteLength(text, 'utf8'),
      text,
    };
  }

  _settleAllWaiters(s, reason) {
    if (!s?.waiters) return;
    for (const waiter of [...s.waiters.values()]) {
      this._settleWaiter(s, waiter, reason);
    }
  }

  _enqueueTermination(task) {
    this._pendingTerminations += 1;
    const queued = this._terminationQueue.then(task, task).finally(() => {
      this._pendingTerminations -= 1;
    });
    // Keep the queue usable after one failed task without creating an
    // unhandled rejection on the internal tail promise.
    this._terminationQueue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  /** Wait until every queued ConPTY termination has delivered its exit event. */
  async whenTerminationsComplete() {
    // A task can enqueue another termination while we are awaiting the current
    // tail. Observe until the tail is stable rather than returning a stale
    // snapshot of the queue.
    let observed;
    do {
      observed = this._terminationQueue;
      await observed;
    } while (observed !== this._terminationQueue);
  }

  _waitForExit(s, timeoutMs = this._terminationTimeoutMs) {
    if (!s || s.status === 'exited' || !s.proc) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      s.exitPromise.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  /**
   * Terminate a session.
   *
   * On Windows the app injects `terminateTree`: request `taskkill /T /F`
   * while the root PID still exists. Killing the outer ConPTY first can orphan
   * its nested AccountShell/Codex children, after which a delayed tree kill has
   * no root to follow. Other environments keep the SIGTERM-then-force fallback.
   */
  kill(id, reason = 'requested') {
    const s = this._sessions.get(id);
    if (!s) return false;

    const pid = s.pid;
    if (s.proc) {
      this._log(`[Sessions] killing ${id} (${reason})`);
      let treeRequested = false;
      if (this._terminateTree) {
        try {
          this._terminateTree(pid);
          treeRequested = true;
        } catch (_e) {
          // Fall through to the parent signal path. The escalation below still
          // retries the whole tree if the PTY remains alive.
        }
      }
      if (!treeRequested) {
        try {
          s.proc.kill('SIGTERM');
        } catch (_e) {
          try { process.kill(pid, 'SIGTERM'); } catch (_e2) { /* already gone */ }
        }
      }
      if (s.killTimer) clearTimeout(s.killTimer);
      // Retry/escalate on the captured session record, not registry membership:
      // remove() deletes the entry immediately, and the tree still has to die.
      s.killTimer = setTimeout(() => {
        s.killTimer = null;
        if (s.status !== 'running') return;
        this._killTree(pid);
        // A failed asynchronous tree request must not leave the root itself.
        if (treeRequested && s.proc) {
          try { s.proc.kill('SIGTERM'); } catch (_e) { /* already gone */ }
        }
      }, KILL_GRACE_MS);
      // Do not let a pending kill timer hold the event loop open at quit.
      if (typeof s.killTimer.unref === 'function') s.killTimer.unref();
    }
    return true;
  }

  /** Kill every session. Returns how many were live. */
  killAll(reason = 'shutdown') {
    let killed = 0;
    for (const [id, s] of this._sessions) {
      if (s.status === 'running') {
        this.kill(id, reason);
        killed++;
      }
    }
    return killed;
  }

  /**
   * Kill live sessions one at a time and wait for node-pty's JS exit callback
   * before initiating the next exit. This is the safe path for multi-session
   * shutdown and bulk-close operations on Windows.
   */
  killAllSequential(reason = 'shutdown', { failOnTimeout = false } = {}) {
    return this._enqueueTermination(async () => {
      const live = [...this._sessions.values()].filter(s => s.status === 'running');
      const failures = [];
      for (const s of live) {
        if (s.status !== 'running') continue;
        try {
          this.kill(s.id, reason);
        } catch (error) {
          failures.push(error);
          try {
            this._killTree(s.pid);
          } catch (killError) {
            failures.push(killError);
          }
          continue;
        }

        let exited = false;
        try {
          exited = await this._waitForExit(s);
        } catch (error) {
          failures.push(error);
        }
        if (!exited) {
          const message = `Timed out waiting for session ${s.id} to exit`;
          if (s.killTimer) {
            clearTimeout(s.killTimer);
            s.killTimer = null;
          }
          try {
            this._killTree(s.pid);
          } catch (error) {
            failures.push(error);
          }
          this._log(`[Sessions] ${message.toLowerCase()} before terminating the next session`);
          if (failOnTimeout) {
            const error = new Error(message);
            error.code = 'session-termination-timeout';
            failures.push(error);
          }
        }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        const error = new AggregateError(
          failures,
          `${failures.length} session termination failures`
        );
        error.code = 'session-termination-failures';
        throw error;
      }
      return live.length;
    });
  }

  /** Drop exited sessions from the registry. Returns how many were removed. */
  prune() {
    let removed = 0;
    for (const [id, s] of [...this._sessions]) {
      if (s.status === 'exited') {
        if (s.killTimer) { clearTimeout(s.killTimer); s.killTimer = null; }
        this._sessions.delete(id);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Forget one session outright (used when a tab is closed).
   * The kill escalation started above keeps running against the detached
   * record, so a stuck child tree is still force-killed after the grace
   * window even though the registry no longer lists it.
   */
  remove(id) {
    const s = this._sessions.get(id);
    if (!s) return false;
    this._settleAllWaiters(s, 'removed');
    if (s.status === 'running') {
      // Reserve the id until this exact PTY has delivered its exit event.
      this._retiringIds.add(id);
      this.kill(id, 'closed');
    }
    this._sessions.delete(id);
    return true;
  }

  /**
   * Queued counterpart to remove(), used by IPC so rapid tab closes and
   * workflow aborts do not terminate several ConPTY sessions concurrently.
   */
  removeAndWait(id) {
    return this._enqueueTermination(async () => {
      const s = this._sessions.get(id);
      if (!s) return false;
      this.remove(id);
      if (!await this._waitForExit(s)) {
        this._log(`[Sessions] timed out waiting for removed session ${id} to exit`);
      }
      return true;
    });
  }

  /**
   * Serializable metadata for one session.
   * Deliberately omits `env` and the resolved executable path: a routed
   * session's spec contains canonical account-home paths, which are
   * secret-adjacent and must not reach the renderer, the log, or an export.
   */
  describe(id) {
    const s = this._sessions.get(id);
    if (!s) return null;
    return {
      id: s.id,
      pid: s.pid,
      profileId: s.profileId,
      agent: s.agent,
      label: s.label,
      assurance: s.assurance,
      resultInputCapable: s.resultInputCapable,
      startedAt: s.startedAt,
      status: s.status,
      exitCode: s.exitCode,
    };
  }

  /** Metadata for every session, oldest first. */
  list() {
    return [...this._sessions.keys()].map(id => this.describe(id));
  }

  get size() {
    return this._sessions.size;
  }

  get hasPendingTermination() {
    return this._pendingTerminations > 0;
  }

  get admissionClosed() {
    return this._admissionClosed;
  }
}

module.exports = { SessionRegistry, nextSessionId, KILL_GRACE_MS };
