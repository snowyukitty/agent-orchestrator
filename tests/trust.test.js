const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const {
  isTrustedRendererUrl,
  getUsableWebContents,
  assertTrustedIpcSender,
  installNavigationGuards,
} = require('../src/main/trust');

const ENTRY = path.resolve('src/index.html');
const ENTRY_URL = pathToFileURL(ENTRY).href;

test('trusted renderer URL accepts only the configured local file', () => {
  assert.equal(isTrustedRendererUrl(`${ENTRY_URL}?selftest=1#ready`, ENTRY), true);
  assert.equal(isTrustedRendererUrl('https://example.com/', ENTRY), false);
  assert.equal(isTrustedRendererUrl(pathToFileURL(path.resolve('preload.js')).href, ENTRY), false);
  assert.equal(isTrustedRendererUrl('not a url', ENTRY), false);
});

test('privileged IPC accepts only the expected main frame and webContents', () => {
  const mainFrame = { url: ENTRY_URL };
  const webContents = { mainFrame, isDestroyed: () => false };
  const event = { sender: webContents, senderFrame: mainFrame };
  assert.equal(assertTrustedIpcSender(event, ENTRY, webContents), true);

  assert.throws(
    () => assertTrustedIpcSender(
      { sender: webContents, senderFrame: { url: ENTRY_URL } },
      ENTRY,
      webContents
    ),
    /non-main frame/
  );
  const remoteFrame = { url: 'https://example.com/' };
  const remoteWebContents = { mainFrame: remoteFrame, isDestroyed: () => false };
  assert.throws(
    () => assertTrustedIpcSender(
      { sender: remoteWebContents, senderFrame: remoteFrame },
      ENTRY
    ),
    /unexpected renderer location/
  );
  assert.throws(
    () => assertTrustedIpcSender(event, ENTRY, { mainFrame }),
    /unexpected renderer/
  );
});

test('destroyed Electron objects fail closed without leaking getter TypeErrors', () => {
  assert.equal(getUsableWebContents({
    isDestroyed: () => true,
    get webContents() { throw new TypeError('Object has been destroyed'); },
  }), null);
  assert.equal(getUsableWebContents({
    isDestroyed: () => false,
    get webContents() { throw new TypeError('Object has been destroyed'); },
  }), null);
  assert.equal(getUsableWebContents({
    isDestroyed: () => false,
    webContents: { isDestroyed: () => true },
  }), null);

  const destroyedSender = {
    isDestroyed: () => false,
    get mainFrame() { throw new TypeError('Object has been destroyed'); },
  };
  assert.throws(
    () => assertTrustedIpcSender(
      { sender: destroyedSender, senderFrame: {} },
      ENTRY
    ),
    /unavailable renderer/
  );
  const destroyedFrame = {};
  Object.defineProperty(destroyedFrame, 'url', {
    get() { throw new TypeError('Object has been destroyed'); },
  });
  const sender = { isDestroyed: () => false, mainFrame: destroyedFrame };
  assert.throws(
    () => assertTrustedIpcSender(
      { sender, senderFrame: destroyedFrame },
      ENTRY
    ),
    /unavailable renderer/
  );
});

test('navigation guards deny remote navigation, webviews, and new windows', () => {
  const handlers = new Map();
  let windowHandler;
  const logs = [];
  const webContents = {
    on(name, handler) { handlers.set(name, handler); },
    setWindowOpenHandler(handler) { windowHandler = handler; },
  };
  installNavigationGuards(webContents, ENTRY, message => logs.push(message));

  let prevented = 0;
  handlers.get('will-navigate')(
    { preventDefault: () => { prevented += 1; } },
    'https://example.com/'
  );
  handlers.get('will-redirect')(
    { preventDefault: () => { prevented += 1; } },
    pathToFileURL(path.resolve('preload.js')).href
  );
  handlers.get('will-navigate')(
    { preventDefault: () => { prevented += 1; } },
    ENTRY_URL
  );
  handlers.get('will-attach-webview')({ preventDefault: () => { prevented += 1; } });

  assert.equal(prevented, 3);
  assert.deepEqual(windowHandler({ url: 'https://example.com/' }), { action: 'deny' });
  assert.equal(logs.length, 4);
});
