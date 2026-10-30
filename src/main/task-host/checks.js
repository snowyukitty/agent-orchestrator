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

function runProcess(file, args, { cwd, timeoutMs, maxOutputBytes, spawnImpl = spawn }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let child;
    try {
      child = spawnImpl(file, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (_error) {
      resolve({ startedAt, finishedAt: Date.now(), exitCode: null, timedOut: false, spawnFailed: true, output: Buffer.alloc(0), truncated: false });
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
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform === 'win32') {
          spawnImpl('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        } else {
          child.kill('SIGKILL');
        }
      } catch (_error) { /* already gone */ }
    }, timeoutMs);
    let settled = false;
    const finish = (code, spawnFailed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        startedAt,
        finishedAt: Date.now(),
        exitCode: typeof code === 'number' ? code : null,
        timedOut,
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
async function runCheck({ worktree, base, check, tree, logFile, timeoutMs = CHECK_TIMEOUT_MS, spawnImpl }) {
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

  // The name is restricted to [A-Za-z0-9:._-], so it cannot carry a cmd.exe
  // metacharacter; npm is a .cmd shim on Windows and needs cmd to run.
  const [file, args] = process.platform === 'win32'
    ? ['cmd.exe', ['/d', '/s', '/c', `npm run ${check.name}`]]
    : ['npm', ['run', check.name]];
  const run = await runProcess(file, args, {
    cwd: worktree, timeoutMs, maxOutputBytes: MAX_CHECK_OUTPUT_BYTES, spawnImpl,
  });
  record.startedAt = new Date(run.startedAt).toISOString();
  record.durationMs = run.finishedAt - run.startedAt;
  record.exitCode = run.exitCode;
  record.outputBytes = run.output.length;
  record.outputTruncated = run.truncated;
  record.outputSha256 = createHash('sha256').update(run.output).digest('hex');
  if (logFile) fs.writeFileSync(logFile, run.output);
  if (run.spawnFailed) record.outcome = 'unavailable';
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
