// ============================================================
// Opt-in live acceptance for exact-session scheduled prompt delivery
//
// This is intentionally not part of npm test or npm verify. It submits two
// harmless prompts on one real routed Codex account, uses the current checkout
// with a disposable schedule store, and prints aggregate facts only. Aliases, paths, prompt
// bodies, PTY output, claim tokens, and account metadata never leave memory.
// ============================================================

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const pty = require('node-pty');
const agents = require('../src/main/agents');
const { CodexLifecycleBroker } = require('../src/main/codex-lifecycle');
const {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  QUIET_PERIOD_MS,
} = require('../src/main/scheduled-prompt-delivery');
const { createSessionPromptHandlers } = require('../src/main/session-prompt-ipc');
const { SessionPromptScheduler } = require('../src/main/session-prompt-scheduler');
const { SessionPromptScheduleStore } = require('../src/main/session-prompt-schedules');
const { SessionContinuationCore } = require('../src/main/session-continuation-core');
const {
  ORCHESTRATOR_PTY_BACKEND_ID,
  createOrchestratorPtyContinuationBackend,
} = require('../src/main/orchestrator-pty-continuation-backend');
const { SessionRegistry } = require('../src/main/sessions');

const CONFIRM_FLAG = '--confirm-live';
const ACCOUNT_NUMBER_PREFIX = '--account-number=';
const SESSION_ID = 'manual-direct-live';
const STARTUP_TIMEOUT_MS = 45_000;
const TURN_TIMEOUT_MS = 180_000;
const TOOL_ENVIRONMENT_TIMEOUT_MS = 45_000;
const SCHEDULE_TIMEOUT_MS = QUIET_PERIOD_MS + TURN_TIMEOUT_MS;
const SCHEDULE_DELAY_MS = QUIET_PERIOD_MS;
const COLS = 160;
const ROWS = 40;
const STARTUP_SETTLE_MS = 3_000;
const HUMAN_CHAR_DELAY_MS = 75;
const HUMAN_ENTER_GAP_MS = 150;
const TOOL_ENVIRONMENT_RECEIPT_MAX_BYTES = 1024;
const PROBE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VISIBILITY_BOUNDARY = '\uFFFC';

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function requestedAccountNumber(argv) {
  const matches = argv.filter(value => value.startsWith(ACCOUNT_NUMBER_PREFIX));
  if (matches.length === 0) return 1;
  if (matches.length !== 1) fail('invalid-account-number');
  const number = Number(matches[0].slice(ACCOUNT_NUMBER_PREFIX.length));
  if (!Number.isSafeInteger(number) || number < 1) fail('invalid-account-number');
  return number;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function assertDisposablePath(candidate) {
  const root = path.resolve(os.tmpdir());
  const target = path.resolve(candidate);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    fail('unsafe-temporary-path');
  }
}

function createDiagnosticNotifyWrapper({ root, productionHelper }) {
  const wrapperPath = path.join(root, 'codex-notify-diagnostic.ps1');
  const diagnosticPath = path.join(root, 'codex-notify-diagnostic.json');
  const helperCopyPath = path.join(root, 'codex-notify-production.ps1');
  const source = `param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $NotificationArguments
)

$diagnostic = [ordered]@{
    invoked = $true
    pipePresent = -not [string]::IsNullOrWhiteSpace(
        [Environment]::GetEnvironmentVariable('AGENT_ORCHESTRATOR_NOTIFY_SECRET_PIPE')
    )
    tokenPresent = -not [string]::IsNullOrWhiteSpace(
        [Environment]::GetEnvironmentVariable('AGENT_ORCHESTRATOR_NOTIFY_SECRET_TOKEN')
    )
    incarnationPresent = -not [string]::IsNullOrWhiteSpace(
        [Environment]::GetEnvironmentVariable('AGENT_ORCHESTRATOR_NOTIFY_SECRET_INCARNATION')
    )
    turnCompleteEvent = $false
    threadIdPresent = $false
    turnIdPresent = $false
}
try {
    if ($NotificationArguments -and $NotificationArguments.Count -gt 0) {
        $event = $NotificationArguments[-1] | ConvertFrom-Json
        $diagnostic.turnCompleteEvent = $event.type -eq 'agent-turn-complete'
        $diagnostic.threadIdPresent = -not [string]::IsNullOrWhiteSpace([string]$event.'thread-id')
        $diagnostic.turnIdPresent = -not [string]::IsNullOrWhiteSpace([string]$event.'turn-id')
    }
} catch {}
$diagnostic | ConvertTo-Json -Compress |
    Set-Content -LiteralPath (Join-Path $PSScriptRoot 'codex-notify-diagnostic.json') -Encoding utf8
& (Join-Path $PSScriptRoot 'codex-notify-production.ps1') @NotificationArguments
`;
  fs.copyFileSync(productionHelper, helperCopyPath, fs.constants.COPYFILE_EXCL);
  fs.writeFileSync(wrapperPath, source, { encoding: 'utf8', flag: 'wx' });
  return { wrapperPath, diagnosticPath };
}

