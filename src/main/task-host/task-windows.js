// One dedicated BrowserWindow per task, bound to its launch in main.
//
// A task window's IPC identity is the window itself: main maps the sender's
// webContents to its launch and never accepts a launch id from the page.
// Closing the window detaches the view; only Stop ends the task.

const { assertTrustedIpcSender, installNavigationGuards } = require('../trust');
const { asCols, asRows } = require('../validate');

const READY_TIMEOUT_MS = 15_000;
const MAX_INPUT_CHARS = 4096;

function createTaskWindowPresentation({
  BrowserWindow,
  ipcMain,
  entryFile,
  preload,
  icon = null,
  getHost,
  // Whether an explicit `show` may take focus. A new task window never does:
  // it may open while the owner is typing elsewhere, or with nobody there.
  activate = true,
  log = () => {},
}) {
  /** launchId -> { win, attached } */
  const windows = new Map();
  /** webContents id -> launchId */
  const owners = new Map();

  function bound(event) {
    const launchId = owners.get(event?.sender?.id);
    const entry = launchId && windows.get(launchId);
    if (!entry || entry.win.isDestroyed()) throw new Error('Rejected IPC from an unknown task window');
    assertTrustedIpcSender(event, entryFile, entry.win.webContents);
    return { launchId, entry };
  }

  ipcMain.handle('task-window:attach', (event) => {
    const { launchId, entry } = bound(event);
    const view = getHost()?.windowAttach(launchId);
    // Snapshot and start streaming in the same main-process turn, so no
    // output chunk is both replayed and streamed, or neither.
    entry.attached = true;
    return view ? { ...view, title: entry.win.getTitle() } : null;
  });
  ipcMain.handle('task-window:input', (event, text) => {
    const { launchId } = bound(event);
    if (typeof text !== 'string' || !text || text.length > MAX_INPUT_CHARS) return false;
    return getHost()?.windowInput(launchId, text) === true;
  });
  ipcMain.handle('task-window:resize', (event, size) => {
    const { launchId } = bound(event);
    return getHost()?.windowResize(launchId, asCols(size?.cols), asRows(size?.rows)) === true;
  });
  ipcMain.handle('task-window:stop', (event) => {
    const { launchId } = bound(event);
    return getHost()?.stop(launchId) || { ok: false };
  });

  function send(launchId, channel, payload) {
    const entry = windows.get(launchId);
    if (!entry?.attached || entry.win.isDestroyed() || entry.win.webContents.isDestroyed()) return;
    try { entry.win.webContents.send(channel, payload); } catch (_error) { /* closing */ }
  }

  return {
    async openTaskWindow({ launchId, title }) {
      if (windows.has(launchId)) throw new Error('Task window already open');
      const win = new BrowserWindow({
        width: 1040,
        height: 700,
        minWidth: 640,
        minHeight: 400,
        title,
        show: false,
        backgroundColor: '#0a0a0f',
        autoHideMenuBar: true,
        ...(icon ? { icon } : {}),
        webPreferences: {
          preload,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          backgroundThrottling: false,
        },
      });
      const webContentsId = win.webContents.id;
      windows.set(launchId, { win, attached: false });
      owners.set(webContentsId, launchId);
      installNavigationGuards(win.webContents, entryFile, log);
      // Keep the task's title; the page cannot rename its window.
      win.on('page-title-updated', event => event.preventDefault());
      win.on('closed', () => {
        windows.delete(launchId);
        owners.delete(webContentsId);
        getHost()?.windowClosed(launchId);
      });

      const ready = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Task window did not become ready')), READY_TIMEOUT_MS);
        win.once('ready-to-show', () => { clearTimeout(timer); resolve(); });
        win.once('closed', () => { clearTimeout(timer); reject(new Error('Task window closed while opening')); });
      });
      try {
        await win.loadFile(entryFile);
        await ready;
      } catch (error) {
        if (!win.isDestroyed()) win.destroy();
        throw error;
      }
      win.showInactive();
      return {
        windowId: win.id,
        shown: win.isVisible(),
        nativeHandle: win.getNativeWindowHandle().length > 0,
      };
    },
    isOpen(launchId) {
      const entry = windows.get(launchId);
      return !!entry && !entry.win.isDestroyed();
    },
    focus(launchId) {
      const entry = windows.get(launchId);
      if (!entry || entry.win.isDestroyed()) return false;
      if (entry.win.isMinimized()) entry.win.restore();
      entry.win.show();
      if (activate) entry.win.focus();
      return true;
    },
    window(launchId) {
      return windows.get(launchId)?.win || null;
    },
    sendOutput(launchId, data) { send(launchId, 'task-window:output', data); },
    sendState(launchId, state) { send(launchId, 'task-window:state', state); },
    closeAll() {
      for (const { win } of windows.values()) if (!win.isDestroyed()) win.destroy();
    },
  };
}

module.exports = { createTaskWindowPresentation };
