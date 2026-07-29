// ============================================================
// Headless Self-Test
// Deterministic regression suite over the app's pure logic. Runs in the
// renderer under `electron . --self-test` (the page is loaded with
// ?selftest=1) and reports pass/fail to the main process, which turns the
// result into the `npm test` exit code.
//
// Everything exercised here must be side-effect free: no real PTYs, no
// timers, no clock reads. Anything needing "now" takes it as an argument.
// ============================================================

import { ExecutionEngine, analyzeLoops, matchingLoopEnd } from './engine.js';
import { BLOCK_TYPES } from './blocks.js';
import { TEMPLATES } from './templates.js';
import {
  computeJobTarget,
  isDue,
  formatCountdown,
  mergeScheduledWorkflowSources,
  DEFAULT_GRACE_MS,
} from './schedule.js';
import { typeInto } from './typing.js';
import { SessionManager, TARGET_ACTIVE, TARGET_ALL, AGENT_TARGET_PREFIX } from './sessions.js';
import {
  WORKFLOW_AGENT_TARGET,
  pendingWorkflowAgentSessions,
  workflowAgentSessions,
} from './agent-targets.js';
import {
  WORKFLOW_FORMAT_VERSION,
  createRunSnapshot,
  generateWorkflowId,
  loadWorkflowDocument,
  workflowIdForSourceFile,
} from './workflow-document.js';

/**
 * Run every case and return a result summary.
 * @returns {Promise<{ passed: boolean, details: string, failures: string[] }>}
 */
export async function runSelfTest() {
  const failures = [];
  const eq = (name, got, want) => {
    const g = JSON.stringify(got), w = JSON.stringify(want);
    if (g !== w) failures.push(`${name}: got ${g}, expected ${w}`);
  };
  const ok = (name, cond) => {
    if (!cond) failures.push(`${name}: expected truthy`);
  };

  try {
    await testLoops(eq);
    await testTemplates(eq);
    await testSchedule(eq);
    await testTyping(eq, ok);
    await testSessionTargets(eq);
    await testAgentStages(eq, ok);
    await testWorkflowDocuments(eq, ok);
  } catch (err) {
    failures.push(`exception: ${err && err.message ? err.message : err}`);
  }

  const passed = failures.length === 0;
  return {
    passed,
    failures,
    details: passed ? 'all engine self-tests passed' : failures.join('; '),
  };
}

// ── Engine loop control flow ─────────────────────────────────

/** Dry-run a block list and return the executed leaf-block indices. */
async function trace(blocks) {
  const engine = new ExecutionEngine();
  const t = await engine.execute(blocks, '.', { dryRun: true });
  return t.filter(e => e.type !== 'loop' && e.type !== 'loopEnd').map(e => e.index);
}

/** Dry-run a block list and return every onLoopIteration event it emitted. */
async function loopEvents(blocks) {
  const engine = new ExecutionEngine();
  const evs = [];
  engine.onLoopIteration = (idx, iter, total, done) => evs.push([idx, iter, total, !!done]);
  await engine.execute(blocks, '.', { dryRun: true });
  return evs;
}

const L = () => ({ type: 'log', params: { message: 'x' } });

