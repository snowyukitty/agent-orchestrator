// Process ownership at the collection boundary.
//
// Root exit alone does not prove a provider is gone: a routed launcher or the
// provider itself can leave descendants that keep writing to the worktree
// while evidence is frozen. Before the host ends a task, it snapshots the
// root's descendants; afterwards it requires that none of them, and nothing
// they started, is still alive.
//
// A process is identified by (pid, creation time), so a reused pid is never
// mistaken for a survivor or for a member of the tree. A child must have been
// created no earlier than its parent; an older process whose parent pid
// happens to match is a pid-reuse coincidence, not a descendant.

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

/**
 * The live processes descending from any member of `roots` (entries from an
 * earlier list), in one listing. Roots themselves are included when alive.
 *
 * A child belongs to an anchor only if it was created no earlier than the
 * anchor, and no later than a live process that has since reused the
 * anchor's pid: a child of the replacement is the replacement's, not ours.
 */
function descendantsOf(processes, roots) {
  const live = new Map(processes.map(entry => [entry.pid, entry]));
  const members = new Map(roots.map(root => [root.pid, root]));
  const found = new Map();
  for (const entry of processes) {
    if (members.get(entry.pid)?.created === entry.created) found.set(key(entry), entry);
  }
  // Walk children until no new member appears; each pass is linear.
  for (let grew = true; grew;) {
    grew = false;
    for (const entry of processes) {
      if (found.has(key(entry))) continue;
      const parent = members.get(entry.ppid);
      if (!parent || entry.created < parent.created) continue;
      const holder = live.get(entry.ppid);
      if (holder && holder.created !== parent.created && entry.created >= holder.created) continue;
      found.set(key(entry), entry);
      members.set(entry.pid, entry);
      grew = true;
    }
  }
  return [...found.values()];
}

/**
 * @param {object} deps
 * @param {function} [deps.list]     () => Promise<process entries>
 * @param {function} [deps.killPid]  (pid) => void, ends that one process (never a tree:
 *                                     the walk here decides what belongs to the task)
 */
function createProcessTree({ list = listProcesses, killPid, delay } = {}) {
  const wait = delay || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  return {
    /** The live process with this pid, as an identity, or null. */
    async identify(pid) {
      try {
        return (await list()).find(entry => entry.pid === pid) || null;
      } catch (_error) {
        return null;
      }
    },

    /** The live members of the trees under `roots`, or null when unobservable. */
    async members(roots) {
      try {
        return descendantsOf(await list(), roots);
      } catch (_error) {
        return null;
      }
    },

    /**
     * After the tree was asked to end: find anything under `roots` that is
     * still alive, end it, and look again until nothing survives or the time
     * runs out. A process that already exited still anchors its children,
     * and every process found on the way is kept as an anchor too, so a
     * grandchild whose parent exits between two looks is still found.
     */
    async settle(roots, { timeoutMs = 10_000 } = {}) {
      const started = Date.now();
      const ended = new Set();
      const anchors = new Map(roots.map(root => [key(root), root]));
      for (;;) {
        let alive;
        try {
          alive = descendantsOf(await list(), [...anchors.values()]);
          for (const entry of alive) anchors.set(key(entry), entry);
        } catch (_error) {
          return { observed: false, survivors: null, endedByHost: ended.size };
        }
        if (!alive.length || Date.now() - started >= timeoutMs) {
          return { observed: true, survivors: alive.length, endedByHost: ended.size };
        }
        for (const entry of alive) {
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

module.exports = { createProcessTree, descendantsOf, listProcesses, parseList };
