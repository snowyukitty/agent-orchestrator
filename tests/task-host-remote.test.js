'use strict';

// W2b relay: the target-side adapter (strict, bounded, fixed codes) and the
// controller-side relay (target-clock authorization, one transmission,
// reconcile-never-replay). Matrix is replaced by a fake that returns the same
// structured observation shape; the target ingress is real loopback.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { PassThrough } = require('node:stream');

const { TaskIngress } = require('../src/main/task-host/ingress');
const { taskRequestDigest, validateTaskRequest } = require('../src/main/task-host/request');
const {
  AdapterError, MAX_REMOTE_BODY_BYTES, parseRemoteArgs, parseRemoteBody, projectList,
  readRemoteBody, runRemoteOperation, sendBounded,
} = require('../src/main/task-host/remote-adapter');
const {
  PRE_ADMISSION_REFUSALS, classifyStart, loadBinding, matrixArgv, mintAuthorization, startRemote,
} = require('../src/main/task-host/remote-relay');

const BASE = 'a'.repeat(40);

function request(overrides = {}) {
  return validateTaskRequest({
    schema: 1,
    kind: 'agent-orchestrator.task-launch',
    launchId: randomUUID(),
    taskId: 'private-task-label',
    provider: 'fixture',
    route: 'complete',
    workspace: 'repo',
    baseRevision: BASE,
    presentation: 'task-window',
    instruction: 'PRIVATE-INSTRUCTION-SENTINEL',
    checks: [],
    gitEffects: 'edits-only',
    ...overrides,
  });
}

function body(req, authorizationOverrides = {}, extra = {}) {
  const digest = taskRequestDigest(req);
  return Buffer.from(JSON.stringify({
    request: req,
    digest,
    authorization: {
      destination: 'target-one', requestDigest: digest,
      issuedAt: '2026-11-06T00:00:00.000Z', expiresAt: '2026-11-06T00:01:00.000Z',
      ...authorizationOverrides,
    },
    ...extra,
  }), 'utf8');
}

function code(fn) {
  try { fn(); } catch (error) { return error instanceof AdapterError ? error.code : `unexpected:${error.message}`; }
  return null;
}

// ── Target adapter ───────────────────────────────────────────

test('the remote client grammar is strict before anything is read', () => {
  assert.deepEqual(parseRemoteArgs(['remote-start', '--stdin']).options, { stdin: true });
  assert.equal(parseRemoteArgs(['list', '--origin', 'remote', '--limit', '64']).options.limit, 64);
  for (const argv of [
    ['remote-start'],
    ['remote-start', '--stdin', '--stdin'],
    ['remote-start', '--stdin', '--token', 'x'],
    ['status'],
    ['status', '--launch', 'not-a-uuid'],
    ['list', '--limit', '65'],
    ['list', '--limit'],
    ['list', '--origin', 'elsewhere'],
    ['list', '--data-dir', 'relative'],
    ['list', 'stray'],
  ]) {
    assert.equal(code(() => parseRemoteArgs(argv)), 'invalid-arguments', argv.join(' '));
  }
  assert.equal(code(() => parseRemoteArgs(['start'])), 'unknown-op');
  assert.equal(code(() => parseRemoteArgs(['diff', '--launch', randomUUID()])), 'unknown-op');
});

test('a remote body is checked completely and never repaired', () => {
  const req = request();
  const parsed = parseRemoteBody(body(req));
  assert.deepEqual(Object.keys(parsed).sort(), ['authorization', 'digest', 'op', 'request']);
  assert.equal(parsed.op, 'remote-start');

  assert.equal(code(() => parseRemoteBody(Buffer.from([0xff, 0xfe]))), 'invalid-utf8');
  assert.equal(code(() => parseRemoteBody(Buffer.from('{"request":1,"request":2}'))), 'duplicate-key');
  assert.equal(code(() => parseRemoteBody(body(req, {}, { token: 'mine' }))), 'invalid-body', 'no token from the body');
  assert.equal(code(() => parseRemoteBody(body(req, {}, { op: 'start' }))), 'invalid-body', 'no op from the body');
  const wrongDigest = JSON.parse(body(req).toString('utf8'));
  wrongDigest.digest = 'b'.repeat(64);
  assert.equal(code(() => parseRemoteBody(Buffer.from(JSON.stringify(wrongDigest)))), 'digest-mismatch');
  assert.equal(code(() => parseRemoteBody(body(req, { requestDigest: 'c'.repeat(64) }))), 'digest-mismatch');
  const badRequest = JSON.parse(body(req).toString('utf8'));
  badRequest.request.launchId = 'x';
  assert.equal(code(() => parseRemoteBody(Buffer.from(JSON.stringify(badRequest)))), 'invalid-launch-id');
});

