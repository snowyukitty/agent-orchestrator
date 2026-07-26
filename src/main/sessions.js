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

let seq = 0;

/** Mint a session id that satisfies validate.ID_PATTERN. */
function nextSessionId(prefix = 'sess') {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq}`;
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
    };
    this._sessions.set(sessionId, session);

    proc.onData((data) => {
      this._onOutput({ id: sessionId, data: data.toString(), stream: 'stdout' });
    });

    proc.onExit(({ exitCode }) => {
      // Update the captured record, not a map lookup: remove() may already
      // have dropped the entry, and the pending kill escalation reads this
      // status to decide whether the tree still needs force-killing.
      if (session.killTimer) { clearTimeout(session.killTimer); session.killTimer = null; }
      session.status = 'exited';
      session.exitCode = exitCode;
      session.proc = null;
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
    if (s.status === 'running') this.kill(id, 'closed');
    this._sessions.delete(id);
    return true;
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
}

module.exports = { SessionRegistry, nextSessionId, KILL_GRACE_MS };
