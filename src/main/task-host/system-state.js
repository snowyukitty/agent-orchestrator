// What the task host knows about the machine at admission: whether its own
// Windows session is unlocked, locked, or not interactive; whether it runs on
// AC power; and the account SID it runs as.
//
// Electron's views are not enough: Chromium caches the lock state and answers
// "unlocked" when its query fails, and reports AC when the power status is
// unknown. A long-lived PowerShell helper (system-state.ps1) asks Windows
// directly (WTSQuerySessionInformation for the host's own session,
// GetSystemPowerStatus, the process token's user SID) every few seconds and
// on every lock or power event. Admission reads the latest answer
// synchronously; an answer that is missing, failed, or older than
// `maxAgeMs` is `unknown`, which admission refuses.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const HELPER = path.join(__dirname, 'system-state.ps1');
const POLL_MS = 5_000;
const MAX_AGE_MS = 15_000;
const READY_TIMEOUT_MS = 20_000;
const SID = /^S-1-\d+(?:-\d+){1,14}$/;

// WTS_CONNECTSTATE_CLASS and WTS_SESSIONSTATE_* values.
const WTS_ACTIVE = 0;
const WTS_DISCONNECTED = 4;
const SESSION_LOCKED = 0;
const SESSION_UNLOCKED = 1;

/** One helper line -> { session, power, sid }. */
function parseObservation(line) {
  const [sessionText = 'error', powerText = 'error', sidText = 'error'] = String(line).trim().split('|');
  let session = 'unknown';
  const fields = sessionText.split(' ').map(Number);
  if (fields.length === 3 && fields.every(Number.isSafeInteger)) {
    const [id, state, flags] = fields;
    if (id === 0) session = 'not-interactive';
    // A disconnected session (RDP dropped, switched away) is treated as locked.
    else if (state === WTS_DISCONNECTED) session = 'locked';
    else if (state === WTS_ACTIVE && flags === SESSION_UNLOCKED) session = 'unlocked';
    else if (state === WTS_ACTIVE && flags === SESSION_LOCKED) session = 'locked';
  }
  const power = { 0: 'battery', 1: 'ac' }[powerText] || 'unknown';
  const sid = SID.test(sidText) ? sidText : null;
  return { session, power, sid };
}

/**
 * @param {object} [deps]
 * @param {function} [deps.spawnHelper] () => child process speaking the helper protocol
 * @param {function} [deps.onChange]    (effective, previous) => void whenever the effective
 *                                      session or power changes, including when an answer
 *                                      ages into unknown because the helper stopped answering
 */
function createSystemObserver({
  spawnHelper = defaultSpawnHelper, onChange = () => {}, pollMs = POLL_MS, maxAgeMs = MAX_AGE_MS,
  now = Date.now, log = () => {},
} = {}) {
  let child = null;
  let buffer = '';
  let latest = null; // { session, power, sid, at }
  let timer = null;
  let stopped = false;
  let waiters = [];
  let reported = null; // the effective state last passed to onChange

  function ensureChild() {
    if (child || stopped) return child;
    try {
      child = spawnHelper();
    } catch (_error) {
      child = null;
      return null;
    }
    buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        latest = { ...parseObservation(line), at: now() };
        for (const resolve of waiters) resolve(true);
        waiters = [];
        report();
      }
      if (buffer.length > 4096) buffer = '';
    });
    child.stderr?.resume();
    child.on('error', () => {});
    child.on('exit', () => {
      // Started again by the next poll; until then answers age into unknown.
      child = null;
      if (!stopped) log('[TaskHost] system-state helper exited');
    });
    child.stdin.on('error', () => {});
    return child;
  }

  function effective() {
    const answer = fresh();
    return { session: answer?.session || 'unknown', power: answer?.power || 'unknown', sid: answer?.sid || null };
  }

  function report() {
    const current = effective();
    if (reported && current.session === reported.session && current.power === reported.power) return;
    const previous = reported;
    reported = current;
    try { onChange(current, previous); } catch (_error) { /* observer callbacks never break polling */ }
  }

  function poll() {
    // An answer that aged out is a change too, even if the helper is silent.
    if (reported) report();
    const current = ensureChild();
    try { current?.stdin.write('q\n'); } catch (_error) { /* restarted next time */ }
  }

  function fresh() {
    return latest && now() - latest.at <= maxAgeMs ? latest : null;
  }

  return {
    /** Start polling; resolves once the first answer arrives or the wait ends. */
    start() {
      stopped = false;
      poll();
      if (!timer) {
        timer = setInterval(poll, pollMs);
        timer.unref?.();
      }
      if (latest) return Promise.resolve(true);
      return new Promise((resolve) => {
        waiters.push(resolve);
        setTimeout(() => resolve(false), READY_TIMEOUT_MS).unref?.();
      });
    },
    /** Ask again now (after a lock, unlock, or power event). */
    refresh() { poll(); },
    session() { return fresh()?.session || 'unknown'; },
    power() { return fresh()?.power || 'unknown'; },
    account() { return fresh()?.sid || null; },
    stop() {
      stopped = true;
      clearInterval(timer);
      timer = null;
      try { child?.stdin.end(); } catch (_error) { /* gone */ }
      try { child?.kill(); } catch (_error) { /* gone */ }
      child = null;
    },
  };
}

function defaultSpawnHelper() {
  // Passed inline: the script may live inside an asar archive, which
  // PowerShell cannot open by path.
  const script = fs.readFileSync(HELPER, 'utf8');
  return spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
  ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
}

module.exports = { createSystemObserver, parseObservation };
