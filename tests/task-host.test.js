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
const { collectDiffEvidence, isWorkTreeRoot, summarizeStatus } = require('../src/main/task-host/git');
const { compareCheckClaims } = require('../src/main/task-host/checks');
const {
  CODEX_ADAPTER_CONTRACT, createCodexAdapter, createFixtureAdapter, createResultFrame, parseResultFrame, readResultFile,
  renderPromptFile,
} = require('../src/main/task-host/adapters');
const { TaskHost } = require('../src/main/task-host/host');
const {
  REQUIRED_EVIDENCE, qualificationEvidence, qualificationFile, qualificationShortfall, readQualification, writeQualification,
} = require('../src/main/task-host/qualification');
const { PROFILES, POLICY_KIND, checkRemoteAuthorization, readPolicy } = require('../src/main/task-host/policy');
const { createProcessTree, descendantsOf } = require('../src/main/task-host/process-tree');
const { createSystemObserver, parseObservation } = require('../src/main/task-host/system-state');

const TEST_SID = 'S-1-5-21-1000-2000-3000-1001';

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
    name: 'fixture-repo', private: true, scripts: { test: 'node test.js', slow: 'node -e "setTimeout(() => {}, 60000)"' },
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

/**
 * Process ownership without listing the system's processes: the root is
 * identified and nothing is left behind. One test drives the real listing.
 */
const settledTree = Object.freeze({
  identify: async pid => ({ pid, ppid: 0, created: 1 }),
  members: async roots => [...roots],
  settle: async () => ({ observed: true, survivors: 0, endedByHost: 0 }),
});

async function hostFixture(t, { limits = {}, adapters = null, hostOptions = {} } = {}) {
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
    processTree: settledTree,
    account: () => TEST_SID,
    limits: { resultGraceMs: 1_500, ...limits },
    ...hostOptions,
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

const CODEX_LAUNCH = {
  route: 'a', worktree: 'C:\\wt', promptFile: 'C:\\private\\prompt.md', resultDir: 'C:\\private\\outbox',
  repositoryRoot: 'D:\\Work\\Repo-1',
};

test('codex adapter adds only the task sandbox, outbox, one-launch trust, and pointer prompt', async () => {
  const adapter = createCodexAdapter({
    resolveProfile: async route => ({ kind: 'routed', id: `codex:${route}`, alias: route }),
    buildLaunchSpec: (_profile, ctx) => ({
      file: 'pwsh.exe', args: ['-File', 'entry.ps1', 'target', 'run', 'codex:a', '--'], env: {},
      cwd: 'C:\\elsewhere', agent: 'codex', sessionMode: ctx.sessionMode,
    }),
    launchContext: async () => ({}),
  });
  assert.equal(adapter.qualification, 'unqualified');
  assert.equal(adapter.resultChannel, 'file', 'a full-screen TUI reports through a file, not the screen');
  const { spec, providerVersion } = await adapter.buildSpec(CODEX_LAUNCH);
  assert.equal(providerVersion, null, 'no version probe was configured');
  assert.equal(spec.cwd, 'C:\\wt');
  assert.equal(spec.initialTurnSubmitted, true);
  assert.deepEqual(spec.args.slice(6, 13), [
    '--no-daemon',
    '-c', 'approval_policy="never"',
    '--add-dir', 'C:\\private\\outbox',
    '-c', `projects={'d:\\work\\repo-1'={trust_level="trusted"}}`,
  ]);
  assert.ok(!spec.args.includes('--sandbox'), 'the sandbox stays the account policy');
  assert.equal(spec.args.length, 14);
  assert.match(spec.args[13], /^Your complete task is in the file C:\\private\\prompt\.md \./);

  // The trust root is a TOML literal key, so dots, spaces, and '=' are fine;
  // only ASCII letters fold, matching Windows.
  const trustArg = async repositoryRoot => (await adapter.buildSpec({ ...CODEX_LAUNCH, repositoryRoot })).spec.args[12];
  assert.equal(await trustArg('D:\\Work\\my.repo v2=x'), `projects={'d:\\work\\my.repo v2=x'={trust_level="trusted"}}`);
  assert.equal(await trustArg('D:\\WÖRK\\Repo'), `projects={'d:\\wÖrk\\repo'={trust_level="trusted"}}`);
  // What a literal key cannot carry is refused, never guessed.
  for (const repositoryRoot of ["D:\\Work\\it's", 'D:\\Work\\a\nb', '\\\\server\\share\\repo', 'relative\\repo']) {
    await assert.rejects(adapter.buildSpec({ ...CODEX_LAUNCH, repositoryRoot }), { code: 'provider-trust-unexpressible' });
  }

  const conflicting = createCodexAdapter({
    resolveProfile: async route => ({ kind: 'routed', id: `codex:${route}`, alias: route }),
    buildLaunchSpec: (_profile, ctx) => ({
      file: 'pwsh.exe', args: ['-File', 'entry.ps1', 'target', 'run', 'codex:a', '--', '--add-dir=C:\\'], env: {},
      cwd: 'C:\\elsewhere', agent: 'codex', sessionMode: ctx.sessionMode,
    }),
    launchContext: async () => ({}),
  });
  await assert.rejects(conflicting.buildSpec(CODEX_LAUNCH), { code: 'route-policy-conflict' });
});

test('a qualified codex adapter launches only the version it was qualified on', async () => {
  const probes = [];
  let reported = 'codex-cli 0.165.0\n';
  const adapter = createCodexAdapter({
    resolveProfile: async route => ({ kind: 'routed', id: `codex:${route}`, alias: route }),
    buildLaunchSpec: (_profile, ctx) => ({
      file: 'pwsh.exe', args: ['-File', 'entry.ps1', 'target', 'run', 'codex:a', '--', '-c', 'notify=x'], env: { A: '1' },
      cwd: 'C:\\elsewhere', agent: 'codex', sessionMode: ctx.sessionMode,
    }),
    launchContext: async () => ({}),
    runVersion: async (file, args, options) => { probes.push({ file, args, options }); return reported; },
    qualification: { status: 'qualified', providerVersion: '0.165.0' },
  });
  assert.equal(adapter.qualification, 'qualified');
  assert.equal(adapter.contract, CODEX_ADAPTER_CONTRACT);
  const built = await adapter.buildSpec(CODEX_LAUNCH);
  assert.equal(built.providerVersion, '0.165.0');
  assert.deepEqual(probes[0].args, ['-File', 'entry.ps1', 'target', 'run', 'codex:a', '--', '--version'],
    'the probe uses the exact route prefix and makes no model turn');
  assert.equal(probes[0].options.cwd, 'C:\\wt');

  reported = 'codex-cli 0.166.0';
  await assert.rejects(adapter.buildSpec(CODEX_LAUNCH), { code: 'provider-version-changed' });
  reported = 'something else';
  await assert.rejects(adapter.buildSpec(CODEX_LAUNCH), { code: 'provider-version-unknown' });
});

test('qualification receipts need every axis, and bind the adapter contract', (t) => {
  const dir = tempDir(t, 'ao-qualify-');
  const file = qualificationFile(dir, 'codex');
  const passing = { ...REQUIRED_EVIDENCE };
  assert.deepEqual(readQualification(file, { provider: 'codex', adapterContract: 1 }), { status: 'absent' });
  assert.throws(() => writeQualification(file, {
    provider: 'codex', adapterContract: 1, providerVersion: '0.165.0', evidence: { ...passing, providerRead: 'mismatch' },
  }), /does not qualify/);
  assert.equal(fs.existsSync(file), false, 'a failed turn writes no receipt');
  assert.deepEqual(qualificationShortfall({ ...passing, frame: 'truncated', hostCheck: 'not-passed' }), ['frame', 'hostCheck']);

  writeQualification(file, { provider: 'codex', adapterContract: 1, providerVersion: '0.165.0', evidence: passing });
  assert.equal(readQualification(file, { provider: 'codex', adapterContract: 1 }).providerVersion, '0.165.0');
  assert.deepEqual(readQualification(file, { provider: 'codex', adapterContract: 2 }), { status: 'stale-contract' });
  const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...receipt, evidence: { ...passing, diffComplete: false } }));
  assert.deepEqual(readQualification(file, { provider: 'codex', adapterContract: 1 }), { status: 'invalid' });
});

