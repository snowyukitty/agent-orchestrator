// These tests drive real ConPTY sessions. Under plain Node, node-pty keeps its
// conout worker alive after a child exits on its own, so `test:unit` runs with
// --test-force-exit; the Electron app is long-lived and unaffected.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const pty = require('node-pty');
const { CodexLifecycleBroker } = require('../src/main/codex-lifecycle');
const { parseStrictJson, canonicalJson } = require('../src/main/task-host/strict-json');
const {
  MAX_INSTRUCTION_CHARS, taskRequestDigest, validateEnvelope, validateTaskRequest,
} = require('../src/main/task-host/request');
const { TaskIngress, readDiscovery, sendIngressCommand } = require('../src/main/task-host/ingress');
const { collectDiffEvidence, summarizeStatus } = require('../src/main/task-host/git');
const { compareCheckClaims } = require('../src/main/task-host/checks');
const {
  createCodexAdapter, createFixtureAdapter, createResultFrame, parseResultFrame, renderPromptFile,
} = require('../src/main/task-host/adapters');
const { TaskHost } = require('../src/main/task-host/host');

const FIXTURE_AGENT = path.join(__dirname, 'fixtures', 'task-host', 'fixture-agent.js');

function removeDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

function tempDir(t, prefix, { cleanup = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  if (cleanup) t.after(() => removeDir(dir));
  return dir;
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

/** A tiny repository whose `test` script passes only after the fixture's edit. */
function fixtureRepo(t, dir = null) {
  const repo = dir || tempDir(t, 'ao-task-repo-');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'fixture@example.invalid');
  git(repo, 'config', 'user.name', 'Fixture');
  git(repo, 'config', 'commit.gpgsign', 'false');
  git(repo, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({
    name: 'fixture-repo', private: true, scripts: { test: 'node test.js' },
  }, null, 2));
  fs.writeFileSync(path.join(repo, 'test.js'),
    "process.exit(require('fs').existsSync('fixture-output.txt') ? 0 : 1);\n");
  fs.writeFileSync(path.join(repo, 'README.md'), '# Fixture\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored/\n');
  git(repo, 'add', '--', 'package.json', 'test.js', 'README.md', '.gitignore');
  git(repo, 'commit', '-q', '-m', 'base');
  return { repo, base: git(repo, 'rev-parse', 'HEAD') };
}

function request(overrides = {}) {
  return {
    schema: 1,
    kind: 'agent-orchestrator.task-launch',
    launchId: randomUUID(),
    taskId: 'fixture-task',
    provider: 'fixture',
    route: 'complete',
    workspace: 'fixture',
    baseRevision: 'a'.repeat(40),
    presentation: 'task-window',
    instruction: 'Create fixture-output.txt and make the test pass.',
    checks: [{ kind: 'npm-script', name: 'test' }],
    gitEffects: 'edits-only',
    ...overrides,
  };
}

function fakePresentation() {
  const windows = new Map();
  let next = 1;
  return {
    windows,
    opened: [],
    failOpen: false,
    async openTaskWindow({ launchId, title }) {
      if (this.failOpen) throw new Error('no desktop');
      const windowId = next++;
      windows.set(launchId, windowId);
      this.opened.push({ launchId, title, windowId });
      return { windowId, shown: true };
    },
    isOpen(launchId) { return windows.has(launchId); },
    focus() {},
    sendOutput() {},
    sendState() {},
  };
}

async function hostFixture(t, { limits = {}, adapters = null } = {}) {
  // Removed only after shutdown: a live task PTY holds its worktree open.
  const dataDir = tempDir(t, 'ao-task-host-', { cleanup: false });
  const repoDir = tempDir(t, 'ao-task-repo-', { cleanup: false });
  const broker = new CodexLifecycleBroker();
  await broker.start();
  const presentation = fakePresentation();
  const host = new TaskHost({
    dataDir,
    pty,
    lifecycleBroker: broker,
    adapters: adapters || { fixture: createFixtureAdapter({ script: FIXTURE_AGENT }) },
    presentation,
    limits: { resultGraceMs: 1_500, ...limits },
  });
  t.after(async () => {
    await host.shutdown();
    broker.stop();
    removeDir(dataDir);
    removeDir(repoDir);
  });
  const { repo, base } = fixtureRepo(t, repoDir);
  fs.writeFileSync(host.workspacesFile, JSON.stringify({ schema: 1, workspaces: { fixture: repo } }));
  return { host, dataDir, presentation, repo, base, broker };
}

async function waitFor(predicate, timeoutMs = 30_000) {
  const started = Date.now();
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

function startTask(host, req) {
  const normalized = validateTaskRequest(req);
  return host.start(normalized, taskRequestDigest(normalized));
}

// ── strict JSON and request validation ─────────────────────────

test('strict JSON rejects duplicate keys, trailing data, and deep nesting', () => {
  assert.deepEqual(parseStrictJson('{"a":[1,{"b":"x\\n"}],"c":null}'), { a: [1, { b: 'x\n' }], c: null });
  assert.throws(() => parseStrictJson('{"a":1,"a":2}'), { code: 'duplicate-key' });
  assert.throws(() => parseStrictJson('{"a":{"b":1,"b":1}}'), { code: 'duplicate-key' });
  assert.throws(() => parseStrictJson('{"a":1} x'), { code: 'invalid-json' });
  assert.throws(() => parseStrictJson('[01]'), { code: 'invalid-json' });
  assert.throws(() => parseStrictJson('"\u0001"'), { code: 'invalid-json' });
  assert.throws(() => parseStrictJson('['.repeat(40) + ']'.repeat(40)), { code: 'too-deep' });
  const proto = parseStrictJson('{"__proto__":{"polluted":true}}');
  assert.equal(Object.getPrototypeOf(proto), Object.prototype);
  assert.equal(({}).polluted, undefined);
  assert.equal(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] }), '{"a":[{"c":3,"d":2}],"b":1}');
});

