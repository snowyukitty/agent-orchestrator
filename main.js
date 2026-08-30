// ============================================================
// Agent Orchestrator — Electron Main Process
// System Tray Application with Process Automation
// ============================================================
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  dialog,
  nativeImage,
  powerMonitor,
  powerSaveBlocker,
  safeStorage,
} = require('electron');
const path = require('path');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const pty = require('node-pty');

const { SessionRegistry } = require('./src/main/sessions');
const { CodexLifecycleBroker } = require('./src/main/codex-lifecycle');
const { SessionPromptScheduleStore } = require('./src/main/session-prompt-schedules');
const { SessionPromptScheduler } = require('./src/main/session-prompt-scheduler');
const { createSessionPromptHandlers } = require('./src/main/session-prompt-ipc');
const { SessionContinuationCore } = require('./src/main/session-continuation-core');
const {
  ORCHESTRATOR_PTY_BACKEND_ID,
  createOrchestratorPtyContinuationBackend,
} = require('./src/main/orchestrator-pty-continuation-backend');
const agentProfiles = require('./src/main/agents');
const { writeJsonAtomic, readJsonStrict, readJsonDir, ensureDir } = require('./src/main/store');
const { loadSettings, saveSettings } = require('./src/main/settings');
const { prepareUserData } = require('./src/main/user-data');
const { RoutedDiscoveryCache } = require('./src/main/routed-cache');
const { ShutdownCoordinator } = require('./src/main/shutdown');
const { RunJournal } = require('./src/main/run-journal');
const {
  PROMO_CAPTURE_TIME,
  createVisualUuidSource,
  seedVisualRunJournal,
} = require('./src/main/visual-fixtures');
const {
  capturePromoFrames,
  parsePromoCaptureOptions,
} = require('./src/main/promo-capture');
const {
  RendererDocumentLifecycle,
  RendererContainmentCoordinator,
  isReloadAccelerator,
} = require('./src/main/renderer-containment');
const {
  assertTrustedIpcSender,
  getUsableWebContents,
  installNavigationGuards,
  isTrustedRendererUrl,
} = require('./src/main/trust');
const {
  asPlainObject, asId, asText, asCols, asRows,
} = require('./src/main/validate');

// Establish the singular identity before Electron creates storage, sessions,
// or its single-instance lock. Test modes never touch production AppData.
const isSmokeTest = process.argv.includes('--smoke-test');
const isSelfTest = process.argv.includes('--self-test');
const isVisualTest = process.argv.includes('--visual-test');
const promoCapture = parsePromoCaptureOptions(process.argv, __dirname);
if (promoCapture) {
  // Capture receipts are portable only when the output pixel ratio is fixed
  // here rather than inherited from whatever display runs the capture. Scale 1
  // maps one CSS pixel to one output pixel; a higher scale keeps the same
  // layout and multiplies resolution. The switch is scoped to the disposable
  // promo process and must be set before Electron creates a BrowserWindow.
  app.commandLine.appendSwitch('force-device-scale-factor', String(promoCapture.scale ?? 1));
}
app.setName('Agent Orchestrator');
const userDataState = prepareUserData({
  appDataRoot: app.getPath('appData'),
  tempRoot: app.getPath('temp'),
  // Visual QA uses the normal renderer while remaining unable to read or
  // mutate production settings, workflows, local profiles, or Run Journal files.
  testMode: isSmokeTest || isSelfTest || isVisualTest || Boolean(promoCapture),
});
app.setPath('userData', userDataState.path);
const sessionDataPath = path.join(userDataState.path, 'session');
fs.mkdirSync(sessionDataPath, { recursive: true });
app.setPath('sessionData', sessionDataPath);

const RENDERER_ENTRY_FILE = path.join(__dirname, 'src', 'index.html');

// ── Timestamped Logging ──────────────────────────────────────
// Prefix every main-process console line with a local HH:MM:SS.mmm
// timestamp so logs are correlatable with the renderer's Log pane.
(() => {
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const stamp = () => {
    const d = new Date();
    return `[${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}]`;
  };
  for (const level of ['log', 'warn', 'error']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => orig(stamp(), ...args);
  }
})();

// ── GPU Compatibility Fix (prevents invisible windows on some Windows machines)
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');

// ── Keep the scheduler alive when minimized / in tray / screen locked ──
// Chromium otherwise throttles background/occluded renderers (timers drop to
// ~1/minute), which makes scheduled runs miss their trigger window. These
// switches + backgroundThrottling:false + a main-process heartbeat keep the
// renderer's scheduler ticking whenever the machine is awake.
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

let mainWindow;
let tray;
let schedulerHeartbeatTimer = null;
let powerResumeHandler = null;
let powerUnlockHandler = null;
let cleanupComplete = false;
let keepAwakeId = null;
let sleepTimer = null;
let sleepTarget = null; // epoch ms when hibernate fires (null = none armed)
let sessions = null;    // SessionRegistry, created once the app is ready
let runJournal = null;  // RunJournal, created once safeStorage is available
let codexLifecycleBroker = null;
let sessionPromptStore = null;
let sessionPromptScheduler = null;
let sessionPromptHandlers = null;
let sessionContinuation = null;
let testDataCleanupScheduled = false;
const gotSingleInstanceLock = app.requestSingleInstanceLock();
const isDev = process.argv.includes('--dev');
let selfTestTimer = null;

function isDirectory(dir) {
  try {
    return !!dir && fs.statSync(dir).isDirectory();
  } catch (_e) {
    return false;
  }
}

/**
 * Resolve a requested working directory to one that exists.
 * A missing path makes ConPTY fail with "Cannot create process, error code:
 * 267" and leaves a dead terminal, so fall back to the user's home instead.
 */
function resolveWorkingDir(cwd) {
  if (isDirectory(cwd)) return cwd;
  const fallback = app.getPath('home');
  if (cwd) console.warn('[Main] Requested working directory was unavailable; using the default directory');
  return fallback;
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function sendToRenderer(channel, payload) {
  if (app.isQuitting || !mainWindow || mainWindow.isDestroyed()) return false;
  const { webContents } = mainWindow;
  if (!webContents || webContents.isDestroyed()) return false;
  try {
    webContents.send(channel, payload);
    return true;
  } catch (err) {
    if (!app.isQuitting) {
      console.warn(`[Main] Failed to send "${channel}": ${err.message}`);
    }
    return false;
  }
}

/** Register an IPC route that only the app's own top-level renderer may call. */
function handleTrusted(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    const expectedWebContents = getUsableWebContents(mainWindow);
    // A renderer can finish an in-flight preload call after BrowserWindow
    // teardown has started. Do not invoke the privileged handler once the
    // trusted renderer is gone; a live but unexpected sender is still rejected
    // by assertTrustedIpcSender below.
    if (!expectedWebContents) return undefined;
    assertTrustedIpcSender(event, RENDERER_ENTRY_FILE, expectedWebContents);
    const documentToken = args.pop();
    const rendererEpoch = rendererContainment.validateDocumentToken(documentToken);
    if (args.length === 0) return handler(event, undefined, rendererEpoch);
    return handler(event, ...args, rendererEpoch);
  });
}

