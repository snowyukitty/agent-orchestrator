// ============================================================
// Workflow Execution Engine
// Runs blocks sequentially, managing processes & timing
// ============================================================

import { typeInto } from './typing.js';
import {
  WORKFLOW_AGENT_TARGET,
  pendingWorkflowAgentSessions,
  workflowAgentSessions,
} from './agent-targets.js';

export class ExecutionEngine {
  constructor({ api = null, getSessions = null, getGeometry = null, typeIntoFn = typeInto } = {}) {
    this._api = api;
    this._getSessions = getSessions;
    this._getGeometry = getGeometry;
    this._typeInto = typeIntoFn;
    this.running = false;
    this.aborted = false;
    this.runId = null;
    this.currentProcessId = null;   // the PTY currently targeted by input/keypress
    this._procSeq = 0;
    this._waitSeq = 0;
    this._spawnedIds = new Set();   // every PTY this run spawned (for abort cleanup)
    this._outputCheckpoints = new Map(); // session id → main-process output sequence
    this._pendingAgentIds = new Set(); // prompted agent lanes not yet individually waited/joined
    this._pendingAgentLanes = new Map(); // id → identity captured before a lane can exit/disappear
    this._activeWaits = new Map(); // wait id → { id, waitId }, supports group barriers
    this.currentBlockIndex = -1;
    this.cwd = null;
    this._abortLogged = false;

    // Callbacks — set these from the outside
    this.onLog = null;            // (message, type) => void
    this.onBlockStart = null;     // (index) => void
    this.onBlockEnd = null;       // (index, success) => void
    this.onComplete = null;       // (success) => void
    this.onStatusChange = null;   // (status) => void
    this.onLoopIteration = null;  // (loopIndex, iter, total, done, blockId) => void
    this.onSessionSpawned = null; // (sessionMeta) => void — lets the UI adopt it
    this.onAgentJoinProgress = null; // ({ blockId, index, ready, settled, total, session, reason }) => void
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
    this._pendingAgentIds = new Set();
    this._pendingAgentLanes = new Map();
    this._activeWaits = new Map();
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
      this._activeWaits.clear();
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
      if (this.onBlockStart) this.onBlockStart(i, block.id || null);

      if (block.type === 'loop') {
        const end = matchingLoopEnd(blocks, i);
        const count = Math.max(0, Math.floor(Number(block.params?.count) || 0));
        if (end === -1) {
          this._log('🔄 Loop has no matching “End Loop” — skipping this block', 'system');
          if (this.onBlockEnd) this.onBlockEnd(i, true, block.id || null);
          i++;
          continue;
        }
        if (count <= 0) {
          this._log('🔄 Loop count is 0 — skipping its body', 'system');
          if (this.onBlockEnd) this.onBlockEnd(i, true, block.id || null);
          i = end + 1;
          continue;
        }
        const frame = { start: i, end, total: count, iter: 1, blockId: block.id || null };
        loopStack.push(frame);
        this._log(`🔄 Loop ▸ iteration 1/${count}`, 'system');
        if (this._dryRun) this._trace.push({ index: i, type: 'loop', iter: 1 });
        this._notifyLoop(frame, false);
        if (this.onBlockEnd) this.onBlockEnd(i, true, block.id || null);
        i++;
        continue;
      }

      if (block.type === 'loopEnd') {
        const frame = loopStack[loopStack.length - 1];
        if (!frame) {
          this._log('🔁 “End Loop” without a matching Loop — ignoring', 'system');
          if (this.onBlockEnd) this.onBlockEnd(i, true, block.id || null);
          i++;
          continue;
        }
        if (frame.iter < frame.total) {
          frame.iter++;
          this._log(`🔁 Loop ▸ iteration ${frame.iter}/${frame.total}`, 'system');
          this._notifyLoop(frame, false);
          if (this.onBlockEnd) this.onBlockEnd(i, true, block.id || null);
          i = frame.start + 1;   // jump back to the first block of the body
          continue;
        }
        this._log(`🔁 Loop complete (${frame.total}×)`, 'system');
        this._notifyLoop(frame, true);
        loopStack.pop();
        if (this.onBlockEnd) this.onBlockEnd(i, true, block.id || null);
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
          if (this.onBlockEnd) this.onBlockEnd(i, false, block.id || null);
          this._logAbortOnce();
          return false;
        }
        if (this.onBlockEnd) this.onBlockEnd(i, true, block.id || null);
      } catch (err) {
        this._log(`❌ Error: ${err.message}`, 'stderr');
        if (this.onBlockEnd) this.onBlockEnd(i, false, block.id || null);
        return false;
      }
      i++;
    }

    return true;
  }

  abort() {
    this.aborted = true;
    for (const wait of this._activeWaits.values()) {
      Promise.resolve(this._apiClient().cancelSessionWait?.(wait)).catch(() => {});
    }
    // Kill every PTY this run spawned, not just the latest one.
    for (const id of this._spawnedIds) {
      Promise.resolve(this._apiClient().killProcess?.({ id })).catch(() => {});
    }
    this._log('🛑 Abort requested...', 'system');
  }

  get isRunning() {
    return this.running;
  }

  // ── Block Executors ────────────────────────────────────────

  async _executeBlock(block) {
    if (!Object.hasOwn(this._executors, block.type)) {
      this._log(`⚠️ Unknown block type "${block.type}", skipping`, 'system');
      return;
    }
    const executor = this._executors[block.type];
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

      const result = await this._apiClient().executeCommand({
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
      const result = await this._apiClient().createSession({
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

    /** Send a prompt to one agent lane, or fan out to every lane in this run. */
    async agentSend(block) {
      const target = block.params.profileId;
      const text = block.params.text || '';
      const pressEnter = block.params.pressEnter !== false;
      const sessionIds = target === WORKFLOW_AGENT_TARGET
        ? this._workflowAgentSessions().map(session => session.id)
        : [target ? this._sessionForProfile(target) : this.currentProcessId].filter(Boolean);
      const agentLanes = new Map(
        this._workflowAgentSessions()
          .filter(session => sessionIds.includes(session.id))
          .map(session => [session.id, session])
      );

      if (sessionIds.length === 0) {
        throw new Error(target
          ? (target === WORKFLOW_AGENT_TARGET
            ? 'No live workflow agent sessions — add Agent Session blocks first'
            : `No live session for agent profile "${target}" — add an Agent Session block first`)
          : 'No active session to receive input');
      }

      const label = target === WORKFLOW_AGENT_TARGET
        ? `${sessionIds.length} workflow agents`
        : (target || 'current session');
      this._log(`📨 → ${label}: "${text}"${pressEnter ? ' ⏎' : ''}`, 'input-echo');

      // Type into independent PTYs concurrently. Promise.allSettled ensures a
      // failure in one lane cannot leave other typing tasks running after this
      // block has already reported an error.
      const sends = await Promise.allSettled(sessionIds.map(async sessionId => {
        const result = await this._typeInto({
          sessionId,
          text,
          pressEnter,
          isAborted: () => this.aborted,
          onTyped: () => this._rememberOutputCheckpoint(sessionId),
        });
        if (!result?.aborted && agentLanes.has(sessionId)) {
          this._rememberPendingAgentLane(agentLanes.get(sessionId));
        }
        return result;
      }));

      const failures = sends
        .map((result, index) => ({ result, sessionId: sessionIds[index] }))
        .filter(item => item.result.status === 'rejected');
      if (failures.length) {
        const detail = failures
          .map(item => `${this._sessionLabel(item.sessionId)}: ${item.result.reason?.message || item.result.reason}`)
          .join('; ');
        throw new Error(`Send failed for ${failures.length} agent lane(s): ${detail}`);
      }
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
      const result = await this._waitForSessionSignal({
        sessionId,
        waitId,
        afterSeq,
        idleMs,
        pattern,
        timeoutMs,
      });

      if (Number.isInteger(result?.outputSeq)) {
        this._outputCheckpoints.set(sessionId, result.outputSeq);
      }
      this._pendingAgentIds.delete(sessionId);
      this._pendingAgentLanes.delete(sessionId);
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

    /**
     * Fan-in barrier for every agent lane prompted since its previous wait or
     * join. Each main-process waiter starts before we await any of them, so
     * lanes truly advance concurrently and fast replies remain race-safe.
     */
    async agentJoin(block) {
      const idleMs = Number(block.params.idleMs ?? 2000);
      const pattern = String(block.params.pattern || '');
      const timeoutMs = Number(block.params.timeoutMs ?? 120000);
      const onIncomplete = block.params.onIncomplete === 'continue' ? 'continue' : 'stop';
      const sessions = this._pendingWorkflowAgentSessions();

      if (!idleMs && !pattern) {
        throw new Error('Join Agents needs an idle duration or output text');
      }
      if (sessions.length === 0) {
        throw new Error('Join Agents has no pending lanes — send a prompt to workflow agents first');
      }

      const total = sessions.length;
      let ready = 0;
      let settledCount = 0;
      const readyReasons = new Set(['match', 'idle']);
      const criteria = [
        idleMs ? `${idleMs} ms idle` : '',
        pattern ? `output contains "${shortText(pattern)}"` : '',
      ].filter(Boolean).join(' or ');
      this._log(`◇ Joining ${total} agent lane(s): ${criteria} (timeout ${timeoutMs} ms)…`, 'system');
      this._setStatus(`◇ Join 0/${total}`);
      this._notifyAgentJoin(block, {
        ready: 0,
        settled: 0,
        total,
        session: null,
        reason: 'waiting',
      });

      const waits = sessions.map(async session => {
        try {
          let result;
          if (session.status === 'removed') {
            result = { reason: 'removed' };
          } else {
            let afterSeq = this._outputCheckpoints.get(session.id);
            if (!Number.isInteger(afterSeq)) {
              afterSeq = await this._rememberOutputCheckpoint(session.id);
            }
            const waitId = `${this.runId}-w${++this._waitSeq}`;
            result = await this._waitForSessionSignal({
              sessionId: session.id,
              waitId,
              afterSeq,
              idleMs,
              pattern,
              timeoutMs,
            });
          }
          if (Number.isInteger(result?.outputSeq)) {
            this._outputCheckpoints.set(session.id, result.outputSeq);
          }
          this._pendingAgentIds.delete(session.id);
          this._pendingAgentLanes.delete(session.id);
          settledCount++;
          if (readyReasons.has(result?.reason)) ready++;
          this._setStatus(`◇ Join ${ready}/${total} ready`);
          this._notifyAgentJoin(block, {
            ready,
            settled: settledCount,
            total,
            session: { id: session.id, label: session.label },
            reason: result?.reason || 'unknown',
          });
          return { session, result };
        } catch (error) {
          await this._cancelActiveWaits();
          throw error;
        }
      });

      const settled = await Promise.allSettled(waits);
      if (this.aborted) return;

      const rejected = settled.filter(result => result.status === 'rejected');
      if (rejected.length) {
        // A renderer/main IPC failure is not a workflow signal. Cancel any
        // waiter still registered before surfacing the first concrete error.
        await this._cancelActiveWaits();
        throw rejected[0].reason;
      }

      const outcomes = settled.map(result => result.value);
      const incomplete = outcomes.filter(({ result }) => !readyReasons.has(result?.reason));
      const policyControlledReasons = new Set(['timeout', 'exit']);
      for (const { session, result } of outcomes) {
        const ready = readyReasons.has(result?.reason);
        this._log(
          `${ready ? '◆' : '⚠️'} ${session.label}: ${joinReasonLabel(result?.reason, idleMs, timeoutMs)}`,
          ready ? 'system' : 'stderr'
        );
      }

      const invalid = incomplete.filter(({ result }) => !policyControlledReasons.has(result?.reason));
      if (invalid.length) {
        const detail = invalid
          .map(({ session, result }) => `${session.label} (${result?.reason || 'unknown'})`)
          .join(', ');
        throw new Error(`Join could not observe every lane: ${detail}`);
      }
      if (incomplete.length && onIncomplete === 'stop') {
        const detail = incomplete
          .map(({ session, result }) => `${session.label} (${result?.reason || 'unknown'})`)
          .join(', ');
        throw new Error(`Join incomplete — downstream blocks were stopped: ${detail}`);
      }
      if (incomplete.length) {
        this._log(`⚠️ Join incomplete for ${incomplete.length}/${total} lane(s); continuing by block policy`, 'system');
      } else {
        this._log(`◆ Join complete — all ${total} agent lane(s) are ready`, 'system');
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
      const pendingLane = this._workflowAgentSessions()
        .find(session => session.id === this.currentProcessId);
      const result = await this._typeInto({
        sessionId: this.currentProcessId,
        text,
        pressEnter,
        isAborted: () => this.aborted,
        onTyped: () => this._rememberOutputCheckpoint(this.currentProcessId),
      });
      if (!result?.aborted && pendingLane) {
        this._rememberPendingAgentLane(pendingLane);
      }
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
      const sent = await this._apiClient().sendInput({
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

      if (this._apiClient().armSleep) {
        await this._apiClient().armSleep({ delayMs: ms });
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

  _apiClient() {
    if (this._api) return this._api;
    if (typeof window !== 'undefined' && window.api) return window.api;
    return {};
  }

  /** Terminal geometry to spawn a PTY with, from the visible session. */
  _geometry() {
    if (typeof this._getGeometry === 'function') {
      const geometry = this._getGeometry() || {};
      return { cols: geometry.cols ?? 80, rows: geometry.rows ?? 24 };
    }
    const term = (typeof window !== 'undefined' && window.app) ? window.app.term : null;
    return { cols: term?.cols ?? 80, rows: term?.rows ?? 24 };
  }

  async _rememberOutputCheckpoint(sessionId) {
    const api = this._apiClient();
    if (!api.sessionCheckpoint) {
      throw new Error('Output-aware waiting is unavailable in this build');
    }
    const checkpoint = await api.sessionCheckpoint({ id: sessionId });
    if (!Number.isInteger(checkpoint?.outputSeq)) {
      throw new Error('Could not read the agent output checkpoint');
    }
    this._outputCheckpoints.set(sessionId, checkpoint.outputSeq);
    return checkpoint.outputSeq;
  }

  async _waitForSessionSignal({ sessionId, waitId, afterSeq, idleMs, pattern, timeoutMs }) {
    const api = this._apiClient();
    if (!api.waitForSession) {
      throw new Error('Output-aware waiting is unavailable in this build');
    }
    const activeWait = { id: sessionId, waitId };
    this._activeWaits.set(waitId, activeWait);
    try {
      return await api.waitForSession({
        id: sessionId,
        waitId,
        afterSeq,
        idleMs,
        pattern,
        timeoutMs,
      });
    } finally {
      this._activeWaits.delete(waitId);
    }
  }

  async _cancelActiveWaits() {
    const cancel = this._apiClient().cancelSessionWait;
    if (!cancel || this._activeWaits.size === 0) return;
    await Promise.allSettled(
      [...this._activeWaits.values()].map(wait => cancel(wait))
    );
  }

  _sessionSource() {
    if (typeof this._getSessions === 'function') return this._getSessions();
    return (typeof window !== 'undefined' && window.app) ? window.app.sessions : null;
  }

  _sessionList() {
    const source = this._sessionSource();
    if (Array.isArray(source)) return source.map(session => ({ ...session }));
    return source && typeof source.list === 'function' ? source.list() : [];
  }

  _workflowAgentSessions() {
    return workflowAgentSessions(this._sessionList(), this._spawnedIds);
  }

  _pendingWorkflowAgentSessions() {
    return pendingWorkflowAgentSessions(
      this._sessionList(),
      this._spawnedIds,
      this._pendingAgentIds,
      this._pendingAgentLanes
    );
  }

  _rememberPendingAgentLane(session) {
    if (!session?.id) return;
    this._pendingAgentIds.add(session.id);
    this._pendingAgentLanes.set(session.id, {
      id: session.id,
      label: session.label || session.id,
      profileId: session.profileId,
      agent: session.agent,
    });
  }

  _sessionLabel(sessionId) {
    return this._sessionList().find(session => session.id === sessionId)?.label || sessionId;
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
    // Prefer the most recently opened matching lane when a workflow
    // intentionally starts the same profile more than once.
    const match = [...this._sessionList()].reverse().find(
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
    if (this.onLoopIteration) {
      this.onLoopIteration(frame.start, frame.iter, frame.total, done, frame.blockId || null);
    }
  }

  _notifyAgentJoin(block, progress) {
    if (!this.onAgentJoinProgress) return;
    this.onAgentJoinProgress({
      blockId: block.id || null,
      index: this.currentBlockIndex,
      ...progress,
    });
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

function joinReasonLabel(reason, idleMs, timeoutMs) {
  switch (reason) {
    case 'match': return 'completion marker matched';
    case 'idle': return `output idle for ${idleMs} ms`;
    case 'timeout': return `timed out after ${timeoutMs} ms`;
    case 'exit': return 'session exited before a completion signal';
    case 'cancelled': return 'wait cancelled';
    case 'removed': return 'session was removed';
    case 'replaced': return 'session was replaced';
    default: return `unknown outcome (${reason || 'none'})`;
  }
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