function readNotifyDiagnostic(diagnosticPath) {
  try {
    const value = JSON.parse(fs.readFileSync(diagnosticPath, 'utf8').replace(/^\uFEFF/, ''));
    return {
      notifyInvoked: value?.invoked === true,
      notifyPipePresent: value?.pipePresent === true,
      notifyTokenPresent: value?.tokenPresent === true,
      notifyIncarnationPresent: value?.incarnationPresent === true,
      notifyTurnCompleteEvent: value?.turnCompleteEvent === true,
      notifyThreadIdPresent: value?.threadIdPresent === true,
      notifyTurnIdPresent: value?.turnIdPresent === true,
    };
  } catch (_error) {
    return {
      notifyInvoked: false,
      notifyPipePresent: false,
      notifyTokenPresent: false,
      notifyIncarnationPresent: false,
      notifyTurnCompleteEvent: false,
      notifyThreadIdPresent: false,
      notifyTurnIdPresent: false,
    };
  }
}

function notifyContractSatisfied(diagnostic) {
  return [
    'notifyInvoked',
    'notifyPipePresent',
    'notifyTokenPresent',
    'notifyIncarnationPresent',
    'notifyTurnCompleteEvent',
    'notifyThreadIdPresent',
    'notifyTurnIdPresent',
  ].every(name => diagnostic?.[name] === true);
}

function terminalPlainText(value) {
  return String(value)
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ');
}

function terminalVisibleText(value) {
  return String(value)
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, VISIBILITY_BOUNDARY)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, VISIBILITY_BOUNDARY)
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ');
}

function observeProviderSignals(state, chunk) {
  const plain = terminalPlainText(`${state.signalCarry}${String(chunk)}`);
  const checks = {
    usageLimited: /usage limit reached|exceeded your current quota|quota exceeded|rate limit exceeded/i,
    authenticationRequired: /sign in with chatgpt to use codex|log in to use codex|authentication required/i,
    trustRequired: /do you trust the contents of this directory/i,
    approvalRequired: /approval required|needs your approval|permission required/i,
    connectionFailure: /connection (?:failed|error)|stream disconnected|failed to connect/i,
  };
  for (const [name, pattern] of Object.entries(checks)) {
    if (pattern.test(plain)) state.providerSignals[name] = true;
  }
  state.signalCarry = plain.slice(-512);
}

function expectResponseMarker(state, marker) {
  state.expectedResponseMarker = marker;
  state.expectedResponseSeen = false;
  state.responseCarry = '';
}

function observeExpectedResponse(state, chunk) {
  const plain = terminalVisibleText(`${state.responseCarry}${String(chunk)}`);
  if (state.expectedResponseMarker && plain.includes(state.expectedResponseMarker)) {
    state.expectedResponseSeen = true;
  }
  state.responseCarry = plain.slice(-512);
}

function assertLiveSafe(state) {
  failOnProviderBlock(state.providerSignals);
}

function failOnProviderBlock(signals) {
  const blocked = [
    ['usageLimited', 'provider-usage-limited'],
    ['authenticationRequired', 'provider-authentication-required'],
    ['trustRequired', 'provider-trust-required'],
    ['approvalRequired', 'provider-approval-required'],
    ['connectionFailure', 'provider-connection-failed'],
  ].find(([name]) => signals[name]);
  if (blocked) fail(blocked[1]);
}