async function testLoops(eq) {
  // A simple loop repeats its single-block body N times.
  eq('simple-loop',
    await trace([L(), { type: 'loop', params: { count: 2 } }, L(), { type: 'loopEnd', params: {} }, L()]),
    [0, 2, 2, 4]);

  // Nested loops multiply (outer 2 × inner 3).
  eq('nested-loop',
    await trace([
      { type: 'loop', params: { count: 2 } }, L(),
      { type: 'loop', params: { count: 3 } }, L(),
      { type: 'loopEnd', params: {} }, { type: 'loopEnd', params: {} }, L(),
    ]),
    [1, 3, 3, 3, 1, 3, 3, 3, 6]);

  // A zero-count loop skips its whole body.
  eq('zero-count-loop',
    await trace([L(), { type: 'loop', params: { count: 0 } }, L(), { type: 'loopEnd', params: {} }, L()]),
    [0, 4]);

  // An unmatched Loop (no End Loop) is skipped, not fatal.
  eq('unmatched-loop',
    await trace([{ type: 'loop', params: { count: 2 } }, L()]),
    [1]);

  // An unmatched End Loop is ignored.
  eq('unmatched-end',
    await trace([{ type: 'loopEnd', params: {} }, L()]),
    [1]);

  // matchingLoopEnd pairs the correct (nested) markers.
  const nested = [
    { type: 'loop' }, { type: 'loop' }, { type: 'loopEnd' }, { type: 'loopEnd' },
  ];
  eq('matching-outer', matchingLoopEnd(nested, 0), 3);
  eq('matching-inner', matchingLoopEnd(nested, 1), 2);

  // analyzeLoops reports structural errors and depths.
  const a = analyzeLoops([{ type: 'loop' }, { type: 'log' }, { type: 'loopEnd' }]);
  eq('analyze-clean-errors', a.errors.length, 0);
  eq('analyze-clean-depths', a.depths, [0, 1, 0]);
  const b = analyzeLoops([{ type: 'loop' }, { type: 'log' }]);
  eq('analyze-open-loop', b.errors.length, 1);
  const c = analyzeLoops([{ type: 'loopEnd' }]);
  eq('analyze-stray-end', c.errors.length, 1);
  eq('analyze-stray-end-index', c.unmatched, [0]);

  // onLoopIteration fires once per iteration plus a final done event.
  eq('loop-events',
    await loopEvents([L(), { type: 'loop', params: { count: 2 } }, L(), { type: 'loopEnd', params: {} }, L()]),
    [[1, 1, 2, false], [1, 2, 2, false], [1, 2, 2, true]]);
}

// ── Shipped templates ────────────────────────────────────────

async function testTemplates(eq) {
  // Every shipped template is structurally sound (balanced loops).
  TEMPLATES.forEach(t => {
    eq(`template-balanced:${t.id}`, analyzeLoops(t.blocks).errors.length, 0);
  });

  eq('agent-wait-defaults', BLOCK_TYPES.agentWait.defaultParams,
    { profileId: '', idleMs: 2000, pattern: '', timeoutMs: 120000 });
  eq('agent-join-defaults', BLOCK_TYPES.agentJoin.defaultParams,
    { idleMs: 2000, pattern: '', timeoutMs: 120000, onIncomplete: 'stop' });

  // Account selections stay portable: starts are blank for local choice and
  // the prompt uses the machine-independent workflow broadcast target.
  const multi = TEMPLATES.find(t => t.id === 'tpl-multi-account');
  eq('multi-account-template-portable-start-profiles',
    multi.blocks.filter(b => b.type === 'agentStart').map(b => b.params.profileId),
    ['', '']);
  eq('multi-account-template-broadcast-target',
    multi.blocks.find(b => b.type === 'agentSend').params.profileId,
    WORKFLOW_AGENT_TARGET);
  eq('multi-account-template-shared-join',
    multi.blocks.filter(b => b.type === 'agentJoin').length, 1);
  eq('multi-account-template-sends-before-join',
    multi.blocks.map(b => b.type),
    ['directory', 'agentStart', 'agentStart', 'agentSend', 'agentJoin', 'log']);
}

// ── Schedule time math ───────────────────────────────────────