test('launch requests are exact, bounded, and path-free', () => {
  const valid = request();
  assert.equal(validateTaskRequest(valid).launchId, valid.launchId);
  const rejects = (patch, code) => assert.throws(() => validateTaskRequest({ ...valid, ...patch }), { code });
  rejects({ extra: 1 }, 'invalid-request-shape');
  rejects({ schema: 2 }, 'unsupported-schema');
  rejects({ launchId: 'not-a-uuid' }, 'invalid-launch-id');
  rejects({ workspace: 'C:\\repo' }, 'invalid-workspace');
  rejects({ workspace: '../repo' }, 'invalid-workspace');
  rejects({ route: 'a b' }, 'invalid-route');
  rejects({ baseRevision: 'HEAD' }, 'invalid-base-revision');
  rejects({ gitEffects: 'commit' }, 'unsupported-git-effects');
  rejects({ presentation: 'headless' }, 'unsupported-presentation');
  rejects({ instruction: 'x'.repeat(MAX_INSTRUCTION_CHARS + 1) }, 'invalid-instruction');
  rejects({ instruction: 'bell\u0007' }, 'invalid-instruction');
  rejects({ instruction: '   ' }, 'invalid-instruction');
  rejects({ checks: [{ kind: 'npm-script', name: 'test & calc' }] }, 'invalid-checks');
  rejects({ checks: [{ kind: 'npm-script', name: 'test' }, { kind: 'npm-script', name: 'test' }] }, 'invalid-checks');
  rejects({ checks: [{ kind: 'shell', name: 'test' }] }, 'unsupported-check-kind');
  rejects({ checks: [{ kind: 'npm-script', name: 'test', argv: ['x'] }] }, 'invalid-checks');
});

test('start envelopes must carry the digest of the exact request', () => {
  const req = request();
  const digest = taskRequestDigest(validateTaskRequest(req));
  assert.equal(validateEnvelope({ token: 't', op: 'start', request: req, digest }).digest, digest);
  assert.throws(() => validateEnvelope({ token: 't', op: 'start', request: { ...req, route: 'ask' }, digest }),
    { code: 'digest-mismatch' });
  assert.throws(() => validateEnvelope({ token: 't', op: 'exec', command: 'calc' }), { code: 'unknown-op' });
  assert.throws(() => validateEnvelope({ token: 't', op: 'status', launchId: req.launchId, path: 'x' }),
    { code: 'invalid-envelope' });
});

