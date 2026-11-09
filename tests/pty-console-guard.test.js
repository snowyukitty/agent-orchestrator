const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { guardConsoleKill } = require('../src/main/pty-console-guard');

function fakeAgent() {
  const child = new EventEmitter();
  child.killed = 0;
  child.kill = () => { child.killed++; };
  return child;
}

function fakeProc(innerPid = 4242) {
  const exitListeners = [];
  return {
    _agent: { _useConpty: true, _innerPid: innerPid, _getConsoleProcessList: () => Promise.resolve([innerPid]) },
    onExit: (listener) => { exitListeners.push(listener); },
    exit: () => exitListeners.forEach(listener => listener({ exitCode: 0 })),
  };
}

function guarded(child, innerPid = 4242) {
  const seen = [];
  const proc = fakeProc(innerPid);
  assert.equal(guardConsoleKill(proc, { platform: 'win32', forkAgent: (pid) => { seen.push(pid); return child; } }), true);
  return { list: proc._agent._getConsoleProcessList(), seen };
}

test('the processes a working agent names are still returned', async () => {
  const child = fakeAgent();
  const { list, seen } = guarded(child);
  child.emit('message', { consoleProcessList: [4242, 4243] });
  child.emit('disconnect');
  assert.deepEqual(await list, [4242, 4243]);
  assert.deepEqual(seen, [4242]);
});

test('an agent that dies without answering names nobody, not the root pid', async () => {
  const child = fakeAgent();
  const { list } = guarded(child);
  child.emit('disconnect');
  assert.deepEqual(await list, []);
});

test('an agent that cannot start names nobody', async () => {
  const proc = fakeProc(7);
  guardConsoleKill(proc, { platform: 'win32', forkAgent: () => { throw new Error('no fork'); } });
  assert.deepEqual(await proc._agent._getConsoleProcessList(), []);
});

test('a malformed answer names nobody', async () => {
  const child = fakeAgent();
  const { list } = guarded(child);
  child.emit('message', { consoleProcessList: 'all of them' });
  assert.deepEqual(await list, []);
});

test('an agent that hangs is ended and names nobody', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const child = fakeAgent();
  const { list } = guarded(child);
  t.mock.timers.tick(5000);
  assert.deepEqual(await list, []);
  assert.equal(child.killed, 1);
});

test('a root known to have exited is not listed at all', async () => {
  const proc = fakeProc();
  let forks = 0;
  guardConsoleKill(proc, { platform: 'win32', forkAgent: () => { forks++; return fakeAgent(); } });
  proc.exit();
  assert.deepEqual(await proc._agent._getConsoleProcessList(), []);
  assert.equal(forks, 0);
});

test('a native exit counts before the public exit event has fired', async () => {
  const proc = fakeProc();
  let forks = 0;
  guardConsoleKill(proc, { platform: 'win32', forkAgent: () => { forks++; return fakeAgent(); } });
  proc._agent.exitCode = 0;
  assert.deepEqual(await proc._agent._getConsoleProcessList(), []);
  assert.equal(forks, 0);
});

for (const [when, end] of [
  ['the native exit', (proc) => { proc._agent.exitCode = 1; }],
  ['the public exit event', proc => proc.exit()],
]) {
  test(`an answer that arrives after ${when} is not trusted`, async () => {
    const proc = fakeProc();
    const child = fakeAgent();
    guardConsoleKill(proc, { platform: 'win32', forkAgent: () => child });
    const list = proc._agent._getConsoleProcessList();
    end(proc);
    child.emit('message', { consoleProcessList: [4242, 4243] });
    assert.deepEqual(await list, []);
  });
}

test('a fake PTY, winpty and other platforms are left alone', () => {
  assert.equal(guardConsoleKill({}, { platform: 'win32' }), false);
  assert.equal(guardConsoleKill(null, { platform: 'win32' }), false);
  const winpty = fakeProc();
  winpty._agent._useConpty = false;
  const original = winpty._agent._getConsoleProcessList;
  assert.equal(guardConsoleKill(winpty, { platform: 'win32' }), false);
  assert.equal(winpty._agent._getConsoleProcessList, original);
  const other = fakeProc();
  assert.equal(guardConsoleKill(other, { platform: 'linux' }), false);
});

test('the node-pty privates the guard relies on still exist', { skip: process.platform !== 'win32' }, () => {
  const { WindowsPtyAgent } = require('node-pty/lib/windowsPtyAgent');
  assert.equal(typeof WindowsPtyAgent.prototype._getConsoleProcessList, 'function');
  assert.equal(typeof Object.getOwnPropertyDescriptor(WindowsPtyAgent.prototype, 'exitCode')?.get, 'function');
  require.resolve('node-pty/lib/conpty_console_list_agent');
});

test('killing a real PTY whose root is gone signals no pid afterwards', { skip: process.platform !== 'win32' }, async (t) => {
  const pty = require('node-pty');
  const proc = pty.spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'echo ready'], { cols: 80, rows: 24, useConpty: true });
  assert.equal(guardConsoleKill(proc), true, 'a real Windows PTY must carry the guarded hook');
  const guardedList = proc._agent._getConsoleProcessList;
  let listed = 0;
  proc._agent._getConsoleProcessList = () => { listed++; return guardedList(); };
  // kill() is deferred until the terminal has produced output, so wait for it.
  await Promise.all([
    new Promise((resolve) => { let seen = ''; proc.onData((data) => { seen += data; if (seen.includes('ready')) resolve(); }); }),
    new Promise(resolve => proc.onExit(resolve)),
  ]);
  // Recorded and never forwarded: if this regresses, the pid is not signalled for real.
  const signalled = [];
  t.mock.method(process, 'kill', (pid) => { signalled.push(pid); return true; });
  proc.kill();
  // Past node-pty's own 5-second fallback.
  await new Promise(resolve => setTimeout(resolve, 5600));
  assert.equal(listed, 1, 'the guarded listing must have been reached');
  assert.deepEqual(signalled, []);
});
