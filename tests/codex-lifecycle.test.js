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

test('an expected input digest separates the started turn from side turns', async () => {
  const { createHash } = require('node:crypto');
  const digest = text => createHash('sha256').update(text, 'utf8').digest('hex');
  const broker = new CodexLifecycleBroker();
  await broker.start();
  let receipts = 0;
  let uncorrelated = 0;
  const registration = broker.register({
    sessionId: 'sess-task',
    incarnationId: INCARNATION,
    expectedInputDigest: digest('the task pointer'),
    onEvent: () => { receipts += 1; return true; },
    onUncorrelated: () => { uncorrelated += 1; },
  });
  const token = registration.env[ENV_TOKEN];
  const receipt = fields => JSON.stringify({
    token, incarnationId: INCARNATION, type: 'agent-turn-complete', threadDigest: THREAD_A, turnDigest: TURN_A, ...fields,
  });
  try {
    assert.throws(() => broker.register({ sessionId: 'x', incarnationId: INCARNATION, onEvent: () => true, expectedInputDigest: 'nope' }));
    assert.equal(broker.acceptPayload(receipt({ inputDigests: 'not-an-array' })), false);
    assert.equal(broker.acceptPayload(receipt({ inputDigests: ['short'] })), false);
    assert.equal(uncorrelated, 0, 'malformed receipts are not counted as side turns');
    assert.equal(broker.acceptPayload(receipt({ threadDigest: THREAD_B, inputDigests: [digest('background summary')] })), false);
    assert.equal(broker.acceptPayload(receipt({ threadDigest: THREAD_B })), false, 'no input digests cannot correlate');
    assert.equal(uncorrelated, 2);
    assert.equal(receipts, 0);
    // The side turns neither completed the task nor captured the thread.
    assert.equal(broker.acceptPayload(receipt({ inputDigests: [digest('x'), digest('the task pointer')] })), true);
    assert.equal(receipts, 1);
  } finally {
    registration.release();
    broker.stop();
  }
});

test('the PowerShell helper forwards digests of the turn input, never the input', async (t) => {
  const probe = spawnSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-Command', 'exit 0'], { windowsHide: true });
  if (probe.error?.code === 'ENOENT') {
    t.skip('pwsh.exe is unavailable');
    return;
  }
  const { createHash } = require('node:crypto');
  const broker = new CodexLifecycleBroker();
  await broker.start();
  let resolveReceipt;
  const receipt = new Promise(resolve => { resolveReceipt = resolve; });
  const registration = broker.register({
    sessionId: 'sess-input',
    incarnationId: INCARNATION,
    expectedInputDigest: createHash('sha256').update('Read the private task file.', 'utf8').digest('hex'),
    onEvent: event => { resolveReceipt(event); return true; },
  });
  const helper = path.join(__dirname, '..', 'src', 'main', 'codex-notify.ps1');
  const notification = JSON.stringify({
    type: 'agent-turn-complete',
    'thread-id': 'thread',
    'turn-id': 'turn',
    'input-messages': ['  Read the private task file.  '],
  });
  try {
    await new Promise((resolve, reject) => {
      execFile('pwsh.exe', ['-NoLogo', '-NoProfile', '-File', helper, notification],
        { windowsHide: true, timeout: 5_000, env: { ...process.env, ...registration.env } },
        error => error ? reject(error) : resolve());
    });
    const event = await Promise.race([
      receipt,
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error('receipt timeout')), 3_000)),
    ]);
    assert.deepEqual(event, { type: 'agent-turn-complete' });
  } finally {
    registration.release();
    broker.stop();
  }
});
