// `electron . --task-host-fixture`: drive the real ingress, real task windows,
// and real PTYs with the fixture provider only, then exit with a report.
//
// It runs on throwaway user data against a throwaway Git repository. It never
// starts a real provider, resolves an account, or opens anything but loopback.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { randomUUID } = require('crypto');

const { readDiscovery, sendIngressCommand } = require('./ingress');
const { taskRequestDigest, validateTaskRequest } = require('./request');

const TERMINAL = new Set(['needs-review', 'failed-to-start', 'interrupted', 'uncertain']);

function createFixtureRepo(dir) {
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true }).trim();
  fs.mkdirSync(dir, { recursive: true });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'user.name', 'Fixture');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'fixture-repo', private: true, scripts: { test: 'node test.js' },
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'test.js'), "process.exit(require('fs').existsSync('fixture-output.txt') ? 0 : 1);\n");
  fs.writeFileSync(path.join(dir, 'README.md'), '# Fixture\n');
  git('add', '--', 'package.json', 'test.js', 'README.md');
  git('commit', '-q', '-m', 'base');
  return git('rev-parse', 'HEAD');
}

async function runTaskHostFixture({ host, presentation, dataDir, BrowserWindow, log = console.log }) {
  const results = [];
  const check = (name, ok, detail = '') => {
    results.push({ name, ok: !!ok, detail });
    log(`[TaskHostFixture] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  };
  const repo = path.join(dataDir, 'fixture-repo');
  const base = createFixtureRepo(repo);
  fs.writeFileSync(host.workspacesFile, JSON.stringify({ schema: 1, workspaces: { fixture: repo } }));

  const discovery = readDiscovery(dataDir);
  const call = command => sendIngressCommand(discovery, command);
  const makeRequest = (route, overrides = {}) => validateTaskRequest({
    schema: 1,
    kind: 'agent-orchestrator.task-launch',
    launchId: randomUUID(),
    taskId: `fixture-${route}`,
    provider: 'fixture',
    route,
    workspace: 'fixture',
    baseRevision: base,
    presentation: 'task-window',
    instruction: 'Create fixture-output.txt so that `npm run test` passes. Do not commit.',
    checks: [{ kind: 'npm-script', name: 'test' }],
    gitEffects: 'edits-only',
    ...overrides,
  });
  const start = request => call({ op: 'start', request, digest: taskRequestDigest(request) });
  const waitFor = async (launchId, predicate, timeoutMs = 60_000) => {
    const started = Date.now();
    for (;;) {
      const status = await call({ op: 'status', launchId });
      if (predicate(status)) return status;
      if (Date.now() - started > timeoutMs) return status;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  };
  const windowVisible = id => {
    const win = Number.isInteger(id) ? BrowserWindow.fromId(id) : null;
    return !!win && !win.isDestroyed() && win.isVisible();
  };

  // Ingress boundary.
  const caps = await call({ op: 'capabilities' });
  check('capabilities are observed with an expiry', caps.ok && Date.parse(caps.expiresAt) > Date.parse(caps.observedAt));
  check('only the fixture provider is admitted',
    caps.providers?.find(p => p.provider === 'fixture')?.admitted === true &&
    caps.providers?.find(p => p.provider === 'codex')?.admitted === false);
  check('a wrong token is refused',
    (await sendIngressCommand({ ...discovery, token: '0'.repeat(64) }, { op: 'capabilities' })).error === 'unauthorized');
  check('an unqualified provider is refused at admission',
    (await start(makeRequest('default', { provider: 'codex' }))).error === 'provider-unqualified');
  check('an unregistered workspace is refused',
    (await start(makeRequest('complete', { workspace: 'elsewhere' }))).error === 'unknown-workspace');

  // A complete task, with double-start protection.
  const complete = makeRequest('complete');
  const ack = await start(complete);
  check('start acknowledges acceptance only', ack.ok && ack.state === 'accepted' && !ack.duplicate);
  check('a repeated start returns the same launch', (await start(complete)).duplicate === true);
  check('the same launch id with different bytes is refused',
    (await start({ ...complete, route: 'ask' })).error === 'launch-id-conflict');
  const done = await waitFor(complete.launchId, s => TERMINAL.has(s.state));
  check('the complete task reaches needs-review', done.state === 'needs-review', done.state);
  const result = await call({ op: 'result', launchId: complete.launchId });
  check('it ran in a new visible window', result.window?.created && result.window.nativeHandle && windowVisible(result.window.windowId));
  const rendered = await BrowserWindow.fromId(result.window?.windowId)?.webContents.executeJavaScript(
    "[document.querySelector('.xterm-rows')?.textContent || '', document.getElementById('task-state')?.textContent || '']",
  ).catch(() => null);
  check('the task window shows its own terminal and state',
    rendered?.[0].includes('fixture agent (complete) starting') && rendered[1] === 'needs review',
    rendered ? `state "${rendered[1]}"` : 'unreadable');
  check('the provider read the private instruction', result.delivery?.providerRead === 'echoed',
    `${result.delivery?.providerRead} / frame ${result.evidence?.result?.frame}`);
  check('turn completion came from an authenticated receipt', result.lifecycle?.turnComplete?.source === 'authenticated-receipt');
  check('the result frame is complete and labelled AI-reported',
    result.evidence?.result?.frame === 'complete' && result.evidence.result.source === 'ai-reported');
  const observed = result.evidence?.checks?.hostObserved?.[0];
  check('the host ran the check itself against the collected tree',
    observed?.outcome === 'passed' && observed.tree === result.evidence.diff.tree && observed.definitionChangedFromBase === false);
  check('AI claim and host observation agree', result.evidence?.checks?.comparison?.[0]?.agreement === 'agree');
  check('the diff is complete, includes untracked and binary files',
    result.evidence?.diff?.complete && result.evidence.diff.layers.untracked === 2 && result.evidence.diff.binaryFiles === 1);
  const diff = await call({ op: 'diff', launchId: complete.launchId });
  const patch = diff.ok ? Buffer.from(diff.patchBase64, 'base64').toString('utf8') : '';
  check('the explicit diff retrieval returns the recorded patch',
    diff.patchSha256 === result.evidence?.diff?.patchSha256 && patch.includes('fixture-output.txt'));
  check("the owner's checkout is untouched",
    execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim() === '');

  // An AI claim the host does not confirm, in a different window.
  const claim = makeRequest('claim-false');
  await start(claim);
  await waitFor(claim.launchId, s => TERMINAL.has(s.state));
  const claimResult = await call({ op: 'result', launchId: claim.launchId });
  check('a false AI check claim is reported as disagreement',
    claimResult.evidence?.checks?.comparison?.[0]?.agreement === 'disagree');
  check('each task gets its own window', claimResult.window?.windowId !== result.window?.windowId);

  // No receipt: running until stopped; closing the window only detaches it.
  const silent = makeRequest('no-receipt');
  await start(silent);
  await waitFor(silent.launchId, s => s.state === 'running');
  check('a second task in a busy workspace is refused', (await start(makeRequest('complete'))).error === 'workspace-busy');
  await new Promise(resolve => setTimeout(resolve, 1_500));
  presentation.window(silent.launchId)?.close();
  await new Promise(resolve => setTimeout(resolve, 500));
  const detached = await call({ op: 'status', launchId: silent.launchId });
  check('silence is not completion, and closing the window detaches it',
    detached.state === 'running' && detached.process?.running && detached.window?.open === false,
    `${detached.state} running=${detached.process?.running} open=${detached.window?.open}`);
  const shown = await call({ op: 'show', launchId: silent.launchId });
  check('show reopens a window onto the running task', shown.status === 'reopened' && presentation.isOpen(silent.launchId));
  check('stop is acknowledged as a request', (await call({ op: 'stop', launchId: silent.launchId })).status === 'stop-requested');
  const stopped = await waitFor(silent.launchId, s => TERMINAL.has(s.state));
  const stoppedResult = await call({ op: 'result', launchId: silent.launchId });
  check('stop ends the task and evidence is still collected',
    stopped.ending === 'stopped' && stoppedResult.stop?.rootExitObservedAt &&
    stoppedResult.stop.effectReconciliation === 'not-performed' && stoppedResult.evidence?.diff?.complete,
    `${stopped.state}/${stopped.ending} exit=${stoppedResult.stop?.rootExitObservedAt ? 'observed' : 'none'}`);
  check('the reopened window was counted', stoppedResult.window?.reopenedCount === 1 && stoppedResult.window.detachedCount === 1);

  return { passed: results.every(r => r.ok), results };
}

module.exports = { runTaskHostFixture };