function taskkillTree(pid) {
  if (!Number.isInteger(pid) || pid < 1) return Promise.resolve(false);
  return new Promise(resolve => {
    execFile(
      'taskkill',
      ['/PID', String(pid), '/T', '/F'],
      { windowsHide: true },
      error => resolve(!error)
    );
  });
}

function gitStatusSnapshot(cwd) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['status', '--porcelain=v1', '-z', '--untracked-files=no'],
      { cwd, windowsHide: true, encoding: 'buffer', maxBuffer: 2 * 1024 * 1024 },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(Buffer.from(stdout));
      }
    );
  });
}

async function waitFor(check, timeoutMs, code) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(100);
  }
  fail(typeof code === 'function' ? code() : code);
}

function fragments(label) {
  const nonce = randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase();
  const parts = ['AO_DIRECT_', `${label}_${nonce}`, '_OK'];
  return {
    prompt: 'Reply with exactly the concatenation of these three fragments, ' +
      `with no separators or extra text: "${parts[0]}", "${parts[1]}", "${parts[2]}". ` +
      'Do not inspect or modify files and do not use tools.',
    responseMarker: parts.join(''),
  };
}

function environmentProbe({ receiptPath, probeId = randomUUID() } = {}) {
  if (typeof probeId !== 'string' || !PROBE_ID_PATTERN.test(probeId)) {
    throw new TypeError('Tool environment probe needs a UUID probe id');
  }
  const resolvedReceiptPath = receiptPath || path.join(
    os.tmpdir(),
    `agent-orchestrator-tool-environment-${probeId}.json`
  );
  if (typeof resolvedReceiptPath !== 'string' || !resolvedReceiptPath) {
    throw new TypeError('Tool environment probe needs a receipt path');
  }
  const temporaryRoot = path.resolve(os.tmpdir());
  const relativeReceiptPath = path.relative(temporaryRoot, path.resolve(resolvedReceiptPath));
  if (
    !relativeReceiptPath || relativeReceiptPath.startsWith('..') ||
    path.isAbsolute(relativeReceiptPath) || !/^[A-Za-z0-9._\\/-]+$/.test(relativeReceiptPath) ||
    relativeReceiptPath.includes('@')
  ) {
    throw new TypeError('Tool environment probe needs a safe path inside the temporary directory');
  }
  const escapedRelativeReceiptPath = relativeReceiptPath.replaceAll("'", "''");
  const command = [
    `$receipt=Join-Path ([System.IO.Path]::GetTempPath()) '${escapedRelativeReceiptPath}'`,
    "$names='AGENT_ORCHESTRATOR_NOTIFY_SECRET_PIPE','AGENT_ORCHESTRATOR_NOTIFY_SECRET_TOKEN','AGENT_ORCHESTRATOR_NOTIFY_SECRET_INCARNATION'",
    "$present=$names|Where-Object{Test-Path \"Env:$_\"}",
    "if($present){$absent='false'}else{$absent='true'}",
    `[System.IO.File]::WriteAllText($receipt,'{"schemaVersion":1,"probeId":"${probeId}","secretsAbsent":'+$absent+'}',[System.Text.UTF8Encoding]::new($false))`,
  ].join(';');
  return {
    command,
    probeId,
    receiptPath: resolvedReceiptPath,
  };
}

function readToolEnvironmentProbe(probe) {
  const missing = { observed: false, valid: false, secretsAbsent: false };
  if (!probe?.receiptPath || !probe?.probeId || !fs.existsSync(probe.receiptPath)) return missing;
  try {
    const stat = fs.statSync(probe.receiptPath);
    if (!stat.isFile() || stat.size > TOOL_ENVIRONMENT_RECEIPT_MAX_BYTES) {
      return { ...missing, observed: true };
    }
    const value = JSON.parse(fs.readFileSync(probe.receiptPath, 'utf8').replace(/^\uFEFF/, ''));
    const keys = value && typeof value === 'object' && !Array.isArray(value)
      ? Object.keys(value).sort()
      : [];
    const valid = keys.join(',') === 'probeId,schemaVersion,secretsAbsent' &&
      value.schemaVersion === 1 && value.probeId === probe.probeId &&
      typeof value.secretsAbsent === 'boolean';
    return {
      observed: true,
      valid,
      secretsAbsent: valid && value.secretsAbsent === true,
    };
  } catch (_error) {
    return { ...missing, observed: true };
  }
}