test('a remote body must reach EOF within its bound', async () => {
  const big = new PassThrough();
  const tooLarge = readRemoteBody(big);
  big.end(Buffer.alloc(MAX_REMOTE_BODY_BYTES + 1, 0x20));
  await assert.rejects(tooLarge, { code: 'body-too-large' });

  const open = new PassThrough();
  open.write('{"partial":');
  await assert.rejects(readRemoteBody(open, { deadlineMs: 100 }), { code: 'body-incomplete' });

  const exact = new PassThrough();
  const ok = readRemoteBody(exact);
  exact.end('{}');
  assert.equal((await ok).toString(), '{}');
});

/** A real loopback ingress in front of a fake host that records commands. */
async function ingressFixture(t, answer = command => ({ ok: true, op: command.op })) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-remote-'));
  const seen = [];
  const host = {
    hostIncarnationId: randomUUID(),
    handle: async (command) => { seen.push(command); return answer(command); },
  };
  const ingress = new TaskIngress({ host, dir });
  await ingress.start();
  t.after(() => { ingress.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, seen, ingress };
}

test('remote-start reaches the ingress with a constructed command and the local token only', async (t) => {
  const { dir, seen } = await ingressFixture(t);
  const req = request();
  const stdin = new PassThrough();
  stdin.end(body(req));
  const answer = await runRemoteOperation(['remote-start', '--stdin', '--data-dir', dir], { stdin });
  assert.equal(answer.ok, true);
  assert.equal(seen.length, 1);
  assert.deepEqual(Object.keys(seen[0]).sort(), ['authorization', 'digest', 'op', 'request']);
  assert.equal(seen[0].op, 'remote-start');
});

test('a body that fails its checks never reaches the ingress', async (t) => {
  const { dir, seen } = await ingressFixture(t);
  const req = request();
  const stdin = new PassThrough();
  stdin.end(body(req, { requestDigest: 'd'.repeat(64) }));
  await assert.rejects(runRemoteOperation(['remote-start', '--stdin', '--data-dir', dir], { stdin }), { code: 'digest-mismatch' });
  assert.equal(seen.length, 0);
});

