// ============================================================
// Workflow Execution Engine
// Runs blocks sequentially, managing processes & timing
// ============================================================

import { typeInto } from './typing.js';

export class ExecutionEngine {
  constructor() {
    this.running = false;
    this.aborted = false;
    this.runId = null;
    this.currentProcessId = null;   // the PTY currently targeted by input/keypress
    this._procSeq = 0;
    this._waitSeq = 0;
    this._spawnedIds = new Set();   // every PTY this run spawned (for abort cleanup)
    this._outputCheckpoints = new Map(); // session id → main-process output sequence
    this._activeWait = null;
    this.currentBlockIndex = -1;
    this.cwd = null;
    this._abortLogged = false;

    // Callbacks — set these from the outside
    this.onLog = null;            // (message, type) => void
    this.onBlockStart = null;     // (index) => void
    this.onBlockEnd = null;       // (index, success) => void
    this.onComplete = null;       // (success) => void
    this.onStatusChange = null;   // (status) => void
    this.onLoopIteration = null;  // (loopIndex, iter, total, done) => void
    this.onSessionSpawned = null; // (sessionMeta) => void — lets the UI adopt it
  }

  // ── Public API ─────────────────────────────────────────────

  async execute(blocks, defaultCwd, opts = {}) {
    if (this.running) throw new Error('Engine is already running');

    this.running = true;
    this.aborted = false;
    this.cwd = defaultCwd || '.';
    this.runId = `run-${Date.now()}`;
    this.currentProcessId = null;
    this._procSeq = 0;
    this._waitSeq = 0;
    this._spawnedIds = new Set();
    this._outputCheckpoints = new Map();
    this._activeWait = null;
    this._abortLogged = false;
    this._dryRun = !!opts.dryRun;   // record-only mode for tests (no PTY, no waits)
    this._trace = [];               // [{ index, type, iter? }] executed-block log

    this._setStatus('running');
    this._log('▶ Workflow execution started', 'system');
    this._log(`  Working directory: ${this.cwd}`, 'system');

    let success = true;

    try {
      success = await this._drive(blocks);
    } finally {
      this._activeWait = null;
      this.running = false;
      this.currentBlockIndex = -1;
      this._setStatus(success ? 'completed' : 'error');
      this._log(
        `\n${success ? '✅ Workflow completed successfully' : '❌ Workflow failed'}`,
        'system'
      );
      if (this.onComplete) this.onComplete(success);
    }

    return this._trace;
  }

