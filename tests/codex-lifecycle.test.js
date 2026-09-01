const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFile, spawnSync } = require('node:child_process');

const {
  CodexLifecycleBroker,
  ENV_INCARNATION,
  ENV_PIPE,
  ENV_TOKEN,
} = require('../src/main/codex-lifecycle');

const INCARNATION = '40000000-0000-4000-8000-000000000001';
const THREAD_A = 'a'.repeat(64);
const THREAD_B = 'b'.repeat(64);
const TURN_A = 'c'.repeat(64);
const TURN_B = 'd'.repeat(64);

test('lifecycle broker accepts only an exact token, incarnation, and event', async () => {
  const broker = new CodexLifecycleBroker();
  await broker.start();
  let receipts = 0;
  const registration = broker.register({
    sessionId: 'sess-1',
    incarnationId: INCARNATION,
    onEvent: event => { receipts += 1; return event.type === 'agent-turn-complete'; },
  });
  const token = registration.env[ENV_TOKEN];
  try {
    assert.equal(broker.acceptPayload('not json'), false);
    assert.equal(broker.acceptPayload(JSON.stringify({ token, incarnationId: INCARNATION, type: 'approval-requested' })), false);
    const valid = { token, incarnationId: INCARNATION, type: 'agent-turn-complete', threadDigest: THREAD_A, turnDigest: TURN_A };
    assert.equal(broker.acceptPayload(JSON.stringify({ ...valid, token: 'wrong' })), false);
    assert.equal(broker.acceptPayload(JSON.stringify({ ...valid, incarnationId: 'wrong' })), false);
    assert.equal(broker.acceptPayload(JSON.stringify({ ...valid, output: 'leak' })), false);
    assert.equal(broker.acceptPayload(JSON.stringify({ token, incarnationId: INCARNATION, type: 'agent-turn-complete' })), false);
    assert.equal(broker.acceptPayload(JSON.stringify(valid)), true);
    assert.equal(receipts, 1);
    assert.equal(broker.acceptPayload(JSON.stringify(valid)), false, 'duplicate turn receipt is rejected');
    assert.equal(broker.acceptPayload(JSON.stringify({ ...valid, threadDigest: THREAD_B, turnDigest: TURN_B })), false,
      'one registration cannot switch provider threads');
    assert.equal(broker.acceptPayload(JSON.stringify({ ...valid, turnDigest: TURN_B })), true);
    assert.equal(receipts, 2);
    assert.match(registration.env[ENV_PIPE], /^agent-orchestrator-/);
    assert.equal(registration.env[ENV_INCARNATION], INCARNATION);
    assert.ok(Object.keys(registration.env).every(name => name.includes('SECRET')),
      'every lifecycle routing variable must match Codex secret-name filtering');
    assert.equal(registration.release(), true);
    assert.equal(registration.release(), false);
    assert.equal(broker.acceptPayload(JSON.stringify({ ...valid, turnDigest: 'e'.repeat(64) })), false);
  } finally {
    broker.stop();
  }
});

test('bundled PowerShell helper forwards only a synthetic turn-complete receipt', async (t) => {
  const probe = spawnSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-Command', 'exit 0'], {
    windowsHide: true,
  });
  if (probe.error?.code === 'ENOENT') {
    t.skip('pwsh.exe is unavailable');
    return;
  }
  const broker = new CodexLifecycleBroker();
  await broker.start();
  let resolveReceipt;
  const receipt = new Promise(resolve => { resolveReceipt = resolve; });
  const registration = broker.register({
    sessionId: 'sess-helper',
    incarnationId: INCARNATION,
    onEvent: event => { resolveReceipt(event); return true; },
  });
  const helper = path.join(__dirname, '..', 'src', 'main', 'codex-notify.ps1');
  const notification = JSON.stringify({
    type: 'agent-turn-complete',
    'thread-id': 'private-provider-thread-id',
    'turn-id': 'private-provider-turn-id',
    'last-assistant-message': 'This text must not cross the named pipe.',
  });
  try {
    const child = new Promise((resolve, reject) => {
      execFile(
        'pwsh.exe',
        ['-NoLogo', '-NoProfile', '-File', helper, notification],
        {
          windowsHide: true,
          timeout: 5_000,
          env: { ...process.env, ...registration.env },
        },
        (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr })
      );
    });
    const event = await Promise.race([
      receipt,
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error('receipt timeout')), 3_000)),
    ]);
    const output = await child;
    assert.deepEqual(event, { type: 'agent-turn-complete' });
    assert.equal(output.stdout, '');
    assert.equal(output.stderr, '');
  } finally {
    registration.release();
    broker.stop();
  }
});
