const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {
  CAPTURE_SIZE,
  FRAME_STEPS,
  capturePromoFrames,
  parsePromoCaptureOptions,
} = require('../src/main/promo-capture');

test('promo capture arguments are explicit, isolated, and never target a filesystem root', () => {
  assert.equal(parsePromoCaptureOptions(['electron', '.']), null);
  assert.throws(
    () => parsePromoCaptureOptions(['electron', '.', '--promo-capture']),
    /requires --promo-output/
  );
  const parsed = parsePromoCaptureOptions(
    ['electron', '.', '--promo-capture', '--promo-output=docs/assets/promo'],
    path.join('D:\\', 'work', 'agent-orchestrator')
  );
  assert.equal(parsed.width, CAPTURE_SIZE.width);
  assert.equal(parsed.height, CAPTURE_SIZE.height);
  assert.equal(parsed.outputDir, path.resolve('D:\\work\\agent-orchestrator', 'docs/assets/promo'));
  assert.throws(
    () => parsePromoCaptureOptions(
      ['electron', '.', '--promo-capture', '--promo-output=D:\\'],
      'D:\\work'
    ),
    /filesystem root/
  );
});

test('promo capture writes three hashed real-renderer frames and a truthful manifest', async () => {
  const calls = [];
  const pngs = FRAME_STEPS.map((_, index) => Buffer.from(`frame-${index + 1}`));
  let captureIndex = 0;
  const browserWindow = {
    isDestroyed: () => false,
    webContents: {
      executeJavaScript: async (script) => {
        calls.push(['script', script]);
        return { ready: true };
      },
    },
    capturePage: async () => {
      const png = pngs[Math.floor(captureIndex++ / 2)];
      return {
        toPNG: () => png,
        getSize: () => ({ width: 1600, height: 1000 }),
      };
    },
  };
  const writes = new Map();
  const manifest = await capturePromoFrames(
    browserWindow,
    { outputDir: 'D:\\capture', ...CAPTURE_SIZE },
    {
      mkdir: async (...args) => calls.push(['mkdir', ...args]),
      delay: async () => {},
      writeFile: async (file, body) => writes.set(path.basename(file), body),
    }
  );

  assert.equal(manifest.frames.length, 3);
  assert.deepEqual(manifest.viewport, CAPTURE_SIZE);
  assert.match(manifest.disclosure, /no PTY or agent was launched/i);
  assert.match(manifest.disclosure, /no account or production data was read/i);
  assert.deepEqual([...writes.keys()], [
    '01-workflow-editor.png',
    '02-join-and-handoff.png',
    '03-run-journal.png',
    'manifest.json',
  ]);
  assert.equal(manifest.frames[0].sha256.length, 64);
  assert.equal(calls.filter(([kind]) => kind === 'script').length, 4);
});

test('promo capture rejects a device-scaled frame instead of writing a misleading receipt', async () => {
  const browserWindow = {
    isDestroyed: () => false,
    webContents: {
      executeJavaScript: async () => ({ ready: true }),
    },
    capturePage: async () => ({
      toPNG: () => Buffer.from('scaled-frame'),
      getSize: () => ({ width: 2400, height: 1500 }),
    }),
  };

  await assert.rejects(
    capturePromoFrames(
      browserWindow,
      { outputDir: 'D:\\capture', ...CAPTURE_SIZE },
      { mkdir: async () => {}, delay: async () => {}, writeFile: async () => {} }
    ),
    /2400x1500; expected 1600x1000/
  );
});
