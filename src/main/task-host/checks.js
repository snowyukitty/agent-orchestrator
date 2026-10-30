// Host-observed checks: the host runs each requested npm script itself in the
// task worktree, after the agent's turn, and records what it saw.
//
// This runs repository code that the agent may have changed. A passing check
// is evidence about the tree it ran against, not proof the change is correct;
// the record therefore notes when the script definition differs from base.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { createHash } = require('crypto');

const { showFile } = require('./git');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const CHECK_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_CHECK_OUTPUT_BYTES = 256 * 1024;
const SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,63}$/;

function scriptDefinition(packageJsonText, name) {
  try {
    const scripts = JSON.parse(packageJsonText)?.scripts;
    return scripts && Object.hasOwn(scripts, name) && typeof scripts[name] === 'string'
      ? scripts[name]
      : null;
  } catch (_error) {
    return null;
  }
}

// After a cancelled or timed-out check's job is ended, how long to wait for
// its output to close before giving up on it.
const CLOSE_GRACE_MS = 5_000;

function runProcess(file, args, {
  cwd, timeoutMs, maxOutputBytes, spawnImpl = spawn, signal = null, jobs = null, jobKey = null,
}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    // Decided to skip before anything started: start nothing.
    if (signal?.aborted) {
      resolve({ startedAt, finishedAt: startedAt, exitCode: null, timedOut: false, cancelled: true, notStarted: true, spawnFailed: false, output: Buffer.alloc(0), truncated: false });
      return;
    }
    let child;
    try {
      child = spawnImpl(file, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (_error) {
      resolve({ startedAt, finishedAt: Date.now(), exitCode: null, timedOut: false, cancelled: false, spawnFailed: true, output: Buffer.alloc(0), truncated: false });
      return;
    }
    const chunks = [];
    let size = 0;
    let truncated = false;
    const take = (chunk) => {
      if (size >= maxOutputBytes) { truncated = true; return; }
      const room = maxOutputBytes - size;
      const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
      if (part.length < chunk.length) truncated = true;
      chunks.push(part);
      size += part.length;
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let exited = false;
    let termination = null;
    child.on('exit', () => { exited = true; });
    // The check runs in its own job, so ending it reaches every process it
    // started, including ones that outlived it and still hold its output.
    const owned = jobs && jobKey && child.pid
      ? jobs.adopt(jobKey, child.pid, startedAt).catch(() => ({ adopted: false }))
      : Promise.resolve({ adopted: false });
    const endTree = () => {
      if (settled || termination) return;
      termination = (async () => {
        const adoption = await owned;
        if (adoption.adopted) return { job: true, survivors: await jobs.end(jobKey, 10_000) };
        // Without a job, only a root that has not exited may be ended by pid:
        // Node still holds its handle, so the pid still names it.
        if (!exited) {
          try {
            if (process.platform === 'win32') {
              spawnImpl('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
            } else {
              child.kill('SIGKILL');
            }
          } catch (_error) { /* already gone */ }
        }
        return { job: false, survivors: null };
      })();
      // Bounded even if something still holds the output open.
      termination.then(() => delay(CLOSE_GRACE_MS)).then(() => {
        if (settled) return;
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(null, false);
      });
    };
    const timer = setTimeout(() => { timedOut = true; endTree(); }, timeoutMs);
    const onAbort = () => { cancelled = true; endTree(); };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    const finish = async (code, spawnFailed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      let ended = termination ? await termination : null;
      // A check that finished normally can still have left a background
      // process in its job; end the job on every path before releasing it.
      if (!ended && (await owned).adopted) ended = { job: true, survivors: await jobs.end(jobKey, 10_000), leftovers: true };
      if ((await owned).adopted) await jobs.release(jobKey);
      resolve({
        termination: ended,
        startedAt,
        finishedAt: Date.now(),
        exitCode: typeof code === 'number' ? code : null,
        timedOut,
        cancelled,
        spawnFailed,
        output: Buffer.concat(chunks, size),
        truncated,
      });
    };
    child.on('error', () => finish(null, true));
    child.on('close', code => finish(code, false));
  });
}

/**
 * Run one npm-script check. `tree` is the tree id the worktree held when the
 * check started; `logFile` receives the bounded output privately.
 */
async function runCheck({
  worktree, base, check, tree, logFile, timeoutMs = CHECK_TIMEOUT_MS, spawnImpl, signal = null, jobs = null, jobKey = null,
}) {
  const record = {
    kind: check.kind,
    name: check.name,
    command: `npm run ${check.name}`,
    tree,
    outcome: 'not-run',
    exitCode: null,
    durationMs: null,
    outputBytes: 0,
    outputTruncated: false,
    outputSha256: null,
    definitionChangedFromBase: null,
  };
  if (check.kind !== 'npm-script' || !SCRIPT_NAME.test(check.name)) {
    record.outcome = 'unsupported';
    return record;
  }
  let current = null;
  try { current = fs.readFileSync(path.join(worktree, 'package.json'), 'utf8'); } catch (_error) { /* absent */ }
  const definition = current === null ? null : scriptDefinition(current, check.name);
  if (definition === null) {
    record.outcome = 'unavailable';
    return record;
  }
  const baseText = await showFile(worktree, base, 'package.json');
  record.definitionChangedFromBase = scriptDefinition(baseText || '', check.name) !== definition;
  if (signal?.aborted) {
    // Cancelled while preparing: the repository's script never starts.
    record.outcome = 'cancelled';
    return record;
  }

  // The name is restricted to [A-Za-z0-9:._-], so it cannot carry a cmd.exe
  // metacharacter; npm is a .cmd shim on Windows and needs cmd to run.
  const [file, args] = process.platform === 'win32'
    ? ['cmd.exe', ['/d', '/s', '/c', `npm run ${check.name}`]]
    : ['npm', ['run', check.name]];
  const run = await runProcess(file, args, {
    cwd: worktree, timeoutMs, maxOutputBytes: MAX_CHECK_OUTPUT_BYTES, spawnImpl, signal, jobs, jobKey,
  });
  if (run.notStarted) {
    record.outcome = 'cancelled';
    return record;
  }
  // What ending the check's job left behind.
  if (run.termination) {
    const { job, survivors } = run.termination;
    record.termination = { job, survivors };
  }
  record.startedAt = new Date(run.startedAt).toISOString();
  record.durationMs = run.finishedAt - run.startedAt;
  record.exitCode = run.exitCode;
  record.outputBytes = run.output.length;
  record.outputTruncated = run.truncated;
  record.outputSha256 = createHash('sha256').update(run.output).digest('hex');
  if (logFile) fs.writeFileSync(logFile, run.output);
  if (run.spawnFailed) record.outcome = 'unavailable';
  else if (run.cancelled) record.outcome = 'cancelled';
  else if (run.timedOut) record.outcome = 'timed-out';
  else record.outcome = run.exitCode === 0 ? 'passed' : 'failed';
  return record;
}

/** Compare host-observed outcomes with the agent's claims, by check name. */
function compareCheckClaims(observed, claimed) {
  const byName = new Map();
  for (const check of observed) byName.set(check.name, { name: check.name, host: check.outcome, ai: null });
  for (const claim of claimed || []) {
    const entry = byName.get(claim.name) || { name: claim.name, host: null, ai: null };
    entry.ai = claim.outcome;
    byName.set(claim.name, entry);
  }
  return [...byName.values()].map((entry) => {
    let agreement;
    if (entry.host === null) agreement = 'ai-only';
    else if (entry.ai === null) agreement = 'host-only';
    else agreement = entry.host === entry.ai ? 'agree' : 'disagree';
    return { ...entry, agreement };
  });
}

module.exports = { CHECK_TIMEOUT_MS, MAX_CHECK_OUTPUT_BYTES, compareCheckClaims, runCheck, scriptDefinition };