  // Walks the flat block list, honouring loop / loopEnd as a nesting structure.
  // A `loop` block repeats every block up to its matching `loopEnd` N times.
  // Nesting is supported via a frame stack; unmatched markers are skipped with
  // a warning. Returns true if the whole list ran without error/abort.
  async _drive(blocks) {
    const loopStack = [];
    // Safety net so a pathological workflow can't spin forever (counts are
    // bounded per-block, but deeply nested loops multiply).
    const MAX_STEPS = 1_000_000;
    let steps = 0;
    let i = 0;

    while (i < blocks.length) {
      if (this.aborted) { this._logAbortOnce(); return false; }
      if (++steps > MAX_STEPS) {
        this._log('⚠️ Loop step limit reached — stopping to avoid an infinite loop', 'stderr');
        return false;
      }

      const block = blocks[i];
      this.currentBlockIndex = i;
      if (this.onBlockStart) this.onBlockStart(i);

      if (block.type === 'loop') {
        const end = matchingLoopEnd(blocks, i);
        const count = Math.max(0, Math.floor(Number(block.params?.count) || 0));
        if (end === -1) {
          this._log('🔄 Loop has no matching “End Loop” — skipping this block', 'system');
          if (this.onBlockEnd) this.onBlockEnd(i, true);
          i++;
          continue;
        }
        if (count <= 0) {
          this._log('🔄 Loop count is 0 — skipping its body', 'system');
          if (this.onBlockEnd) this.onBlockEnd(i, true);
          i = end + 1;
          continue;
        }
        const frame = { start: i, end, total: count, iter: 1 };
        loopStack.push(frame);
        this._log(`🔄 Loop ▸ iteration 1/${count}`, 'system');
        if (this._dryRun) this._trace.push({ index: i, type: 'loop', iter: 1 });
        this._notifyLoop(frame, false);
        if (this.onBlockEnd) this.onBlockEnd(i, true);
        i++;
        continue;
      }

      if (block.type === 'loopEnd') {
        const frame = loopStack[loopStack.length - 1];
        if (!frame) {
          this._log('🔁 “End Loop” without a matching Loop — ignoring', 'system');
          if (this.onBlockEnd) this.onBlockEnd(i, true);
          i++;
          continue;
        }
        if (frame.iter < frame.total) {
          frame.iter++;
          this._log(`🔁 Loop ▸ iteration ${frame.iter}/${frame.total}`, 'system');
          this._notifyLoop(frame, false);
          if (this.onBlockEnd) this.onBlockEnd(i, true);
          i = frame.start + 1;   // jump back to the first block of the body
          continue;
        }
        this._log(`🔁 Loop complete (${frame.total}×)`, 'system');
        this._notifyLoop(frame, true);
        loopStack.pop();
        if (this.onBlockEnd) this.onBlockEnd(i, true);
        i++;
        continue;
      }

      this._log(`\n─── Step ${i + 1}: ${block.type.toUpperCase()} ───`, 'system');
      try {
        if (this._dryRun) {
          this._trace.push({ index: i, type: block.type });
        } else {
          await this._executeBlock(block);
        }
        if (this.aborted) {
          if (this.onBlockEnd) this.onBlockEnd(i, false);
          this._logAbortOnce();
          return false;
        }
        if (this.onBlockEnd) this.onBlockEnd(i, true);
      } catch (err) {
        this._log(`❌ Error: ${err.message}`, 'stderr');
        if (this.onBlockEnd) this.onBlockEnd(i, false);
        return false;
      }
      i++;
    }

    return true;
  }

  abort() {
    this.aborted = true;
    if (this._activeWait) {
      window.api.cancelSessionWait?.(this._activeWait).catch(() => {});
    }
    // Kill every PTY this run spawned, not just the latest one.
    for (const id of this._spawnedIds) {
      window.api.killProcess({ id }).catch(() => {});
    }
    this._log('🛑 Abort requested...', 'system');
  }

  get isRunning() {
    return this.running;
  }

  // ── Block Executors ────────────────────────────────────────

  async _executeBlock(block) {
    const executor = this._executors[block.type];
    if (!executor) {
      this._log(`⚠️ Unknown block type "${block.type}", skipping`, 'system');
      return;
    }
    await executor.call(this, block);
  }