// ── PTY Sessions ─────────────────────────────────────────────
// The app can hold several concurrent PTYs (one per agent account), so a
// session registry owns them instead of a bare Map of processes. Session
// metadata sent to the renderer deliberately excludes env and resolved
// paths — a routed session's env contains canonical account-home paths.

/**
 * Force-kill a process tree. node-pty's kill() ends the ConPTY, but a routed
 * session is `pwsh` with a `codex` child, and the child can outlive it.
 */
function killProcessTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, (err) => {
      // An already-dead tree is the common case; only surface real failures.
      if (err && !/not found|no running instance/i.test(err.message)) {
        console.warn(`[Sessions] taskkill ${pid} failed: ${err.message}`);
      }
    });
    return;
  }
  try { process.kill(-pid, 'SIGKILL'); } catch (_e) { /* already gone */ }
}

function createSessionRegistry() {
  return new SessionRegistry({
    pty,
    lifecycleBroker: codexLifecycleBroker,
    continuationBackendId: ORCHESTRATOR_PTY_BACKEND_ID,
    // On Windows, request whole-tree termination before touching the outer
    // ConPTY root. Once that pwsh exits, nested routed children can be
    // reparented and a later taskkill /T can no longer discover them.
    terminateTree: process.platform === 'win32' ? killProcessTree : null,
    killTree: killProcessTree,
    log: (msg) => console.log(msg),
    onOutput: ({ id, data, stream }) => {
      // Legacy channel name kept so existing renderer listeners keep working.
      sendToRenderer('process-output', { id, data, stream });
    },
    onExit: ({ id, code }) => {
      sendToRenderer('process-exit', { id, code });
    },
    onStatus: (meta) => {
      if (meta) sendToRenderer('session-status', meta);
    },
  });
}

function sessionPromptFile() {
  return path.join(app.getPath('userData'), 'session-prompt-schedules.json');
}

function codexNotifyScriptPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'codex-notify.ps1')
    : path.join(__dirname, 'src', 'main', 'codex-notify.ps1');
}

async function reconcileSessionPromptBindings() {
  if (!sessionPromptStore || !sessionContinuation) return;
  try {
    await sessionPromptStore.prepareTick(schedule => sessionContinuation.inspectSchedule(schedule));
    return true;
  } catch (error) {
    console.warn(`[Session prompts] binding reconciliation failed (${error.code || 'error'})`);
    return false;
  }
}

// ── Tray Icon ────────────────────────────────────────────────
function getTrayIcon() {
  const iconPath = path.join(__dirname, 'src', 'assets', 'icon.png');
  if (fs.existsSync(iconPath)) {
    return nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  }
  // Fallback: create a minimal 16x16 cyan pixel icon
  const size = 16;
  const channels = 4;
  const raw = Buffer.alloc(size * size * channels);
  for (let i = 0; i < size * size; i++) {
    raw[i * 4]     = 74;  // R
    raw[i * 4 + 1] = 158; // G
    raw[i * 4 + 2] = 255; // B
    raw[i * 4 + 3] = 255; // A
  }
  return nativeImage.createFromBitmap(raw, { width: size, height: size });
}

function getWindowIcon() {
  // Prefer the multi-size .ico on Windows (sharp taskbar/title-bar icon),
  // fall back to the PNG everywhere else.
  const icoPath = path.join(__dirname, 'src', 'assets', 'icon.ico');
  if (process.platform === 'win32' && fs.existsSync(icoPath)) {
    const img = nativeImage.createFromPath(icoPath);
    if (!img.isEmpty()) return img;
  }
  const iconPath = path.join(__dirname, 'src', 'assets', 'icon.png');
  if (fs.existsSync(iconPath)) {
    return nativeImage.createFromPath(iconPath);
  }
  return undefined;
}

// ── Persisted Settings ───────────────────────────────────────
function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function runJournalDir() {
  return path.join(app.getPath('userData'), 'run-journal');
}

function createRunJournal() {
  const promoUuidSource = promoCapture ? createVisualUuidSource() : undefined;
  return new RunJournal({
    dir: runJournalDir(),
    ...(promoCapture ? {
      now: () => new Date(PROMO_CAPTURE_TIME),
      randomUUID: promoUuidSource,
    } : {}),
    encryption: {
      isAvailable: () => safeStorage.isEncryptionAvailable(),
      encrypt: (plaintext) => (
        safeStorage.encryptString(plaintext).toString('base64')
      ),
      decrypt: (ciphertext) => (
        safeStorage.decryptString(Buffer.from(ciphertext, 'base64'))
      ),
    },
    onError: (file, error) => {
      const code = typeof error?.code === 'string' ? error.code : 'invalid-record';
      console.warn(`[Journal] skipped ${path.basename(file)} (${code})`);
    },
  });
}

/**
 * Terminate every main-owned PTY after renderer loss. This intentionally
 * includes manually opened sessions: once their renderer disappears, keeping
 * them alive would leave invisible processes with no reliable owner or Stop UI.
 *
 * killAllSequential() is called before this function returns, so the registry's
 * termination queue closes the old-renderer spawn race in the same event turn.
 */
function containRendererSessions() {
  const registry = sessions;
  if (!registry) return Promise.resolve({ terminated: 0, pruned: 0 });
  const stopping = registry.killAllSequential(
    'renderer lost',
    { failOnTimeout: true }
  );
  return (async () => {
    let terminated = 0;
    let failure = null;
    try {
      terminated = await stopping;
    } catch (error) {
      failure = error;
    }
    try {
      await registry.whenTerminationsComplete();
    } catch (error) {
      failure ||= error;
    }
    const pruned = registry.prune();
    if (failure) throw failure;
    return { terminated, pruned };
  })();
}

async function recoverRendererJournal() {
  const recovered = await requireRunJournal().recoverInterrupted();
  return { recovered: recovered.length };
}

function containmentErrorCode(error) {
  return typeof error?.code === 'string' ? error.code : 'containment-error';
}

const rendererContainment = new RendererContainmentCoordinator({
  containSessions: containRendererSessions,
  recoverJournal: recoverRendererJournal,
  onStart: ({ reason }) => {
    console.warn(
      `[Containment] ${reason}; terminating all sessions, including manually opened sessions`
    );
  },
  onComplete: ({ sessionResult, recoveryResult }) => {
    console.warn(
      `[Containment] complete: terminated ${sessionResult.terminated}, `
      + `pruned ${sessionResult.pruned}, recovered ${recoveryResult.recovered} run(s)`
    );
  },
  onError: ({ error }) => {
    // Do not log session identifiers or error text from lower layers.
    console.error(`[Containment] failed closed (${containmentErrorCode(error)})`);
  },
});

