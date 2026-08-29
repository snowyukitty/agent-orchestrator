const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {
  CAPTURE_SIZE,
  FRAME_STEPS,
  capturePromoFrames,
  evidenceCropBox,
  evidenceSnapshotsEqual,
  parsePromoCaptureOptions,
  waitForStableEvidence,
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

  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.capture.motion, 'frozen');
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
  assert.equal(calls.filter(([kind]) => kind === 'script').length, 5);
});

test('evidence crop keeps every claim rect and safe margin inside its boundary', () => {
  const evidence = {
    selectors: ['#claim'],
    boundary: '#boundary',
    paddingCss: { x: 16, y: 20 },
  };
  const box = evidenceCropBox({
    dpr: 2,
    boundary: { x: 80, y: 80, width: 600, height: 400 },
    rects: [{ x: 120, y: 140, width: 500, height: 200 }],
  }, { width: 1600, height: 1000 }, evidence);

  assert.deepEqual(box, {
    x: 208,
    y: 240,
    width: 1064,
    height: 480,
    claimCoverage: 0.7832,
  });
});

test('evidence crop rejects silent clamping at a claim boundary', () => {
  const evidence = {
    selectors: ['#claim'],
    boundary: '#boundary',
    paddingCss: { x: 16, y: 20 },
  };
  assert.throws(() => evidenceCropBox({
    dpr: 2,
    boundary: { x: 80, y: 80, width: 600, height: 400 },
    rects: [{ x: 90, y: 140, width: 500, height: 200 }],
  }, { width: 1600, height: 1000 }, evidence), /safe margin/);
});

test('evidence stability includes boundary, claim rects, scale, and scroll position', () => {
  const base = {
    dpr: 2.5,
    boundary: { x: 100, y: 80, width: 600, height: 500 },
    rects: [{ x: 140, y: 120, width: 500, height: 200 }],
    scroll: { left: 0, top: 400 },
  };
  assert.equal(evidenceSnapshotsEqual(base, {
    ...base,
    rects: [{ x: 140.3, y: 120.2, width: 500, height: 200 }],
  }), true);
  assert.equal(evidenceSnapshotsEqual(base, {
    ...base,
    scroll: { left: 0, top: 401 },
  }), false);
});

test('evidence stability waits for consecutive settled measurements', async () => {
  const measurements = [10, 20, 20.2, 20.1].map(x => ({
    dpr: 2,
    boundary: { x: 0, y: 0, width: 800, height: 600 },
    rects: [{ x, y: 100, width: 400, height: 200 }],
    scroll: { left: 0, top: 300 },
  }));
  const result = await waitForStableEvidence({}, {}, {
    delay: async () => {},
    measure: async () => measurements.shift(),
    policy: { attempts: 4, samples: 3, intervalMs: 0, tolerance: 0.5 },
  });
  assert.equal(result.rects[0].x, 20.1);
});

test('promo detail frames carry parent-linked semantic crop receipts', async () => {
  let captureIndex = 0;
  const crops = [];
  const browserWindow = {
    isDestroyed: () => false,
    webContents: {
      setZoomFactor() {},
      invalidate() {},
    },
    capturePage: async () => {
      const frameIndex = Math.floor(captureIndex++ / 2);
      return {
        toPNG: () => Buffer.from(`frame-${frameIndex}`),
        getSize: () => ({ width: 1600, height: 1000 }),
        crop: box => {
          crops.push(box);
          return { toPNG: () => Buffer.from(`detail-${frameIndex}`) };
        },
      };
    },
  };
  const snapshotFor = evidence => ({
    dpr: 1,
    boundary: { x: 80, y: 60, width: 1200, height: 800 },
    rects: evidence.selectors.map((_, index) => ({
      x: 140 + (index * 30),
      y: 120 + (index * 170),
      width: 700,
      height: 140,
    })),
    scroll: evidence.scrollContainer ? { left: 0, top: 200 } : null,
  });
  const writes = new Map();
  const manifest = await capturePromoFrames(browserWindow, {
    outputDir: 'D:\\capture',
    ...CAPTURE_SIZE,
    details: true,
  }, {
    mkdir: async () => {},
    delay: async () => {},
    executeJavaScript: async script => (
      script.includes('required evidence element is missing') ? { staged: true } : { inert: true }
    ),
    stabilizeEvidence: async evidence => snapshotFor(evidence),
    measureEvidence: async evidence => snapshotFor(evidence),
    writeFile: async (file, body) => writes.set(path.basename(file), body),
  });

  assert.equal(manifest.frames.length, 6);
  assert.equal(crops.length, 3);
  assert.deepEqual([...writes.keys()], [
    '01-workflow-editor.png',
    '01-workflow-editor-detail.png',
    '02-join-and-handoff.png',
    '02-join-and-handoff-detail.png',
    '03-run-journal.png',
    '03-run-journal-detail.png',
    'manifest.json',
  ]);
  const details = manifest.frames.filter(frame => frame.detailOf);
  assert.equal(details.length, 3);
  assert.ok(details.every(frame => frame.derivation.method === 'lossless-parent-crop'));
  assert.ok(details.every(frame => frame.derivation.evidenceSelectors.length > 0));
  assert.deepEqual(details.map(frame => frame.derivation.crop), crops);
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
