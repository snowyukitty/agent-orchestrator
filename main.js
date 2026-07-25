// ============================================================
// Agents Orchestrator — Electron Main Process
// System Tray Application with Process Automation
// ============================================================
const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, nativeImage, powerMonitor, powerSaveBlocker } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const pty = require('node-pty');

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
const activeProcesses = new Map();
const gotSingleInstanceLock = app.requestSingleInstanceLock();
const isSmokeTest = process.argv.includes('--smoke-test');
const isSelfTest = process.argv.includes('--self-test');
let selfTestTimer = null;

function isDirectory(dir) {
  try {
    return !!dir && fs.statSync(dir).isDirectory();
  } catch (_e) {
    return false;
  }
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

// ── Window Creation ──────────────────────────────────────────
function createWindow() {
  const icon = getWindowIcon();

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1000,
    minHeight: 600,
    backgroundColor: '#0a0a0f',
    show: false,
    center: true,
    autoHideMenuBar: true,
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // keep timers full-speed when hidden/locked
    }
  });

  mainWindow.loadFile('src/index.html', isSelfTest ? { query: { selftest: '1' } } : undefined);

  // Show window only after content is fully rendered
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
    console.log('[Main] Window shown and focused');
  });

  // Clicking X hides to tray instead of quitting
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
      console.log('[Main] Window hidden to tray');
    }
  });

  // Debug: log page load errors
  mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
    console.error(`[Main] Page load failed: ${code} - ${desc}`);
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
      label: '🎛️ Agents Orchestrator',
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

  tray.setToolTip('Agents Orchestrator');
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

  app.whenReady().then(() => {
    console.log('[Main] App ready, creating window and tray...');
    createWindow();
    createTray();
    startSchedulerHeartbeat();
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
  const entries = Array.from(activeProcesses.entries());
  activeProcesses.clear();
  for (const [id, proc] of entries) {
    console.log(`[Main] Killing process (${reason}): ${id}`);
    try {
      proc.kill('SIGTERM');
    } catch (_e) {
      try { process.kill(proc.pid, 'SIGTERM'); } catch (_e2) { /* ignore */ }
    }
  }
  return entries.length;
}

function cleanupForQuit() {
  if (cleanupComplete) return;
  cleanupComplete = true;
  app.isQuitting = true;
  stopSchedulerHeartbeat();
  cancelSleepTimer();
  stopKeepAwake();
  killAllActiveProcesses('shutdown');
  if (tray) {
    tray.destroy();
    tray = null;
  }
}

app.on('window-all-closed', () => {
  // On Windows, don't quit when all windows are closed (tray keeps running)
  // Only quit if isQuitting flag is set
});

app.on('before-quit', cleanupForQuit);
app.on('will-quit', cleanupForQuit);

app.on('activate', () => {
  showMainWindow();
});

// ── IPC: Execute Command ─────────────────────────────────────
ipcMain.handle('execute-command', async (_event, { id, command, cwd, cols = 80, rows = 24 }) => {
  try {
    console.log(`[IPC] execute-command: "${command}" in "${cwd}"`);

    // If a process is already registered under this id, kill it first so we
    // never overwrite the Map entry and orphan the old PTY.
    const existing = activeProcesses.get(id);
    if (existing) {
      try { existing.kill(); } catch (e) { /* ignore */ }
      activeProcesses.delete(id);
    }

    // Validate the working directory — a missing path makes ConPTY fail with
    // "Cannot create process, error code: 267" and leaves a dead terminal.
    let workingDir = cwd;
    if (!isDirectory(workingDir)) {
      const fallback = app.getPath('home');
      if (workingDir) console.warn(`[IPC] cwd not found: "${workingDir}" — falling back to "${fallback}"`);
      workingDir = fallback;
    }

    // Using node-pty with ConPTY (wmux-inspired config)
    const proc = pty.spawn('powershell.exe', ['-NoExit', '-Command', command], {
      name: 'xterm-color',
      cols: cols,
      rows: rows,
      cwd: workingDir,
      env: process.env,
      useConpty: true,
      conptyInheritCursor: true
    });

    activeProcesses.set(id, proc);

    proc.onData((data) => {
      sendToRenderer('process-output', {
        id, data: data.toString(), stream: 'stdout'
      });
    });

    proc.onExit(({ exitCode }) => {
      activeProcesses.delete(id);
      sendToRenderer('process-exit', { id, code: exitCode });
    });

    return { id, pid: proc.pid };
  } catch (err) {
    console.error(`[IPC] execute-command error: ${err.message}`);
    return { id, error: err.message };
  }
});

// ── IPC: Send Input to Process ───────────────────────────────
ipcMain.handle('send-input', async (_event, { id, text }) => {
  const proc = activeProcesses.get(id);
  if (proc) {
    proc.write(text.replace(/\n/g, '\r'));
    return true;
  }
  return false;
});

// ── IPC: Resize Process ──────────────────────────────────────
ipcMain.handle('resize-process', async (_event, { id, cols, rows }) => {
  const proc = activeProcesses.get(id);
  if (proc && typeof proc.resize === 'function') {
    try {
      proc.resize(cols, rows);
      return true;
    } catch (e) {
      console.error(`[IPC] resize error: ${e.message}`);
    }
  }
  return false;
});

// ── IPC: Kill Process ────────────────────────────────────────
ipcMain.handle('kill-process', async (_event, { id }) => {
  const proc = activeProcesses.get(id);
  if (proc) {
    activeProcesses.delete(id);
    try {
      proc.kill('SIGTERM');
    } catch (e) {
      try { process.kill(proc.pid, 'SIGTERM'); } catch (e2) { /* ignore */ }
    }
    return true;
  }
  return false;
});

// ── IPC: Keep Awake (power save blocker) ─────────────────────
// The renderer requests this ON while any future scheduled run is pending,
// so the machine won't sleep through a scheduled time. The display is still
// allowed to turn off ('prevent-app-suspension'), only system sleep is held.
ipcMain.handle('set-keep-awake', async (_event, { on }) => {
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

ipcMain.handle('arm-sleep', async (_event, { delayMs }) => {
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

ipcMain.handle('cancel-sleep', async () => {
  const wasArmed = cancelSleepTimer();
  if (wasArmed) console.log('[Hibernate] Cancelled by user');
  broadcastSleepState();
  return wasArmed;
});

ipcMain.handle('get-sleep-state', async () => ({ target: sleepTarget }));

// ── IPC: Kill All Processes ──────────────────────────────────
// Used at the start of a run to clear the default shell and any
// leftover processes from previous runs, preventing PTY leaks.
ipcMain.handle('kill-all-processes', async () => {
  const count = killAllActiveProcesses('renderer request');
  if (count) console.log(`[IPC] kill-all-processes: terminated ${count} process(es)`);
  return count;
});

// ── IPC: App Defaults ────────────────────────────────────────
ipcMain.handle('get-default-directory', async () => app.getPath('home'));
ipcMain.handle('get-app-version', async () => app.getVersion());

// ── IPC: Self-Test Result ────────────────────────────────────
// The renderer reports the headless engine self-test outcome here; we log it
// and exit with a matching status code so `npm test` reflects pass/fail.
function finishSelfTest(passed) {
  if (selfTestTimer) { clearTimeout(selfTestTimer); selfTestTimer = null; }
  app.isQuitting = true;
  cleanupForQuit();
  app.exit(passed ? 0 : 1);
}

ipcMain.handle('self-test-result', async (_event, { passed, details } = {}) => {
  if (passed) console.log(`[Main] Self-test PASSED — ${details || ''}`);
  else console.error(`[Main] Self-test FAILED — ${details || ''}`);
  finishSelfTest(!!passed);
  return true;
});

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
  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = JSON.parse(raw);
  return { file: path.basename(filePath), ...parsed };
}

ipcMain.handle('save-workflow', async (_event, { workflow, filePath }) => {
  if (!workflow || typeof workflow !== 'object') {
    throw new Error('Workflow payload is invalid');
  }

  const dir = workflowStoreDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const target = filePath || path.join(dir, safeWorkflowFileName(workflow));
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(workflow, null, 2), 'utf-8');
  fs.renameSync(tmp, target);
  return target;
});

// ── IPC: Load Workflow ───────────────────────────────────────
ipcMain.handle('load-workflow', async (_event, { filePath }) => {
  if (filePath) {
    return readWorkflowFile(filePath);
  }
  const dir = workflowStoreDir();
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  const workflows = [];
  for (const file of files) {
    const fullPath = path.join(dir, file);
    try {
      workflows.push(readWorkflowFile(fullPath));
    } catch (err) {
      console.warn(`[IPC] Skipping unreadable workflow "${file}": ${err.message}`);
    }
  }
  return workflows;
});

// ── IPC: Delete Workflow ─────────────────────────────────────
ipcMain.handle('delete-workflow', async (_event, { file, id } = {}) => {
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
ipcMain.handle('select-directory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });
  return result.canceled ? null : result.filePaths[0];
});

// ── IPC: File Dialogs ────────────────────────────────────────
ipcMain.handle('open-file-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    filters: [{ name: 'Workflow', extensions: ['json'] }],
    properties: ['openFile']
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('save-file-dialog', async () => {
  const result = await dialog.showSaveDialog(mainWindow, {
    filters: [{ name: 'Workflow', extensions: ['json'] }],
  });
  return result.canceled ? null : result.filePath;
});
