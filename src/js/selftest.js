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
import { TEMPLATES } from './templates.js';
import { computeJobTarget, isDue, formatCountdown, DEFAULT_GRACE_MS } from './schedule.js';
import { typeInto } from './typing.js';
import { SessionManager, TARGET_ACTIVE, TARGET_ALL, AGENT_TARGET_PREFIX } from './sessions.js';

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
}