  _executors = {
    schedule(block) {
      // During manual execution, schedule blocks are informational only
      const dt = block.params.datetime
        ? new Date(block.params.datetime).toLocaleString()
        : '(not set)';
      this._log(`⏰ Schedule: ${dt} [${block.params.mode}]`, 'system');
      this._log('   ℹ️  Schedule blocks only apply to timed execution, skipping.', 'system');
    },

    directory(block) {
      const p = block.params.path;
      if (!p) throw new Error('Directory path is empty');
      this.cwd = p;
      this._log(`📁 Working directory → ${p}`, 'system');
    },

    async command(block) {
      const cmd = block.params.command;
      if (!cmd) throw new Error('Command is empty');

      this._log(`⌨️  $ ${cmd}`, 'input-echo');

      // Each command gets its own PTY id so multiple command blocks don't
      // collide on a single shared id (which would orphan earlier PTYs).
      const procId = `${this.runId}-c${++this._procSeq}`;
      this.currentProcessId = procId;
      this._spawnedIds.add(procId);

      const { cols, rows } = this._geometry();

      const result = await window.api.executeCommand({
        id: procId,
        command: cmd,
        cwd: this.cwd,
        cols,
        rows,
      });

      if (result.error) {
        throw new Error(`Failed to start process: ${result.error}`);
      }

      this._log(`   PID: ${result.pid}`, 'system');

      // Hand the new PTY to the UI so it gets a tab and its output is rendered.
      this._notifySessionSpawned({
        id: procId,
        label: shortLabel(cmd),
        agent: 'shell',
        assurance: 'L0-native',
        status: 'running',
      });
      this._outputCheckpoints.set(procId, 0);

      // Give the process a moment to initialize
      await this._sleep(800);
    },

    /**
     * Open a session for a named agent profile and make it the target of the
     * blocks that follow. This is how one workflow drives several accounts.
     */
    async agentStart(block) {
      const profileId = block.params.profileId;
      if (!profileId) throw new Error('No agent profile selected');

      const { cols, rows } = this._geometry();
      const result = await window.api.createSession({
        profileId,
        cwd: block.params.cwd || this.cwd,
        cols,
        rows,
      });

      // A routed profile that cannot be resolved fails closed; surface that
      // rather than continuing against whatever session happened to be active.
      if (!result || result.error) {
        throw new Error(result?.error || `Could not start agent "${profileId}"`);
      }

      const meta = result.session || { id: result.id, label: profileId, agent: 'shell', assurance: 'L0-native', status: 'running' };
      this.currentProcessId = result.id;
      this._spawnedIds.add(result.id);
      this._log(`🤖 Agent session: ${meta.label} [${meta.assurance}]`, 'system');
      this._notifySessionSpawned(meta);
      this._outputCheckpoints.set(result.id, 0);

      await this._sleep(Number(block.params.settleMs) || 1500);
    },

    /** Send a prompt to a specific agent session (or the current one). */
    async agentSend(block) {
      const target = block.params.profileId;
      const text = block.params.text || '';
      const pressEnter = block.params.pressEnter !== false;

      const sessionId = target ? this._sessionForProfile(target) : this.currentProcessId;
      if (!sessionId) {
        throw new Error(target
          ? `No live session for agent profile "${target}" — add an Agent Session block first`
          : 'No active session to receive input');
      }

      this._log(`📨 → ${target || 'current session'}: "${text}"${pressEnter ? ' ⏎' : ''}`, 'input-echo');
      await typeInto({
        sessionId,
        text,
        pressEnter,
        isAborted: () => this.aborted,
        onTyped: () => this._rememberOutputCheckpoint(sessionId),
      });
    },

    async agentWait(block) {
      const target = block.params.profileId;
      const idleMs = Number(block.params.idleMs ?? 2000);
      const pattern = String(block.params.pattern || '');
      const timeoutMs = Number(block.params.timeoutMs ?? 120000);
      const sessionId = target ? this._sessionForProfile(target) : this.currentProcessId;

      if (!sessionId) {
        throw new Error(target
          ? `No live session for agent profile "${target}" — add an Agent Session block first`
          : 'No active agent session to wait for');
      }
      if (!idleMs && !pattern) {
        throw new Error('Wait for Agent needs an idle duration or output text');
      }

      let afterSeq = this._outputCheckpoints.get(sessionId);
      if (!Number.isInteger(afterSeq)) {
        afterSeq = await this._rememberOutputCheckpoint(sessionId);
      }

      const waitId = `${this.runId}-w${++this._waitSeq}`;
      const criteria = [
        idleMs ? `${idleMs} ms idle` : '',
        pattern ? `output contains "${shortText(pattern)}"` : '',
      ].filter(Boolean).join(' or ');
      this._log(`👂 Waiting for ${target || 'current agent'}: ${criteria} (timeout ${timeoutMs} ms)…`, 'system');
      this._setStatus('👂 Waiting for agent');

      const activeWait = { id: sessionId, waitId };
      this._activeWait = activeWait;
      let result;
      try {
        result = await window.api.waitForSession({
          id: sessionId,
          waitId,
          afterSeq,
          idleMs,
          pattern,
          timeoutMs,
        });
      } finally {
        if (this._activeWait === activeWait) this._activeWait = null;
      }

      if (Number.isInteger(result?.outputSeq)) {
        this._outputCheckpoints.set(sessionId, result.outputSeq);
      }
      switch (result?.reason) {
        case 'match':
          this._log('👂 Wait complete — output text matched', 'system');
          break;
        case 'idle':
          this._log(`👂 Wait complete — agent output was idle for ${idleMs} ms`, 'system');
          break;
        case 'timeout':
          this._log(`⚠️ Wait for Agent reached its ${timeoutMs} ms timeout; continuing`, 'system');
          break;
        case 'exit':
          this._log('⬡ Wait complete — agent session exited', 'system');
          break;
        case 'cancelled':
          if (!this.aborted) throw new Error('Wait for Agent was cancelled');
          break;
        case 'removed':
        case 'replaced':
          throw new Error('Agent session was closed while waiting');
        default:
          throw new Error('Wait for Agent returned no completion reason');
      }
    },

    async wait(block) {
      const duration = Number(block.params.duration) || 0;
      const unit = block.params.unit || 'seconds';

      let ms;
      switch (unit) {
        case 'minutes': ms = duration * 60_000; break;
        case 'hours':   ms = duration * 3_600_000; break;
        default:        ms = duration * 1_000;
      }

      this._log(`⏳ Waiting ${duration} ${unit}...`, 'system');

      const endTime = Date.now() + ms;

      while (Date.now() < endTime && !this.aborted) {
        const remaining = Math.ceil((endTime - Date.now()) / 1000);
        const mins = Math.floor(remaining / 60);
        const secs = remaining % 60;
        const display = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
        this._setStatus(`⏳ ${display}`);
        await this._sleep(Math.min(1000, endTime - Date.now()));
      }

      if (!this.aborted) {
        this._log('⏳ Wait complete', 'system');
      }
    },

    async input(block) {
      const text = block.params.text || '';
      const pressEnter = block.params.pressEnter !== false;

      if (!this.currentProcessId) {
        throw new Error('No active process to receive input');
      }

      this._log(
        `📝 Sending: "${text}"${pressEnter ? ' ⏎' : ''}`,
        'input-echo'
      );

      // Shared with the quick-send bar so their pacing can never drift apart.
      await typeInto({
        sessionId: this.currentProcessId,
        text,
        pressEnter,
        isAborted: () => this.aborted,
        onTyped: () => this._rememberOutputCheckpoint(this.currentProcessId),
      });
    },

    async keypress(block) {
      const key = block.params.key || 'enter';
      // Enter is CR, matching what a real terminal sends and what the `input`
      // block uses. LF here made some CLIs treat it as a newline-in-buffer
      // rather than a submit.
      const keyMap = {
        'enter':  '\r',
        'ctrl+c': '\x03',
        'ctrl+d': '\x04',
        'escape': '\x1b',
        'tab':    '\t',
      };

      const char = keyMap[key] || '\r';

      this._log(`🔑 Key: ${key}`, 'input-echo');

      if (!this.currentProcessId) {
        throw new Error('No active process to receive keypress');
      }

      await this._rememberOutputCheckpoint(this.currentProcessId);
      const sent = await window.api.sendInput({
        id: this.currentProcessId,
        text: char,
      });
      if (!sent) {
        throw new Error('No active process to receive keypress');
      }
    },

    log(block) {
      const msg = block.params.message || '';
      this._log(`📋 ${msg}`, 'system');
    },

    async sleep(block) {
      const delay = Number(block.params.delay) || 0;
      const unit = block.params.unit || 'minutes';

      let ms;
      switch (unit) {
        case 'seconds': ms = delay * 1_000; break;
        case 'hours':   ms = delay * 3_600_000; break;
        default:        ms = delay * 60_000;
      }

      // Arming is non-blocking: the workflow continues (or ends) while the
      // main process holds an independent timer. The user can cancel from the
      // toolbar banner before it fires.
      this._log(
        `💤 Hibernate armed — fires in ${delay} ${unit}. Cancel from the toolbar banner.`,
        'system'
      );

      if (window.api && window.api.armSleep) {
        await window.api.armSleep({ delayMs: ms });
      } else {
        this._log('⚠️ Hibernate API unavailable in this build', 'stderr');
      }
    },
  };