async function testSchedule(eq) {
  const GRACE = DEFAULT_GRACE_MS;

  // `once` returns the absolute saved time regardless of `now`.
  const onceDt = '2026-01-15T08:30';
  const onceMs = new Date(onceDt).getTime();
  eq('once-target', computeJobTarget(onceDt, 'once', new Date(2020, 0, 1).getTime(), GRACE), onceMs);
  eq('invalid-target', computeJobTarget('not-a-date', 'once', 0, GRACE), 0);

  // `cron` fires today when upcoming, else exactly +24h tomorrow.
  const cronDt = '2026-01-15T08:30';
  const beforeNow = new Date(2026, 0, 15, 6, 0, 0).getTime();
  const afterNow = new Date(2026, 0, 15, 20, 0, 0).getTime();
  const todayTarget = computeJobTarget(cronDt, 'cron', beforeNow, GRACE);
  const rolledTarget = computeJobTarget(cronDt, 'cron', afterNow, GRACE);
  eq('cron-today', todayTarget, new Date(2026, 0, 15, 8, 30, 0, 0).getTime());
  eq('cron-rolls-24h', rolledTarget - todayTarget, 86_400_000);

  // isDue: at target true, before false, beyond grace false, edge true.
  eq('isdue-at', isDue(1000, 1000, GRACE), true);
  eq('isdue-before', isDue(1000, 999, GRACE), false);
  eq('isdue-stale', isDue(1000, 1000 + GRACE + 1, GRACE), false);
  eq('isdue-edge', isDue(1000, 1000 + GRACE, GRACE), true);
  eq('isdue-invalid', isDue(0, 5000, GRACE), false);

  // formatCountdown: clamps negatives, pads, and prefixes days.
  eq('fmt-zero', formatCountdown(0), '00:00:00');
  eq('fmt-negative', formatCountdown(-5000), '00:00:00');
  eq('fmt-hms', formatCountdown(3_661_000), '01:01:01');
  eq('fmt-days', formatCountdown(90_061_000), '1d 01:01:01');

  const saved = { id: 'shared', name: 'Saved' };
  const dirtyDraft = { id: 'shared', name: 'Unsaved edit' };
  const unsaved = { id: 'draft-only', name: 'Draft only' };
  eq('saved-schedule-wins-dirty-editor-collision',
    mergeScheduledWorkflowSources([saved], dirtyDraft),
    [saved]);
  eq('unsaved-schedule-remains-available-in-memory',
    mergeScheduledWorkflowSources([saved], unsaved),
    [saved, unsaved]);
}

// ── Human-paced typing (shared by the engine and quick-send) ──

async function testTyping(eq, ok) {
  // Characters go one at a time, then two Enters: the first dismisses any
  // autocomplete menu, the second submits.
  const sent = [];
  await typeInto({
    sessionId: 's1',
    text: 'hi',
    send: (id, chunk) => { sent.push([id, chunk]); return Promise.resolve(true); },
    charDelayMs: 0,
  });
  eq('typing-sequence', sent, [['s1', 'h'], ['s1', 'i'], ['s1', '\r'], ['s1', '\r']]);

  // The output checkpoint hook runs after prompt echo, before either Enter.
  const checkpointOrder = [];
  await typeInto({
    sessionId: 's1',
    text: 'x',
    send: (_id, chunk) => { checkpointOrder.push(chunk); return Promise.resolve(true); },
    onTyped: () => { checkpointOrder.push('checkpoint'); },
    charDelayMs: 0,
  });
  eq('typing-checkpoint-before-enter', checkpointOrder, ['x', 'checkpoint', '\r', '\r']);

  // pressEnter:false leaves the prompt unsubmitted.
  const noEnter = [];
  await typeInto({
    sessionId: 's1', text: 'ab', pressEnter: false,
    send: (_id, chunk) => { noEnter.push(chunk); return Promise.resolve(true); },
    charDelayMs: 0,
  });
  eq('typing-no-enter', noEnter, ['a', 'b']);

  // An empty text with pressEnter still submits (a bare "confirm" step).
  const bare = [];
  await typeInto({
    sessionId: 's1', text: '',
    send: (_id, chunk) => { bare.push(chunk); return Promise.resolve(true); },
    charDelayMs: 0,
  });
  eq('typing-empty-submits', bare, ['\r', '\r']);

  // Abort stops mid-word rather than finishing the prompt.
  const aborted = [];
  let calls = 0;
  const result = await typeInto({
    sessionId: 's1', text: 'abcdef',
    send: (_id, chunk) => { aborted.push(chunk); calls++; return Promise.resolve(true); },
    isAborted: () => calls >= 2,
    charDelayMs: 0,
  });
  eq('typing-abort-stops', aborted, ['a', 'b']);
  eq('typing-abort-flag', result.aborted, true);

  // A dead session surfaces as an error instead of silently losing the text.
  let threw = false;
  try {
    await typeInto({ sessionId: 's1', text: 'x', send: () => Promise.resolve(false), charDelayMs: 0 });
  } catch (_e) { threw = true; }
  ok('typing-dead-session-throws', threw);

  let noTarget = false;
  try {
    await typeInto({ sessionId: null, text: 'x', send: () => Promise.resolve(true) });
  } catch (_e) { noTarget = true; }
  ok('typing-no-session-throws', noTarget);
}

