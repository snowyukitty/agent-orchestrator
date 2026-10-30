// Process ownership at the collection boundary.
//
// Root exit alone does not prove a provider is gone: a routed launcher or the
// provider itself can leave descendants that keep writing to the worktree
// while evidence is frozen. Before the host ends a task, it snapshots the
// root's descendants; afterwards it requires that none of them, and nothing
// they started, is still alive.
//
// A process is identified by (pid, creation time). Parentage is proven by
// time, never assumed from a parent pid alone, because Windows reuses pids:
// a listed process belongs to the task only if its parent pid names an
// anchor and it was created while that anchor was known to be alive (from
// its creation to `lastSeen`). A child created after its anchor might have
// exited, but before the anchor was seen to be gone (`goneBy`), cannot be
// attributed either way: it is `unresolved`, never signalled, and keeps the
// collection unstable. A child of a live process that reused the anchor's
// pid belongs to that process.
//
// Windows does not reuse a pid while a handle to the process is open. The
// PTY and Node hold a handle to the processes they spawn until they report
// the exit, so a root is known alive from its creation until its exit was
// observed.

const { execFile } = require('child_process');

const LIST_TIMEOUT_MS = 15_000;
const SETTLE_POLL_MS = 500;

const WINDOWS_LIST_COMMAND = [
  "$ErrorActionPreference = 'Stop'",
  'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate | ForEach-Object {',
  // FILETIME in 10 microsecond units: CIM reports creation to the microsecond,
  // and the value stays a safe integer for JavaScript.
  "  '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $(if ($_.CreationDate) { [math]::Floor($_.CreationDate.ToFileTimeUtc() / 100) } else { 0 })",
  '}',
].join('\n');

function run(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: LIST_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

/** Every live process as { pid, ppid, created } (created is an opaque, ordered number). */
async function listProcesses() {
  if (process.platform === 'win32') {
    const stdout = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_LIST_COMMAND]);
    return parseList(stdout);
  }
  // etimes is elapsed seconds; creation order is its negation.
  const stdout = await run('ps', ['-A', '-o', 'pid=,ppid=,etimes=']);
  const now = Math.floor(Date.now() / 1000);
  return parseList(stdout).map(entry => ({ ...entry, created: now - entry.created }));
}

function parseList(stdout) {
  const out = [];
  for (const line of String(stdout).split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length !== 3) continue;
    const [pid, ppid, created] = parts.map(Number);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid) || !Number.isSafeInteger(created)) continue;
    out.push({ pid, ppid, created });
  }
  if (!out.length) throw new Error('process list was empty');
  return out;
}

const key = entry => `${entry.pid}:${entry.created}`;

/** Milliseconds since the epoch, in the units `created` uses. */
function toCreated(ms) {
  return process.platform === 'win32'
    ? Math.floor((ms + 11_644_473_600_000) * 100) // FILETIME / 100
    : Math.floor(ms / 1000);
}

/**
 * Sort one listing against the known anchors.
 * @param {object[]} processes  { pid, ppid, created }
 * @param {object[]} anchors    { pid, created, lastSeen, goneBy? }
 * @returns {{ found: object[], unresolved: object[] }} live members, and live
 *   processes whose parentage cannot be established
 */