// ── result frame ───────────────────────────────────────────────

test('result frames are typed, bounded, and nonce-checked', () => {
  const frame = createResultFrame();
  const prompt = renderPromptFile(validateTaskRequest(request()), frame);
  assert.ok(prompt.includes(frame.nonce) && prompt.includes(frame.startMarker) && prompt.includes(frame.endMarker));
  const body = nonce => JSON.stringify({ nonce, summary: 'ok', checks: [{ name: 'test', outcome: 'passed' }] });
  const complete = text => ({ complete: true, text });
  assert.deepEqual(parseResultFrame(complete(body(frame.nonce)), frame).nonce, 'echoed');
  assert.equal(parseResultFrame(complete(body('0'.repeat(32))), frame).nonce, 'mismatch');
  assert.equal(parseResultFrame(complete('{"nonce":"x","summary":"s","checks":[],"extra":1}'), frame).frame, 'invalid');
  assert.equal(parseResultFrame(complete('not json'), frame).frame, 'invalid');
  assert.equal(parseResultFrame({ complete: false, missingStart: true }, frame).frame, 'missing');
  assert.equal(parseResultFrame({ complete: false, truncatedAfter: true }, frame).frame, 'truncated');
  assert.equal(parseResultFrame({ complete: false, missingStart: false, missingEnd: true }, frame).frame, 'truncated',
    'a frame that began but never ended is partial output');
  assert.equal(parseResultFrame(null, frame).frame, 'missing');
});

test('check comparison keeps AI claims and host observations apart', () => {
  assert.deepEqual(compareCheckClaims(
    [{ name: 'test', outcome: 'failed' }, { name: 'lint', outcome: 'passed' }],
    [{ name: 'test', outcome: 'passed' }, { name: 'e2e', outcome: 'passed' }],
  ).map(entry => `${entry.name}:${entry.agreement}`), ['test:disagree', 'lint:host-only', 'e2e:ai-only']);
});

// ── adapters ───────────────────────────────────────────────────

test('codex adapter appends only the pointer prompt to the routed direct spec', async () => {
  const adapter = createCodexAdapter({
    resolveProfile: async route => ({ kind: 'routed', id: `codex:${route}`, alias: route }),
    buildLaunchSpec: (_profile, ctx) => ({
      file: 'pwsh.exe', args: ['-File', 'entry.ps1', 'target', 'run', 'codex:a', '--'], env: {},
      cwd: 'C:\\elsewhere', agent: 'codex', sessionMode: ctx.sessionMode,
    }),
    launchContext: async () => ({}),
  });
  assert.equal(adapter.qualification, 'unqualified');
  const spec = await adapter.buildSpec({ route: 'a', worktree: 'C:\\wt', promptFile: 'C:\\private\\prompt.md' });
  assert.equal(spec.cwd, 'C:\\wt');
  assert.equal(spec.initialTurnSubmitted, true);
  assert.equal(spec.args.length, 7);
  assert.match(spec.args[6], /^Your complete task is in the file C:\\private\\prompt\.md \./);
});

// ── git evidence ───────────────────────────────────────────────

