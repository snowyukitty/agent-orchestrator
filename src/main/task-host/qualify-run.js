// `electron . --task-host-qualify --confirm-live`: one owner-authorized live
// turn that qualifies the Codex adapter for the desktop task host.
//
// It drives the same real ingress, task window, PTY, lifecycle receipt, and
// evidence pipeline as the fixture run, but the provider is routed Codex and
// the task is harmless: create one marker file in a throwaway repository so
// that repository's own test passes. Nothing outside that repository and the
// throwaway user data is touched. The report is aggregate facts only: no route
// alias, path, prompt, or provider output is printed.
//
// When every qualification axis holds, it writes a receipt to the production
// task-host directory binding the result to the adapter contract and the
// exact Codex version observed. When any axis fails, no receipt is written.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { randomUUID } = require('crypto');

const { readDiscovery, sendIngressCommand } = require('./ingress');
const { taskRequestDigest, validateTaskRequest } = require('./request');
const { createFixtureRepo } = require('./fixture-run');
const {
  qualificationEvidence, qualificationShortfall, writeQualification,
} = require('./qualification');

const TERMINAL = new Set(['needs-review', 'failed-to-start', 'interrupted', 'uncertain']);
// The harmless task takes well under a minute; a stalled turn should not burn quota.
const TURN_TIMEOUT_MS = 3 * 60_000;

const INSTRUCTION = [
  'Create a file named fixture-output.txt in the current working directory',
  'containing the single line `done`. Do not change, create, or delete any other',
  'file, and do not commit. This is a qualification task for the host that',
  'launched you; the repository is a throwaway fixture.',
].join(' ');

async function runTaskHostQualification({
  dataDir, receiptFile, route, adapterContract, log = console.log,
}) {
  const report = (name, ok, detail = '') => log(`[TaskHostQualify] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  const repo = path.join(dataDir, 'qualify-repo');
  const base = createFixtureRepo(repo);
  fs.writeFileSync(path.join(dataDir, 'workspaces.json'), JSON.stringify({ schema: 1, workspaces: { qualify: { path: repo, codexProjectTrust: 'allow' } } }));

  const discovery = readDiscovery(dataDir);
  const call = command => sendIngressCommand(discovery, command);
  const request = validateTaskRequest({
    schema: 1,
    kind: 'agent-orchestrator.task-launch',
    launchId: randomUUID(),
    taskId: 'codex-qualification',
    provider: 'codex',
    route,
    workspace: 'qualify',
    baseRevision: base,
    presentation: 'task-window',
    instruction: INSTRUCTION,
    checks: [{ kind: 'npm-script', name: 'test' }],
    gitEffects: 'edits-only',
  });

  const ack = await call({ op: 'start', request, digest: taskRequestDigest(request) });
  report('the live launch was accepted', ack.ok && ack.state === 'accepted', ack.ok ? '' : ack.error);
  if (!ack.ok) return { qualified: false, shortfall: ['accepted'] };

  const started = Date.now();
  let status;
  let stopSent = false;
  for (;;) {
    status = await call({ op: 'status', launchId: request.launchId });
    if (TERMINAL.has(status.state)) break;
    if (!stopSent && Date.now() - started > TURN_TIMEOUT_MS) {
      stopSent = true;
      log('[TaskHostQualify] no completion within the turn timeout; stopping the task');
      await call({ op: 'stop', launchId: request.launchId });
    }
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
  const result = await call({ op: 'result', launchId: request.launchId });
  const ownerCheckoutClean = execFileSync('git', ['status', '--porcelain'], {
    cwd: repo, encoding: 'utf8', windowsHide: true,
  }).trim() === '';
  const evidence = qualificationEvidence(result, { ownerCheckoutClean });
  const providerVersion = result.delivery?.providerVersion ?? null;

  report('the task ended in needs-review', status.state === 'needs-review',
    `${status.state}${status.reason ? `/${status.reason}` : ''}, ending ${status.ending ?? 'none'}`);
  report('the provider version was observed through the route', !!providerVersion, providerVersion || 'unknown');
  log(`[TaskHostQualify] receipts for other turns in the provider process: ${result.lifecycle?.uncorrelatedReceipts || 0}`);
  for (const [axis, value] of Object.entries(evidence)) {
    report(`qualification axis ${axis}`, !qualificationShortfall(evidence).includes(axis), String(value));
  }
  const shortfall = qualificationShortfall(evidence);
  if (status.state !== 'needs-review') shortfall.unshift('needs-review');
  if (!providerVersion) shortfall.push('providerVersion');
  if (shortfall.length) {
    // The throwaway user data is removed at exit; keep the failed turn's
    // terminal transcript privately beside the receipts so it can be read.
    const transcript = path.join(dataDir, 'launches', request.launchId, 'terminal.log');
    if (fs.existsSync(transcript)) {
      fs.mkdirSync(path.dirname(receiptFile), { recursive: true });
      fs.copyFileSync(transcript, path.join(path.dirname(receiptFile), 'codex.last-failure.log'));
      log('[TaskHostQualify] the failed turn\'s terminal transcript is kept privately beside the receipts');
    }
    log(`[TaskHostQualify] NOT qualified: ${shortfall.join(', ')}. No receipt was written.`);
    return { qualified: false, shortfall, evidence };
  }
  writeQualification(receiptFile, { provider: 'codex', adapterContract, providerVersion, evidence });
  // A transcript from an earlier failed turn no longer describes this state.
  fs.rmSync(path.join(path.dirname(receiptFile), 'codex.last-failure.log'), { force: true });
  log(`[TaskHostQualify] QUALIFIED codex-cli ${providerVersion} for adapter contract ${adapterContract}`);
  return { qualified: true, shortfall: [], evidence, providerVersion };
}

module.exports = { INSTRUCTION, runTaskHostQualification };