test('qualification evidence comes from host observations, not AI claims', () => {
  const result = {
    window: { created: true },
    delivery: { providerRead: 'echoed' },
    lifecycle: { turnComplete: { source: 'authenticated-receipt' } },
    evidence: {
      result: { frame: 'complete' },
      checks: { hostObserved: [{ outcome: 'failed' }], comparison: [{ agreement: 'disagree' }] },
      diff: { complete: true },
    },
  };
  const evidence = qualificationEvidence(result, { ownerCheckoutClean: true });
  assert.deepEqual(qualificationShortfall(evidence), ['hostCheck', 'checkAgreement', 'collectionStable'],
    'a snapshot taken while the provider may still be writing never qualifies');
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

test('a workspace is its work tree root however its path is spelled', async (t) => {
  const { repo } = fixtureRepo(t, tempDir(t, 'ao-task-root-long-name-'));
  assert.equal(await isWorkTreeRoot(repo), true);
  assert.equal(await isWorkTreeRoot(repo.toUpperCase()), true, 'letter case');
  fs.mkdirSync(path.join(repo, 'sub'));
  assert.equal(await isWorkTreeRoot(path.join(repo, 'sub')), false, 'a subdirectory is not the root');
  assert.equal(await isWorkTreeRoot(path.join(repo, '.git')), false, 'the Git directory is not a work tree');
  if (process.platform !== 'win32') return;
  // Hosted Windows runners hand out an 8.3 temp path (RUNNER~1); Git reports
  // the long name, so a string comparison refused every workspace there.
  const short = execFileSync('powershell', ['-NoProfile', '-Command',
    `(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${repo.replace(/'/g, "''")}').ShortPath`],
  { encoding: 'utf8', windowsHide: true }).trim();
  if (short.toLowerCase() === repo.toLowerCase()) {
    t.diagnostic('8.3 names are disabled on this volume; the short-path case is not exercised');
    return;
  }
  assert.equal(await isWorkTreeRoot(short), true, '8.3 short path');
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

test('a side turn completing first neither completes the task nor captures its receipt', async (t) => {
  const { host, base } = await hostFixture(t);
  const req = request({ baseRevision: base, route: 'side-thread' });
  startTask(host, req);
  await host.whenIdle();
  const result = host.result(req.launchId);
  assert.equal(result.ending, 'turn-complete');
  assert.equal(result.lifecycle.uncorrelatedReceipts, 1, 'the side turn is counted, not trusted');
  assert.equal(result.lifecycle.turnComplete.source, 'authenticated-receipt');
  assert.equal(result.evidence.result.frame, 'complete', 'the task was not cut off by the side turn');
  assert.equal(result.evidence.checks.comparison[0].agreement, 'agree');
});

test('a wrong nonce is reported as a mismatch', async (t) => {
  const { host, base } = await hostFixture(t);
  const req = request({ baseRevision: base, route: 'wrong-nonce' });
  startTask(host, req);
  await host.whenIdle();
  assert.equal(host.result(req.launchId).delivery.providerRead, 'mismatch');
});

test('a file-channel report is read from the private outbox, outside the diff', async (t) => {
  const { host, base, dataDir } = await hostFixture(t, {
    adapters: { fixture: createFixtureAdapter({ script: FIXTURE_AGENT, resultChannel: 'file' }) },
  });
  const req = request({ baseRevision: base });
  startTask(host, req);
  await host.whenIdle();
  const result = host.result(req.launchId);
  assert.equal(result.delivery.resultChannel, 'file');
  assert.equal(result.delivery.providerRead, 'echoed');
  assert.equal(result.evidence.result.frame, 'complete');
  assert.equal(result.evidence.checks.comparison[0].agreement, 'agree');
  assert.match(result.evidence.result.reportSha256, /^[0-9a-f]{64}$/);
  const outboxes = fs.readdirSync(path.join(dataDir, 'launches', req.launchId)).filter(name => name.startsWith('outbox-'));
  assert.equal(outboxes.length, 1, 'one randomly named outbox');
  assert.match(outboxes[0], /^outbox-[0-9a-f]{16}$/);
  assert.equal(result.evidence.diff.layers.untracked, 2, 'the report is not part of the task diff');
  assert.deepEqual([result.collection.providerEndedByHost, result.collection.rootExitObserved], [true, true],
    'the provider tree ends before evidence is frozen');
  assert.equal(result.collection.stable, true);
  assert.deepEqual(result.collection.descendants, { observed: true, atBoundary: 0, survivors: 0, endedAfterRoot: 0 });
  assert.equal(result.collection.treeTermination, 'not-needed', 'an exited root is never signalled by pid');
  assert.equal(host.windowInput(req.launchId, 'more\r'), false, 'input is closed once collection starts');
  const prompt = fs.readFileSync(path.join(dataDir, 'launches', req.launchId, 'prompt.md'), 'utf8');
  assert.ok(!prompt.includes('AO-TASK-RESULT-BEGIN'), 'no terminal frame is requested');
  assert.match(prompt, /- `test` \(run it as `npm run test`\)/);

  const silent = request({ baseRevision: base, route: 'exit-nonzero' });
  startTask(host, silent);
  await host.whenIdle();
  assert.equal(host.result(silent.launchId).evidence.result.frame, 'missing');
});

test('a file report must be one bounded regular file', (t) => {
  const dir = tempDir(t, 'ao-outbox-');
  const file = path.join(dir, 'result.json');
  assert.equal(readResultFile(file, 64), null, 'absent');
  fs.mkdirSync(file);
  assert.deepEqual(readResultFile(file, 64), { complete: true, text: '' }, 'a directory parses as invalid');
  fs.rmdirSync(file);
  fs.writeFileSync(file, 'x'.repeat(65));
  assert.equal(parseResultFrame(readResultFile(file, 64), createResultFrame()).frame, 'truncated');

  const frame = createResultFrame();
  const body = checks => JSON.stringify({ nonce: frame.nonce, summary: 's', checks });
  fs.writeFileSync(file, `﻿${body([{ name: 'test', outcome: 'passed' }])}`);
  assert.equal(parseResultFrame(readResultFile(file, 4096), frame).nonce, 'echoed', 'a UTF-8 byte-order mark is accepted');
  fs.writeFileSync(file, Buffer.from(body([]), 'utf16le'));
  assert.equal(parseResultFrame(readResultFile(file, 4096), frame).frame, 'invalid', 'UTF-16 is not UTF-8');
  fs.writeFileSync(file, body([{ name: 'test', outcome: 'passed' }, { name: 'test', outcome: 'failed' }]));
  assert.equal(parseResultFrame(readResultFile(file, 4096), frame).frame, 'invalid', 'duplicate claims');
  fs.writeFileSync(file, body([]));
  fs.linkSync(file, path.join(dir, 'alias.json'));
  assert.equal(parseResultFrame(readResultFile(file, 4096), frame).frame, 'invalid', 'a hard-linked report');
  fs.rmSync(path.join(dir, 'alias.json'));

  // A file report is parsed exactly as written.
  fs.writeFileSync(file, `{"nonce":"${frame.nonce}","summary":"two\nlines","checks":[]}`);
  assert.equal(parseResultFrame(readResultFile(file, 4096), frame).frame, 'invalid', 'a literal newline in a string');
  fs.writeFileSync(file, JSON.stringify({ nonce: frame.nonce, summary: 'kept  as\twritten', checks: [] }));
  assert.equal(parseResultFrame(readResultFile(file, 4096), frame).aiReported.summary, 'kept  as\twritten');

  fs.writeFileSync(file, ` ${JSON.stringify({ nonce: frame.nonce, summary: 's', checks: [] })}\u000B`);
  assert.equal(parseResultFrame(readResultFile(file, 4096), frame).frame, 'invalid', 'non-JSON whitespace is not trimmed away');
  fs.writeFileSync(file, `\r\n ${JSON.stringify({ nonce: frame.nonce, summary: 's', checks: [] })}\t\n`);
  assert.equal(parseResultFrame(readResultFile(file, 4096), frame).frame, 'complete', 'JSON whitespace is allowed');

  // A handle that will not close is a failed read, not an accepted report.
  const close = t.mock.method(fs, 'closeSync', () => { throw Object.assign(new Error('io'), { code: 'EIO' }); });
  assert.equal(parseResultFrame(readResultFile(file, 4096), frame).frame, 'invalid');
  close.mock.restore();
  // A read that fails after inspection is an unreadable report, not a crash.
  t.mock.method(fs, 'openSync', () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); });
  assert.equal(parseResultFrame(readResultFile(file, 4096), frame).frame, 'invalid');
});

test('a printed frame tolerates only the terminal wrapping its line', () => {
  const frame = createResultFrame();
  const line = JSON.stringify({ nonce: frame.nonce, summary: 'wrapped by the terminal', checks: [] });
  const wrapped = `${line.slice(0, 40)}\r\n${line.slice(40)}`;
  assert.equal(parseResultFrame({ complete: true, text: `\r\n${wrapped}\r\n` }, frame).frame, 'complete');
  const tabbed = line.replace('wrapped by', 'wrapped\tby');
  assert.equal(parseResultFrame({ complete: true, text: tabbed }, frame).frame, 'invalid');
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

test('admission refuses busy workspaces, unknown routes, unqualified providers, and unobservable sessions', async (t) => {
  const codex = { id: 'codex', qualification: 'unqualified', delivery: 'argv-pointer', lifecycle: 'x', buildSpec: async () => { throw new Error('never'); } };
  const { host, base, presentation } = await hostFixture(t, {
    adapters: { fixture: createFixtureAdapter({ script: FIXTURE_AGENT }), codex },
  });
  assert.deepEqual(startTask(host, request({ provider: 'codex', baseRevision: base })), { ok: false, error: 'provider-unqualified' });
  assert.deepEqual(startTask(host, request({ provider: 'grok', baseRevision: base })), { ok: false, error: 'provider-unavailable' });
  // Project trust is a separate, default-deny opt-in per workspace.
  codex.qualification = 'qualified';
  codex.requiresProjectTrust = true;
  assert.deepEqual(startTask(host, request({ provider: 'codex', baseRevision: base })),
    { ok: false, error: 'workspace-trust-not-granted' });
  codex.qualification = 'unqualified';
  assert.deepEqual(startTask(host, request({ workspace: 'other', baseRevision: base })), { ok: false, error: 'unknown-workspace' });

  const first = request({ baseRevision: base, route: 'no-receipt' });
  assert.equal(startTask(host, first).ok, true);
  assert.deepEqual(startTask(host, request({ baseRevision: base })), { ok: false, error: 'workspace-busy' });
  host.stop(first.launchId);
  await host.whenIdle();

  // The session is read from the system at admission, never assumed.
  host._observeSession = () => 'locked';
  assert.deepEqual(startTask(host, request({ baseRevision: base })), { ok: false, error: 'provider-session-unqualified' });
  host._observeSession = () => 'disconnected';
  assert.deepEqual(startTask(host, request({ baseRevision: base })), { ok: false, error: 'session-state-unknown' });
  host._observeSession = () => { throw new Error('query failed'); };
  assert.deepEqual(startTask(host, request({ baseRevision: base })), { ok: false, error: 'session-state-unknown' });
  host._observeSession = () => 'not-interactive';
  assert.deepEqual(startTask(host, request({ baseRevision: base })), { ok: false, error: 'session-not-interactive' });
  host._observeSession = () => 'unlocked';
  host._observePower = () => 'battery';
  assert.deepEqual(startTask(host, request({ baseRevision: base })), { ok: false, error: 'battery-disallowed' });
  host._observePower = () => undefined;
  assert.deepEqual(startTask(host, request({ baseRevision: base })), { ok: false, error: 'power-state-unknown' });
  host._observePower = () => 'ac';
  host.setSuspending(true);
  assert.deepEqual(startTask(host, request({ baseRevision: base })), { ok: false, error: 'host-suspending' });
  host.setSuspending(false);
  assert.equal(host.capabilities().session, 'unlocked');

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
// ── W2b: unattended starts (docs/w2b-unattended-policy.md) ─────

function writePolicy(host, overrides = {}) {
  fs.writeFileSync(host.policyFile, JSON.stringify({
    schema: 1,
    kind: POLICY_KIND,
    revision: 1,
    hostId: 'target-one',
    profile: 'primary',
    ownerSid: TEST_SID,
    remoteStarts: 'enabled',
    ...overrides,
  }));
}

function authorization(req, overrides = {}) {
  const now = Date.now();
  return {
    destination: 'target-one',
    requestDigest: taskRequestDigest(validateTaskRequest(req)),
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 30_000).toISOString(),
    ...overrides,
  };
}

function remoteStart(host, req, auth = authorization(req)) {
  const normalized = validateTaskRequest(req);
  return host.remoteStart(auth, normalized, taskRequestDigest(normalized));
}

test('the host policy is exact, and only its profile sets the limits', (t) => {
  const dir = tempDir(t, 'ao-task-policy-');
  const file = path.join(dir, 'policy.json');
  assert.equal(readPolicy(file).status, 'absent');
  const valid = {
    schema: 1, kind: POLICY_KIND, revision: 3, hostId: 'snowy-npc', profile: 'light', ownerSid: TEST_SID, remoteStarts: 'enabled',
  };
  fs.writeFileSync(file, JSON.stringify(valid));
  const policy = readPolicy(file);
  assert.equal(policy.status, 'valid');
  assert.deepEqual(policy.limits, PROFILES.light);
  for (const bad of [
    { ...valid, profile: 'unlimited' },
    { ...valid, remoteStarts: true },
    { ...valid, hostId: 'Snowy NPC' },
    { ...valid, maxActiveTasks: 9 },
    { ...valid, revision: 0 },
    { ...valid, ownerSid: 'snowy' },
  ]) {
    fs.writeFileSync(file, JSON.stringify(bad));
    assert.equal(readPolicy(file).status, 'invalid', JSON.stringify(bad));
  }
  assert.deepEqual(PROFILES.primary, { maxActiveTasks: 2, taskTimeoutMs: 2 * 3_600_000, maxStartsPerDay: 24 });
  assert.deepEqual(PROFILES.secondary, { maxActiveTasks: 1, taskTimeoutMs: 3_600_000, maxStartsPerDay: 12 });
  assert.deepEqual(PROFILES.light, { maxActiveTasks: 1, taskTimeoutMs: 20 * 60_000, maxStartsPerDay: 4 });
});

test('a remote authorization names this host and the exact request, and expires within a minute', () => {
  const policy = {
    status: 'valid', hostId: 'target-one', ownerSid: TEST_SID, remoteStarts: 'enabled', profile: 'primary',
  };
  const digest = 'a'.repeat(64);
  const now = Date.parse('2026-10-30T12:00:00.000Z');
  const auth = (overrides = {}) => ({
    destination: 'target-one',
    requestDigest: digest,
    issuedAt: '2026-10-30T11:59:50.000Z',
    expiresAt: '2026-10-30T12:00:20.000Z',
    ...overrides,
  });
  const check = (a, extra = {}) => checkRemoteAuthorization(a, { policy, digest, account: TEST_SID, now, ...extra });
  assert.equal(check(auth()), null);
  assert.equal(check(auth(), { policy: { ...policy, remoteStarts: 'disabled' } }), 'remote-starts-disabled');
  assert.equal(check(auth(), { policy: { status: 'absent' } }), 'remote-starts-disabled');
  assert.equal(check(auth({ destination: 'target-two' })), 'wrong-destination');
  assert.equal(check(auth({ requestDigest: 'b'.repeat(64) })), 'digest-mismatch');
  assert.equal(check(auth({ expiresAt: '2026-10-30T11:59:59.000Z' })), 'authorization-expired');
  assert.equal(check(auth({ issuedAt: '2026-10-30T12:00:10.000Z', expiresAt: '2026-10-30T12:00:30.000Z' })),
    'authorization-expired', 'issued too far in the future');
  assert.equal(check(auth({ expiresAt: '2026-10-30T12:00:51.000Z' })), 'invalid-authorization', 'longer than 60 s');
  assert.equal(check(auth({ extra: 1 })), 'invalid-authorization');
  assert.equal(check(auth({ issuedAt: '2026-10-30 11:59:50' })), 'invalid-authorization');
  assert.equal(check(auth(), { account: 'S-1-5-21-1000-2000-3000-1002' }), 'session-owner-mismatch',
    'another account, whatever its name');
  assert.equal(check(auth(), { account: null }), 'session-owner-mismatch', 'an unreadable account never matches');
});

test('remote starts are off without a policy, and a retry after expiry never starts another task', async (t) => {
  const { host, base } = await hostFixture(t);
  const req = request({ baseRevision: base });
  assert.deepEqual(remoteStart(host, req), { ok: false, error: 'remote-starts-disabled' });
  writePolicy(host, { remoteStarts: 'disabled' });
  assert.deepEqual(remoteStart(host, req), { ok: false, error: 'remote-starts-disabled' });
  writePolicy(host);
  assert.deepEqual(remoteStart(host, req, authorization(req, { destination: 'target-two' })), { ok: false, error: 'wrong-destination' });
  const ack = remoteStart(host, req);
  assert.equal(ack.ok, true);
  assert.equal(ack.duplicate, false);
  await host.whenIdle();
  const result = host.result(req.launchId);
  assert.equal(result.origin, 'remote');
  assert.deepEqual(result.admission, { session: 'unlocked', power: 'ac', policy: { revision: 1, profile: 'primary' } });
  const expired = authorization(req, {
    issuedAt: new Date(Date.now() - 120_000).toISOString(),
    expiresAt: new Date(Date.now() - 90_000).toISOString(),
  });
  const retry = remoteStart(host, req, expired);
  assert.equal(retry.ok, true);
  assert.equal(retry.duplicate, true);
  assert.equal(retry.state, 'needs-review');
  assert.equal(launchCount(host._dataDir), 1);
  const fresh = request({ baseRevision: base });
  assert.deepEqual(remoteStart(host, fresh, expired), { ok: false, error: 'digest-mismatch' });
  assert.deepEqual(remoteStart(host, fresh, { ...expired, requestDigest: authorization(fresh).requestDigest }),
    { ok: false, error: 'authorization-expired' });
});

test('the profile limits concurrency and starts per day', async (t) => {
  const { host, base } = await hostFixture(t);
  writePolicy(host, { profile: 'light' });
  const first = request({ baseRevision: base, route: 'no-receipt' });
  assert.equal(startTask(host, first).ok, true);
  fs.writeFileSync(host.workspacesFile, JSON.stringify({
    schema: 1, workspaces: { fixture: host._readWorkspaces().fixture.path, second: host._readWorkspaces().fixture.path },
  }));
  assert.deepEqual(startTask(host, request({ baseRevision: base, workspace: 'second' })), { ok: false, error: 'host-busy' });
  assert.equal(host.capabilities().limits.taskTimeoutMs, PROFILES.light.taskTimeoutMs);
  host.stop(first.launchId);
  await host.whenIdle();
  for (let i = 0; i < 3; i += 1) {
    const req = request({ baseRevision: 'b'.repeat(40) });
    assert.equal(startTask(host, req).ok, true);
    await host.whenIdle();
  }
  assert.equal(host.capabilities().limits.startsInLastDay, 4);
  assert.deepEqual(startTask(host, request({ baseRevision: base })), { ok: false, error: 'daily-limit-reached' });
});

test('a locked session admits only an adapter qualified while locked', async (t) => {
  const { host, base } = await hostFixture(t, {
    adapters: { fixture: createFixtureAdapter({ script: FIXTURE_AGENT, lockedSession: true }) },
    hostOptions: { observeSession: () => 'locked' },
  });
  const req = request({ baseRevision: base });
  assert.equal(startTask(host, req).ok, true);
  await host.whenIdle();
  assert.equal(host.status(req.launchId).state, 'needs-review');
  assert.equal(host.result(req.launchId).admission.session, 'locked');
  assert.equal(host.capabilities().providers[0].lockedSession, true);
});

test('the machine is kept awake only while a task is active, and stops off AC', async (t) => {
  const holds = [];
  let power = 'ac';
  const { host, base } = await hostFixture(t, {
    hostOptions: {
      observePower: () => power,
      holdAwake: () => { const hold = { released: false }; holds.push(hold); return () => { hold.released = true; }; },
    },
  });
  const req = request({ baseRevision: base, route: 'no-receipt' });
  startTask(host, req);
  assert.equal(host.awakeHeld, true);
  await waitFor(() => host.status(req.launchId).state === 'running');
  power = 'battery';
  assert.equal(host.powerChanged(), 1);
  await host.whenIdle();
  const result = host.result(req.launchId);
  assert.equal(result.state, 'needs-review');
  assert.equal(result.stop.reason, 'on-battery');
  assert.equal(result.evidence.checks.skipped, 'on-battery');
  assert.deepEqual(result.evidence.checks.hostObserved, [], 'no host checks run off AC');
  assert.equal(host.awakeHeld, false);
  assert.deepEqual(holds.map(hold => hold.released), [true], 'one hold, released once idle');
  assert.deepEqual(startTask(host, request({ baseRevision: base })), { ok: false, error: 'battery-disallowed' });
  assert.equal(holds.length, 1, 'a refused start holds nothing');
});

test('list shows launches without instruction, terminal content, or route alias', async (t) => {
  const { host, base } = await hostFixture(t);
  const req = request({ baseRevision: base, route: 'complete', instruction: 'SECRET-INSTRUCTION do the work' });
  startTask(host, req);
  await host.whenIdle();
  startTask(host, request({ baseRevision: 'b'.repeat(40) }));
  await host.whenIdle();
  const listed = await host.handle({ op: 'list' });
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.launches.map(entry => entry.state), ['failed-to-start', 'needs-review'], 'newest first');
  assert.equal(listed.launches[1].provider, 'fixture');
  assert.equal(listed.launches[1].origin, 'local');
  const text = JSON.stringify(listed);
  assert.ok(listed.launches.every(entry => !('route' in entry)), 'no route alias');
  for (const secret of ['SECRET-INSTRUCTION', 'fixture agent', 'AO-TASK']) {
    assert.ok(!text.includes(secret), `list leaks ${secret}`);
  }
  assert.equal(validateEnvelope({ token: 'x', op: 'list' }).op, 'list');
  const normalized = validateTaskRequest(req);
  const envelope = {
    token: 'x', op: 'remote-start', authorization: authorization(req), request: normalized, digest: taskRequestDigest(normalized),
  };
  assert.equal(validateEnvelope(envelope).op, 'remote-start');
  assert.throws(() => validateEnvelope({ ...envelope, authorization: 'yes' }), { code: 'invalid-authorization' });
});

test('task windows open with a neutral title', async (t) => {
  const { host, base, presentation } = await hostFixture(t);
  const req = request({ baseRevision: base, route: 'complete' });
  startTask(host, req);
  await host.whenIdle();
  assert.equal(presentation.opened[0].title, 'Task fixture-task · fixture');
  assert.equal(host.windowAttach(req.launchId).state.route, undefined);
});

test('descendants are found by creation order, never by a reused pid', () => {
  const processes = [
    { pid: 10, ppid: 1, created: 100 },
    { pid: 11, ppid: 10, created: 110 },
    { pid: 12, ppid: 11, created: 120 },
    { pid: 13, ppid: 10, created: 50 }, // older than its "parent": pid reuse
    { pid: 14, ppid: 99, created: 130 }, // parent 99 exited; anchored by the snapshot
  ];
  const keys = list => list.map(entry => entry.pid).sort((a, b) => a - b);
  assert.deepEqual(keys(descendantsOf(processes, [{ pid: 10, ppid: 1, created: 100 }])), [10, 11, 12]);
  assert.deepEqual(keys(descendantsOf(processes, [{ pid: 10, ppid: 1, created: 90 }])), [],
    'a live process with another creation time replaced the root; its children belong to it, not the task');
  assert.deepEqual(keys(descendantsOf(processes, [{ pid: 99, ppid: 1, created: 125 }])), [14]);
});

test('a descendant left behind by the provider is ended before evidence is frozen', async (t) => {
  const { host, base } = await hostFixture(t, {
    hostOptions: { processTree: createProcessTree({ killPid: pid => { try { process.kill(pid); } catch (_error) { /* gone */ } } }) },
  });
  const req = request({ baseRevision: base, route: 'orphan' });
  startTask(host, req);
  await host.whenIdle();
  const result = host.result(req.launchId);
  assert.equal(result.state, 'needs-review');
  const { collection } = result;
  assert.equal(collection.rootExitObserved, true);
  assert.equal(collection.descendants.observed, true);
  assert.equal(collection.descendants.survivors, 0);
  assert.ok(collection.descendants.endedAfterRoot >= 1, 'the orphan was found and ended');
  assert.equal(collection.stable, true);
  const orphan = Number(fs.readFileSync(path.join(host._dataDir, 'worktrees', req.launchId, 'ignored', 'orphan.pid'), 'utf8'));
  assert.throws(() => process.kill(orphan, 0), { code: 'ESRCH' }, 'the orphan is gone');
});

test('a collection whose descendants cannot be observed is never stable', async (t) => {
  const { host, base } = await hostFixture(t, {
    hostOptions: { processTree: { ...settledTree, settle: async () => ({ observed: false, survivors: null, endedByHost: 0 }) } },
  });
  const req = request({ baseRevision: base });
  startTask(host, req);
  await host.whenIdle();
  assert.equal(host.result(req.launchId).collection.stable, false);
  const survivor = await hostFixture(t, {
    hostOptions: { processTree: { ...settledTree, settle: async () => ({ observed: true, survivors: 1, endedByHost: 3 }) } },
  });
  const other = request({ baseRevision: survivor.base });
  startTask(survivor.host, other);
  await survivor.host.whenIdle();
  assert.equal(survivor.host.result(other.launchId).collection.stable, false);
});

test('a locked qualification is kept across an unlocked one of the same version only', (t) => {
  const dir = tempDir(t, 'ao-qual-session-');
  const file = qualificationFile(dir, 'codex');
  const evidence = { ...REQUIRED_EVIDENCE };
  const read = () => readQualification(file, { provider: 'codex', adapterContract: 1 });
  writeQualification(file, { provider: 'codex', adapterContract: 1, providerVersion: '1.0.0', evidence });
  assert.deepEqual([read().sessions, read().lockedSession], [['unlocked'], false]);
  writeQualification(file, { provider: 'codex', adapterContract: 1, providerVersion: '1.0.0', evidence, session: 'locked' });
  writeQualification(file, { provider: 'codex', adapterContract: 1, providerVersion: '1.0.0', evidence });
  assert.deepEqual([read().sessions, read().lockedSession], [['unlocked', 'locked'], true]);
  writeQualification(file, { provider: 'codex', adapterContract: 1, providerVersion: '1.0.1', evidence });
  assert.deepEqual(read().sessions, ['unlocked'], 'a new version must be qualified locked again');
  const legacy = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete legacy.sessions;
  fs.writeFileSync(file, JSON.stringify(legacy));
  assert.deepEqual(read().sessions, ['unlocked'], 'a receipt from before sessions were recorded was unlocked');
  fs.writeFileSync(file, JSON.stringify({ ...legacy, sessions: ['asleep'] }));
  assert.equal(read().status, 'invalid');
  assert.throws(() => writeQualification(file, {
    provider: 'codex', adapterContract: 1, providerVersion: '1.0.1', evidence, session: 'unknown',
  }));
});
// ── independent review (2026-10-31) regressions ────────────────

test('a child of a process that reused an anchor pid is not the task\'s', () => {
  const root = { pid: 10, ppid: 1, created: 100 };
  const processes = [
    { pid: 10, ppid: 5, created: 200 }, // pid 10 now belongs to another process
    { pid: 11, ppid: 10, created: 210 }, // ...whose child this is
    { pid: 12, ppid: 10, created: 150 }, // created before the reuse: the task's orphan
  ];
  assert.deepEqual(descendantsOf(processes, [root]).map(entry => entry.pid), [12]);
});

test('settling keeps every process it found, so a grandchild of an exited child is still ended', async () => {
  const root = { pid: 10, ppid: 1, created: 100 };
  const listings = [
    [{ pid: 20, ppid: 10, created: 120 }], // child started after the boundary
    [{ pid: 30, ppid: 20, created: 130 }], // the child exited, leaving a grandchild
    [],
  ];
  const killed = [];
  const tree = createProcessTree({
    list: async () => listings.shift() || [],
    killPid: pid => killed.push(pid),
    delay: async () => {},
  });
  const settled = await tree.settle([root]);
  assert.deepEqual(killed, [20, 30]);
  assert.deepEqual(settled, { observed: true, survivors: 0, endedByHost: 2 });
});

test('the system observer reads the session, power, and account from Windows, and ages into unknown', async () => {
  assert.deepEqual(parseObservation('1 0 1|1|S-1-5-21-1-2-3-1001'), { session: 'unlocked', power: 'ac', sid: 'S-1-5-21-1-2-3-1001' });
  assert.deepEqual(parseObservation('1 0 0|0|x'), { session: 'locked', power: 'battery', sid: null });
  assert.equal(parseObservation('2 4 1|1|x').session, 'locked', 'a disconnected session is locked');
  assert.equal(parseObservation('0 0 1|1|x').session, 'not-interactive');
  assert.equal(parseObservation('1 0 -1|255|x').session, 'unknown', 'unknown lock flag');
  assert.equal(parseObservation('1 0 -1|255|x').power, 'unknown', 'unknown AC status is not AC');
  assert.equal(parseObservation('error|error|error').session, 'unknown');

  const { EventEmitter, PassThrough } = require('node:stream');
  let clock = 0;
  const answers = ['1 0 1|1|S-1-5-21-1-2-3-1001', '1 0 0|0|S-1-5-21-1-2-3-1001'];
  const changes = [];
  const observer = createSystemObserver({
    now: () => clock,
    pollMs: 60_000,
    onChange: (current, previous) => changes.push([previous?.power ?? null, current.power]),
    spawnHelper: () => {
      const child = new (require('node:events'))();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.stdin.on('data', () => child.stdout.write(`${answers.shift() ?? 'error|error|error'}\n`));
      child.kill = () => {};
      return child;
    },
  });
  assert.equal(observer.session(), 'unknown', 'nothing is assumed before the first answer');
  assert.equal(await observer.start(), true);
  assert.deepEqual([observer.session(), observer.power(), observer.account()], ['unlocked', 'ac', 'S-1-5-21-1-2-3-1001']);
  observer.refresh();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual([observer.session(), observer.power()], ['locked', 'battery']);
  assert.deepEqual(changes, [[null, 'ac'], ['ac', 'battery']]);
  clock += 16_000;
  assert.deepEqual([observer.session(), observer.power(), observer.account()], ['unknown', 'unknown', null], 'a stale answer is unknown');
  observer.stop();
  void EventEmitter;
});

test('going off AC ends a host check that is already running', async (t) => {
  let power = 'ac';
  const { host, base } = await hostFixture(t, { hostOptions: { observePower: () => power } });
  const req = request({ baseRevision: base, checks: [{ kind: 'npm-script', name: 'slow' }, { kind: 'npm-script', name: 'test' }] });
  startTask(host, req);
  await waitFor(() => host.status(req.launchId).state === 'collecting', 60_000);
  await new Promise(resolve => setTimeout(resolve, 2_000)); // the slow check is running
  power = 'battery';
  const started = Date.now();
  host.powerChanged();
  await host.whenIdle();
  const { checks } = host.result(req.launchId).evidence;
  assert.ok(Date.now() - started < 30_000, 'the check did not run to its end');
  assert.equal(checks.skipped, 'on-battery');
  assert.deepEqual(checks.hostObserved.map(check => [check.name, check.outcome]), [['slow', 'cancelled']]);
});