function beginRendererContainment(
  reason,
  { advanceEpoch = true, newIncident = advanceEpoch } = {}
) {
  // Event handlers cannot await. The coordinator retains the failed state, and
  // every later journal/session admission observes it and fails closed.
  void rendererContainment.contain(
    reason,
    { advanceEpoch, newIncident }
  ).catch(() => {});
}

/** Save the window's current geometry so the next launch reopens in place. */
function persistWindowBounds() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
  try {
    saveSettings(settingsFile(), { windowBounds: mainWindow.getNormalBounds() });
  } catch (err) {
    console.warn(`[Main] Failed to persist window bounds: ${err.message}`);
  }
}

// ── Window Creation ──────────────────────────────────────────
function createWindow() {
  const icon = getWindowIcon();
  const stored = loadSettings(settingsFile());
  const bounds = stored.windowBounds;

  mainWindow = new BrowserWindow({
    width: promoCapture?.width ?? bounds?.width ?? 1440,
    height: promoCapture?.height ?? bounds?.height ?? 920,
    useContentSize: Boolean(promoCapture),
    ...(!promoCapture && bounds && bounds.x !== undefined && bounds.y !== undefined
      ? { x: bounds.x, y: bounds.y }
      : { center: true }),
    minWidth: 1000,
    minHeight: 600,
    backgroundColor: '#0a0a0f',
    show: false,
    autoHideMenuBar: true,
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false, // keep timers full-speed when hidden/locked
      ...(isSelfTest ? { additionalArguments: ['--orchestrator-self-test'] } : {}),
    }
  });

  installNavigationGuards(mainWindow.webContents, RENDERER_ENTRY_FILE, (message) => {
    console.warn(message);
  });
  const rendererLifecycle = new RendererDocumentLifecycle();
  let committedRendererToken = null;
  const containmentEnabled = !isSmokeTest && !isSelfTest;
  const applyRendererLoss = (reason, signal) => {
    if (app.isQuitting) return;
    if (signal.block) {
      committedRendererToken = null;
      rendererContainment.blockPrivilegedIpc();
    }
    if (containmentEnabled && signal.contain) {
      beginRendererContainment(reason, {
        advanceEpoch: false,
        newIncident: signal.newIncident,
      });
    }
  };
  mainWindow.webContents.on('did-start-navigation', (details) => {
    if (!details.isMainFrame || details.isSameDocument) return;
    const trusted = isTrustedRendererUrl(details.url, RENDERER_ENTRY_FILE);
    applyRendererLoss(
      'renderer navigation detected',
      rendererLifecycle.didStartLoading({ trusted })
    );
  });
  mainWindow.webContents.on(
    'did-frame-navigate',
    (_event, _url, _code, _status, isMainFrame) => {
      if (!isMainFrame || !rendererLifecycle.didNavigateCommit()) return;
      if (containmentEnabled && rendererContainment.failed) {
        // A committed replacement renderer is the recovery point after a
        // failed cleanup sweep: rerun the sweep so a single failure does not
        // block every future run and session until an app restart.
        beginRendererContainment('renderer recovered after failed cleanup', {
          advanceEpoch: false,
          newIncident: true,
        });
      }
      rendererContainment.commitRenderer();
      committedRendererToken = rendererContainment.getCommittedToken();
    }
  );
  const deliverDocumentToken = () => {
    const token = rendererContainment.getCommittedToken();
    if (
      app.isQuitting
      || !token
      || token !== committedRendererToken
    ) return;
    // Preload installed this private listener before dom-ready. The token never
    // crosses contextBridge into page JavaScript.
    sendToRenderer('renderer-document-token', token);
  };
  mainWindow.webContents.on('dom-ready', deliverDocumentToken);
  // The dom-ready delivery can race a navigation that momentarily cleared the
  // committed token. The preload re-requests until a token arrives, so a lost
  // first message cannot leave the document permanently unable to call IPC.
  ipcMain.removeAllListeners('renderer-document-token-request');
  ipcMain.on('renderer-document-token-request', (event) => {
    const expected = getUsableWebContents(mainWindow);
    if (!expected || event.sender !== expected) return;
    deliverDocumentToken();
  });
  if (containmentEnabled) {
    mainWindow.webContents.on('render-process-gone', () => {
      applyRendererLoss(
        'renderer process lost',
        rendererLifecycle.renderProcessGone()
      );
    });
  }
  if (!isDev && !isSmokeTest && !isSelfTest) {
    mainWindow.webContents.on('before-input-event', (event, input) => {
      if (isReloadAccelerator(input)) event.preventDefault();
    });
  }
  mainWindow.loadFile(
    RENDERER_ENTRY_FILE,
    isSelfTest
      ? { query: { selftest: '1' } }
      : (promoCapture ? { query: { promoCapture: '1' } } : undefined)
  );

  // Show window only after content is fully rendered
  mainWindow.once('ready-to-show', () => {
    if (promoCapture) return;
    mainWindow.show();
    mainWindow.focus();
    console.log('[Main] Window shown and focused');
  });

  // Clicking X hides to tray instead of quitting
  mainWindow.on('close', (e) => {
    persistWindowBounds();
    if (!app.isQuitting) {
      // The disposable visual-QA mode has no reason to linger in the tray;
      // closing it should exercise the same sequenced cleanup as tray Quit.
      if (isVisualTest || promoCapture) {
        e.preventDefault();
        app.isQuitting = true;
        app.quit();
        return;
      }
      e.preventDefault();
      mainWindow.hide();
      console.log('[Main] Window hidden to tray');
    }
  });

  // Debounce geometry writes; a drag/resize fires these continuously.
  let boundsTimer = null;
  const scheduleBoundsSave = () => {
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = setTimeout(persistWindowBounds, 800);
    if (typeof boundsTimer.unref === 'function') boundsTimer.unref();
  };
  mainWindow.on('resize', scheduleBoundsSave);
  mainWindow.on('move', scheduleBoundsSave);

  // Debug: log page load errors
  mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
    console.error(`[Main] Page load failed: ${code} - ${desc}`);
  });

  // Surface renderer errors in the main log. Without this a thrown exception
  // in the renderer is invisible unless DevTools happens to be open.
  mainWindow.webContents.on('console-message', (event) => {
    const { level, message, lineNumber, sourceId } = event;
    if (level !== 'error' && level !== 'warning') return;
    const where = sourceId ? ` (${path.basename(sourceId)}:${lineNumber})` : '';
    console.error(`[Renderer:${level}] ${message}${where}`);
  });

  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[Main] Page loaded successfully');
    if (isSmokeTest) {
      console.log('[Main] Smoke test loaded; quitting...');
      setTimeout(() => {
        app.isQuitting = true;
        app.quit();
      }, 1000);
    }
    if (isSelfTest) {
      console.log('[Main] Self-test loaded; waiting for result...');
      // Fail-safe: if the renderer never reports back (e.g. it threw before
      // running), exit non-zero so CI/the smoke chain notices.
      selfTestTimer = setTimeout(() => {
        console.error('[Main] Self-test timed out without a result');
        finishSelfTest(false);
      }, 15000);
    }
    if (promoCapture) {
      console.log('[Main] Promo capture loaded; creating isolated product frames...');
      capturePromoFrames(mainWindow, promoCapture)
        .then((manifest) => {
          console.log(`[Main] Promo capture PASSED — ${manifest.frames.length} frame(s)`);
          app.isQuitting = true;
          app.quit();
        })
        .catch((error) => {
          console.error(`[Main] Promo capture failed: ${error.message}`);
          process.exitCode = 1;
          app.isQuitting = true;
          app.quit();
        });
    }
  });

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

