// ============================================================
// Opt-in live verification for routed Codex sessions
//
// This is intentionally not part of npm test. It launches two real routed
// account shells, checks each shell's active routing and login status, starts
// an idle Codex TUI in both, then exercises the same queued termination path
// used by the app's Stop button.
//
// Privacy boundary: aliases, account homes, doctor JSON, terminal output, and
// process command lines are never printed or written to disk. Only aggregate
// booleans leave this process.
// ============================================================
const { execFile } = require('child_process');

const pty = require('node-pty');
const agents = require('../src/main/agents');
const { SessionRegistry } = require('../src/main/sessions');

const CONFIRM_FLAG = '--confirm-live';
const SESSION_IDS = ['manual-live-1', 'manual-live-2'];
const OUTPUT_LIMIT = 128 * 1024;
const READY_TIMEOUT_MS = 30_000;
const PROCESS_TIMEOUT_MS = 30_000;
const RELEVANT_PROCESS_NAMES = new Set(['codex.exe', 'powershell.exe', 'pwsh.exe']);

function fail(message) {
  throw new Error(message);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function runFile(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, ...options }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function processSnapshot() {
  const script = [
    '$items = Get-CimInstance Win32_Process',
    '| Where-Object { $_.ProcessId -ne $PID }',
    '| Select-Object ProcessId, ParentProcessId, Name;',
    '$items | ConvertTo-Json -Compress',
  ].join(' ');
  const { stdout } = await runFile(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }
  );
  const text = stdout.trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list.map(item => ({
    pid: Number(item.ProcessId),
    parentPid: Number(item.ParentProcessId),
    name: String(item.Name || '').toLowerCase(),
  }));
}

function descendantsOf(snapshot, rootPid) {
  const ids = new Set([Number(rootPid)]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const process of snapshot) {
      if (!ids.has(process.pid) && ids.has(process.parentPid)) {
        ids.add(process.pid);
        changed = true;
      }
    }
  }
  return snapshot.filter(process => ids.has(process.pid) && process.pid !== Number(rootPid));
}

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await check();
    if (latest) return latest;
    await delay(250);
  }
  fail(`Timed out waiting for ${label}`);
}

async function typeLine(registry, id, text, charDelayMs = 2) {
  for (const char of String(text)) {
    if (!registry.write(id, char)) fail(`Session ${id} refused verification input`);
    await delay(charDelayMs);
  }
  if (!registry.write(id, '\r')) fail(`Session ${id} refused verification Enter`);
}

function appendBounded(map, id, chunk) {
  const next = `${map.get(id) || ''}${String(chunk)}`;
  map.set(id, next.slice(-OUTPUT_LIMIT));
}

function markerCommand(alias, token) {
  // ROUTED_ALIAS_PATTERN makes this interpolation safe. The helper contains
  // no machine/account data; the interactive command stays short enough for
  // PSReadLine to accept reliably through ConPTY.
  return [
    "& '.\\scripts\\manual-routed-probe.ps1'",
    "-Entrypoint '..\\ai-agent-entrypoint\\bin\\agent-entrypoint.ps1'",
    `-Alias '${alias}'`,
    `-Token '${token}'`,
  ].join(' ');
}

function pingCommand(token) {
  return `Write-Output ([string]::Concat('AO_PING_', '${token}'))`;
}

function sawPing(output, token) {
  const normalized = String(output)
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B(?:[@-_]|\[[0-?]*[ -/]*[@-~])/g, '')
    .replace(/[\u0000-\u001F\u007F]/g, '');
  return normalized.includes(`AO_PING_${token}`);
}

function readMarker(output, token) {
  const normalized = String(output)
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B(?:[@-_]|\[[0-?]*[ -/]*[@-~])/g, '')
    .replace(/[\u0000-\u001F\u007F]/g, '');
  const pattern = new RegExp(
    `AO_LIVE_${token}:([01]{5}):([A-F0-9]{24})`,
    'i'
  );
  const match = normalized.match(pattern);
  if (!match) return null;
  return {
    status: match[1][0] === '1' ? 'ok' : 'error',
    homeMatches: match[1][1] === '1',
    sqliteMatches: match[1][2] === '1',
    authenticated: match[1][3] === '1',
    homesAgree: match[1][4] === '1',
    homeFingerprint: match[2],
  };
}

