const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
} = require('../src/main/scheduled-prompt-delivery');

const {
  expectResponseMarker,
  environmentProbe,
  failOnProviderBlock,
  fragments,
  notifyContractSatisfied,
  observeExpectedResponse,
  observeProviderSignals,
  readToolEnvironmentProbe,
  requestedAccountNumber,
  submitLocalShellProbe,
  typeHumanPrompt,
} = require('../scripts/manual-verify-direct-delivery');

function signalState() {
  return {
    signalCarry: '',
    providerSignals: {
      usageLimited: false,
      authenticationRequired: false,
      trustRequired: false,
      approvalRequired: false,
      connectionFailure: false,
    },
  };
}

test('live delivery gate requires a valid explicit account ordinal', () => {
  assert.equal(requestedAccountNumber([]), 1);
  assert.equal(requestedAccountNumber(['--account-number=2']), 2);
  for (const argv of [
    ['--account-number=0'],
    ['--account-number=1.5'],
    ['--account-number=two'],
    ['--account-number=1', '--account-number=2'],
  ]) {
    assert.throws(
      () => requestedAccountNumber(argv),
      error => error?.code === 'invalid-account-number'
    );
  }
});

test('live delivery gate submits through the same human-paced double Enter contract', async () => {
  const writes = [];
  const delays = [];
  let safetyChecks = 0;
  await typeHumanPrompt(
    { write: (_id, text) => { writes.push(text); return true; } },
    'session-id',
    'ab',
    () => { safetyChecks += 1; },
    { delayFn: async ms => delays.push(ms), charDelayMs: 75, enterGapMs: 150 }
  );
  assert.deepEqual(writes, ['a', 'b', '\r', '\r']);
  assert.deepEqual(delays, [75, 75, 150]);
  assert.equal(safetyChecks, 4);
});

test('live delivery gate submits its deterministic local-shell probe with one protected Enter', async () => {
  const writes = [];
  const delays = [];
  let safetyChecks = 0;
  const probe = { command: 'Write-Output safe' };
  await submitLocalShellProbe(
    { write: (_id, text) => { writes.push(text); return true; } },
    'session-id',
    probe,
    () => { safetyChecks += 1; },
    { delayFn: async ms => delays.push(ms), settleMs: 150 }
  );
  assert.deepEqual(writes, [
    '!',
    `${BRACKETED_PASTE_START}${probe.command}${BRACKETED_PASTE_END}`,
    '\r',
  ]);
  assert.deepEqual(delays, [150, 150]);
  assert.equal(safetyChecks, 3);
});

test('live delivery gate rejects unsafe local-shell probe bodies before writing', async () => {
  const registry = {
    write: () => {
      assert.fail('an invalid probe body must never reach the PTY');
    },
  };
  for (const command of ['', 'line\rbreak', 'line\nbreak', `escape\x1b[201~tail`, undefined]) {
    await assert.rejects(
      submitLocalShellProbe(registry, 'session-id', { command }, () => {}),
      /one terminal line/
    );
  }
});

test('live delivery gate classifies chunked provider blockers without retaining output', () => {
  const state = signalState();
  observeProviderSignals(state, '\x1b[31mUsage limit re');
  observeProviderSignals(state, 'ached\x1b[0m');
  observeProviderSignals(state, 'Do you trust the contents of this direc');
  observeProviderSignals(state, 'tory?');

  assert.deepEqual(state.providerSignals, {
    usageLimited: true,
    authenticationRequired: false,
    trustRequired: true,
    approvalRequired: false,
    connectionFailure: false,
  });
  assert.ok(state.signalCarry.length <= 512);
});

test('live delivery gate fails closed on a recognized provider blocker', () => {
  const state = signalState();
  state.providerSignals.approvalRequired = true;
  assert.throws(
    () => failOnProviderBlock(state.providerSignals),
    error => error?.code === 'provider-approval-required'
  );
});