// ── System Tray ──────────────────────────────────────────────
function createTray() {
  const icon = getTrayIcon();
  tray = new Tray(icon);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '🎛️ Agent Orchestrator',
      enabled: false,
    },
    { type: 'separator' },
    {
      label: '📋 Show Window',
      click: () => {
        showMainWindow();
      }
    },
    {
      label: '🔄 Restart',
      click: () => {
        app.isQuitting = true;
        app.relaunch();
        app.quit();
      }
    },
    { type: 'separator' },
    {
      label: '❌ Quit',
      click: () => {
        app.isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setToolTip('Agent Orchestrator');
  tray.setContextMenu(contextMenu);

  // Left-click on tray icon shows/focuses window
  tray.on('click', () => {
    showMainWindow();
  });

  console.log('[Main] System tray created');
}

// ── App Lifecycle ────────────────────────────────────────────
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    console.log('[Main] Second instance requested; focusing existing window');
    showMainWindow();
  });

  app.whenReady().then(async () => {
    if (userDataState.migrated) {
      console.log(`[Storage] Migrated ${userDataState.copied} app data file(s) to the singular identity`);
      if (userDataState.skipped) {
        console.warn(`[Storage] Left ${userDataState.skipped} invalid legacy JSON file(s) in the backup location`);
      }
    } else if (userDataState.conflict) {
      console.warn('[Storage] Both legacy and canonical app data exist; canonical data was kept without merging');
    }
    console.log('[Main] App ready, creating window and tray...');
    codexLifecycleBroker = new CodexLifecycleBroker({
      log: message => console.warn(`[Session prompts] ${message}`),
    });
    try {
      await codexLifecycleBroker.start();
    } catch (error) {
      console.warn(`[Session prompts] direct-agent lifecycle unavailable (${error.code || 'error'})`);
      codexLifecycleBroker = null;
    }
    sessions = createSessionRegistry();
    sessionContinuation = new SessionContinuationCore({
      backends: [createOrchestratorPtyContinuationBackend({ registry: sessions })],
    });
    sessionPromptStore = new SessionPromptScheduleStore({
      filePath: sessionPromptFile(),
      onChange: () => sendToRenderer('session-prompt-schedules-changed'),
    });
    try {
      const migration = await sessionPromptStore.migrateV1(ORCHESTRATOR_PTY_BACKEND_ID);
      if (migration.migrated) {
        console.log(`[Session prompts] migrated ${migration.migratedCount} schedule(s) to backend-bound schema v2`);
      }
    } catch (error) {
      console.warn(`[Session prompts] store migration unavailable (${error.code || 'error'})`);
    }
    sessionPromptHandlers = createSessionPromptHandlers({
      store: sessionPromptStore,
      continuation: sessionContinuation,
      defaultBackendId: ORCHESTRATOR_PTY_BACKEND_ID,
    });
    sessionPromptScheduler = new SessionPromptScheduler({
      store: sessionPromptStore,
      inspectBinding: schedule => sessionContinuation?.inspectSchedule(schedule) || { status: 'unavailable' },
      deliver: schedule => sessionContinuation?.deliverClaimed(schedule) || 'unavailable',
      log: message => console.warn(`[Session prompts] ${message}`),
    });
    sessionPromptScheduler.start();
    // Headless verification uses injected renderer fakes and must never recover
    // or write the user's real journal. A test accidentally calling journal IPC
    // should fail closed via requireRunJournal() instead.
    if (!isSmokeTest && !isSelfTest) {
      runJournal = createRunJournal();
      let journalInitializationError = null;
      try {
        const migration = await runJournal.migrateV1Records();
        if (migration.migratedCount) {
          console.log(`[Journal] migrated ${migration.migratedCount} v1 run record(s) to v2`);
        }
        if (migration.skippedCount) {
          console.warn(`[Journal] migration skipped ${migration.skippedCount} unreadable or unsupported record(s)`);
        }
        if (migration.legacyIndexCleanupFailures) {
          console.warn(`[Journal] could not remove ${migration.legacyIndexCleanupFailures} obsolete index file(s); cleanup will retry next launch`);
        }
      } catch (error) {
        journalInitializationError = error;
        const code = typeof error?.code === 'string' ? error.code : 'migration-error';
        console.warn(`[Journal] migration failed (${code})`);
      }
      if (!journalInitializationError) {
        try {
          const deletion = await runJournal.recoverDelete();
          if (deletion.recovered) {
            console.log('[Journal] recovered a confirmed run deletion');
          }
        } catch (error) {
          journalInitializationError = error;
          const code = typeof error?.code === 'string' ? error.code : 'delete-recovery-error';
          console.warn(`[Journal] delete recovery failed (${code})`);
        }
      }
      if (!journalInitializationError) {
        try {
          const retention = await runJournal.recoverPrune();
          if (retention.recovered) {
            if (retention.result.aborted) {
              console.warn('[Journal] discarded a stale retention intent before deletion began');
            } else {
              console.log(
                `[Journal] recovered a confirmed retention transaction (${retention.result.deletedCount} run(s))`
              );
            }
          }
        } catch (error) {
          journalInitializationError = error;
          const code = typeof error?.code === 'string' ? error.code : 'retention-recovery-error';
          console.warn(`[Journal] retention recovery failed (${code})`);
        }
      }
      try {
        const interrupted = await runJournal.recoverInterrupted();
        if (interrupted.length) {
          console.log(`[Journal] recovered ${interrupted.length} interrupted run(s)`);
        }
      } catch (error) {
        journalInitializationError ||= error;
        const code = typeof error?.code === 'string' ? error.code : 'recovery-error';
        console.warn(`[Journal] recovery failed (${code})`);
      }
      if (journalInitializationError) {
        try {
          await rendererContainment.contain(
            'startup journal initialization failed',
            { advanceEpoch: false, newIncident: true }
          );
        } catch (_error) {
          // The coordinator latches the failure and blocks every later journal
          // mutation and session admission until a fresh containment succeeds.
        }
      }
      if (!rendererContainment.failed && (isVisualTest || promoCapture)) {
        const fixture = await seedVisualRunJournal(runJournal);
        console.log(`[Journal] prepared ${fixture.recoveredCount} visual resume scenario(s)`);
      }
    }
    createWindow();
    if (!promoCapture) {
      createTray();
      startSchedulerHeartbeat();
    }
  });
}