async function typeHumanPrompt(registry, id, prompt, assertSafe, {
  delayFn = delay,
  charDelayMs = HUMAN_CHAR_DELAY_MS,
  enterGapMs = HUMAN_ENTER_GAP_MS,
} = {}) {
  for (const char of prompt) {
    assertSafe();
    if (!registry.write(id, char)) fail('initial-input-refused');
    await delayFn(charDelayMs);
  }
  assertSafe();
  if (!registry.write(id, '\r')) fail('initial-enter-refused');
  await delayFn(enterGapMs);
  assertSafe();
  if (!registry.write(id, '\r')) fail('initial-enter-refused');
}

async function submitLocalShellProbe(registry, id, probe, assertSafe, {
  delayFn = delay,
  settleMs = HUMAN_ENTER_GAP_MS,
} = {}) {
  if (!probe?.command || /[\x00-\x1f\x7f]/.test(probe.command)) {
    throw new TypeError('Local shell probe needs one terminal line');
  }
  assertSafe();
  // Codex intentionally treats a leading `!` introduced only by paste expansion
  // as model input. Send the sigil as a real key first so the TUI enters its
  // local-shell mode, then paste the inert command body and submit exactly once.
  if (!registry.write(id, '!')) fail('tool-environment-shell-mode-refused');
  await delayFn(settleMs);
  assertSafe();
  const protectedLine = `${BRACKETED_PASTE_START}${probe.command}${BRACKETED_PASTE_END}`;
  if (!registry.write(id, protectedLine)) fail('tool-environment-input-refused');
  await delayFn(settleMs);
  assertSafe();
  if (!registry.write(id, '\r')) fail('tool-environment-enter-refused');
}