  // ── Process Event Hooks ────────────────────────────────────
  // The app owns the (single, persistent) IPC listeners and forwards
  // relevant events here. The engine no longer registers its own IPC
  // listeners — doing so previously caused the app's terminal listener
  // to be torn down by removeAllListeners(), and double-wrote PTY output.

  handleProcessExit(data) {
    if (this.running && data.id === this.currentProcessId) {
      this._log(`\n⬡ Process exited (code ${data.code})`, 'system');
    }
  }

  handleProcessError(data) {
    if (this.running && data.id === this.currentProcessId) {
      this._log(`❌ Process error: ${data.error}`, 'stderr');
    }
  }

  // ── Utilities ──────────────────────────────────────────────

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
  }

  /** Terminal geometry to spawn a PTY with, from the visible session. */
  _geometry() {
    const term = (typeof window !== 'undefined' && window.app) ? window.app.term : null;
    return { cols: term?.cols ?? 80, rows: term?.rows ?? 24 };
  }

  async _rememberOutputCheckpoint(sessionId) {
    if (!window.api?.sessionCheckpoint) {
      throw new Error('Output-aware waiting is unavailable in this build');
    }
    const checkpoint = await window.api.sessionCheckpoint({ id: sessionId });
    if (!Number.isInteger(checkpoint?.outputSeq)) {
      throw new Error('Could not read the agent output checkpoint');
    }
    this._outputCheckpoints.set(sessionId, checkpoint.outputSeq);
    return checkpoint.outputSeq;
  }

  /** Announce a PTY this run opened so the UI can give it a tab. */
  _notifySessionSpawned(meta) {
    this._spawnedIds.add(meta.id);
    this.currentProcessId = meta.id;
    if (this.onSessionSpawned) this.onSessionSpawned(meta);
  }

  /**
   * The live session id for an agent profile, if this run started one.
   * Lets a later Send block address "the Claude · work session" by profile.
   */
  _sessionForProfile(profileId) {
    const sessions = (typeof window !== 'undefined' && window.app) ? window.app.sessions : null;
    if (!sessions) return null;
    const match = sessions.list().find(
      s => s.profileId === profileId && s.status !== 'exited' && this._spawnedIds.has(s.id)
    );
    return match ? match.id : null;
  }

  _logAbortOnce() {
    if (this._abortLogged) return;
    this._abortLogged = true;
    this._log('⛔ Workflow aborted by user', 'system');
  }

  _log(message, type = 'stdout') {
    if (this.onLog) this.onLog(message, type);
  }

  _setStatus(status) {
    if (this.onStatusChange) this.onStatusChange(status);
  }

  _notifyLoop(frame, done) {
    if (this.onLoopIteration) this.onLoopIteration(frame.start, frame.iter, frame.total, done);
  }
}