// ── Scheduler Heartbeat ──────────────────────────────────────
// A main-process (Node) timer is NOT subject to Chromium's renderer
// throttling, so it reliably fires even when the window is hidden in the
// tray or the screen is locked (as long as the machine is awake). It nudges
// the renderer to re-evaluate its schedules every few seconds.
function startSchedulerHeartbeat() {
  const tick = () => {
    sendToRenderer('scheduler-tick');
  };
  if (schedulerHeartbeatTimer) clearInterval(schedulerHeartbeatTimer);
  schedulerHeartbeatTimer = setInterval(tick, 5000);

  // After the system wakes from sleep, immediately re-check (a run may be due).
  try {
    powerResumeHandler = () => {
      console.log('[Main] System resumed from sleep — re-checking schedules');
      tick();
    };
    powerUnlockHandler = () => tick();
    powerMonitor.on('resume', powerResumeHandler);
    powerMonitor.on('unlock-screen', powerUnlockHandler);
  } catch (e) {
    console.warn(`[Main] powerMonitor unavailable: ${e.message}`);
  }
}

function stopSchedulerHeartbeat() {
  if (schedulerHeartbeatTimer) {
    clearInterval(schedulerHeartbeatTimer);
    schedulerHeartbeatTimer = null;
  }
  try {
    if (powerResumeHandler) {
      powerMonitor.removeListener('resume', powerResumeHandler);
      powerResumeHandler = null;
    }
    if (powerUnlockHandler) {
      powerMonitor.removeListener('unlock-screen', powerUnlockHandler);
      powerUnlockHandler = null;
    }
  } catch (e) {
    console.warn(`[Main] Failed to detach powerMonitor listeners: ${e.message}`);
  }
}

function stopKeepAwake() {
  if (keepAwakeId !== null && powerSaveBlocker.isStarted(keepAwakeId)) {
    powerSaveBlocker.stop(keepAwakeId);
    console.log(`[Main] keep-awake OFF (blocker ${keepAwakeId})`);
  }
  keepAwakeId = null;
}

function cancelSleepTimer({ broadcast = false } = {}) {
  if (sleepTimer) {
    clearTimeout(sleepTimer);
    sleepTimer = null;
  }
  const wasArmed = sleepTarget !== null;
  sleepTarget = null;
  if (broadcast && wasArmed) broadcastSleepState();
  return wasArmed;
}

function killAllActiveProcesses(reason = 'shutdown') {
  return sessions ? sessions.killAll(reason) : 0;
}

function cleanupNonProcessState() {
  if (cleanupComplete) return false;
  cleanupComplete = true;
  app.isQuitting = true;
  stopSchedulerHeartbeat();
  sessionPromptScheduler?.stop();
  codexLifecycleBroker?.stop();
  cancelSleepTimer();
  stopKeepAwake();
  if (tray) {
    tray.destroy();
    tray = null;
  }
  return true;
}

function cleanupForQuit() {
  const firstCleanup = cleanupNonProcessState();
  if (firstCleanup) killAllActiveProcesses('shutdown');
  // before-quit normally performs non-process cleanup first. Temporary test
  // data still belongs to will-quit even when that earlier cleanup was not the
  // first call here; rmSync(force) makes this retry-safe.
  if (userDataState.temporary) {
    try { fs.rmSync(userDataState.path, { recursive: true, force: true }); } catch (_error) { /* retry below */ }
    if (fs.existsSync(userDataState.path) && !testDataCleanupScheduled) {
      testDataCleanupScheduled = true;
      try {
        const helper = spawn(
          process.execPath,
          [
            path.join(__dirname, 'src', 'main', 'cleanup-test-user-data.js'),
            userDataState.path,
            String(process.pid),
          ],
          {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
            env: {
              ELECTRON_RUN_AS_NODE: '1',
              SystemRoot: process.env.SystemRoot,
              TEMP: process.env.TEMP,
              TMP: process.env.TMP,
            },
          }
        );
        helper.unref();
      } catch (_error) {
        console.warn('[Storage] temporary test-data cleanup helper could not start');
      }
    }
  }
}

const shutdownCoordinator = new ShutdownCoordinator({
  getRegistry: () => sessions,
  cleanup: cleanupNonProcessState,
  // A claimed occurrence must finish or be consumed before ConPTY teardown.
  // This also prevents binding loss caused by shutdown from rewriting rows.
  beforeDrain: () => sessionPromptScheduler?.whenIdle(),
  requestQuit: () => app.quit(),
  onError: (err) => console.error(`[Sessions] sequential shutdown failed: ${err.message}`),
});

function handleBeforeQuit(event) {
  shutdownCoordinator.handleBeforeQuit(event);
}

app.on('window-all-closed', () => {
  // On Windows, don't quit when all windows are closed (tray keeps running)
  // Only quit if isQuitting flag is set
});

app.on('before-quit', handleBeforeQuit);
app.on('will-quit', cleanupForQuit);

app.on('activate', () => {
  showMainWindow();
});

// ── IPC: Execute Command ─────────────────────────────────────
// Legacy channel: spawns a plain PowerShell session running one command.
// Kept so workflows saved before the session/agent model still run; it is
// now just a session with no profile and no account selection (L0-native).
handleTrusted('execute-command', async (_event, payload, rendererEpoch) => {
  let id = null;
  try {
    const p = asPlainObject(payload);
    id = asId(p.id, 'session id');
    const command = asText(p.command ?? '', { what: 'command', max: 32_000 });
    console.log(`[IPC] execute-command: id=${id}, commandChars=${command.length}`);

    const { id: sessionId, pid } = await rendererContainment.admitSession(
      rendererEpoch,
      {
        waitForTerminations: () => sessions.whenTerminationsComplete(),
        create: () => sessions.create({
          file: 'powershell.exe',
          args: ['-NoExit', '-Command', command],
          env: process.env,
          cwd: resolveWorkingDir(p.cwd),
          agent: 'shell',
          label: 'Shell',
          assurance: 'L0-native',
        }, { id, cols: asCols(p.cols), rows: asRows(p.rows) }),
      }
    );

    return { id: sessionId, pid };
  } catch (err) {
    console.error(`[IPC] execute-command error: ${err.message}`);
    return { id, error: err.message };
  }
});

// ── IPC: Send Input to Process ───────────────────────────────
handleTrusted('send-input', async (_event, payload) => {
  try {
    const p = asPlainObject(payload);
    return sessions.write(asId(p.id, 'session id'), asText(p.text));
  } catch (err) {
    console.warn(`[IPC] send-input rejected: ${err.message}`);
    return false;
  }
});

// Generated result contracts and handoffs use a separate, main-enforced
// capability. Never fall back to generic terminal input: that could submit an
// untrusted result body at a PowerShell prompt after an agent exits.
handleTrusted('session:send-structured', async (_event, payload) => {
  const p = asPlainObject(payload, 'session:send-structured payload');
  if (!sessions) throw new Error('Session registry is not ready');
  return sessions.writeStructured(
    asId(p.id, 'session id'),
    asText(p.text, { what: 'structured input', max: 2048 })
  );
});

