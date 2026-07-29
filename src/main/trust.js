// ============================================================
// Main-process trust boundary helpers
//
// The preload API can launch commands and change machine state, so only the
// app's own top-level renderer may invoke it. Keep the checks here free of an
// Electron dependency so the policy is unit-testable.
// ============================================================
const path = require('path');
const { fileURLToPath } = require('url');

function comparablePath(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isTrustedRendererUrl(rawUrl, expectedFile) {
  if (typeof rawUrl !== 'string' || !rawUrl || !expectedFile) return false;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'file:') return false;
    return comparablePath(fileURLToPath(parsed)) === comparablePath(expectedFile);
  } catch (_err) {
    return false;
  }
}

function getUsableWebContents(browserWindow) {
  try {
    if (!browserWindow || browserWindow.isDestroyed?.()) return null;
    const webContents = browserWindow.webContents;
    if (!webContents || webContents.isDestroyed?.()) return null;
    return webContents;
  } catch (_err) {
    // Electron getters can throw "Object has been destroyed" during teardown.
    return null;
  }
}

function assertTrustedIpcSender(event, expectedFile, expectedWebContents = null) {
  let frame;
  let sender;
  let mainFrame;
  let frameUrl;
  try {
    frame = event?.senderFrame;
    sender = event?.sender;
    if (!frame || !sender || sender.isDestroyed?.()) {
      throw new Error('unavailable');
    }
    mainFrame = sender.mainFrame;
    frameUrl = frame.url;
  } catch (_err) {
    throw new Error('Rejected IPC from an unavailable renderer');
  }
  if (!mainFrame || frame !== mainFrame) {
    throw new Error('Rejected IPC from a non-main frame');
  }
  if (expectedWebContents && sender !== expectedWebContents) {
    throw new Error('Rejected IPC from an unexpected renderer');
  }
  if (!isTrustedRendererUrl(frameUrl, expectedFile)) {
    throw new Error('Rejected IPC from an unexpected renderer location');
  }
  return true;
}

function installNavigationGuards(webContents, expectedFile, log = () => {}) {
  const blockUnexpectedNavigation = (event, targetUrl) => {
    if (isTrustedRendererUrl(targetUrl, expectedFile)) return;
    event.preventDefault();
    log('[Security] Blocked unexpected renderer navigation');
  };

  webContents.on('will-navigate', blockUnexpectedNavigation);
  webContents.on('will-redirect', blockUnexpectedNavigation);
  webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
    log('[Security] Blocked webview attachment');
  });
  webContents.setWindowOpenHandler(() => {
    log('[Security] Blocked renderer window creation');
    return { action: 'deny' };
  });
}

module.exports = {
  isTrustedRendererUrl,
  getUsableWebContents,
  assertTrustedIpcSender,
  installNavigationGuards,
};