test('diff evidence covers commits, staged, unstaged, untracked, binary, and renames', async (t) => {
  const { repo, base } = fixtureRepo(t);
  fs.writeFileSync(path.join(repo, 'committed.txt'), 'c\n');
  git(repo, 'add', '--', 'committed.txt');
  git(repo, 'commit', '-q', '-m', 'since base');
  fs.writeFileSync(path.join(repo, 'staged.txt'), 's\n');
  git(repo, 'add', '--', 'staged.txt');
  fs.appendFileSync(path.join(repo, 'README.md'), 'unstaged\n');
  git(repo, 'mv', 'test.js', 'check.js');
  fs.writeFileSync(path.join(repo, 'untracked.bin'), Buffer.from([0, 1, 2, 255]));
  fs.mkdirSync(path.join(repo, 'ignored'));
  fs.writeFileSync(path.join(repo, 'ignored', 'secret.txt'), 'never swept');
  const indexBefore = fs.readFileSync(path.join(repo, '.git', 'index'));

  const patchFile = path.join(tempDir(t, 'ao-patch-'), 'diff.patch');
  const evidence = await collectDiffEvidence(repo, base, { patchFile });
  assert.equal(evidence.commitsSinceBase, 1);
  assert.equal(evidence.complete, true);
  assert.equal(evidence.binaryFiles, 1);
  assert.equal(evidence.renames, 1);
  assert.equal(evidence.layers.untracked, 1);
  assert.ok(evidence.layers.staged >= 2 && evidence.layers.unstaged >= 1);
  const patch = fs.readFileSync(patchFile, 'utf8');
  for (const name of ['committed.txt', 'staged.txt', 'README.md', 'check.js', 'untracked.bin']) {
    assert.ok(patch.includes(name), `patch includes ${name}`);
  }
  assert.ok(!patch.includes('secret.txt'), 'ignored files are never swept');
  assert.ok(patch.includes('GIT binary patch'));
  assert.deepEqual(fs.readFileSync(path.join(repo, '.git', 'index')), indexBefore,
    'the real index is untouched');
  assert.ok(evidence.notDetected.includes('writes-outside-worktree'));
});

test('porcelain v2 status summary consumes rename source fields', () => {
  const raw = [
    '1 M. N... 100644 100644 100644 a b one.txt',
    '2 R. N... 100644 100644 100644 a b R100 new.txt', 'old.txt',
    '? new-untracked.txt',
    '',
  ].join('\0');
  assert.deepEqual(summarizeStatus(raw), {
    staged: 2, unstaged: 0, untracked: 1, unmerged: 0, renamed: 1, submodules: 0,
  });
});

// ── ingress ────────────────────────────────────────────────────

test('ingress is loopback-only, token-gated, and returns fixed error codes', async (t) => {
  const dir = tempDir(t, 'ao-ingress-');
  const seen = [];
  const host = {
    hostIncarnationId: randomUUID(),
    async handle(command) { seen.push(command); return { ok: true, op: command.op }; },
  };
  const ingress = new TaskIngress({ host, dir });
  await ingress.start();
  t.after(() => ingress.stop());
  const discovery = readDiscovery(dir);
  assert.equal(discovery.host, '127.0.0.1');
  assert.equal(discovery.hostIncarnationId, host.hostIncarnationId);
  assert.match(discovery.token, /^[0-9a-f]{64}$/);

  assert.deepEqual(await sendIngressCommand(discovery, { op: 'capabilities' }), { ok: true, op: 'capabilities' });
  assert.deepEqual(await sendIngressCommand({ ...discovery, token: 'x'.repeat(64) }, { op: 'capabilities' }),
    { ok: false, error: 'unauthorized' });
  assert.deepEqual(await sendIngressCommand(discovery, { op: 'exec', command: 'calc.exe' }),
    { ok: false, error: 'unknown-op' });

  const raw = async (payload) => new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: discovery.port });
    const chunks = [];
    socket.on('connect', () => socket.end(payload));
    socket.on('data', chunk => chunks.push(chunk));
    socket.on('error', reject);
    socket.on('close', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
  });
  assert.deepEqual(await raw(`{"token":"${discovery.token}","op":"capabilities","op":"start"}\n`),
    { ok: false, error: 'duplicate-key' });
  assert.deepEqual(await raw(`{"token":"${discovery.token}","op":"capabilities"}`),
    { ok: false, error: 'incomplete-request' });
  assert.deepEqual(await raw(`${'x'.repeat(200 * 1024)}\n`), { ok: false, error: 'request-too-large' });
  assert.deepEqual(await raw(Buffer.concat([Buffer.from('{"token":"'), Buffer.from([0xff]), Buffer.from('"}\n')])),
    { ok: false, error: 'invalid-utf8' });
  assert.equal(seen.length, 1, 'only the authenticated, valid command reached the host');

  ingress.stop();
  assert.equal(fs.existsSync(path.join(dir, 'ingress.json')), false, 'discovery file is removed on stop');
});

// ── host end to end with real PTYs and the fixture provider ──────