// ── IPC: Resize Process ──────────────────────────────────────
handleTrusted('resize-process', async (_event, payload) => {
  try {
    const p = asPlainObject(payload);
    return sessions.resize(asId(p.id, 'session id'), p.cols, p.rows);
  } catch (err) {
    console.warn(`[IPC] resize-process rejected: ${err.message}`);
    return false;
  }
});

// ── IPC: Kill Process ────────────────────────────────────────
handleTrusted('kill-process', async (_event, payload) => {
  try {
    const p = asPlainObject(payload);
    const removed = await sessions.removeAndWait(asId(p.id, 'session id'));
    if (removed) await reconcileSessionPromptBindings();
    return removed;
  } catch (err) {
    console.warn(`[IPC] kill-process rejected: ${err.message}`);
    return false;
  }
});

// ── IPC: Session Introspection ───────────────────────────────
handleTrusted('list-sessions', async () => (sessions ? sessions.list() : []));

// Output-aware workflow waiting. The checkpoint is an opaque sequence number;
// PTY text remains in the main-process registry and never crosses this bridge.
handleTrusted('session:checkpoint', async (_event, payload) => {
  const p = asPlainObject(payload, 'session:checkpoint payload');
  const id = asId(p.id, 'session id');
  if (!sessions) throw new Error('Session registry is not ready');
  const checkpoint = sessions.checkpoint(id);
  if (!checkpoint) throw new Error(`No session named "${id}"`);
  return checkpoint;
});

handleTrusted('session:wait', async (_event, payload) => {
  const p = asPlainObject(payload, 'session:wait payload');
  const id = asId(p.id, 'session id');
  const waitId = asId(p.waitId, 'wait id');
  const pattern = asText(p.pattern ?? '', { max: 1000, what: 'output pattern' });
  let capture;
  if (p.capture !== undefined) {
    const c = asPlainObject(p.capture, 'result capture');
    capture = {
      startMarker: asText(c.startMarker, { max: 200, what: 'result start marker' }),
      endMarker: asText(c.endMarker, { max: 200, what: 'result end marker' }),
      maxBytes: c.maxBytes,
    };
  }
  if (!sessions) throw new Error('Session registry is not ready');
  return sessions.waitForOutput(id, {
    waitId,
    afterSeq: p.afterSeq,
    idleMs: p.idleMs,
    pattern,
    timeoutMs: p.timeoutMs,
    capture,
  });
});

handleTrusted('session:cancel-wait', async (_event, payload) => {
  const p = asPlainObject(payload, 'session:cancel-wait payload');
  const id = asId(p.id, 'session id');
  const waitId = asId(p.waitId, 'wait id');
  return sessions ? sessions.cancelWait(id, waitId) : false;
});

// ── Agent Profiles ───────────────────────────────────────────
// Local (L2 env-only) profiles live here; routed (L1) Codex accounts are
// discovered from ai-agent-entrypoint, which owns them. See src/main/agents.js.

const ROUTED_CACHE_MS = 60_000;
const routedCache = new RoutedDiscoveryCache({ ttlMs: ROUTED_CACHE_MS });

function agentProfileFile() {
  return path.join(app.getPath('userData'), 'agents.json');
}

/** Where ai-agent-entrypoint lives: an explicit setting, else a sibling checkout. */
function entrypointPath() {
  const configured = loadSettings(settingsFile()).entrypointPath;
  return agentProfiles.resolveEntrypointPath({ configured, appRoot: __dirname });
}

async function getRoutedProfiles({ force = false } = {}) {
  const source = entrypointPath();
  const result = await routedCache.get(source, {
    force,
    discover: async (currentSource) => {
      const discovered = await agentProfiles.discoverRoutedProfiles({ entrypointPath: currentSource });
      if (discovered.error) console.warn(`[Agents] routed discovery: ${discovered.error}`);
      else console.log(`[Agents] discovered ${discovered.profiles.length} routed Codex account(s)`);
      return discovered;
    },
  });
  return { ...result, source };
}

function getLocalProfiles() {
  return agentProfiles.loadLocalProfiles(agentProfileFile(), (id, err) => {
    console.warn(`[Agents] Skipping malformed profile "${id}": ${err.message}`);
  });
}

/** Find a profile by id across both sources. */
async function findProfile(id) {
  const local = getLocalProfiles().find(p => p.id === id);
  if (local) return { profile: local, entrypointSource: null };
  const { profiles, source } = await getRoutedProfiles();
  if (source !== entrypointPath()) {
    throw new Error('The routed account source changed during discovery. Refresh the account list and try again.');
  }
  const profile = profiles.find(p => p.id === id) || null;
  return profile ? { profile, entrypointSource: source } : null;
}

handleTrusted('agents:list', async (_event, payload) => {
  const { force = false } = payload && typeof payload === 'object' ? payload : {};
  const routed = await getRoutedProfiles({ force });
  return {
    local: getLocalProfiles().map(agentProfiles.describeProfile),
    routed: routed.profiles.map(agentProfiles.describeProfile),
    routedError: routed.error,
    entrypointFound: !!entrypointPath(),
    agentKinds: Object.entries(agentProfiles.AGENT_KINDS)
      .filter(([key]) => key !== 'codex')
      .map(([key, def]) => ({
        key, label: def.label, icon: def.icon, command: def.command, homeEnv: def.homeEnv,
      })),
  };
});

handleTrusted('agents:save', async (_event, payload) => {
  const { profile } = asPlainObject(payload, 'agents:save payload');
  // Throws with a user-facing message on a credential-shaped env key.
  const saved = agentProfiles.saveLocalProfile(agentProfileFile(), profile);
  console.log(`[Agents] saved local profile "${saved.id}"`);
  return agentProfiles.describeProfile(saved);
});

handleTrusted('agents:delete', async (_event, payload) => {
  const { id } = asPlainObject(payload, 'agents:delete payload');
  const removed = agentProfiles.deleteLocalProfile(agentProfileFile(), String(id ?? ''));
  if (removed) console.log(`[Agents] deleted local profile "${id}"`);
  return removed;
});