function respondToTerminalQueries(registry, id, state, chunk) {
  const previous = state.queryCarry;
  const combined = `${previous}${String(chunk)}`;
  const replies = [];
  const collect = (pattern, replyFor) => {
    for (const match of combined.matchAll(pattern)) {
      if (match.index + match[0].length <= previous.length) continue;
      replies.push(replyFor(match));
    }
  };

  collect(/\x1b\[(?:0)?c/g, () => '\x1b[?1;2c');
  collect(/\x1b\[>(?:0)?c/g, () => '\x1b[>0;276;0c');
  collect(/\x1b\[5n/g, () => '\x1b[0n');
  collect(/\x1b\[6n/g, () => '\x1b[1;1R');
  collect(/\x1b\[\?6n/g, () => '\x1b[?1;1R');
  collect(/\x1b\[\?2004\$p/g, () => (
    registry.describe(id)?.scheduledPrompt?.bracketedPaste
      ? '\x1b[?2004;1$y'
      : '\x1b[?2004;2$y'
  ));
  collect(/\x1b\[(14|16|18)t/g, match => ({
    14: '\x1b[4;800;1280t',
    16: '\x1b[6;20;8t',
    18: `\x1b[8;${ROWS};${COLS}t`,
  })[match[1]]);
  collect(/\x1b\](10|11|12);\?(?:\x07|\x1b\\)/g, match => (
    `\x1b]${match[1]};rgb:ffff/ffff/ffff\x1b\\`
  ));

  state.queryCarry = combined.slice(-64);
  for (const reply of replies) registry.write(id, reply);
}

function instrumentPty(realPty, probe) {
  return {
    ...realPty,
    spawn(file, args, options) {
      const processHandle = realPty.spawn(file, args, options);
      const nativeWrite = processHandle.write.bind(processHandle);
      processHandle.write = (text) => {
        if (probe.armed) {
          if (text === probe.expectedPaste) {
            probe.protectedPasteWrites += 1;
            try {
              const file = JSON.parse(fs.readFileSync(probe.storePath, 'utf8'));
              const record = file.schedules.find(item => item.id === probe.scheduleId);
              probe.claimWasDurableBeforeWrite = !!record?.deliveryClaim?.token;
            } catch (_error) {
              probe.claimWasDurableBeforeWrite = false;
            }
          } else if (text === '\r') {
            probe.submitWrites += 1;
          }
        }
        return nativeWrite(text);
      };
      return processHandle;
    },
  };
}

async function main() {
  if (process.platform !== 'win32') fail('windows-required');
  if (!process.argv.includes(CONFIRM_FLAG)) fail('live-confirmation-required');
  const accountNumber = requestedAccountNumber(process.argv.slice(2));

  const appRoot = path.resolve(__dirname, '..');
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-orchestrator-direct-live-'));
  assertDisposablePath(temporaryRoot);
  const storePath = path.join(temporaryRoot, 'session-prompt-schedules.json');
  const toolEnvironmentReceiptPath = path.join(temporaryRoot, 'tool-environment-receipt.json');
  const productionNotifyScriptPath = path.join(appRoot, 'src', 'main', 'codex-notify.ps1');
  let notifyDiagnostic = null;
  const state = {
    queryCarry: '',
    outputEvents: 0,
    outputChars: 0,
    lastOutputAt: 0,
    initialInputAfterSeq: null,
    signalCarry: '',
    responseCarry: '',
    expectedResponseMarker: '',
    expectedResponseSeen: false,
    sessionExited: false,
    providerSignals: {
      usageLimited: false,
      authenticationRequired: false,
      trustRequired: false,
      approvalRequired: false,
      connectionFailure: false,
    },
  };
  const probe = {
    armed: false,
    expectedPaste: '',
    scheduleId: null,
    storePath,
    protectedPasteWrites: 0,
    submitWrites: 0,
    claimWasDurableBeforeWrite: false,
  };
  const broker = new CodexLifecycleBroker();
  const pendingTreeRequests = new Set();
  const requestTreeTermination = (pid) => {
    const request = taskkillTree(pid);
    pendingTreeRequests.add(request);
    request.finally(() => pendingTreeRequests.delete(request));
  };
  let registry = null;
  let scheduler = null;
  let rootPid = null;
  let stage = 'preflight';
  let result = null;
  let failure = null;
  let lifecycleReceipts = 0;
  let worktreeBefore = null;
  let initial = null;
  let toolEnvironmentProbe = null;
  let initialToolEnvironmentProof = { observed: false, valid: false, secretsAbsent: false };
  let initialResponseMarkerObserved = false;
  let scheduledResponseMarkerObserved = false;

  try {
    notifyDiagnostic = createDiagnosticNotifyWrapper({
      root: temporaryRoot,
      productionHelper: productionNotifyScriptPath,
    });
    const entrypointPath = agents.resolveEntrypointPath({ appRoot });
    const discovered = await agents.discoverRoutedProfiles({ entrypointPath });
    if (discovered.error) fail('routing-discovery-failed');
    const eligibleProfiles = discovered.profiles.filter(
      item => item.status === 'ok' && item.authenticated
    );
    const profile = eligibleProfiles[accountNumber - 1];
    if (!profile) fail('healthy-routed-account-required');
    worktreeBefore = await gitStatusSnapshot(appRoot);

    await broker.start();
    const spec = agents.buildLaunchSpec(profile, {
      baseEnv: process.env,
      defaultCwd: appRoot,
      entrypointPath,
      notifyScriptPath: notifyDiagnostic.wrapperPath,
      sessionMode: 'direct-agent',
    });
    // The live-only local-shell probe may write only inside this disposable
    // directory. Product launches do not add or relax any sandbox root.
    spec.args.push('--add-dir', temporaryRoot);

    const wrappedPty = instrumentPty(pty, probe);
    const trackingBroker = {
      register(args) {
        return broker.register({
          ...args,
          onEvent(event) {
            if (event?.type !== 'agent-turn-complete') return false;
            const accepted = args.onEvent(event);
            if (accepted) lifecycleReceipts += 1;
            return accepted;
          },
        });
      },
    };
    registry = new SessionRegistry({
      pty: wrappedPty,
      lifecycleBroker: trackingBroker,
      log: () => {},
      onExit: () => { state.sessionExited = true; },
      onStatus: () => {},
      onOutput: ({ id, data }) => {
        state.outputEvents += 1;
        state.outputChars += String(data).length;
        state.lastOutputAt = Date.now();
        observeProviderSignals(state, data);
        observeExpectedResponse(state, data);
        respondToTerminalQueries(registry, id, state, data);
      },
      terminateTree: requestTreeTermination,
      killTree: requestTreeTermination,
    });

    stage = 'startup';
    const created = registry.create(spec, { id: SESSION_ID, cols: COLS, rows: ROWS });
    rootPid = created.pid;
    await waitFor(
      () => {
        assertLiveSafe(state);
        return registry.describe(SESSION_ID)?.scheduledPrompt?.bracketedPaste;
      },
      STARTUP_TIMEOUT_MS,
      'protected-paste-mode-missing'
    );
    await waitFor(
      () => {
        assertLiveSafe(state);
        return state.lastOutputAt && Date.now() - state.lastOutputAt >= STARTUP_SETTLE_MS;
      },
      STARTUP_TIMEOUT_MS,
      'terminal-did-not-settle'
    );
    assertLiveSafe(state);

    stage = 'initial-turn';
    initial = fragments('INITIAL');
    expectResponseMarker(state, initial.responseMarker);
    state.initialInputAfterSeq = registry.checkpoint(SESSION_ID).outputSeq;
    await typeHumanPrompt(
      registry,
      SESSION_ID,
      initial.prompt,
      () => assertLiveSafe(state)
    );
    await waitFor(
      () => {
        assertLiveSafe(state);
        return lifecycleReceipts >= 1 && registry.describe(SESSION_ID)?.scheduledPrompt?.ready;
      },
      TURN_TIMEOUT_MS,
      () => {
        if (lifecycleReceipts < 1) return 'initial-lifecycle-receipt-missing';
        return 'initial-readiness-proof-missing';
      }
    );
    if (!notifyContractSatisfied(readNotifyDiagnostic(notifyDiagnostic.diagnosticPath))) {
      fail('notify-contract-invalid');
    }
    initialResponseMarkerObserved = state.expectedResponseSeen;

    stage = 'schedule';
    const scheduled = fragments('SCHEDULED');
    const store = new SessionPromptScheduleStore({ filePath: storePath });
    const continuation = new SessionContinuationCore({
      backends: [createOrchestratorPtyContinuationBackend({ registry })],
    });
    const handlers = createSessionPromptHandlers({
      store,
      continuation,
      defaultBackendId: ORCHESTRATOR_PTY_BACKEND_ID,
    });
    const meta = registry.describe(SESSION_ID);
    const createdSchedule = await handlers.create({
      sessionId: SESSION_ID,
      sessionIncarnationId: meta.incarnationId,
      prompt: scheduled.prompt,
      nextOccurrenceAt: Date.now() + SCHEDULE_DELAY_MS,
      repeatIntervalMinutes: null,
    });
    probe.scheduleId = createdSchedule.id;
    probe.expectedPaste = `${BRACKETED_PASTE_START}${scheduled.prompt}${BRACKETED_PASTE_END}`;
    const receiptsBeforeScheduledDelivery = lifecycleReceipts;
    expectResponseMarker(state, scheduled.responseMarker);

    scheduler = new SessionPromptScheduler({
      store,
      inspectBinding: schedule => continuation.inspectSchedule(schedule),
      deliver: schedule => continuation.deliverClaimed(schedule),
      log: () => {},
    });
    probe.armed = true;
    if (!scheduler.start() || scheduler.start()) fail('scheduler-idempotence-failed');
    await waitFor(async () => {
      assertLiveSafe(state);
      const record = await store.get(createdSchedule.id);
      if (record?.lastResult?.status === 'sent') return record;
      if (record?.lastResult && !['busy', 'unavailable'].includes(record.lastResult.status)) {
        fail('scheduled-delivery-failed');
      }
      return null;
    }, SCHEDULE_TIMEOUT_MS, 'scheduled-delivery-timeout');
    scheduler.stop();
    await scheduler.whenIdle();
    probe.armed = false;

    stage = 'second-receipt';
    await waitFor(
      () => {
        assertLiveSafe(state);
        return lifecycleReceipts > receiptsBeforeScheduledDelivery &&
          registry.describe(SESSION_ID)?.scheduledPrompt?.ready;
      },
      TURN_TIMEOUT_MS,
      'second-lifecycle-receipt-missing'
    );
    const notifyHookContract = readNotifyDiagnostic(notifyDiagnostic.diagnosticPath);
    if (!notifyContractSatisfied(notifyHookContract)) fail('notify-contract-invalid');
    const publicList = await handlers.list({});
    const publicRecord = publicList.schedules.find(item => item.id === createdSchedule.id);
    if (
      !publicRecord || publicRecord.enabled || publicRecord.lastResult?.status !== 'sent' ||
      publicRecord.deliveryInFlight || publicRecord.deliveryClaim !== undefined
    ) {
      fail('public-result-invalid');
    }
    if (
      probe.protectedPasteWrites !== 1 || probe.submitWrites !== 1 ||
      !probe.claimWasDurableBeforeWrite
    ) {
      fail('delivery-sequence-invalid');
    }
    if (!registry.scheduleTarget(SESSION_ID)) fail('session-not-reusable');
    scheduledResponseMarkerObserved = state.expectedResponseSeen;

    stage = 'tool-environment';
    toolEnvironmentProbe = environmentProbe({ receiptPath: toolEnvironmentReceiptPath });
    assertDisposablePath(toolEnvironmentProbe.receiptPath);
    await submitLocalShellProbe(
      registry,
      SESSION_ID,
      toolEnvironmentProbe,
      () => assertLiveSafe(state)
    );
    await waitFor(
      () => {
        assertLiveSafe(state);
        initialToolEnvironmentProof = readToolEnvironmentProbe(toolEnvironmentProbe);
        if (
          initialToolEnvironmentProof.observed && initialToolEnvironmentProof.valid &&
          !initialToolEnvironmentProof.secretsAbsent
        ) {
          fail('tool-environment-secret-present');
        }
        return initialToolEnvironmentProof.valid && initialToolEnvironmentProof.secretsAbsent;
      },
      TOOL_ENVIRONMENT_TIMEOUT_MS,
      () => {
        if (!initialToolEnvironmentProof.observed) return 'tool-environment-probe-missing';
        if (!initialToolEnvironmentProof.valid) return 'tool-environment-probe-invalid';
        return 'tool-environment-secret-present';
      }
    );

    stage = 'cleanup';
    await registry.removeAndWait(SESSION_ID);
    await registry.whenTerminationsComplete();
    if (!state.sessionExited) fail('session-cleanup-unconfirmed');
    rootPid = null;
    const worktreeAfter = await gitStatusSnapshot(appRoot);
    if (!worktreeBefore.equals(worktreeAfter)) fail('repository-worktree-changed');

    result = {
      passed: true,
      eligibleRoutedAccounts: eligibleProfiles.length,
      selectedAccountNumber: accountNumber,
      routedAccountsUsed: 1,
      harmlessPromptsSubmitted: 2,
      localShellProbesExecuted: 1,
      lifecycleReceiptsObserved: lifecycleReceipts,
      initialResponseMarkerObserved,
      toolEnvironmentProbeObserved: initialToolEnvironmentProof.observed,
      toolEnvironmentSecretsAbsent: initialToolEnvironmentProof.secretsAbsent,
      scheduledResponseMarkerObserved,
      durableClaimBeforeWrite: probe.claimWasDurableBeforeWrite,
      protectedPasteWrites: probe.protectedPasteWrites,
      unattendedEnterWrites: probe.submitWrites,
      terminalResult: 'sent',
      reusableAfterSecondReceipt: true,
      notifyHookContract,
      worktreeStatusUnchanged: true,
    };
  } catch (error) {
    const meta = registry?.describe(SESSION_ID);
    initialToolEnvironmentProof = readToolEnvironmentProbe(toolEnvironmentProbe);
    failure = {
      passed: false,
      stage,
      code: /^[a-z0-9-]+$/.test(String(error?.code || ''))
        ? error.code
        : 'unexpected-error',
      lifecycleReceiptsObserved: lifecycleReceipts,
      sessionRunning: meta?.status === 'running',
      providerConfirmed: meta?.scheduledPrompt?.confirmed === true,
      protectedPasteMode: meta?.scheduledPrompt?.bracketedPaste === true,
      outputEventsObserved: state.outputEvents,
      outputCharsObserved: state.outputChars,
      outputAfterInitialInput: Number.isInteger(state.initialInputAfterSeq)
        ? (registry?.checkpoint(SESSION_ID)?.outputSeq || 0) > state.initialInputAfterSeq
        : false,
      providerSignals: state.providerSignals,
      expectedResponseSeen: state.expectedResponseSeen,
      toolEnvironmentProbeObserved: initialToolEnvironmentProof.observed,
      toolEnvironmentProbeValid: initialToolEnvironmentProof.valid,
      toolEnvironmentSecretsAbsent: initialToolEnvironmentProof.secretsAbsent,
      durableClaimBeforeWrite: probe.claimWasDurableBeforeWrite,
      protectedPasteWrites: probe.protectedPasteWrites,
      unattendedEnterWrites: probe.submitWrites,
      selectedAccountNumber: accountNumber,
      ...readNotifyDiagnostic(notifyDiagnostic?.diagnosticPath),
    };
    process.exitCode = 1;
  } finally {
    let cleanupCode = null;
    scheduler?.stop();
    await scheduler?.whenIdle().catch(() => {});
    if (registry) {
      await registry.removeAndWait(SESSION_ID).catch(() => false);
      await registry.whenTerminationsComplete().catch(() => {});
    }
    while (pendingTreeRequests.size > 0) {
      await Promise.allSettled([...pendingTreeRequests]);
    }
    if (rootPid && !state.sessionExited) {
      await taskkillTree(rootPid);
      try {
        await waitFor(() => state.sessionExited, 10_000, 'session-cleanup-unconfirmed');
      } catch (_error) {
        cleanupCode = 'session-cleanup-unconfirmed';
      }
    }
    broker.stop();
    await delay(500);
    assertDisposablePath(temporaryRoot);
    try {
      fs.rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (_error) {
      cleanupCode ||= 'temporary-cleanup-failed';
    }
    const temporaryArtifactsRemoved = !fs.existsSync(temporaryRoot);
    if (!temporaryArtifactsRemoved) cleanupCode ||= 'temporary-cleanup-failed';
    if (result) result.temporaryArtifactsRemoved = temporaryArtifactsRemoved;
    if (failure) failure.temporaryArtifactsRemoved = temporaryArtifactsRemoved;
    if (worktreeBefore && failure) {
      try {
        failure.worktreeStatusUnchanged = worktreeBefore.equals(await gitStatusSnapshot(appRoot));
      } catch (_error) {
        failure.worktreeStatusUnchanged = false;
      }
    }
    if (cleanupCode) {
      const priorFailure = failure?.code || null;
      failure = {
        passed: false,
        stage: 'cleanup',
        code: cleanupCode,
        priorFailure,
        temporaryArtifactsRemoved,
      };
      result = null;
      process.exitCode = 1;
    }
  }

  if (failure) console.error(JSON.stringify(failure));
  else console.log(JSON.stringify(result));
}

if (require.main === module) {
  main().then(
    () => process.exit(process.exitCode || 0),
    (error) => {
      const code = /^[a-z0-9-]+$/.test(String(error?.code || ''))
        ? error.code
        : 'unexpected-error';
      const stage = [
        'windows-required',
        'live-confirmation-required',
        'invalid-account-number',
      ].includes(code)
        ? 'preflight'
        : 'finalize';
      console.error(JSON.stringify({ passed: false, stage, code }));
      process.exit(1);
    }
  );
}

module.exports = {
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
};