// ── Quick-send target resolution ─────────────────────────────

async function testSessionTargets(eq) {
  const manager = new SessionManager({ api: {} });
  // Seed the registry directly: resolveTargets is pure over session metadata,
  // and building real xterms here would need a laid-out DOM.
  const seed = (id, agent, status = 'running') => {
    manager._sessions.set(id, { meta: { id, agent, status, label: id }, term: null, fitAddon: null, el: null });
  };
  seed('s-claude-work', 'claude');
  seed('s-claude-personal', 'claude');
  seed('s-codex-a', 'codex');
  seed('s-dead', 'claude', 'exited');
  manager._activeId = 's-codex-a';

  eq('target-active', manager.resolveTargets(TARGET_ACTIVE), ['s-codex-a']);
  eq('target-default-is-active', manager.resolveTargets(), ['s-codex-a']);
  eq('target-explicit-id', manager.resolveTargets('s-claude-work'), ['s-claude-work']);

  // Fan-out by agent hits every live account of that agent.
  eq('target-by-agent', manager.resolveTargets(`${AGENT_TARGET_PREFIX}claude`),
    ['s-claude-work', 's-claude-personal']);
  eq('target-by-agent-unknown', manager.resolveTargets(`${AGENT_TARGET_PREFIX}gemini`), []);

  eq('target-all', manager.resolveTargets(TARGET_ALL),
    ['s-claude-work', 's-claude-personal', 's-codex-a']);

  // Exited sessions are never targeted — input there would vanish silently.
  eq('target-skips-exited', manager.resolveTargets('s-dead'), []);
  eq('target-unknown-id', manager.resolveTargets('s-nope'), []);

  // With the active session gone, "current" resolves to nothing rather than
  // guessing at another account.
  manager._activeId = 's-dead';
  eq('target-active-exited', manager.resolveTargets(TARGET_ACTIVE), []);
  manager._activeId = null;
  eq('target-active-none', manager.resolveTargets(TARGET_ACTIVE), []);

  // Multi-target typing starts every independent PTY before any lane finishes.
  const starts = [];
  const releases = [];
  const concurrent = new SessionManager({
    api: {},
    typeIntoFn: ({ sessionId }) => new Promise(resolve => {
      starts.push(sessionId);
      releases.push(() => resolve({ sent: true, aborted: false }));
    }),
  });
  const add = (id, label) => {
    concurrent._sessions.set(id, {
      meta: { id, agent: 'claude', status: 'running', label },
      term: null, fitAddon: null, el: null,
    });
  };
  add('lane-a', 'Lane A');
  add('lane-b', 'Lane B');
  const sending = concurrent.sendTo(TARGET_ALL, 'hello');
  await Promise.resolve();
  eq('broadcast-starts-concurrently', starts, ['lane-a', 'lane-b']);
  releases.forEach(release => release());
  eq('broadcast-preserves-target-order', await sending, ['Lane A', 'Lane B']);
}

// ── Signal-aware team stages ─────────────────────────────────

