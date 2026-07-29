// ============================================================
// Scheduling — pure time math
// Extracted from the app so the trigger/countdown logic can be unit-tested
// deterministically (it takes `now` as an argument instead of reading the
// clock). No DOM or Electron dependencies live here.
// ============================================================

export const DEFAULT_GRACE_MS = 5 * 60 * 1000; // tolerate a tick up to 5 min late
const DAY_MS = 86_400_000;

/**
 * Next trigger timestamp (ms) for a scheduled job, or 0 if its time is invalid.
 *   • once → the absolute saved datetime.
 *   • cron → the same clock time, today if still upcoming (within grace),
 *            otherwise rolled forward exactly 24h to tomorrow.
 */
export function computeJobTarget(datetime, mode, now, graceMs = DEFAULT_GRACE_MS) {
  const base = new Date(datetime).getTime();
  if (isNaN(base)) return 0;

  if (mode === 'cron') {
    const d = new Date(datetime);
    const next = new Date(now);
    next.setHours(d.getHours(), d.getMinutes(), d.getSeconds() || 0, 0);
    let t = next.getTime();
    if (t < now - graceMs) t += DAY_MS; // today's window passed → tomorrow
    return t;
  }

  return base; // once
}

/**
 * True when a job is due now: at or past its target, but not so far past that
 * it's stale (so a late/throttled tick still fires, but an ancient schedule
 * doesn't fire on app load).
 */
export function isDue(target, now, graceMs = DEFAULT_GRACE_MS) {
  return target > 0 && now >= target && (now - target) <= graceMs;
}

/** Format a millisecond duration as `HH:MM:SS`, prefixed with `Nd ` past a day. */
export function formatCountdown(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const p = n => String(n).padStart(2, '0');
  return d > 0 ? `${d}d ${p(h)}:${p(m)}:${p(sec)}` : `${p(h)}:${p(m)}:${p(sec)}`;
}

/**
 * Merge persisted schedules with the editor draft.
 *
 * Persisted data wins an id collision: an unsaved edit must never change what
 * an already-saved schedule will execute. A genuinely unsaved workflow still
 * participates while the app remains open.
 */
export function mergeScheduledWorkflowSources(diskWorkflows, currentWorkflow) {
  const map = new Map();
  for (const workflow of (Array.isArray(diskWorkflows) ? diskWorkflows : [])) {
    if (!workflow?.id || map.has(workflow.id)) continue;
    map.set(workflow.id, workflow);
  }
  if (currentWorkflow?.id && !map.has(currentWorkflow.id)) {
    map.set(currentWorkflow.id, currentWorkflow);
  }
  return [...map.values()];
}