test('a fixture task runs in its own window and worktree and returns joined evidence', async (t) => {
  const { host, presentation, repo, base } = await hostFixture(t);
  const req = request({ baseRevision: base });
  const ack = startTask(host, req);
  assert.equal(ack.ok, true);
  assert.equal(ack.state, 'accepted');
  assert.equal(startTask(host, req).duplicate, true, 'the same launch is observed, not repeated');
  assert.deepEqual(startTask(host, { ...req, route: 'ask' }), { ok: false, error: 'launch-id-conflict' });

  await host.whenIdle();
  const result = host.result(req.launchId);
  assert.equal(result.state, 'needs-review');
  assert.equal(result.ending, 'turn-complete');
  assert.equal(presentation.opened.length, 1, 'exactly one new task window');
  assert.equal(result.window.created, true);
  assert.equal(result.delivery.mechanism, 'argv-pointer');
  assert.equal(result.delivery.providerRead, 'echoed');
  assert.match(result.delivery.promptSha256, /^[0-9a-f]{64}$/);
  assert.equal(result.lifecycle.turnComplete.source, 'authenticated-receipt');
  assert.equal(result.lifecycle.turnStarted, 'unavailable');
  assert.equal(result.evidence.verdict, 'needs-review');
  assert.equal(result.evidence.result.frame, 'complete');
  assert.equal(result.evidence.result.source, 'ai-reported');
  const [check] = result.evidence.checks.hostObserved;
  assert.equal(check.outcome, 'passed');
  assert.equal(check.definitionChangedFromBase, false);
  assert.equal(check.tree, result.evidence.diff.tree);
  assert.equal(result.evidence.checks.comparison[0].agreement, 'agree');
  assert.equal(result.evidence.diff.complete, true);
  assert.equal(result.evidence.diff.layers.untracked, 2);
  assert.equal(result.evidence.diff.binaryFiles, 1);
  assert.equal(git(repo, 'status', '--porcelain'), '', "the owner's checkout is untouched");

  const diff = host.diff(req.launchId);
  const patch = Buffer.from(diff.patchBase64, 'base64').toString('utf8');
  assert.ok(patch.includes('fixture-output.txt') && patch.includes('Edited by the fixture agent.'));
  const serialized = JSON.stringify(host.status(req.launchId));
  assert.ok(!serialized.includes(req.instruction) && !serialized.includes(os.tmpdir()),
    'status carries no task text or paths');
});

test('an AI claim that disagrees with the host-observed check is reported as disagreement', async (t) => {
  const { host, base } = await hostFixture(t);
  const req = request({ baseRevision: base, route: 'claim-false' });
  startTask(host, req);
  await host.whenIdle();
  const { evidence } = host.result(req.launchId);
  assert.equal(evidence.checks.aiClaimed[0].outcome, 'passed');
  assert.equal(evidence.checks.hostObserved[0].outcome, 'failed');
  assert.equal(evidence.checks.comparison[0].agreement, 'disagree');
  assert.equal(evidence.diff.files, 0);
});

test('a nonzero exit without a receipt still collects evidence and never claims completion', async (t) => {
  const { host, base } = await hostFixture(t);
  const req = request({ baseRevision: base, route: 'exit-nonzero' });
  startTask(host, req);
  await host.whenIdle();
  const result = host.result(req.launchId);
  assert.equal(result.state, 'needs-review');
  assert.equal(result.ending, 'process-exited');
  assert.equal(result.process.exitCode, 3);
  assert.equal(result.lifecycle.turnComplete, null);
  assert.equal(result.evidence.result.frame, 'missing');
  assert.equal(result.delivery.providerRead, 'not-observed');
});

test('a wrong nonce is reported as a mismatch', async (t) => {
  const { host, base } = await hostFixture(t);
  const req = request({ baseRevision: base, route: 'wrong-nonce' });
  startTask(host, req);
  await host.whenIdle();
  assert.equal(host.result(req.launchId).delivery.providerRead, 'mismatch');
});

