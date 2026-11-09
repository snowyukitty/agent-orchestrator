// Keeps node-pty's Windows kill() from signalling a pid it no longer owns.
//
// kill() asks a forked agent which processes share the console and kills each
// by pid. The agent cannot attach to a console whose root is gone, which is
// the usual case once `taskkill` or a Job Object has ended the tree, and then
// node-pty waits 5 seconds and kills the root's pid anyway. By then Windows may
// have given that pid to something else: an unrelated process, or the next
// task's root. A task host fixture run lost a root exactly that way.
//
// Here a root known to have exited lists nothing, checked both before the
// listing and on its answer, and an agent that gives no answer names nobody.
// The native exit code counts, because the public exit event can trail it by a
// second or more. A live console is still listed and ended as node-pty
// intends, within milliseconds of the listing; that short window and the
// winpty backend (Windows builds before ConPTY, not a supported host) keep
// node-pty's own behaviour.
//
// `_agent`, `_useConpty`, `exitCode` and `_getConsoleProcessList` are private
// to node-pty; pty-console-guard.test.js fails if an upgrade removes them.

const path = require('path');
const { fork } = require('child_process');

const ANSWER_TIMEOUT_MS = 5000;

function forkConsoleListAgent(shellPid) {
  const script = path.join(path.dirname(require.resolve('node-pty/lib/windowsPtyAgent')), 'conpty_console_list_agent');
  // Silent: the agent's expected AttachConsole crash is not worth a stack in the log.
  const child = fork(script, [String(shellPid)], { silent: true });
  child.stdout?.resume();
  child.stderr?.resume();
  return child;
}

function consoleProcessList(shellPid, forkAgent, rootGone) {
  return new Promise((resolve) => {
    let child;
    try {
      child = forkAgent(shellPid);
    } catch (_error) {
      resolve([]);
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch (_error) { /* already gone */ }
      resolve([]);
    }, ANSWER_TIMEOUT_MS);
    timer.unref?.();
    const finish = (list) => {
      clearTimeout(timer);
      resolve(list);
    };
    child.on('message', message => finish(!rootGone() && Array.isArray(message?.consoleProcessList) ? message.consoleProcessList : []));
    // After any message already sent: a crashed agent closes the channel unanswered.
    child.on('disconnect', () => finish([]));
    child.on('error', () => finish([]));
  });
}

/** Guard `proc`'s console listing when it is a real Windows ConPTY; true if it was. */
function guardConsoleKill(proc, { forkAgent = forkConsoleListAgent, platform = process.platform } = {}) {
  const agent = proc?._agent;
  if (platform !== 'win32' || agent?._useConpty !== true || typeof agent._getConsoleProcessList !== 'function') return false;
  let exited = false;
  proc.onExit?.(() => { exited = true; });
  const rootGone = () => exited || agent.exitCode !== undefined;
  agent._getConsoleProcessList = () => (rootGone() ? Promise.resolve([]) : consoleProcessList(agent._innerPid, forkAgent, rootGone));
  return true;
}

module.exports = { guardConsoleKill };