// ── IPC: Start a Session from a Profile ──────────────────────
handleTrusted('session:create', async (_event, payload, rendererEpoch) => {
  try {
    const p = asPlainObject(payload, 'session:create payload');
    if (p.workflowSession !== undefined && typeof p.workflowSession !== 'boolean') {
      throw new Error('session:create workflowSession must be a boolean');
    }
    if (p.sessionMode !== undefined && !['account-shell', 'direct-agent'].includes(p.sessionMode)) {
      throw new Error('session:create sessionMode is invalid');
    }
    const found = await findProfile(String(p.profileId ?? ''));
    if (!found) throw new Error(`No agent profile named "${p.profileId}"`);
    const { profile, entrypointSource } = found;

    const spec = agentProfiles.buildLaunchSpec(profile, {
      baseEnv: process.env,
      entrypointPath: profile.kind === 'routed' ? entrypointSource : null,
      defaultCwd: resolveWorkingDir(p.cwd),
      workflowSession: p.workflowSession === true,
      sessionMode: p.sessionMode || 'account-shell',
      notifyScriptPath: codexNotifyScriptPath(),
    });
    spec.cwd = resolveWorkingDir(spec.cwd);

    const { id, pid } = await rendererContainment.admitSession(
      rendererEpoch,
      {
        waitForTerminations: () => sessions.whenTerminationsComplete(),
        create: () => sessions.create(
          spec,
          { cols: asCols(p.cols), rows: asRows(p.rows) }
        ),
      }
    );
    return { id, pid, session: sessions.describe(id) };
  } catch (err) {
    // Fail-closed errors (a routed alias that cannot be resolved) land here.
    console.error(`[IPC] session:create failed: ${err.message}`);
    return { error: err.message };
  }
});

// ── IPC: Durable prompts for one exact live direct-agent session ──
function requireSessionPromptHandlers() {
  if (!sessionPromptHandlers) throw new Error('Scheduled prompts are not ready');
  return sessionPromptHandlers;
}

handleTrusted('session-prompts:list', async (_event, payload = {}) => (
  requireSessionPromptHandlers().list(payload)
));

handleTrusted('session-prompts:create', async (_event, payload) => (
  requireSessionPromptHandlers().create(payload)
));

handleTrusted('session-prompts:set-enabled', async (_event, payload) => (
  requireSessionPromptHandlers().setEnabled(payload)
));

handleTrusted('session-prompts:delete', async (_event, payload) => (
  requireSessionPromptHandlers().delete(payload)
));

// ── IPC: Keep Awake (power save blocker) ─────────────────────
// The renderer requests this ON while any future scheduled run is pending,
// so the machine won't sleep through a scheduled time. The display is still
// allowed to turn off ('prevent-app-suspension'), only system sleep is held.
handleTrusted('set-keep-awake', async (_event, { on }) => {
  if (on) {
    if (keepAwakeId === null || !powerSaveBlocker.isStarted(keepAwakeId)) {
      keepAwakeId = powerSaveBlocker.start('prevent-app-suspension');
      console.log(`[IPC] keep-awake ON (blocker ${keepAwakeId}) — system sleep held for pending schedule`);
    }
  } else if (keepAwakeId !== null && powerSaveBlocker.isStarted(keepAwakeId)) {
    powerSaveBlocker.stop(keepAwakeId);
    console.log(`[IPC] keep-awake OFF (blocker ${keepAwakeId})`);
    keepAwakeId = null;
  }
  return keepAwakeId !== null;
});

// ── IPC: Delayed System Hibernate ────────────────────────────
// The renderer arms a delayed hibernate (e.g. "hibernate in 5 min") via a
// Hibernate block — used to save power after an agent run finishes. The timer
// lives HERE in the main process (a Node timer isn't throttled by Chromium),
// so it fires reliably even when the window is hidden in the tray. The
// renderer shows a live countdown and can force-cancel it.
//
// Hibernate (`shutdown /h`) is deliberate: it has single, predictable
// behavior, unlike SetSuspendState which silently hibernates anyway when
// system hibernation is enabled.
function broadcastSleepState() {
  sendToRenderer('sleep-state', { target: sleepTarget });
}

function runHibernate() {
  // Release any sleep-blocker first so hibernate isn't held off.
  stopKeepAwake();
  try {
    spawn('shutdown', ['/h'], { windowsHide: true });
    console.log('[Hibernate] Triggered system hibernate');
  } catch (err) {
    console.error(`[Hibernate] Failed: ${err.message}`);
  }
}

handleTrusted('arm-sleep', async (_event, { delayMs }) => {
  cancelSleepTimer();
  const ms = Math.max(0, Number(delayMs) || 0);
  sleepTarget = Date.now() + ms;
  console.log(`[Hibernate] Armed: in ${Math.round(ms / 1000)}s`);
  sleepTimer = setTimeout(() => {
    sleepTimer = null;
    sleepTarget = null;
    broadcastSleepState();
    runHibernate();
  }, ms);
  broadcastSleepState();
  return { target: sleepTarget };
});

handleTrusted('cancel-sleep', async () => {
  const wasArmed = cancelSleepTimer();
  if (wasArmed) console.log('[Hibernate] Cancelled by user');
  broadcastSleepState();
  return wasArmed;
});

handleTrusted('get-sleep-state', async () => ({ target: sleepTarget }));

// ── IPC: Kill All Processes ──────────────────────────────────
// Used at the start of a run to clear the default shell and any
// leftover processes from previous runs, preventing PTY leaks.
handleTrusted('kill-all-processes', async () => {
  const count = sessions ? await sessions.killAllSequential('renderer request') : 0;
  if (count) await reconcileSessionPromptBindings();
  if (count) console.log(`[IPC] kill-all-processes: terminated ${count} process(es)`);
  return count;
});

// ── IPC: App Defaults ────────────────────────────────────────
handleTrusted('get-default-directory', async () => app.getPath('home'));
handleTrusted('get-app-version', async () => app.getVersion());

// ── IPC: Run Journal ─────────────────────────────────────────
// Metadata is public to the local renderer. Workflow snapshots and explicit
// result bodies stay encrypted at rest (or memory-only when safeStorage is
// unavailable). Plaintext is decrypted only for an explicit result reveal or
// a resume preflight, and a preflight returns redacted facts rather than bodies.
function requireRunJournal() {
  if (!runJournal) throw new Error('Run Journal is not ready');
  return runJournal;
}

handleTrusted('journal:start', (event, payload, rendererEpoch) => {
  const input = asPlainObject(payload, 'journal:start payload');
  return rendererContainment.runJournal(
    rendererEpoch,
    () => requireRunJournal().startRun(input)
  );
});

handleTrusted('journal:block-start', (event, payload, rendererEpoch) => {
  const input = asPlainObject(payload, 'journal:block-start payload');
  return rendererContainment.runJournal(
    rendererEpoch,
    () => requireRunJournal().startBlock(input)
  );
});

handleTrusted('journal:block-finish', (event, payload, rendererEpoch) => {
  const input = asPlainObject(payload, 'journal:block-finish payload');
  return rendererContainment.runJournal(
    rendererEpoch,
    () => requireRunJournal().finishBlock(input)
  );
});

handleTrusted('journal:result-store', (event, payload, rendererEpoch) => {
  const input = asPlainObject(payload, 'journal:result-store payload');
  return rendererContainment.runJournal(
    rendererEpoch,
    () => requireRunJournal().storeResult(input)
  );
});

handleTrusted('journal:finish', (event, payload, rendererEpoch) => {
  const input = asPlainObject(payload, 'journal:finish payload');
  return rendererContainment.runJournal(
    rendererEpoch,
    () => requireRunJournal().finishRun(input)
  );
});