async function testAgentStages(eq, ok) {
  const sessions = [
    { id: 'lane-a', profileId: 'claude-work', label: 'Claude · work', status: 'running' },
    { id: 'lane-b', profileId: 'codex:build', label: 'Codex · build', status: 'running' },
    { id: 'shell', profileId: null, label: 'Shell', status: 'running' },
    { id: 'dead', profileId: 'claude-old', label: 'Old', status: 'exited' },
  ];
  const spawned = new Set(['lane-a', 'lane-b', 'shell', 'dead', 'gone']);
  eq('workflow-agent-targets',
    workflowAgentSessions(sessions, spawned).map(session => session.id),
    ['lane-a', 'lane-b']);
  eq('pending-workflow-agent-targets',
    pendingWorkflowAgentSessions(
      sessions,
      spawned,
      new Set(['lane-b', 'shell', 'dead', 'gone']),
      new Map([['gone', { id: 'gone', profileId: 'claude-gone', label: 'Gone' }]])
    ).map(session => [session.id, session.status]),
    [['lane-b', 'running'], ['dead', 'exited'], ['gone', 'removed']]);

  // One Send block fans out concurrently and checkpoints every lane before
  // submission, making both lanes eligible for the next Join Agents block.
  const sendStarts = [];
  const sendReleases = [];
  let sequence = 10;
  const sendEngine = new ExecutionEngine({
    getSessions: () => sessions,
    api: {
      sessionCheckpoint: async () => ({ outputSeq: ++sequence }),
    },
    typeIntoFn: ({ sessionId, onTyped }) => new Promise(resolve => {
      sendStarts.push(sessionId);
      sendReleases.push(async () => {
        await onTyped();
        resolve({ sent: true, aborted: false });
      });
    }),
  });
  sendEngine.runId = 'run-send';
  sendEngine._spawnedIds = spawned;
  const fanOut = sendEngine._executeBlock({
    id: 'send-all',
    type: 'agentSend',
    params: { profileId: WORKFLOW_AGENT_TARGET, text: 'work', pressEnter: true },
  });
  await Promise.resolve();
  eq('workflow-send-starts-all-lanes', sendStarts, ['lane-a', 'lane-b']);
  await Promise.all(sendReleases.map(release => release()));
  await fanOut;
  eq('workflow-send-marks-pending',
    [...sendEngine._pendingAgentIds].sort(),
    ['lane-a', 'lane-b']);
  eq('workflow-send-captures-pending-identities',
    [...sendEngine._pendingAgentLanes.keys()].sort(),
    ['lane-a', 'lane-b']);

  // The fan-in barrier registers both waits before either result is released,
  // then reports deterministic N/M progress and consumes the pending signals.
  const waitStarts = [];
  const waitReleases = new Map();
  const progress = [];
  const joinEngine = new ExecutionEngine({
    getSessions: () => sessions,
    api: {
      waitForSession: params => new Promise(resolve => {
        waitStarts.push(params.id);
        waitReleases.set(params.id, resolve);
      }),
      cancelSessionWait: async () => true,
    },
  });
  joinEngine.runId = 'run-join';
  joinEngine.currentBlockIndex = 5;
  joinEngine._spawnedIds = spawned;
  joinEngine._pendingAgentIds = new Set(['lane-a', 'lane-b']);
  joinEngine._outputCheckpoints = new Map([['lane-a', 11], ['lane-b', 12]]);
  joinEngine.onAgentJoinProgress = event => {
    progress.push([
      event.ready,
      event.settled,
      event.total,
      event.session?.id || null,
      event.reason,
    ]);
  };
  const joining = joinEngine._executeBlock({
    id: 'join-team',
    type: 'agentJoin',
    params: { idleMs: 100, pattern: 'READY', timeoutMs: 500, onIncomplete: 'stop' },
  });
  await Promise.resolve();
  eq('join-registers-all-waits', waitStarts, ['lane-a', 'lane-b']);
  waitReleases.get('lane-b')({ reason: 'match', outputSeq: 20 });
  await Promise.resolve();
  waitReleases.get('lane-a')({ reason: 'idle', outputSeq: 21 });
  await joining;
  eq('join-progress',
    progress,
    [
      [0, 0, 2, null, 'waiting'],
      [1, 1, 2, 'lane-b', 'match'],
      [2, 2, 2, 'lane-a', 'idle'],
    ]);
  eq('join-consumes-pending-signals', [...joinEngine._pendingAgentIds], []);

  const strictEngine = new ExecutionEngine({
    getSessions: () => sessions,
    api: {
      waitForSession: async ({ id }) => ({
        reason: id === 'lane-a' ? 'match' : 'timeout',
        outputSeq: 30,
      }),
      cancelSessionWait: async () => true,
    },
  });
  strictEngine.runId = 'run-strict';
  strictEngine._spawnedIds = spawned;
  strictEngine._pendingAgentIds = new Set(['lane-a', 'lane-b']);
  strictEngine._outputCheckpoints = new Map([['lane-a', 1], ['lane-b', 1]]);
  const strictProgress = [];
  strictEngine.onAgentJoinProgress = event => {
    strictProgress.push([event.ready, event.settled, event.total, event.reason]);
  };
  let stoppedDownstream = false;
  try {
    await strictEngine._executeBlock({
      id: 'strict-join',
      type: 'agentJoin',
      params: { idleMs: 0, pattern: 'READY', timeoutMs: 100, onIncomplete: 'stop' },
    });
  } catch (error) {
    stoppedDownstream = /downstream blocks were stopped/.test(error.message);
  }
  ok('strict-join-stops-on-timeout', stoppedDownstream);
  eq('timeout-never-counts-as-ready',
    strictProgress.at(-1).slice(0, 3),
    [1, 2, 2]);

  // Pending membership outlives a process. An exited lane still participates
  // in the barrier and follows the block's incomplete policy.
  const exitedEngine = new ExecutionEngine({
    getSessions: () => sessions,
    api: {
      waitForSession: async () => ({ reason: 'exit', outputSeq: 41 }),
      cancelSessionWait: async () => true,
    },
  });
  exitedEngine.runId = 'run-exited';
  exitedEngine._spawnedIds = spawned;
  exitedEngine._pendingAgentIds = new Set(['dead']);
  exitedEngine._outputCheckpoints = new Map([['dead', 1]]);
  let exitedStopped = false;
  try {
    await exitedEngine._executeBlock({
      id: 'exited-join',
      type: 'agentJoin',
      params: { idleMs: 1, pattern: '', timeoutMs: 100, onIncomplete: 'stop' },
    });
  } catch (error) {
    exitedStopped = /downstream blocks were stopped/.test(error.message);
  }
  ok('exited-pending-lane-stops-strict-join', exitedStopped);

  // A removed lane has lost its observation capability, so continue mode may
  // not turn it into a policy-controlled timeout or exit.
  let removedWaitCalls = 0;
  const removedEngine = new ExecutionEngine({
    getSessions: () => sessions,
    api: {
      waitForSession: async () => { removedWaitCalls++; return { reason: 'idle' }; },
      cancelSessionWait: async () => true,
    },
  });
  removedEngine.runId = 'run-removed';
  removedEngine._spawnedIds = spawned;
  removedEngine._pendingAgentIds = new Set(['gone']);
  removedEngine._pendingAgentLanes = new Map([
    ['gone', { id: 'gone', profileId: 'claude-gone', label: 'Gone' }],
  ]);
  let removedRejected = false;
  try {
    await removedEngine._executeBlock({
      id: 'removed-join',
      type: 'agentJoin',
      params: { idleMs: 1, pattern: '', timeoutMs: 100, onIncomplete: 'continue' },
    });
  } catch (error) {
    removedRejected = /could not observe every lane/.test(error.message);
  }
  ok('removed-pending-lane-is-never-policy-continued', removedRejected);
  eq('removed-pending-lane-does-not-register-main-wait', removedWaitCalls, 0);

  const cancelledEngine = new ExecutionEngine({
    getSessions: () => sessions,
    api: {
      waitForSession: async () => ({ reason: 'cancelled', outputSeq: 40 }),
      cancelSessionWait: async () => true,
    },
  });
  cancelledEngine.runId = 'run-cancelled';
  cancelledEngine._spawnedIds = spawned;
  cancelledEngine._pendingAgentIds = new Set(['lane-a']);
  cancelledEngine._outputCheckpoints = new Map([['lane-a', 1]]);
  let cancelledRejected = false;
  try {
    await cancelledEngine._executeBlock({
      id: 'cancelled-join',
      type: 'agentJoin',
      params: { idleMs: 1, pattern: '', timeoutMs: 100, onIncomplete: 'continue' },
    });
  } catch (error) {
    cancelledRejected = /could not observe every lane/.test(error.message);
  }
  ok('join-cancellation-is-never-policy-continued', cancelledRejected);
}

