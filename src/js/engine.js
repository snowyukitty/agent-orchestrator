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
import {
  MAX_RESULT_BYTES_PER_LANE,
  composeAgentPrompt,
  createResultContract,
  normalizeResultBundle,
} from './result-handoff.js';

const ROUTED_CODEX_READY_PATTERN = 'account shell ready';
const ROUTED_CODEX_READY_TIMEOUT_MS = 20_000;

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
    this._journalOpSeq = 0;
    this._resultContractSeq = 0;
    this._spawnedIds = new Set();   // every PTY this run spawned (for abort cleanup)
    this._outputCheckpoints = new Map(); // session id → main-process output sequence
    this._pendingAgentIds = new Set(); // prompted agent lanes not yet individually waited/joined
    this._pendingAgentLanes = new Map(); // id → identity captured before a lane can exit/disappear
    this._activeWaits = new Map(); // wait id → { id, waitId }, supports group barriers
    this._resultsByProducer = new Map(); // Join block id → explicit result bundle
    this._resultPolicies = new Map(); // Join block id → { resultName, onIncomplete, missingLanes }
    this._journalEnabled = false;
    this.currentVisitId = null;
    this.lastOutcome = null;
    this.currentBlockIndex = -1;
    this.cwd = null;
    this._abortLogged = false;
    this._finalizing = false;

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
    this.runId = opts.runId || `run-${Date.now()}`;
    this.currentProcessId = null;
    this._procSeq = 0;
    this._waitSeq = 0;
    this._journalOpSeq = 0;
    this._resultContractSeq = 0;
    this._spawnedIds = new Set();
    this._outputCheckpoints = new Map();
    this._pendingAgentIds = new Set();
    this._pendingAgentLanes = new Map();
    this._activeWaits = new Map();
    this._resultsByProducer = new Map();
    this._resultPolicies = new Map();
    this._abortLogged = false;
    this._finalizing = false;
    this._dryRun = !!opts.dryRun;   // record-only mode for tests (no PTY, no waits)
    this._journalEnabled = !!opts.journal && !this._dryRun;
    this.currentVisitId = null;
    this.lastOutcome = null;
    this._trace = [];               // [{ index, type, iter? }] executed-block log

    let success = false;
    let thrown;
    let hasThrown = false;
    const preserveFirstError = error => {
      if (hasThrown) return;
      thrown = error;
      hasThrown = true;
    };

    try {
      this._setStatus('running');
      this._log('▶ Workflow execution started', 'system');
      this._log(`  Working directory: ${this.cwd}`, 'system');
      for (const warning of analyzeHandoffPolicies(blocks)) {
        this._log(`⚠️ ${warning.message}`, 'system');
      }
      success = await this._drive(blocks);
    } catch (error) {
      preserveFirstError(error);
      success = false;
    } finally {
      const completedRunId = this.runId;
      const completedAborted = this.aborted;
      this._finalizing = true;
      try {
        const status = completedAborted ? 'stopped' : (success ? 'completed' : 'failed');
        if (this._journalEnabled) {
          try {
            await this._finishJournalRun(status, completedRunId);
          } catch (error) {
            success = false;
            preserveFirstError(error);
            try {
              this._log(`❌ Run Journal finalization failed: ${error.message}`, 'stderr');
            } catch (notificationError) {
              preserveFirstError(notificationError);
            }
          }
        }
        const finalStatus = completedAborted ? 'stopped' : (success ? 'completed' : 'failed');
        const outcome = Object.freeze({
          runId: completedRunId,
          status: finalStatus,
          success,
        });
        this.lastOutcome = outcome;
        // UI notifications are independent observers of the immutable
        // terminal outcome. One broken observer must not prevent the owner
        // callback or leak `running = true`, and must not replace an earlier
        // execution/journal error.
        try {
          this._setStatus(success ? 'completed' : (completedAborted ? 'stopped' : 'error'));
        } catch (error) {
          preserveFirstError(error);
        }
        try {
          this._log(
            `\n${success ? '✅ Workflow completed successfully' : (completedAborted ? '⛔ Workflow stopped' : '❌ Workflow failed')}`,
            'system'
          );
        } catch (error) {
          preserveFirstError(error);
        }
        try {
          if (this.onComplete) this.onComplete(success, outcome);
        } catch (error) {
          preserveFirstError(error);
        }
      } finally {
        this._activeWaits.clear();
        this.currentBlockIndex = -1;
        this.currentVisitId = null;
        this.running = false;
        this._finalizing = false;
      }
    }

    if (hasThrown) throw thrown;
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
        if (!this._dryRun) {
          const markerCompleted = await this._journalMarkerBlock(block, i, loopStack);
          if (!markerCompleted) {
            if (this.onBlockEnd) this.onBlockEnd(i, false, block.id || null);
            this._logAbortOnce();
            return false;
          }
        }
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
        if (!this._dryRun) {
          const markerCompleted = await this._journalMarkerBlock(block, i, loopStack);
          if (!markerCompleted) {
            if (this.onBlockEnd) this.onBlockEnd(i, false, block.id || null);
            this._logAbortOnce();
            return false;
          }
        }
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
      let visit = null;
      try {
        if (!this._dryRun) {
          visit = await this._startJournalBlock(block, i, loopStack);
          this.currentVisitId = visit?.visitId || null;
          // Stop can arrive while the journal bridge is creating the visit.
          // Never let that delayed bookkeeping open the executor afterwards.
          if (this.aborted) {
            if (visit) await this._finishJournalBlock(visit, 'stopped');
            if (this.onBlockEnd) this.onBlockEnd(i, false, block.id || null);
            this._logAbortOnce();
            return false;
          }
        }
        if (this._dryRun) {
          this._trace.push({ index: i, type: block.type });
        } else {
          await this._executeBlock(block);
        }
        if (this.aborted) {
          if (visit) await this._finishJournalBlock(visit, 'stopped');
          if (this.onBlockEnd) this.onBlockEnd(i, false, block.id || null);
          this._logAbortOnce();
          return false;
        }
        if (visit) await this._finishJournalBlock(visit, 'completed');
        if (this.onBlockEnd) this.onBlockEnd(i, true, block.id || null);
      } catch (err) {
        if (this.aborted) {
          if (visit) await this._finishJournalBlock(visit, 'stopped');
          if (this.onBlockEnd) this.onBlockEnd(i, false, block.id || null);
          this._logAbortOnce();
          return false;
        }
        if (visit) {
          try {
            await this._finishJournalBlock(visit, 'failed', 'block-error');
          } catch (journalError) {
            throw new Error(`Run Journal failed after a block error: ${journalError.message}`);
          }
        }
        this._log(`❌ Error: ${err.message}`, 'stderr');
        if (this.onBlockEnd) this.onBlockEnd(i, false, block.id || null);
        return false;
      } finally {
        this.currentVisitId = null;
      }
      i++;
    }

    return true;
  }

  abort() {
    if (this._finalizing) {
      this._log('🛑 Run is already finalizing; Stop did not alter its terminal outcome.', 'system');
      return false;
    }
    this.aborted = true;
    for (const wait of this._activeWaits.values()) {
      Promise.resolve(this._apiClient().cancelSessionWait?.(wait)).catch(() => {});
    }
    // Kill every PTY this run spawned, not just the latest one.
    for (const id of this._spawnedIds) {
      Promise.resolve(this._apiClient().killProcess?.({ id })).catch(() => {});
    }
    this._log('🛑 Abort requested...', 'system');
    return true;
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

      if (this.aborted) {
        // abort() may have killed this id before the async IPC actually
        // created it. Re-kill the returned session and never hand it to the UI.
        await this._discardUnadoptedSpawn(result?.id || procId, [procId]);
        return;
      }
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
        workflowSession: true,
      });

      if (this.aborted) {
        // The Stop sweep ran while createSession was unresolved, so this id
        // was not known yet. Dispose it before it can be adopted as a lane.
        await this._discardUnadoptedSpawn(result?.id);
        return;
      }
      // A routed profile that cannot be resolved fails closed; surface that
      // rather than continuing against whatever session happened to be active.
      if (!result || result.error) {
        throw new Error(result?.error || `Could not start agent "${profileId}"`);
      }

      const meta = result.session || {
        id: result.id,
        label: profileId,
        agent: 'shell',
        assurance: 'L0-native',
        resultInputCapable: false,
        status: 'running',
      };
      this.currentProcessId = result.id;
      this._spawnedIds.add(result.id);
      this._log(`🤖 Agent session: ${meta.label} [${meta.assurance}]`, 'system');
      // The account shell can emit terminal queries (for example DSR) while
      // it boots. Adopt immediately so xterm can answer them and display the
      // bootstrap transcript before we wait for its explicit ready marker.
      this._notifySessionSpawned(meta);
      this._outputCheckpoints.set(result.id, 0);

      if (meta.agent === 'codex' && meta.assurance === 'L1-routed') {
        const waitId = `${this.runId}-w${++this._waitSeq}`;
        this._log(
          `🤖 Waiting for routed Codex account shell (timeout ${ROUTED_CODEX_READY_TIMEOUT_MS} ms)…`,
          'system'
        );
        const ready = await this._waitForSessionSignal({
          sessionId: result.id,
          waitId,
          afterSeq: 0,
          idleMs: 0,
          pattern: ROUTED_CODEX_READY_PATTERN,
          timeoutMs: ROUTED_CODEX_READY_TIMEOUT_MS,
        });
        if (this.aborted) return;
        if (ready?.reason !== 'match') {
          throw new Error(
            `Routed Codex account shell did not report "${ROUTED_CODEX_READY_PATTERN}" `
            + `within ${ROUTED_CODEX_READY_TIMEOUT_MS} ms (${ready?.reason || 'unknown'})`
          );
        }

        const launched = await this._apiClient().sendInput?.({
          id: result.id,
          text: 'codex; exit\r',
        });
        if (this.aborted) return;
        if (!launched) {
          throw new Error('Routed Codex account shell refused the fixed Codex workflow launch command');
        }

        await this._sleep(Number(block.params.settleMs) || 1500);
        return;
      }

      await this._sleep(Number(block.params.settleMs) || 1500);
    },

    /** Send a prompt to one agent lane, or fan out to every lane in this run. */
    async agentSend(block) {
      const target = block.params.profileId;
      const text = block.params.text || '';
      const pressEnter = block.params.pressEnter !== false;
      const expectResult = block.params.expectResult === true;
      const handoffFrom = String(block.params.handoffFrom || '').trim();
      const structured = expectResult || !!handoffFrom;
      const handoffBundle = handoffFrom
        ? this._resultsByProducer.get(handoffFrom)
        : null;
      const sessionIds = target === WORKFLOW_AGENT_TARGET
        ? this._workflowAgentSessions().map(session => session.id)
        : [target ? this._sessionForProfile(target) : this.currentProcessId].filter(Boolean);
      const agentLanes = new Map(
        this._workflowAgentSessions()
          .filter(session => sessionIds.includes(session.id))
          .map(session => [session.id, session])
      );

      if (handoffFrom && !handoffBundle) {
        throw new Error('The selected result is unavailable in this run');
      }
      if (handoffBundle && handoffBundle.status !== 'complete') {
        // The safety rule (partial bundles never reach a downstream agent)
        // would also fire inside composeAgentPrompt, but with a message that
        // blames this Send. Name the interaction instead: which Join produced
        // the partial bundle, its on-incomplete policy, and the missing lanes.
        const policy = this._resultPolicies.get(handoffFrom);
        const missingLanes = handoffBundle.lanes
          .filter(lane => !lane.complete || lane.truncated)
          .map(lane => lane.label);
        throw new Error(
          `Partial result bundles cannot be handed to a downstream agent. `
          + `Result "${handoffBundle.name}" from Join "${handoffFrom}" completed partial `
          + `(missing lanes: ${missingLanes.join(', ') || 'none reported'}) and that Join's `
          + `on-incomplete policy is "${policy?.onIncomplete || 'unknown'}", which let the run `
          + `reach this Send. Set the Join to stop on incomplete, or fix the missing lanes.`
        );
      }
      if (sessionIds.length === 0) {
        throw new Error(target
          ? (target === WORKFLOW_AGENT_TARGET
            ? 'No live workflow agent sessions — add Agent Session blocks first'
            : `No live session for agent profile "${target}" — add an Agent Session block first`)
          : 'No active session to receive input');
      }
      if (structured && sessionIds.some(id => !agentLanes.has(id))) {
        throw new Error(
          'Result publishing and handoff require a result-input-capable workflow Agent Session target'
        );
      }
      const incapableLanes = structured
        ? [...agentLanes.values()].filter(session => session.resultInputCapable !== true)
        : [];
      if (incapableLanes.length) {
        throw new Error(
          `Structured result input is unavailable for ${incapableLanes.map(
            session => session.label || session.id
          ).join(', ')}. Use a routed Codex workflow session or a local profile with one direct agent command.`
        );
      }
      if (expectResult && !pressEnter) {
        throw new Error('Publishing a result requires Enter so the result contract is submitted');
      }
      const api = this._apiClient();
      if (structured && typeof api.sendStructuredInput !== 'function') {
        throw new Error('Structured result input is unavailable in this build');
      }

      const label = target === WORKFLOW_AGENT_TARGET
        ? `${sessionIds.length} workflow agents`
        : (target || 'current session');
      const annotations = [
        handoffFrom ? 'attached result' : '',
        expectResult ? 'publishes at Join' : '',
      ].filter(Boolean);
      this._log(
        `📨 → ${label}: "${text}"${pressEnter ? ' ⏎' : ''}`
        + (annotations.length ? ` [${annotations.join(' · ')}]` : ''),
        'input-echo'
      );

      // Type into independent PTYs concurrently. Promise.allSettled ensures a
      // failure in one lane cannot leave other typing tasks running after this
      // block has already reported an error.
      const sends = await Promise.allSettled(sessionIds.map(async (sessionId, laneIndex) => {
        const session = agentLanes.get(sessionId);
        const resultContract = expectResult
          ? createResultContract({
            token: this._nextResultContractToken(block, laneIndex),
            label: session?.label || `Lane ${laneIndex + 1}`,
          })
          : null;
        const prompt = composeAgentPrompt(text, {
          handoffBundle,
          resultContract,
        });
        let afterSeq = null;
        const result = await this._typeInto({
          sessionId,
          text: prompt,
          pressEnter,
          structured,
          ...(structured ? {
            // Every byte of a generated contract/handoff — paste delimiters,
            // body chunks, and both Enters — crosses the main-owned capability
            // check. There is deliberately no generic send-input fallback.
            send: (id, chunk) => api.sendStructuredInput({ id, text: chunk }),
          } : {}),
          isAborted: () => this.aborted,
          onTyped: async () => {
            afterSeq = await this._rememberOutputCheckpoint(sessionId);
          },
        });
        if (!result?.aborted && agentLanes.has(sessionId)) {
          this._rememberPendingAgentLane(session, {
            afterSeq,
            resultContract,
          });
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
      const resultName = String(block.params.resultName || '').trim();
      const capturesResult = resultName.length > 0;
      const sessions = this._pendingWorkflowAgentSessions();

      if (!capturesResult && !idleMs && !pattern) {
        throw new Error('Join Agents needs an idle duration or output text');
      }
      if (sessions.length === 0) {
        throw new Error('Join Agents has no pending lanes — send a prompt to workflow agents first');
      }
      if (capturesResult) {
        const missingContracts = sessions.filter(session => (
          !session.resultContract || !Number.isInteger(session.resultAfterSeq)
        ));
        if (missingContracts.length) {
          throw new Error(
            'A named Join can only collect lanes whose Send block enabled “Publish at Join”'
          );
        }
      }

      const total = sessions.length;
      let ready = 0;
      let settledCount = 0;
      const readyReasons = new Set(['match', 'idle']);
      const criteria = capturesResult
        ? `explicit result "${resultName}"`
        : [
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
            let afterSeq = capturesResult
              ? session.resultAfterSeq
              : this._outputCheckpoints.get(session.id);
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
              capture: capturesResult ? {
                startMarker: session.resultContract.startMarker,
                endMarker: session.resultContract.endMarker,
                maxBytes: MAX_RESULT_BYTES_PER_LANE,
              } : undefined,
            });
          }
          if (Number.isInteger(result?.outputSeq)) {
            this._outputCheckpoints.set(session.id, result.outputSeq);
          }
          this._pendingAgentIds.delete(session.id);
          this._pendingAgentLanes.delete(session.id);
          settledCount++;
          const laneReady = capturesResult
            ? (
              result?.reason === 'match'
              && result?.capture?.complete === true
              && String(result.capture.text || '').trim() !== ''
            )
            : readyReasons.has(result?.reason);
          const reason = capturesResult && result?.reason === 'match' && !laneReady
            ? 'result-partial'
            : (result?.reason || 'unknown');
          if (laneReady) ready++;
          this._setStatus(`◇ Join ${ready}/${total} ready`);
          this._notifyAgentJoin(block, {
            ready,
            settled: settledCount,
            total,
            session: { id: session.id, label: session.label },
            reason,
          });
          return { session, result, ready: laneReady, reason };
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
      if (capturesResult) {
        const producerBlockId = block.id || `index-${this.currentBlockIndex}`;
        let bundle = normalizeResultBundle({
          producerBlockId,
          name: resultName,
          status: outcomes.every(outcome => outcome.ready) ? 'complete' : 'partial',
          lanes: outcomes.map(({ session, result, ready: laneReady }) => ({
            laneId: session.id,
            ...(session.profileId ? { profileId: session.profileId } : {}),
            ...(session.agent ? { agent: session.agent } : {}),
            ...(session.assurance ? { assurance: session.assurance } : {}),
            label: session.label || session.id,
            text: result?.capture?.text || '',
            complete: !!laneReady,
            truncated: !!(
              result?.capture?.truncatedBefore
              || result?.capture?.truncatedAfter
            ),
          })),
        }, { allowIncomplete: true });
        const stored = await this._storeRunResult(bundle);
        if (stored?.id) {
          bundle = normalizeResultBundle({
            ...bundle,
            resultId: stored.id,
          }, { allowIncomplete: true });
        }
        this._resultsByProducer.set(producerBlockId, bundle);
        // Remember how this Join was configured so a later handoff Send can
        // blame the right block if the bundle turns out to be partial.
        this._resultPolicies.set(producerBlockId, { resultName, onIncomplete });
      }

      const incomplete = outcomes.filter(outcome => !outcome.ready);
      // Incompleteness the block's onIncomplete policy may absorb. "removed"
      // is a manually closed tab reconstructed from captured lane metadata;
      // "replaced" is its legacy synonym from older wait plumbing. "cancelled"
      // stays out: outside an abort it signals an IPC-level fault, not a lane
      // outcome, and must hard-fail the Join.
      const policyControlledReasons = new Set([
        'timeout',
        'exit',
        'result-partial',
        'removed',
        'replaced',
      ]);
      for (const { session, reason, ready: laneReady } of outcomes) {
        this._log(
          `${laneReady ? '◆' : '⚠️'} ${session.label}: ${joinReasonLabel(reason, idleMs, timeoutMs)}`,
          laneReady ? 'system' : 'stderr'
        );
      }

      const invalid = incomplete.filter(({ reason }) => !policyControlledReasons.has(reason));
      if (invalid.length) {
        const detail = invalid
          .map(({ session, reason }) => `${session.label} (${reason || 'unknown'})`)
          .join(', ');
        throw new Error(`Join could not observe every lane: ${detail}`);
      }
      if (incomplete.length && onIncomplete === 'stop') {
        const detail = incomplete
          .map(({ session, reason }) => `${session.label} (${reason || 'unknown'})`)
          .join(', ');
        throw new Error(`Join incomplete — downstream blocks were stopped: ${detail}`);
      }
      if (incomplete.length) {
        this._log(`⚠️ Join incomplete for ${incomplete.length}/${total} lane(s); continuing by block policy`, 'system');
      } else if (capturesResult) {
        this._log(`◆ Result "${resultName}" published from all ${total} lane(s)`, 'system');
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

  _journalOpId(kind, runId = this.runId) {
    const safeKind = String(kind || 'event').replace(/[^A-Za-z0-9_.-]/g, '-');
    return `${runId}-${safeKind}-${++this._journalOpSeq}`;
  }

  async _startJournalBlock(block, index, loopStack) {
    if (!this._journalEnabled) return null;
    const start = this._apiClient().startRunBlock;
    if (!start) throw new Error('Run Journal block tracking is unavailable');
    const visit = await start({
      runId: this.runId,
      opId: this._journalOpId('block-start'),
      block: {
        id: block.id || `index-${index}`,
        index,
        type: block.type,
        iterationPath: (Array.isArray(loopStack) ? loopStack : []).map(frame => ({
          loopBlockId: frame.blockId || `index-${frame.start}`,
          iteration: frame.iter,
          total: frame.total,
        })),
      },
    });
    if (!visit?.visitId) throw new Error('Run Journal did not return a block visit id');
    return visit;
  }

  async _finishJournalBlock(visit, status, reasonCode = null) {
    if (!this._journalEnabled || !visit?.visitId) return null;
    const finish = this._apiClient().finishRunBlock;
    if (!finish) throw new Error('Run Journal block tracking is unavailable');
    return finish({
      runId: this.runId,
      visitId: visit.visitId,
      opId: this._journalOpId('block-finish'),
      status: status === 'stopped' ? 'cancelled' : status,
      reasonCode,
    });
  }

  async _journalMarkerBlock(block, index, loopStack) {
    const visit = await this._startJournalBlock(block, index, loopStack);
    if (this.aborted) {
      if (visit) await this._finishJournalBlock(visit, 'stopped');
      return false;
    }
    if (visit) await this._finishJournalBlock(visit, 'completed');
    return !this.aborted;
  }

  async _finishJournalRun(status, runId = this.runId) {
    const finish = this._apiClient().finishRunJournal;
    if (!finish) throw new Error('Run Journal finalization is unavailable');
    return finish({
      runId,
      opId: this._journalOpId('run-finish', runId),
      status: status === 'stopped' ? 'cancelled' : status,
    });
  }

  async _storeRunResult(bundle) {
    if (!this._journalEnabled) return null;
    const storeResult = this._apiClient().storeRunResult;
    if (!storeResult) throw new Error('Run Journal result storage is unavailable');
    const lanes = bundle.lanes.map(lane => ({
      laneId: lane.laneId,
      ...(lane.profileId ? { profileId: lane.profileId } : {}),
      ...(lane.agent ? { agent: lane.agent } : {}),
      ...(lane.assurance ? { assurance: lane.assurance } : {}),
      label: lane.label,
    }));
    return storeResult({
      runId: this.runId,
      producerBlockId: bundle.producerBlockId,
      visitId: this.currentVisitId,
      name: bundle.name,
      status: bundle.status,
      lanes,
      body: JSON.stringify(bundle),
      opId: this._journalOpId('result-store'),
    });
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

  async _waitForSessionSignal({
    sessionId,
    waitId,
    afterSeq,
    idleMs,
    pattern,
    timeoutMs,
    capture,
  }) {
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
        ...(capture ? { capture } : {}),
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

  async _discardUnadoptedSpawn(id, aliases = []) {
    if (id) {
      try {
        await this._apiClient().killProcess?.({ id });
      } catch (_error) {
        // Stop remains best-effort, matching abort()'s existing cleanup path.
      }
    }
    for (const candidate of new Set([id, ...aliases].filter(Boolean))) {
      this._spawnedIds.delete(candidate);
      this._outputCheckpoints.delete(candidate);
      this._pendingAgentIds.delete(candidate);
      this._pendingAgentLanes.delete(candidate);
      if (this.currentProcessId === candidate) this.currentProcessId = null;
    }
  }

  _pendingWorkflowAgentSessions() {
    return pendingWorkflowAgentSessions(
      this._sessionList(),
      this._spawnedIds,
      this._pendingAgentIds,
      this._pendingAgentLanes
    );
  }

  _rememberPendingAgentLane(session, { afterSeq = null, resultContract = null } = {}) {
    if (!session?.id) return;
    this._pendingAgentIds.add(session.id);
    // Merge into any existing record. A follow-up write without contract
    // options (for example a Send Input "y" between a publishing Send and its
    // named Join) must refresh the lane identity without dropping the
    // previously recorded resultContract/resultAfterSeq.
    const previous = this._pendingAgentLanes.get(session.id) || {};
    this._pendingAgentLanes.set(session.id, {
      ...previous,
      id: session.id,
      label: session.label || previous.label || session.id,
      profileId: session.profileId ?? previous.profileId,
      agent: session.agent ?? previous.agent,
      assurance: session.assurance ?? previous.assurance,
      ...(resultContract ? {
        resultAfterSeq: afterSeq,
        resultContract,
      } : {}),
    });
  }

  _nextResultContractToken(block, laneIndex) {
    const sequence = ++this._resultContractSeq;
    const run = markerTokenPart(this.runId || 'run', 40);
    const producer = markerTokenPart(
      block?.id || `step-${this.currentBlockIndex}`,
      40
    );
    return `r${sequence}:l${laneIndex + 1}:${run}:${producer}`;
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

function markerTokenPart(value, maxLength) {
  const normalized = String(value)
    .replace(/[^A-Za-z0-9._:-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, maxLength);
  return normalized || 'item';
}

function joinReasonLabel(reason, idleMs, timeoutMs) {
  switch (reason) {
    case 'match': return 'completion marker matched';
    case 'idle': return `output idle for ${idleMs} ms`;
    case 'result-partial': return 'explicit result was missing, empty, or truncated';
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
 * Flag agentSend blocks whose attached result comes from a Join Agents block
 * configured with onIncomplete "continue". That combination is a guaranteed
 * failure whenever the Join completes partial: partial bundles are never
 * handed to a downstream agent, so the run would fail at the Send instead of
 * the Join. Pure, like analyzeLoops, so the editor can surface it as a
 * validation banner; the engine also logs it at run start.
 * Returns [{ code, severity, index, blockId, reference, message }].
 */
export function analyzeHandoffPolicies(blocks) {
  const list = Array.isArray(blocks) ? blocks : [];
  const byId = new Map(list.map(block => [block?.id, block]));
  const warnings = [];
  list.forEach((block, index) => {
    if (block?.type !== 'agentSend') return;
    const ref = String(block.params?.handoffFrom || '').trim();
    if (!ref) return;
    const producer = byId.get(ref);
    if (producer?.type !== 'agentJoin') return;
    if (producer.params?.onIncomplete !== 'continue') return;
    const resultName = String(producer.params?.resultName || '').trim() || ref;
    warnings.push({
      code: 'partial-handoff-policy',
      severity: 'warning',
      index,
      blockId: block.id || null,
      reference: ref,
      message: `Step ${index + 1} hands off result "${resultName}" from a Join set to `
        + `"continue on incomplete". If that Join completes partial, this Send is guaranteed `
        + `to fail: partial results are never handed to a downstream agent. Set the Join to `
        + `stop on incomplete, or remove the handoff.`,
    });
  });
  return warnings;
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