test('without a receipt the task stays running until Stop, which still collects evidence', async (t) => {
  const { host, base } = await hostFixture(t);
  const req = request({ baseRevision: base, route: 'no-receipt' });
  startTask(host, req);
  await waitFor(() => host.status(req.launchId).state === 'running');
  await new Promise(resolve => setTimeout(resolve, 1_000));
  assert.equal(host.status(req.launchId).state, 'running', 'silence is not completion');
  assert.deepEqual(host.stop(req.launchId), { ok: true, status: 'stop-requested' });
  await host.whenIdle();
  const result = host.result(req.launchId);
  assert.equal(result.ending, 'stopped');
  assert.equal(result.stop.effectReconciliation, 'not-performed');
  assert.ok(result.stop.rootExitObservedAt, 'the root exit was observed separately');
  assert.equal(result.evidence.diff.layers.untracked, 2, 'effects made before Stop remain visible');
});

test('input typed into the task window reaches only that task', async (t) => {
  const { host, base } = await hostFixture(t);
  const req = request({ baseRevision: base, route: 'ask' });
  startTask(host, req);
  await waitFor(() => host.windowAttach(req.launchId)?.replay.includes('Proceed?'));
  assert.equal(host.windowInput(req.launchId, 'y\r'), true);
  await host.whenIdle();
  assert.equal(host.result(req.launchId).ending, 'turn-complete');
  assert.equal(host.windowInput(randomUUID(), 'y\r'), false);
});

test('admission refuses busy workspaces, unknown routes, unqualified providers, and locked sessions', async (t) => {
  const codex = { id: 'codex', qualification: 'unqualified', delivery: 'argv-pointer', lifecycle: 'x', buildSpec: async () => { throw new Error('never'); } };
  const { host, base, presentation } = await hostFixture(t, {
    adapters: { fixture: createFixtureAdapter({ script: FIXTURE_AGENT }), codex },
  });
  assert.deepEqual(startTask(host, request({ provider: 'codex', baseRevision: base })), { ok: false, error: 'provider-unqualified' });
  assert.deepEqual(startTask(host, request({ provider: 'grok', baseRevision: base })), { ok: false, error: 'provider-unavailable' });
  assert.deepEqual(startTask(host, request({ workspace: 'other', baseRevision: base })), { ok: false, error: 'unknown-workspace' });

  const first = request({ baseRevision: base, route: 'no-receipt' });
  assert.equal(startTask(host, first).ok, true);
  assert.deepEqual(startTask(host, request({ baseRevision: base })), { ok: false, error: 'workspace-busy' });
  host.stop(first.launchId);
  await host.whenIdle();

  host._isSessionLocked = () => true;
  assert.deepEqual(startTask(host, request({ baseRevision: base })), { ok: false, error: 'session-locked' });
  host._isSessionLocked = () => false;

  const unknownBase = request({ baseRevision: 'b'.repeat(40) });
  startTask(host, unknownBase);
  await host.whenIdle();
  assert.equal(host.status(unknownBase.launchId).state, 'failed-to-start');
  assert.equal(host.status(unknownBase.launchId).reason, 'base-revision-unknown');

  presentation.failOpen = true;
  const noWindow = request({ baseRevision: base });
  startTask(host, noWindow);
  await host.whenIdle();
  assert.equal(host.status(noWindow.launchId).reason, 'window-unavailable');
  assert.equal(host.result(noWindow.launchId).process, null, 'nothing spawns without a window');
});

// ── W2 fault acceptance (docs/task-host.md#fault-acceptance) ─────

function launchCount(dataDir) {
  const dir = path.join(dataDir, 'launches');
  return fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;
}

test('partial output is a truncated frame, never a result', async (t) => {
  const { host, base } = await hostFixture(t);
  const req = request({ baseRevision: base, route: 'partial' });
  startTask(host, req);
  await host.whenIdle();
  const result = host.result(req.launchId);
  assert.equal(result.state, 'needs-review');
  assert.equal(result.ending, 'process-exited');
  assert.equal(result.evidence.result.frame, 'truncated');
  assert.equal(result.evidence.result.aiReported, null, 'a cut-off report yields no AI claims');
  assert.equal(result.delivery.providerRead, 'not-observed');
  assert.equal(result.lifecycle.turnComplete, null);
  assert.equal(result.evidence.diff.complete, true, 'effects before the cut are still collected');
});

