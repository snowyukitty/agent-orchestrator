// Process ownership through Windows Job Objects.
//
// Root exit alone does not prove a provider is gone: a routed launcher or the
// provider itself can leave descendants that keep writing to the worktree
// while evidence is frozen. Reasoning about parent pids and creation times
// cannot settle this soundly (pids are reused, a PTY releases its handle
// before it reports the exit, and the system clock can move backwards), so
// the host lets Windows keep the membership instead.
//
// Right after a provider or a host check is spawned, a long-lived helper
// (process-jobs.ps1) opens the process, checks it was created after the spawn
// began, and puts it in a new job; children it started in the meantime are
// adopted too. Everything it starts afterwards joins the job by itself,
// detached processes included. Ending the job terminates all of them, and the
// job's own count says whether anything is left. The helper keeps the root's
// handle open, so its pid is never reused while the job exists.
//
// Without the helper (another platform, or it fails) nothing is adopted, and
// a collection that depended on it is not stable.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

const HELPER = path.join(__dirname, 'process-jobs.ps1');
const REPLY_TIMEOUT_MS = 30_000;
// Creation stamps are coarser than Date.now(); allow for the difference.
const CREATION_SLACK_MS = 50;
const KEY = /^[A-Za-z0-9:._-]{1,128}$/;

/** Milliseconds since the epoch as a Windows FILETIME, exactly. */
function toFiletime(ms) {
  return ((BigInt(Math.floor(ms)) + 11_644_473_600_000n) * 10_000n).toString();
}

/**
 * @param {object} [deps]
 * @param {function} [deps.spawnHelper] () => child process speaking the helper protocol
 */
function createProcessJobs({ spawnHelper = defaultSpawnHelper, log = () => {} } = {}) {
  let child = null;
  let next = 0;
  const pending = new Map();

  function failAll() {
    for (const { resolve, timer } of pending.values()) {
      clearTimeout(timer);
      resolve(null);
    }
    pending.clear();
  }

  function ensureChild() {
    if (child) return child;
    try {
      child = spawnHelper();
    } catch (_error) {
      child = null;
      return null;
    }
    const current = child;
    readline.createInterface({ input: current.stdout }).on('line', (line) => {
      const [id, ...rest] = line.trim().split(' ');
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      clearTimeout(entry.timer);
      entry.resolve(rest);
    });
    current.stderr?.resume();
    current.on('error', () => {});
    current.stdin.on('error', () => {});
    current.on('exit', () => {
      if (child === current) child = null;
      // Jobs it held are gone with it; their processes keep running unowned.
      failAll();
      log('[TaskHost] process-jobs helper exited');
    });
    return current;
  }

  /** One request; resolves to the reply's words, or null on any failure. */
  function ask(words) {
    const current = ensureChild();
    if (!current) return Promise.resolve(null);
    const id = String(++next);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve(null);
      }, REPLY_TIMEOUT_MS);
      timer.unref?.();
      pending.set(id, { resolve, timer });
      try {
        current.stdin.write(`${id} ${words.join(' ')}\n`);
      } catch (_error) {
        pending.delete(id);
        clearTimeout(timer);
        resolve(null);
      }
    });
  }

  const ok = reply => Array.isArray(reply) && reply[0] === 'ok';
  const count = (reply) => {
    const value = ok(reply) ? Number(reply[1]) : NaN;
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  };

  return {
    /**
     * Start the helper and wait until it answers. Adoption must follow a spawn
     * within milliseconds: a provider that has already started children by
     * then may have put them in jobs of their own, which no longer nest.
     */
    async start() {
      const reply = await ask(['ping']);
      return ok(reply);
    },
    /**
     * Put the process `pid`, spawned at or after `spawnedAtMs`, and anything
     * it already started, in a new job named `key`.
     */
    async adopt(key, pid, spawnedAtMs) {
      if (!KEY.test(key) || !Number.isSafeInteger(pid) || pid <= 0) return { adopted: false, reason: 'invalid' };
      const reply = await ask(['adopt', key, String(pid), toFiletime(spawnedAtMs - CREATION_SLACK_MS)]);
      if (!ok(reply)) return { adopted: false, reason: reply?.[1] || 'helper-unavailable' };
      return { adopted: true, childrenAdopted: Number(reply[2]) || 0 };
    },
    /** Live processes in the job, or null when unknown. */
    async active(key) {
      return count(await ask(['active', key]));
    },
    /**
     * Live children of live members that are outside the job: their count,
     * or null when unknown, and their executable names.
     */
    async escapes(key) {
      const reply = await ask(['escapes', key]);
      const found = count(reply);
      return {
        count: found,
        names: found ? String(reply[2] || '').split(',').filter(name => /^[A-Za-z0-9._-]{1,64}$/.test(name)) : [],
      };
    },
    /** Terminate everything in the job; the live count left after `waitMs`, or null. */
    async end(key, waitMs = 10_000) {
      return count(await ask(['end', key, String(Math.max(0, Math.floor(waitMs)))]));
    },
    async release(key) {
      await ask(['release', key]);
    },
    stop() {
      try { child?.stdin.end(); } catch (_error) { /* gone */ }
      try { child?.kill(); } catch (_error) { /* gone */ }
      child = null;
      failAll();
    },
  };
}

function defaultSpawnHelper() {
  if (process.platform !== 'win32') throw new Error('job objects are Windows-only');
  // Read here, not run by path: the script may live inside an asar archive.
  const script = fs.readFileSync(HELPER, 'utf8');
  // The script travels in the environment: encoded on the command line it
  // would exceed the 32K command-line limit.
  const bootstrap = "Invoke-Expression ([Environment]::GetEnvironmentVariable('AO_TASK_HOST_JOBS_SCRIPT'))";
  return spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', Buffer.from(bootstrap, 'utf16le').toString('base64'),
  ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, AO_TASK_HOST_JOBS_SCRIPT: script } });
}

module.exports = { createProcessJobs, toFiletime };