// ── Versioned workflow documents and immutable run plans ─────

async function testWorkflowDocuments(eq, ok) {
  const legacy = {
    id: 'legacy',
    name: 'Legacy',
    defaultDirectory: '.',
    blocks: [{ id: 'same', type: 'log', params: { message: 'before' } }],
  };
  const loaded = loadWorkflowDocument(legacy);
  eq('legacy-workflow-migrates-version', loaded.document.formatVersion, WORKFLOW_FORMAT_VERSION);
  eq('legacy-workflow-migrated-flag', loaded.migrated, true);
  eq('legacy-workflow-keeps-block', loaded.document.blocks[0].params.message, 'before');

  const duplicate = loadWorkflowDocument({
    id: 'dupes',
    blocks: [
      { id: 'same', type: 'log', params: { message: 'a' } },
      { id: 'same', type: 'log', params: { message: 'b' } },
    ],
  });
  ok('duplicate-block-ids-repaired',
    duplicate.document.blocks[0].id !== duplicate.document.blocks[1].id);

  let futureRejected = false;
  try {
    loadWorkflowDocument({ formatVersion: WORKFLOW_FORMAT_VERSION + 1, blocks: [] });
  } catch (error) {
    futureRejected = error.code === 'future-version';
  }
  ok('future-workflow-rejected-losslessly', futureRejected);

  let unknownRejected = false;
  try {
    loadWorkflowDocument({ formatVersion: WORKFLOW_FORMAT_VERSION, blocks: [{ type: 'futureBlock' }] });
  } catch (error) {
    unknownRejected = error.code === 'unknown-block';
  }
  ok('unknown-block-rejected-losslessly', unknownRejected);

  for (const [label, value] of [
    ['null', null],
    ['array', []],
    ['string', 'workflow'],
  ]) {
    let rejected = false;
    try {
      loadWorkflowDocument(value);
    } catch (error) {
      rejected = error.code === 'invalid-root';
    }
    ok(`non-object-workflow-root-rejected:${label}`, rejected);
  }

  let malformedParamsRejected = false;
  try {
    loadWorkflowDocument({
      blocks: [{ type: 'log', params: ['message'] }],
    });
  } catch (error) {
    malformedParamsRejected = error.code === 'invalid-params';
  }
  ok('malformed-block-params-rejected', malformedParamsRejected);

  for (const [label, fixture] of [
    ['workflow', { blocks: [], futureMetadata: true }],
    ['block', { blocks: [{ type: 'log', extra: true, params: {} }] }],
    ['params', { blocks: [{ type: 'log', params: { message: 'ok', futureParam: true } }] }],
  ]) {
    let rejected = false;
    try {
      loadWorkflowDocument(fixture);
    } catch (error) {
      rejected = error.code === 'unknown-field';
    }
    ok(`unknown-data-rejected-without-dropping:${label}`, rejected);
  }

  for (const inheritedName of ['constructor', 'toString', '__proto__']) {
    let rejected = false;
    try {
      loadWorkflowDocument({ blocks: [{ type: inheritedName, params: {} }] });
    } catch (error) {
      rejected = error.code === 'unknown-block';
    }
    ok(`prototype-block-type-rejected:${inheritedName}`, rejected);
  }

  const sameMillisecondIds = [generateWorkflowId(1234), generateWorkflowId(1234)];
  ok('workflow-id-generator-does-not-collide-within-one-ms',
    sameMillisecondIds[0] !== sameMillisecondIds[1]);
  eq('legacy-file-id-is-stable-across-refreshes',
    loadWorkflowDocument({ file: 'legacy-team.json', blocks: [] }).document.id,
    workflowIdForSourceFile('legacy-team.json'));
  ok('different-legacy-files-do-not-collapse-into-one-schedule',
    workflowIdForSourceFile('legacy-a.json') !== workflowIdForSourceFile('legacy-b.json'));

  const snapshot = createRunSnapshot(loaded.document);
  loaded.document.blocks[0].params.message = 'after';
  eq('run-snapshot-is-immutable-copy', snapshot.blocks[0].params.message, 'before');
  ok('run-snapshot-deep-frozen',
    Object.isFrozen(snapshot) && Object.isFrozen(snapshot.blocks[0].params));
}