test('transport loss before or after acceptance never creates an extra task', async (t) => {
  const { host, dataDir, presentation, base } = await hostFixture(t);
  const ingress = new TaskIngress({ host, dir: dataDir });
  await ingress.start();
  t.after(() => ingress.stop());
  const discovery = readDiscovery(dataDir);
  const req = validateTaskRequest(request({ baseRevision: base, route: 'no-receipt' }));
  const line = `${JSON.stringify({ token: discovery.token, op: 'start', request: req, digest: taskRequestDigest(req) })}\n`;
  const sendThenDrop = text => new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: discovery.port }, () => {
      socket.write(text, () => socket.destroy());
    });
    socket.on('close', resolve);
    socket.on('error', resolve);
  });

  // Lost before acceptance: the line never completed, so nothing exists.
  await sendThenDrop(line.slice(0, 200));
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.deepEqual(await sendIngressCommand(discovery, { op: 'status', launchId: req.launchId }),
    { ok: false, error: 'unknown-launch' });
  assert.equal(launchCount(dataDir), 0);

  // Lost after acceptance: the client never read the ack. A retry of the same
  // bytes finds the one launch the host already accepted.
  await sendThenDrop(line);
  await waitFor(() => host.status(req.launchId).ok);
  const retry = await sendIngressCommand(discovery, { op: 'start', request: req, digest: taskRequestDigest(req) });
  assert.equal(retry.duplicate, true);
  await waitFor(() => host.status(req.launchId).state === 'running');
  assert.equal(launchCount(dataDir), 1, 'exactly one launch record');
  assert.equal(presentation.opened.length, 1, 'exactly one task window');
  host.stop(req.launchId);
  await host.whenIdle();
  assert.equal((await sendIngressCommand(discovery, { op: 'capabilities' })).ok, true, 'the host still answers');
});

test('an absent or replaced host fails closed for a client with stale discovery', async (t) => {
  const dir = tempDir(t, 'ao-ingress-stale-');
  assert.throws(() => readDiscovery(dir), { code: 'ENOENT' }, 'no host, no discovery file');
  const host = { hostIncarnationId: randomUUID(), handle: async command => ({ ok: true, op: command.op }) };
  const first = new TaskIngress({ host, dir });
  await first.start();
  const stale = readDiscovery(dir);
  first.stop();
  await assert.rejects(sendIngressCommand(stale, { op: 'capabilities' }), { code: 'ECONNREFUSED' });

  const replacement = new TaskIngress({ host: { ...host, hostIncarnationId: randomUUID() }, dir });
  await replacement.start();
  t.after(() => replacement.stop());
  // Even if the port were reused, the old capability no longer authenticates.
  const answer = await sendIngressCommand({ ...stale, port: replacement.port }, { op: 'capabilities' });
  assert.deepEqual(answer, { ok: false, error: 'unauthorized' });
  assert.notEqual(readDiscovery(dir).hostIncarnationId, stale.hostIncarnationId);
});

test('restart recovery reports unfinished launches without respawning them', async (t) => {
  const dataDir = tempDir(t, 'ao-task-recover-');
  const write = (launchId, state) => {
    fs.mkdirSync(path.join(dataDir, 'launches', launchId), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'launches', launchId, 'record.json'), JSON.stringify({
      schema: 1, launchId, taskId: 't', requestDigest: 'd'.repeat(64), state, workspace: 'w',
      lifecycle: { turnComplete: null }, process: state === 'running' ? { rootPid: 1 } : null,
    }));
  };
  const [spawning, running, accepted, done] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  write(spawning, 'spawning');
  write(running, 'running');
  write(accepted, 'accepted');
  write(done, 'needs-review');
  const host = new TaskHost({ dataDir, pty, presentation: fakePresentation(), adapters: {} });
  t.after(() => host.shutdown());
  assert.equal(host.recover(), 3);
  assert.equal(host.status(spawning).state, 'uncertain');
  assert.equal(host.status(running).state, 'interrupted');
  assert.equal(host.status(running).process.observation, 'unknown-after-restart');
  assert.equal(host.status(accepted).state, 'interrupted');
  assert.equal(host.status(done).state, 'needs-review');
  assert.deepEqual(host.start({ launchId: running }, 'e'.repeat(64)), { ok: false, error: 'launch-id-conflict' });
  assert.deepEqual(host.stop(running), { ok: true, status: 'not-running' });
});