handleTrusted('journal:list', (event, payload = {}, rendererEpoch) => {
  const input = asPlainObject(payload, 'journal:list payload');
  return rendererContainment.runJournal(
    rendererEpoch,
    () => requireRunJournal().listRuns(input)
  );
});

handleTrusted('journal:get', (event, payload, rendererEpoch) => {
  const input = asPlainObject(payload, 'journal:get payload');
  return rendererContainment.runJournal(
    rendererEpoch,
    () => requireRunJournal().getRun(input)
  );
});

handleTrusted('journal:resume-preflight', (event, payload, rendererEpoch) => {
  const input = asPlainObject(payload, 'journal:resume-preflight payload');
  return rendererContainment.runJournal(rendererEpoch, async () => {
    const localProfiles = new Map(getLocalProfiles().map(profile => [profile.id, profile]));
    let routedAuthority = null;
    const resolveProfile = async (profileId) => {
      const local = localProfiles.get(profileId);
      if (local) return agentProfiles.describeProfile(local);
      if (!routedAuthority) routedAuthority = getRoutedProfiles({ force: true });
      const routed = await routedAuthority;
      if (routed.error) throw new Error('Routed account authority is unavailable');
      if (routed.source !== entrypointPath()) {
        throw new Error('Routed account authority changed during preflight');
      }
      return agentProfiles.describeProfile(
        routed.profiles.find(profile => profile.id === profileId) || null
      );
    };
    return requireRunJournal().preflightResume(input, {
      resolveProfile,
      isDirectory,
    });
  });
});

handleTrusted('journal:result-get', (event, payload, rendererEpoch) => {
  const input = asPlainObject(payload, 'journal:result-get payload');
  return rendererContainment.runJournal(
    rendererEpoch,
    () => requireRunJournal().getResult(input)
  );
});

handleTrusted('journal:delete', (event, payload, rendererEpoch) => {
  const input = asPlainObject(payload, 'journal:delete payload');
  return rendererContainment.runJournal(
    rendererEpoch,
    () => requireRunJournal().deleteRun(input)
  );
});

handleTrusted('journal:prune', (event, payload, rendererEpoch) => {
  const input = asPlainObject(payload, 'journal:prune payload');
  return rendererContainment.runJournal(
    rendererEpoch,
    () => requireRunJournal().pruneRuns(input)
  );
});

// ── IPC: Settings ────────────────────────────────────────────
// Preferences and machine-local paths only. Never credentials.
handleTrusted('get-settings', async () => loadSettings(settingsFile()));

handleTrusted('update-settings', async (_event, payload) => {
  const patch = asPlainObject(payload, 'settings patch');
  const before = loadSettings(settingsFile());
  const saved = saveSettings(settingsFile(), patch);
  if (saved.entrypointPath !== before.entrypointPath) routedCache.invalidate();
  return saved;
});

// ── IPC: Self-Test Result ────────────────────────────────────
// The renderer reports the headless engine self-test outcome here; we log it
// and exit with a matching status code so `npm test` reflects pass/fail.
function finishSelfTest(passed) {
  if (selfTestTimer) { clearTimeout(selfTestTimer); selfTestTimer = null; }
  app.isQuitting = true;
  cleanupForQuit();
  app.exit(passed ? 0 : 1);
}

if (isSelfTest) {
  handleTrusted('self-test-result', async (_event, { passed, details } = {}) => {
    if (passed) console.log(`[Main] Self-test PASSED — ${details || ''}`);
    else console.error(`[Main] Self-test FAILED — ${details || ''}`);
    finishSelfTest(!!passed);
    return true;
  });
}

// ── IPC: Save Workflow ───────────────────────────────────────
function workflowStoreDir() {
  return path.join(app.getPath('userData'), 'workflows');
}

function safeWorkflowFileName(workflow) {
  const rawId = typeof workflow?.id === 'string' && workflow.id.trim()
    ? workflow.id.trim()
    : `wf-${Date.now()}`;
  const safeId = rawId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 96) || `wf-${Date.now()}`;
  return `${safeId}.json`;
}

function readWorkflowFile(filePath) {
  return { ...readJsonStrict(filePath), file: path.basename(filePath) };
}

handleTrusted('save-workflow', async (_event, payload) => {
  const { workflow, filePath, file } = asPlainObject(payload, 'save-workflow payload');
  if (!workflow || typeof workflow !== 'object') {
    throw new Error('Workflow payload is invalid');
  }
  const dir = ensureDir(workflowStoreDir());
  let target = filePath;
  if (!target && file) {
    const requested = String(file);
    const base = path.basename(requested);
    if (base !== requested || !base.endsWith('.json')) {
      throw new Error('Stored workflow file must be a JSON basename');
    }
    target = path.join(dir, base);
  }
  target ||= path.join(dir, safeWorkflowFileName(workflow));
  return writeJsonAtomic(target, workflow);
});

// ── IPC: Load Workflow ───────────────────────────────────────
handleTrusted('load-workflow', async (_event, payload) => {
  const { filePath } = asPlainObject(payload, 'load-workflow payload');
  if (filePath) {
    return readWorkflowFile(filePath);
  }
  // One malformed file must not break the whole listing.
  return readJsonDir(workflowStoreDir(), (file, err) => {
    console.warn(`[IPC] Skipping unreadable workflow "${file}": ${err.message}`);
  }).map(({ file, data }) => ({ ...data, file }));
});

// ── IPC: Delete Workflow ─────────────────────────────────────
handleTrusted('delete-workflow', async (_event, { file, id } = {}) => {
  const dir = workflowStoreDir();
  let target = null;
  if (file) {
    const base = path.basename(String(file));
    if (base.endsWith('.json')) target = path.join(dir, base);
  } else if (id) {
    target = path.join(dir, safeWorkflowFileName({ id }));
  }
  if (!target) throw new Error('No workflow specified to delete');

  // Refuse to touch anything outside the workflow store directory.
  const resolved = path.resolve(target);
  if (path.dirname(resolved) !== path.resolve(dir)) {
    throw new Error('Refusing to delete outside the workflow store');
  }
  if (fs.existsSync(resolved)) {
    fs.unlinkSync(resolved);
    console.log(`[IPC] delete-workflow: removed ${path.basename(resolved)}`);
    return true;
  }
  return false;
});

// ── IPC: Directory Picker ────────────────────────────────────
handleTrusted('select-directory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });
  return result.canceled ? null : result.filePaths[0];
});

// ── IPC: File Dialogs ────────────────────────────────────────
handleTrusted('open-file-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    filters: [{ name: 'Workflow', extensions: ['json'] }],
    properties: ['openFile']
  });
  return result.canceled ? null : result.filePaths[0];
});

handleTrusted('save-file-dialog', async () => {
  const result = await dialog.showSaveDialog(mainWindow, {
    filters: [{ name: 'Workflow', extensions: ['json'] }],
  });
  return result.canceled ? null : result.filePath;
});
