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
  } catch (err) {
    failures.push(`exception: ${err && err.message ? err.message : err}`);
  }

  // `ok` is part of the shared helper surface; reference it so future cases
  // can use it without an unused-binding surprise.
  void ok;

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