test('an absent or invalid discovery file is host-unavailable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-remote-absent-'));
  try {
    await assert.rejects(runRemoteOperation(['capabilities', '--data-dir', dir]), { code: 'host-unavailable' });
    fs.writeFileSync(path.join(dir, 'ingress.json'), JSON.stringify({
      schema: 1, kind: 'agent-orchestrator.task-ingress', host: '0.0.0.0', port: 1, token: 'a'.repeat(64),
      hostIncarnationId: randomUUID(),
    }));
    await assert.rejects(runRemoteOperation(['capabilities', '--data-dir', dir]), { code: 'host-unavailable' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an answer lost after the write is unknown, not a refusal', async (t) => {
  const server = net.createServer(socket => socket.on('data', () => socket.destroy()));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const discovery = { port: server.address().port, token: 'a'.repeat(64) };
  await assert.rejects(sendBounded(discovery, { op: 'capabilities' }), { code: 'ingress-answer-unavailable' });

  const flood = net.createServer(socket => socket.on('data', () => socket.end(Buffer.alloc(70_000, 0x20))));
  await new Promise(resolve => flood.listen(0, '127.0.0.1', resolve));
  t.after(() => flood.close());
  await assert.rejects(sendBounded({ port: flood.address().port, token: 'a'.repeat(64) }, { op: 'list' }),
    { code: 'ingress-answer-unavailable' }, 'an oversized answer is not read');

  const closed = net.createServer();
  await new Promise(resolve => closed.listen(0, '127.0.0.1', resolve));
  const port = closed.address().port;
  await new Promise(resolve => closed.close(resolve));
  await assert.rejects(sendBounded({ port, token: 'a'.repeat(64) }, { op: 'list' }), { code: 'host-unavailable' },
    'nothing was asked when the connection never opened');
});

test('list is the public projection: no task ID, route, workspace, instruction or digest', () => {
  const launch = (state, acceptedAt, origin = 'remote') => ({
    launchId: randomUUID(), taskId: 'PRIVATE-TASK', provider: 'codex', workspace: 'PRIVATE-WS',
    route: 'PRIVATE-ROUTE', requestDigest: 'e'.repeat(64), recordIncarnationId: randomUUID(),
    state, reason: state === 'interrupted' ? 'host-quit' : 'Has Spaces', acceptedAt, updatedAt: acceptedAt, origin,
  });
  const answer = {
    ok: true, hostId: 'target-one', hostIncarnationId: randomUUID(), observedAt: '2026-11-06T00:00:00.000Z',
    launches: [
      launch('needs-review', '2026-11-06T00:00:03.000Z'),
      launch('running', '2026-11-06T00:00:01.000Z'),
      launch('interrupted', '2026-11-06T00:00:02.000Z'),
      launch('mystery', '2026-11-06T00:00:04.000Z'),
      launch('accepted', '2026-11-06T00:00:00.500Z', 'local'),
    ],
  };
  const doc = projectList(answer, { origin: 'remote' });
  assert.equal(doc.kind, 'agent-orchestrator.task-list');
  assert.equal(doc.hostId, 'target-one');
  assert.equal(doc.launches.length, 4);
  assert.equal(doc.launches[0].phase, 'running', 'active launches first');
  assert.deepEqual(doc.launches.map(l => l.phase).slice(1), ['unknown', 'needs-review', 'failed']);
  assert.equal(doc.launches.find(l => l.phase === 'failed').reasonCode, 'host-quit');
  assert.equal(doc.launches.find(l => l.phase === 'needs-review').reasonCode, null, 'free text is not a reason code');
  const text = JSON.stringify(doc);
  for (const sentinel of ['PRIVATE-TASK', 'PRIVATE-WS', 'PRIVATE-ROUTE', 'codex', 'e'.repeat(64)]) {
    assert.ok(!text.includes(sentinel), sentinel);
  }
  const limited = projectList(answer, { limit: 2 });
  assert.equal(limited.launches.length, 2);
  assert.equal(limited.more, true);
  const small = projectList(answer, { maxBytes: 600 });
  assert.ok(Buffer.byteLength(`${JSON.stringify(small)}\n`) <= 600);
  assert.equal(small.more, true);
});

// ── Controller relay ─────────────────────────────────────────

const BINDING = {
  schema: 1, kind: 'agent-orchestrator.remote-binding',
  matrix: ['C:\\fake\\matrix.exe'], node: 'npc-node', workspace: 'orchestrator', hostId: 'target-one',
};

function observation(answer, overrides = {}) {
  return {
    started: true,
    stdout: Buffer.from(JSON.stringify({
      schema: 1, status: 'exited', child_exit: answer.ok ? 0 : 1, transport_exit: answer.ok ? 0 : 1,
      stdout: `${JSON.stringify(answer)}\n`, stdout_truncated: false, stderr: '', stderr_truncated: false,
      ...overrides,
    })),
  };
}

function capabilities({ hostTime, session = 'unlocked', remoteStarts = 'enabled', hostId = 'target-one' } = {}) {
  return {
    ok: true, observedAt: new Date(hostTime).toISOString(), admission: 'open', session, power: 'ac',
    policy: { status: 'valid', hostId, remoteStarts },
    providers: [{ provider: 'fixture', admitted: true, lockedSession: false }],
    workspaces: ['repo'],
  };
}

/** A fake Matrix: answers by client op, records every call and body. */
function fakeMatrix(handlers, { help = '  --stdin-file STDIN_FILE\n' } = {}) {
  const calls = [];
  const run = async (argv, { input = null } = {}) => {
    // The local help probe never reaches the target; it is not a client call.
    if (argv.at(-1) === '--help') return { started: true, stdout: Buffer.from(help) };
    const op = argv[argv.indexOf('scripts/task-host-client.mjs') + 1];
    calls.push({ op, argv, input });
    return handlers[op]({ argv, input, calls });
  };
  return { run, calls };
}

function relayFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-relay-'));
  let clock = 1_000;
  return {
    dir,
    monotonic: () => clock,
    advance: (ms) => { clock += ms; },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

test('the binding is strict and Matrix gets an argv with a named workspace, never a path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-binding-'));
  try {
    const file = path.join(dir, 'binding.json');
    fs.writeFileSync(file, JSON.stringify(BINDING));
    const binding = loadBinding(file);
    const argv = matrixArgv(binding, ['remote-start', '--stdin'], { stdin: true });
    assert.deepEqual(argv.slice(argv.indexOf('--cwd'), argv.indexOf('--cwd') + 2), ['--cwd', 'orchestrator']);
    assert.ok(argv.includes('--stdin-file') && argv[argv.indexOf('--stdin-file') + 1] === '-');
    for (const bad of [
      { ...BINDING, matrix: ['matrix'] },
      { ...BINDING, node: 'has space' },
      { ...BINDING, ssh: ['-o', 'x'] },
      { ...BINDING, kind: 'other' },
    ]) {
      fs.writeFileSync(file, JSON.stringify(bad));
      assert.throws(() => loadBinding(file), { code: 'invalid-binding' });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a Matrix that cannot carry a body is refused before anything reaches the target', async (t) => {
  const f = relayFixture();
  t.after(f.cleanup);
  const fake = fakeMatrix({
    capabilities: () => assert.fail('must not contact the target'),
    'remote-start': () => assert.fail('must not send'),
  }, { help: '  --cwd CWD\n  --stdin-files-are-not-this\n' });
  const req = request();
  const r = await startRemote({ binding: BINDING, request: req, attemptsDir: f.dir, run: fake.run, monotonic: f.monotonic });
  assert.deepEqual([r.outcome, r.reason], ['not-sent', 'matrix-lacks-body-input']);
  assert.equal(fs.existsSync(path.join(f.dir, `${req.launchId}.json`)), false);
});

test('the authorization is minted from the target clock, never later than its now', () => {
  for (const offset of [-600_000, 0, 600_000]) {
    const hostTime = Date.parse('2026-11-06T00:00:00.000Z') + offset;
    const auth = mintAuthorization({ hostTime, sampledAt: 100, now: 2_100, destination: 'target-one', digest: 'f'.repeat(64) });
    const issued = Date.parse(auth.issuedAt);
    assert.equal(issued, hostTime + 2_000 - 1_000);
    assert.equal(Date.parse(auth.expiresAt) - issued, 60_000);
  }
});

test('an accepted remote start is sent once, with a body the target accepts', async (t) => {
  const f = relayFixture();
  t.after(f.cleanup);
  const req = request();
  const hostTime = Date.parse('2026-11-06T09:00:00.000Z');
  const { run, calls } = fakeMatrix({
    capabilities: () => observation(capabilities({ hostTime })),
    'remote-start': ({ input }) => {
      const parsed = parseRemoteBody(input);
      assert.equal(parsed.authorization.destination, 'target-one');
      assert.ok(Date.parse(parsed.authorization.issuedAt) <= hostTime + 10);
      return observation({ ok: true, duplicate: false, launchId: req.launchId, state: 'accepted' });
    },
  });
  const result = await startRemote({ binding: BINDING, request: req, attemptsDir: f.dir, run, monotonic: f.monotonic });
  assert.equal(result.outcome, 'accepted');
  assert.equal(calls.filter(c => c.op === 'remote-start').length, 1);
  const attempt = JSON.parse(fs.readFileSync(path.join(f.dir, `${req.launchId}.json`), 'utf8'));
  assert.equal(attempt.state, 'accepted');
  assert.ok(!JSON.stringify(attempt).includes('PRIVATE-INSTRUCTION-SENTINEL'), 'the checkpoint keeps no task text');

  const again = await startRemote({ binding: BINDING, request: req, attemptsDir: f.dir, run, monotonic: f.monotonic });
  assert.deepEqual([again.outcome, again.reason], ['not-sent', 'attempt-exists']);
  assert.equal(calls.filter(c => c.op === 'remote-start').length, 1, 'a launch ID is sent at most once');
});

test('a known pre-admission code is a refusal; anything else is unknown', () => {
  const id = randomUUID();
  const answer = a => ({ answer: a });
  for (const refusal of ['authorization-expired', 'host-busy', 'host-unavailable', 'launch-id-conflict']) {
    assert.ok(PRE_ADMISSION_REFUSALS.has(refusal));
    assert.equal(classifyStart(answer({ ok: false, error: refusal }), id).outcome, 'refused', refusal);
  }
  for (const error of ['internal-error', 'ingress-answer-unavailable', 'client-error', 'something-new']) {
    assert.equal(classifyStart(answer({ ok: false, error }), id).outcome, 'unknown', error);
  }
  assert.equal(classifyStart(answer({ ok: true, launchId: randomUUID() }), id).outcome, 'unknown', 'another launch');
  assert.equal(classifyStart({ uncertain: 'transport-failed' }, id).outcome, 'unknown');
  assert.equal(classifyStart({ notStarted: true }, id).outcome, 'not-sent');
});

test('an uncertain start is reconciled by status only, never by sending again', async (t) => {
  const f = relayFixture();
  t.after(f.cleanup);
  const hostTime = Date.parse('2026-11-06T09:00:00.000Z');
  const lost = () => observation({}, { status: 'transport-failed', child_exit: null, transport_exit: 255, stdout: '' });

  // Accepted after all: the stored digest matches.
  const req = request();
  const accepted = fakeMatrix({
    capabilities: () => observation(capabilities({ hostTime })),
    'remote-start': lost,
    status: () => observation({ ok: true, launchId: req.launchId, state: 'running', hostId: 'target-one', requestDigest: taskRequestDigest(req) }),
  });
  const a = await startRemote({ binding: BINDING, request: req, attemptsDir: f.dir, run: accepted.run, monotonic: f.monotonic });
  assert.deepEqual([a.outcome, a.reconciled], ['accepted', true]);

  // Not found: still unknown, and nothing is sent a second time.
  const other = request();
  const unknown = fakeMatrix({
    capabilities: () => observation(capabilities({ hostTime })),
    'remote-start': lost,
    status: () => observation({ ok: false, error: 'unknown-launch' }),
  });
  const u = await startRemote({ binding: BINDING, request: other, attemptsDir: f.dir, run: unknown.run, monotonic: f.monotonic });
  assert.equal(u.outcome, 'unknown');
  assert.deepEqual(unknown.calls.map(c => c.op), ['capabilities', 'remote-start', 'status']);

  // A different digest under the same ID is a conflict, not acceptance.
  const third = request();
  const conflict = fakeMatrix({
    capabilities: () => observation(capabilities({ hostTime })),
    'remote-start': lost,
    status: () => observation({ ok: true, launchId: third.launchId, state: 'running', hostId: 'target-one', requestDigest: '0'.repeat(64) }),
  });
  const c = await startRemote({ binding: BINDING, request: third, attemptsDir: f.dir, run: conflict.run, monotonic: f.monotonic });
  assert.deepEqual([c.outcome, c.reason], ['unknown', 'launch-id-conflict']);
});

test('nothing is sent after a slow sample, a wrong host, or a locally certain refusal', async (t) => {
  const f = relayFixture();
  t.after(f.cleanup);
  const hostTime = Date.parse('2026-11-06T09:00:00.000Z');
  const cases = [
    ['clock-sample-unavailable', () => { f.advance(6_000); return observation(capabilities({ hostTime })); }],
    ['wrong-destination', () => observation(capabilities({ hostTime, hostId: 'target-two' }))],
    ['remote-starts-disabled', () => observation(capabilities({ hostTime, remoteStarts: 'disabled' }))],
    ['provider-session-unqualified', () => observation(capabilities({ hostTime, session: 'locked' }))],
    ['host-unavailable', () => observation({ ok: false, error: 'host-unavailable' })],
  ];
  for (const [reason, caps] of cases) {
    const fake = fakeMatrix({ capabilities: caps, 'remote-start': () => assert.fail('must not send') });
    const r = await startRemote({ binding: BINDING, request: request(), attemptsDir: f.dir, run: fake.run, monotonic: f.monotonic });
    assert.deepEqual([r.outcome, r.reason], ['not-sent', reason]);
  }
});