function safeSessionDiagnostic(registry, output, id, waitResult) {
  const text = String(output.get(id) || '');
  const errorCodes = [...new Set(text.match(/AAE_[A-Z_]+/g) || [])].slice(0, 5);
  const meta = registry.describe(id);
  return {
    waitReason: waitResult?.reason || 'unknown',
    status: meta?.status || 'removed',
    exitCode: Number.isInteger(meta?.exitCode) ? meta.exitCode : null,
    outputChars: text.length,
    sawReadyText: /account shell ready/i.test(text),
    sawMarkerPrefix: /AO_LIVE_/i.test(text),
    errorCodes,
    sawPowerShellError: /categoryinfo|fullyqualifiederrorid|parsererror|commandnotfoundexception|powershell.+error/i.test(text),
  };
}

function runOwnedRelevantIds(snapshot, roots) {
  const ids = new Set();
  for (const rootPid of roots) {
    ids.add(rootPid);
    for (const process of descendantsOf(snapshot, rootPid)) {
      if (RELEVANT_PROCESS_NAMES.has(process.name)) ids.add(process.pid);
    }
  }
  return ids;
}

async function forceCleanup(pids) {
  for (const pid of [...new Set(pids)].filter(Number.isInteger)) {
    try {
      await runFile('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 10_000 });
    } catch (_error) {
      // An already-exited process is the expected cleanup race.
    }
  }
}

async function main() {
  if (process.platform !== 'win32') fail('This live verification currently requires Windows');
  if (!process.argv.includes(CONFIRM_FLAG)) {
    fail(`Refusing to launch real accounts without ${CONFIRM_FLAG}`);
  }

  const entrypointPath = agents.resolveEntrypointPath({ appRoot: process.cwd() });
  const discovered = await agents.discoverRoutedProfiles({ entrypointPath });
  if (discovered.error) fail('Routed account discovery did not pass');

  const profiles = discovered.profiles
    .filter(profile => profile.status === 'ok' && profile.authenticated)
    .slice(0, 2);
  if (profiles.length < 2) {
    fail('Two healthy authenticated routed accounts are required');
  }

  const output = new Map();
  const roots = [];
  let stopSnapshot = [];

  let registry;
  registry = new SessionRegistry({
    pty,
    log: () => {},
    onOutput: ({ id, data }) => {
      appendBounded(output, id, data);
      // xterm answers this terminal device-status query. A headless live
      // harness must do the same or PowerShell waits during startup forever.
      if (String(data).includes('\x1b[6n')) {
        registry.write(id, '\x1b[1;1R');
      }
    },
    onExit: () => {},
    onStatus: () => {},
    terminateTree: (pid) => {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
    },
    killTree: (pid) => {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
    },
  });

  try {
    for (let index = 0; index < profiles.length; index++) {
      const spec = agents.buildLaunchSpec(profiles[index], {
        baseEnv: process.env,
        entrypointPath,
        defaultCwd: process.cwd(),
      });
      const created = registry.create(spec, {
        id: SESSION_IDS[index],
        cols: 240,
        rows: 30,
      });
      roots.push(created.pid);
    }

    const readyWaits = SESSION_IDS.map((id, index) => registry.waitForOutput(id, {
      waitId: `manual-ready-${index + 1}`,
      afterSeq: 0,
      idleMs: 0,
      pattern: 'account shell ready',
      timeoutMs: READY_TIMEOUT_MS,
    }));
    const ready = await Promise.all(readyWaits);
    if (!ready.every(result => result.reason === 'match')) {
      const diagnostics = SESSION_IDS.map((id, index) => (
        safeSessionDiagnostic(registry, output, id, ready[index])
      ));
      fail(`Both routed account shells did not become ready: ${JSON.stringify(diagnostics)}`);
    }

    // Keep this one-off verification out of the account shell's persistent
    // PSReadLine history. This changes only the disposable child process.
    await Promise.all(SESSION_IDS.map(id => typeLine(
      registry,
      id,
      'Set-PSReadLineOption -HistorySaveStyle SaveNothing -ErrorAction SilentlyContinue'
    )));
    await delay(200);

    const tokens = ['slot1check', 'slot2check'];
    await Promise.all(tokens.map((token, index) => (
      typeLine(registry, SESSION_IDS[index], pingCommand(token))
    )));
    await Promise.all(tokens.map((token, index) => waitFor(
      async () => sawPing(output.get(SESSION_IDS[index]), token),
      READY_TIMEOUT_MS,
      `interactive shell input ${index + 1}`
    )));

    await Promise.all(profiles.map((profile, index) => (
      typeLine(
        registry,
        SESSION_IDS[index],
        markerCommand(profile.alias, tokens[index])
      )
    )));

    let checks;
    try {
      checks = await Promise.all(tokens.map((token, index) => waitFor(
        async () => readMarker(output.get(SESSION_IDS[index]), token),
        READY_TIMEOUT_MS,
        `sanitized routed verification ${index + 1}`
      )));
    } catch (error) {
      const diagnostics = SESSION_IDS.map(id => (
        safeSessionDiagnostic(registry, output, id, null)
      ));
      fail(`${error.message}: ${JSON.stringify(diagnostics)}`);
    }
    const doctorPassed = checks.every(check => (
      check.status === 'ok'
      && check.homeMatches
      && check.sqliteMatches
      && check.authenticated
      && check.homesAgree
    ));
    const accountHomesDiffer = new Set(checks.map(check => check.homeFingerprint)).size === 2;
    if (!doctorPassed || !accountHomesDiffer) {
      fail('Routed doctor, login, or account-separation checks failed');
    }

    // Start the interactive CLI without sending a prompt. This creates the
    // routed agent child that Stop must tear down, but consumes no model work.
    for (const id of SESSION_IDS) registry.write(id, 'codex\n');

    stopSnapshot = await waitFor(async () => {
      const snapshot = await processSnapshot();
      const eachHasAgentChild = roots.every(rootPid => (
        descendantsOf(snapshot, rootPid).some(process => process.name === 'codex.exe')
      ));
      return eachHasAgentChild ? snapshot : null;
    }, PROCESS_TIMEOUT_MS, 'an idle Codex child in both routed sessions');

    // ExecutionEngine.abort() invokes kill-process for every run-owned id.
    // The app's IPC handler maps those calls to this queued removeAndWait path.
    await Promise.all(SESSION_IDS.map(id => registry.removeAndWait(id)));
    await registry.whenTerminationsComplete();

    // Capture the exact pre-Stop descendant set. After the root exits, a
    // routed child can be reparented and no longer discoverable by ancestry.
    // Never treat unrelated PowerShell/Codex processes as cleanup targets.
    const spawnedRelevant = runOwnedRelevantIds(stopSnapshot, roots);

    try {
      await waitFor(async () => {
        const snapshot = await processSnapshot();
        const liveIds = new Set(snapshot.map(process => process.pid));
        return [...spawnedRelevant].every(pid => !liveIds.has(pid)) ? snapshot : null;
      }, PROCESS_TIMEOUT_MS, 'all run-owned PowerShell and Codex processes to exit');
    } catch (error) {
      const residualSnapshot = await processSnapshot();
      const residual = residualSnapshot.filter(process => spawnedRelevant.has(process.pid));
      const byName = {};
      for (const process of residual) {
        byName[process.name] = (byName[process.name] || 0) + 1;
      }
      fail(`${error.message}: ${JSON.stringify({
        residualCount: residual.length,
        byName,
        rootShellsAlive: residual.filter(process => roots.includes(process.pid)).length,
        reparentedCount: residual.filter(process => !spawnedRelevant.has(process.parentPid)).length,
      })}`);
    }

    console.log(JSON.stringify({
      routedAccountsChecked: profiles.length,
      concurrentSessions: true,
      bothLoginsHealthy: true,
      accountHomesDiffer: true,
      activeHomeMatches: true,
      activeSqliteMatches: true,
      agentChildPerSessionBeforeStop: true,
      orphanProcessesAfterStop: 0,
    }));
  } catch (error) {
    const captured = runOwnedRelevantIds(stopSnapshot, roots);
    await forceCleanup([...roots, ...captured]);
    throw error;
  } finally {
    await Promise.all(SESSION_IDS.map(id => registry.removeAndWait(id).catch(() => false)));
    await registry.whenTerminationsComplete();
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(JSON.stringify({ passed: false, error: error.message }));
    process.exit(1);
  }
);
