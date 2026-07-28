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
const MAX_IDLE_MS = 60 * 60 * 1000;
const MAX_WAIT_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const TERMINATION_TIMEOUT_MS = 5000;

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

class SessionRegistry {
  /**
   * @param {object} deps
   * @param {object} deps.pty            node-pty (or a test double)
   * @param {function} [deps.onOutput]   ({ id, data }) => void
   * @param {function} [deps.onExit]     ({ id, code }) => void
   * @param {function} [deps.onStatus]   (sessionMeta) => void
   * @param {function} [deps.killTree]   (pid) => void, force-kill a process tree
   * @param {function} [deps.log]        (message) => void
   */
  constructor({ pty, onOutput, onExit, onStatus, killTree, log } = {}) {
    this._pty = pty;
    this._onOutput = onOutput || (() => {});
    this._onExit = onExit || (() => {});
    this._onStatus = onStatus || (() => {});
    this._killTree = killTree || (() => {});
    this._log = log || (() => {});
    /** @type {Map<string, object>} id → session record */
    this._sessions = new Map();
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
   *                       profileId, agent, label, assurance }
   * @param {object} opts  { id, cols, rows }
   * @returns {{ id: string, pid: number }}
   */
  create(spec, { id, cols, rows } = {}) {
    if (!spec || typeof spec.file !== 'string' || !spec.file) {
      throw new Error('Launch spec is missing an executable');
    }

    const sessionId = id || nextSessionId();

    // Never silently overwrite a live entry — that used to orphan the old PTY.
    if (this._sessions.has(sessionId)) {
      this._settleAllWaiters(this._sessions.get(sessionId), 'replaced');
      this.kill(sessionId, 'replaced');
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
      cwd: spec.cwd || null,
      startedAt: Date.now(),
      status: 'running',
      exitCode: null,
      killTimer: null,
      outputSeq: 0,
      outputChunks: [],
      outputChars: 0,
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
      // Update the captured record, not a map lookup: remove() may already
      // have dropped the entry, and the pending kill escalation reads this
      // status to decide whether the tree still needs force-killing.
      if (session.killTimer) { clearTimeout(session.killTimer); session.killTimer = null; }
      session.status = 'exited';
      session.exitCode = exitCode;
      session.proc = null;
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
   * session exits, or the timeout backstop fires. Idle never completes before
   * at least one output chunk after `afterSeq`; an already-quiet terminal is
   * not evidence that an agent finished the prompt just sent.
   *
   * @returns {Promise<{reason, elapsedMs, outputSeq}>}
   */
  waitForOutput(id, {
    waitId = nextWaitId(),
    afterSeq,
    idleMs = 2000,
    pattern = '',
    timeoutMs = 120_000,
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
    if (!normalizedIdleMs && !pattern) {
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
      return Promise.resolve({ reason: 'exit', elapsedMs: 0, outputSeq: s.outputSeq });
    }

    return new Promise((resolve) => {
      const waiter = {
        id: waitId,
        afterSeq: startSeq,
        idleMs: normalizedIdleMs,
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
      s.waiters.set(waitId, waiter);

      waiter.timeoutTimer = setTimeout(() => {
        this._settleWaiter(s, waiter, 'timeout');
      }, normalizedTimeoutMs);

      // Include output that raced between the renderer's checkpoint and this
      // IPC call. That is why the registry keeps a small bounded history.
      for (const chunk of s.outputChunks) {
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
    const chunk = { seq: ++s.outputSeq, data, at: Date.now() };
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
      only.data = only.data.slice(-OUTPUT_HISTORY_CHARS);
      s.outputChars = only.data.length;
    }
  }

  _consumeWaiterOutput(s, waiter, chunk) {
    if (!s.waiters.has(waiter.id)) return;
    waiter.sawOutput = true;
    waiter.lastOutputAt = chunk.at;

    if (waiter.pattern) {
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
    waiter.resolve({
      reason,
      elapsedMs: Math.max(0, Date.now() - waiter.startedAt),
      outputSeq: s.outputSeq,
    });
    return true;
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
  whenTerminationsComplete() {
    return this._terminationQueue;
  }

  _waitForExit(s, timeoutMs = TERMINATION_TIMEOUT_MS) {
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
   * Terminate a session. Sends SIGTERM, then force-kills the whole process
   * tree if it has not exited within the grace window — a routed session is
   * `pwsh` with a `codex` child, and killing only the ConPTY leaves the
   * child running.
   */
  kill(id, reason = 'requested') {
    const s = this._sessions.get(id);
    if (!s) return false;

    const pid = s.pid;
    if (s.proc) {
      this._log(`[Sessions] killing ${id} (${reason})`);
      try {
        s.proc.kill('SIGTERM');
      } catch (_e) {
        try { process.kill(pid, 'SIGTERM'); } catch (_e2) { /* already gone */ }
      }
      if (s.killTimer) clearTimeout(s.killTimer);
      // Escalate on the session *record*, not on registry membership: remove()
      // deletes the entry immediately, and the tree still has to die.
      s.killTimer = setTimeout(() => {
        s.killTimer = null;
        if (s.status === 'running') this._killTree(pid);
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
  killAllSequential(reason = 'shutdown') {
    return this._enqueueTermination(async () => {
      const live = [...this._sessions.values()].filter(s => s.status === 'running');
      for (const s of live) {
        if (s.status !== 'running') continue;
        this.kill(s.id, reason);
        if (!await this._waitForExit(s)) {
          this._log(`[Sessions] timed out waiting for ${s.id} to exit before terminating the next session`);
        }
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
    if (s.status === 'running') this.kill(id, 'closed');
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
}

module.exports = { SessionRegistry, nextSessionId, KILL_GRACE_MS };