function classify(processes, anchors) {
  const live = new Map(processes.map(entry => [entry.pid, entry]));
  const byPid = new Map();
  const add = (identity) => {
    const list = byPid.get(identity.pid) || [];
    list.push(identity);
    byPid.set(identity.pid, list);
  };
  for (const anchor of anchors) add(anchor);
  const found = new Map();
  const unresolved = new Map();
  for (const entry of processes) {
    if ((byPid.get(entry.pid) || []).some(identity => !identity.unresolved && identity.created === entry.created)) {
      found.set(key(entry), entry);
      add({ pid: entry.pid, created: entry.created, lastSeen: Infinity });
    }
  }
  // Walk children until no new process is placed; each pass is linear.
  for (let grew = true; grew;) {
    grew = false;
    for (const entry of processes) {
      const id = key(entry);
      if (found.has(id) || unresolved.has(id)) continue;
      const parents = byPid.get(entry.ppid);
      if (!parents) continue;
      const whileAlive = parent => parent.created <= entry.created && entry.created <= parent.lastSeen;
      if (parents.some(parent => !parent.unresolved && whileAlive(parent))) {
        found.set(id, entry);
        add({ pid: entry.pid, created: entry.created, lastSeen: Infinity });
        grew = true;
        continue;
      }
      const holder = live.get(entry.ppid);
      const holderIsOurs = holder && parents.some(parent => parent.created === holder.created);
      if (holder && !holderIsOurs && holder.created <= entry.created) continue; // the replacement's child
      const maybe = parent => parent.created <= entry.created &&
        (parent.goneBy === undefined || entry.created <= parent.goneBy);
      if (parents.some(maybe)) {
        unresolved.set(id, entry);
        add({ pid: entry.pid, created: entry.created, lastSeen: Infinity, unresolved: true });
        grew = true;
      }
    }
  }
  return { found: [...found.values()], unresolved: [...unresolved.values()] };
}

/**
 * @param {object} deps
 * @param {function} [deps.list]     () => Promise<process entries>
 * @param {function} [deps.killPid]  (pid) => void, ends that one process (never a tree:
 *                                     the walk here decides what belongs to the task)
 * @param {function} [deps.now]      () => milliseconds since the epoch
 */
function createProcessTree({ list = listProcesses, killPid, delay, now = Date.now } = {}) {
  const wait = delay || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const clock = () => toCreated(now());
  return {
    toCreated,

    /** The live process with this pid, as an anchor, or null. */
    async identify(pid) {
      try {
        const startedAt = clock();
        const entry = (await list()).find(candidate => candidate.pid === pid);
        return entry ? { ...entry, lastSeen: startedAt } : null;
      } catch (_error) {
        return null;
      }
    },

    /** The live members under `anchors`, as anchors, or null when unobservable. */
    async members(anchors) {
      try {
        const startedAt = clock();
        return classify(await list(), anchors).found.map(entry => ({ ...entry, lastSeen: startedAt }));
      } catch (_error) {
        return null;
      }
    },

    /**
     * After the tree was asked to end: find anything under `anchors` that is
     * still alive, end it, and look again until nothing survives or the time
     * runs out. Every process found stays an anchor, and an anchor seen gone
     * bounds what it can have started. Unresolved processes are never ended.
     */
    async settle(anchors, { timeoutMs = 10_000 } = {}) {
      const started = Date.now();
      const ended = new Set();
      const known = new Map(anchors.map(anchor => [key(anchor), { ...anchor }]));
      for (;;) {
        let listing;
        const listedFrom = clock();
        try {
          listing = await list();
        } catch (_error) {
          return { observed: false, survivors: null, unresolved: null, endedByHost: ended.size };
        }
        const listedTo = clock();
        const { found, unresolved } = classify(listing, [...known.values()]);
        const alive = new Set(listing.map(key));
        for (const anchor of known.values()) {
          if (!alive.has(key(anchor)) && anchor.goneBy === undefined) anchor.goneBy = listedTo;
        }
        for (const entry of found) {
          const anchor = known.get(key(entry)) || { ...entry, lastSeen: -Infinity };
          anchor.lastSeen = Math.max(anchor.lastSeen, listedFrom);
          known.set(key(entry), anchor);
        }
        const done = !found.length && !unresolved.length;
        if (done || Date.now() - started >= timeoutMs) {
          return { observed: true, survivors: found.length, unresolved: unresolved.length, endedByHost: ended.size };
        }
        for (const entry of found) {
          try {
            killPid?.(entry.pid);
            ended.add(key(entry));
          } catch (_error) { /* gone already */ }
        }
        await wait(SETTLE_POLL_MS);
      }
    },
  };
}

module.exports = { classify, createProcessTree, listProcesses, parseList, toCreated };