/** A short, readable tab label for an ad-hoc command session. */
function shortLabel(command) {
  const first = String(command).trim().split(/\s+/)[0] || 'shell';
  return first.length > 24 ? `${first.slice(0, 23)}…` : first;
}

function shortText(text, max = 80) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// ── Loop Structure Helpers ───────────────────────────────────
// Pure functions so the loop nesting model can be reasoned about (and tested)
// independently of the engine's side effects.

/** Index of the `loopEnd` that closes the `loop` at startIdx, or -1 if none. */
export function matchingLoopEnd(blocks, startIdx) {
  let depth = 0;
  for (let j = startIdx + 1; j < blocks.length; j++) {
    const t = blocks[j]?.type;
    if (t === 'loop') depth++;
    else if (t === 'loopEnd') {
      if (depth === 0) return j;
      depth--;
    }
  }
  return -1;
}

/**
 * Compute the nesting depth of each block for indentation, and flag structural
 * problems (a loop with no end, or an end with no loop). Returns
 * { depths: number[], errors: string[], unmatched: number[] } where `unmatched`
 * lists the indices of structurally broken loop/loopEnd markers.
 */
export function analyzeLoops(blocks) {
  const depths = new Array(blocks.length).fill(0);
  const errors = [];
  const unmatched = [];
  const stack = []; // indices of open `loop` blocks
  blocks.forEach((block, i) => {
    if (block.type === 'loopEnd') {
      if (stack.length === 0) {
        errors.push(`Block ${i + 1}: “End Loop” without a matching Loop`);
        unmatched.push(i);
        depths[i] = 0;
      } else {
        stack.pop();
        depths[i] = stack.length; // align the end marker with its loop body's parent
      }
      return;
    }
    depths[i] = stack.length;
    if (block.type === 'loop') stack.push(i);
  });
  for (const openIdx of stack) {
    errors.push(`Block ${openIdx + 1}: Loop has no matching “End Loop”`);
    unmatched.push(openIdx);
  }
  return { depths, errors, unmatched };
}