test('live delivery gate binds an ANSI-split response marker without echoing it in the prompt', () => {
  const state = signalState();
  const challenge = fragments('TEST');
  assert.equal(challenge.prompt.includes(challenge.responseMarker), false);

  expectResponseMarker(state, challenge.responseMarker);
  observeExpectedResponse(state, `\x1b[32m${challenge.responseMarker.slice(0, 10)}`);
  assert.equal(state.expectedResponseSeen, false);
  observeExpectedResponse(state, `${challenge.responseMarker.slice(10)}\x1b[0m`);
  assert.equal(state.expectedResponseSeen, true);
  assert.ok(state.responseCarry.length <= 512);

  expectResponseMarker(state, challenge.responseMarker);
  observeExpectedResponse(
    state,
    `${challenge.responseMarker.slice(0, 10)}\x1b[2K${challenge.responseMarker.slice(10)}`
  );
  assert.equal(state.expectedResponseSeen, false,
    'terminal redraw controls cannot join visible marker fragments');
});

test('live delivery gate requires a deterministic local-shell proof that notify secrets are absent', (t) => {
  const challenge = environmentProbe();
  assert.throws(
    () => environmentProbe({ probeId: "not-a-uuid';Write-Output('injected')" }),
    /UUID probe id/
  );
  assert.equal(challenge.command.startsWith('!'), false,
    'the shell-mode sigil must be sent as a separate real key');
  assert.equal(challenge.command.includes('@'), false,
    'the local-shell probe must avoid interactive mention/autocomplete triggers');
  assert.equal(challenge.command.includes(path.resolve(os.tmpdir())), false,
    'the terminal line must not expose the expanded account-local temporary path');
  assert.equal(challenge.command.includes('Write-Output'), false,
    'the presence-only probe does not print environment evidence');

  const probe = spawnSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-Command', 'exit 0'], {
    windowsHide: true,
  });
  if (probe.error?.code === 'ENOENT') {
    t.diagnostic('pwsh.exe is unavailable; deterministic receipt execution was skipped');
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-tool-env-test-'));
  try {
    const clean = environmentProbe({
      receiptPath: path.join(root, 'clean.json'),
      probeId: '40000000-0000-4000-8000-000000000001',
    });
    const cleanEnv = { ...process.env };
    for (const name of [
      'AGENT_ORCHESTRATOR_NOTIFY_SECRET_PIPE',
      'AGENT_ORCHESTRATOR_NOTIFY_SECRET_TOKEN',
      'AGENT_ORCHESTRATOR_NOTIFY_SECRET_INCARNATION',
    ]) delete cleanEnv[name];
    const cleanRun = spawnSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-Command', clean.command], {
      env: cleanEnv,
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(cleanRun.status, 0);
    assert.deepEqual(readToolEnvironmentProbe(clean), {
      observed: true,
      valid: true,
      secretsAbsent: true,
    });

    const contaminated = environmentProbe({
      receiptPath: path.join(root, 'contaminated.json'),
      probeId: '40000000-0000-4000-8000-000000000002',
    });
    const contaminatedRun = spawnSync(
      'pwsh.exe',
      ['-NoLogo', '-NoProfile', '-Command', contaminated.command],
      {
        env: { ...cleanEnv, AGENT_ORCHESTRATOR_NOTIFY_SECRET_TOKEN: 'synthetic' },
        encoding: 'utf8',
        windowsHide: true,
      }
    );
    assert.equal(contaminatedRun.status, 0);
    assert.deepEqual(readToolEnvironmentProbe(contaminated), {
      observed: true,
      valid: true,
      secretsAbsent: false,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('live delivery gate accepts only a complete notify-helper contract', () => {
  const complete = {
    notifyInvoked: true,
    notifyPipePresent: true,
    notifyTokenPresent: true,
    notifyIncarnationPresent: true,
    notifyTurnCompleteEvent: true,
    notifyThreadIdPresent: true,
    notifyTurnIdPresent: true,
  };
  assert.equal(notifyContractSatisfied(complete), true);
  assert.equal(notifyContractSatisfied({ ...complete, notifyTokenPresent: false }), false);
});
