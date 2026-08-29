const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const CAPTURE_SIZE = Object.freeze({ width: 1600, height: 1000 });

// Legibility dials. A frame is only useful if a reader can still read the UI
// after the host surface scales it down: GitHub renders a README image at
// roughly 900px, so a 1600px frame arrives at 0.56x and this app's 9-11px
// secondary labels fall under 6px. `scale` raises output resolution (sharper,
// same apparent size), `zoom` enlarges the UI within the same frame, and a
// focus crop publishes the region that carries the claim.
const CAPTURE_LIMITS = Object.freeze({ minScale: 1, maxScale: 3, minZoom: 0.5, maxZoom: 2.5 });
const DETAIL_SUFFIX = '-detail.png';
const EVIDENCE_STABILITY = Object.freeze({ attempts: 40, samples: 3, tolerance: 0.5, intervalMs: 32 });

function evidenceConfig({ selectors, boundary, scrollContainer = null, paddingX = 16, paddingY = 20 }) {
  return Object.freeze({
    selectors: Object.freeze(selectors),
    boundary,
    scrollContainer,
    paddingCss: Object.freeze({ x: paddingX, y: paddingY }),
  });
}

const FRAME_STEPS = Object.freeze([
  {
    file: '01-workflow-editor.png',
    label: 'Parallel workflow in the real editor',
    claim: 'join-waiting',
    evidence: evidenceConfig({
      selectors: ['.workflow-block[data-type="agentJoin"]'],
      boundary: '#editor-canvas',
      scrollContainer: '#editor-canvas',
    }),
    script: `(() => {
      document.querySelectorAll('.modal-overlay').forEach((modal) => modal.classList.add('hidden'));
      document.querySelectorAll('.workflow-block').forEach((block) => block.classList.remove('done', 'error', 'executing'));
      const blocks = [...document.querySelectorAll('.workflow-block')];
      blocks.slice(0, 4).forEach((block) => block.classList.add('done'));
      const join = document.querySelector('.workflow-block[data-type="agentJoin"]');
      join?.classList.add('executing');
      if (join) {
        const header = join.querySelector('.block-header');
        const badge = document.createElement('span');
        badge.className = 'agent-join-progress';
        badge.textContent = '2/3 ready';
        header?.appendChild(badge);
      }
      const next = join?.nextElementSibling?.matches('.block-connector')
        ? join.nextElementSibling.nextElementSibling
        : join?.nextElementSibling;
      document.getElementById('workflow-status').textContent = 'Running';
      document.getElementById('workflow-status').className = 'workflow-status running';
      document.getElementById('status-text').textContent = 'Waiting at Join Agents · 2/3 ready';
      document.getElementById('status-indicator').className = 'status-indicator running';
      document.getElementById('output-log').innerHTML = [
        '<div class="log-line system">❯ Product capture fixture — no agent or account was launched.</div>',
        '<div class="log-line">↗ Prompt sent to every workflow agent concurrently.</div>',
        '<div class="log-line">✓ Research lane A published an explicit result.</div>',
        '<div class="log-line">✓ Research lane B published an explicit result.</div>',
        '<div class="log-line system">◇ Join Agents · 2/3 ready · downstream work remains stopped.</div>'
      ].join('');
      if (!join || !next || !join.classList.contains('executing') || next.classList.contains('executing')) {
        throw new Error('Promo fixture could not prove the waiting Join boundary');
      }
      return {
        workflow: document.getElementById('workflow-name')?.value,
        blockCount: blocks.length,
        ready: 2,
        total: 3,
        downstream: 'stopped',
        executionAvailable: false
      };
    })()`,
  },
  {
    file: '02-join-and-handoff.png',
    label: 'Join completion and explicit result handoff',
    claim: 'join-handoff',
    evidence: evidenceConfig({
      selectors: [
        '.workflow-block[data-type="agentJoin"]',
        '.workflow-block[data-type="agentJoin"] + .block-connector + .workflow-block'
      ],
      boundary: '#editor-canvas',
      scrollContainer: '#editor-canvas',
      paddingY: 16,
    }),
    script: `(() => {
      const blocks = [...document.querySelectorAll('.workflow-block')];
      const join = document.querySelector('.workflow-block[data-type="agentJoin"]');
      const next = join?.nextElementSibling?.matches('.block-connector')
        ? join.nextElementSibling.nextElementSibling
        : join?.nextElementSibling;
      blocks.forEach((block) => block.classList.remove('done', 'error', 'executing'));
      const joinIndex = blocks.indexOf(join);
      blocks.slice(0, joinIndex + 1).forEach((block) => block.classList.add('done'));
      const badge = join?.querySelector('.agent-join-progress');
      if (badge) {
        badge.textContent = '3/3 ready';
        badge.classList.add('done');
      }
      next?.classList.add('executing');
      document.getElementById('status-text').textContent = 'Result bundle attached · synthesis running';
      document.getElementById('output-log').innerHTML = [
        '<div class="log-line system">❯ Product capture fixture — no agent or account was launched.</div>',
        '<div class="log-line">✓ Three explicit results captured inside bounded frames.</div>',
        '<div class="log-line system">◇ Join Agents · 3/3 ready.</div>',
        '<div class="log-line">↳ Complete research bundle attached to the synthesis prompt.</div>',
        '<div class="log-line system">▶ Downstream synthesis stage admitted.</div>'
      ].join('');
      if (!join || !next || !join.classList.contains('done') || !next.classList.contains('executing')) {
        throw new Error('Promo fixture could not prove the completed Join handoff');
      }
      return { ready: 3, total: 3, handoff: 'research', downstream: 'running', executionAvailable: false };
    })()`,
  },
  {
    file: '03-run-journal.png',
    label: 'Protected Run Journal evidence',
    claim: 'journal-review-boundary',
    evidence: evidenceConfig({
      selectors: [
        '#runs-list .run-row.selected',
        '#run-detail .run-detail-head',
        '#run-detail .run-resume-evidence'
      ],
      boundary: '#runs-modal .run-journal-layout',
      paddingX: 12,
      paddingY: 12,
    }),
    script: `(() => {
      document.getElementById('btn-runs')?.click();
      return {
        modalOpen: !document.getElementById('runs-modal')?.classList.contains('hidden'),
        decision: 'required',
        executionAvailable: false
      };
    })()`,
    settleMs: 900,
  },
]);

const BOOTSTRAP_SCRIPT = `(() => {
  const captureStyle = document.createElement('style');
  captureStyle.id = 'promo-capture-stability';
  captureStyle.textContent = [
    '*, *::before, *::after {',
    '  animation: none !important;',
    '  caret-color: transparent !important;',
    '  scroll-behavior: auto !important;',
    '  transition: none !important;',
    '}'
  ].join('\\n');
  document.head.appendChild(captureStyle);
  document.getElementById('btn-templates')?.click();
  document.querySelector('[data-template-id="tpl-multi-account"]')?.click();
  const badge = document.createElement('div');
  badge.id = 'promo-capture-badge';
  badge.textContent = 'PRODUCT UI · INERT CAPTURE FIXTURE';
  Object.assign(badge.style, {
    position: 'fixed', right: '18px', top: '42px', zIndex: '10000',
    padding: '7px 11px', borderRadius: '999px',
    border: '1px solid rgba(110, 231, 183, .45)',
    background: 'rgba(7, 17, 31, .92)', color: '#6ee7b7',
    font: '700 11px/1.2 system-ui, sans-serif', letterSpacing: '.08em'
  });
  document.body.appendChild(badge);
  return { ready: true };
})()`;

const FONTS_READY_SCRIPT = `(() => (
  document.fonts?.ready ? document.fonts.ready.then(() => ({ ready: true })) : { ready: true }
))()`;

function parseNumericFlag(argv, flag, fallback, { min, max }) {
  const arg = argv.find((entry) => entry.startsWith(`${flag}=`));
  if (!arg) return fallback;
  const value = Number(arg.slice(flag.length + 1));
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${flag} must be a number between ${min} and ${max}`);
  }
  return value;
}

function parsePromoCaptureOptions(argv, cwd = process.cwd()) {
  if (!Array.isArray(argv) || !argv.includes('--promo-capture')) return null;
  const outputArg = argv.find((arg) => arg.startsWith('--promo-output='));
  const raw = outputArg?.slice('--promo-output='.length).trim();
  if (!raw) throw new Error('--promo-capture requires --promo-output=<directory>');
  const outputDir = path.resolve(cwd, raw);
  if (path.parse(outputDir).root === outputDir) {
    throw new Error('Promo capture output cannot be a filesystem root');
  }
  const scale = parseNumericFlag(argv, '--promo-scale', 1, {
    min: CAPTURE_LIMITS.minScale,
    max: CAPTURE_LIMITS.maxScale,
  });
  const zoom = parseNumericFlag(argv, '--promo-zoom', 1, {
    min: CAPTURE_LIMITS.minZoom,
    max: CAPTURE_LIMITS.maxZoom,
  });
  return {
    outputDir,
    ...CAPTURE_SIZE,
    scale,
    zoom,
    details: argv.includes('--promo-details'),
  };
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

const rectLiteral = rect => ({
  x: rect.x,
  y: rect.y,
  width: rect.width,
  height: rect.height,
});

const EVIDENCE_STAGE_SCRIPT = evidence => `(() => {
  const selectors = ${JSON.stringify(evidence.selectors)};
  const elements = selectors.map(selector => document.querySelector(selector));
  if (elements.some(element => !element)) {
    return { error: 'required evidence element is missing' };
  }
  const scroller = ${evidence.scrollContainer
    ? `document.querySelector(${JSON.stringify(evidence.scrollContainer)})`
    : 'null'};
  if (scroller) {
    scroller.style.scrollBehavior = 'auto';
    const rects = elements.map(element => element.getBoundingClientRect());
    const top = Math.min(...rects.map(rect => rect.top));
    const bottom = Math.max(...rects.map(rect => rect.bottom));
    const scrollerRect = scroller.getBoundingClientRect();
    const delta = ((top + bottom) / 2) - ((scrollerRect.top + scrollerRect.bottom) / 2);
    scroller.scrollTop = Math.max(0, Math.min(
      scroller.scrollTop + delta,
      scroller.scrollHeight - scroller.clientHeight
    ));
  }
  return { staged: true };
})()`;

const EVIDENCE_MEASURE_SCRIPT = evidence => `(() => {
  const selectors = ${JSON.stringify(evidence.selectors)};
  const elements = selectors.map(selector => document.querySelector(selector));
  const boundary = document.querySelector(${JSON.stringify(evidence.boundary)});
  if (!boundary || elements.some(element => !element)) {
    return { error: 'required evidence geometry is missing' };
  }
  const rect = value => ({ x: value.x, y: value.y, width: value.width, height: value.height });
  const scroller = ${evidence.scrollContainer
    ? `document.querySelector(${JSON.stringify(evidence.scrollContainer)})`
    : 'null'};
  return {
    dpr: window.devicePixelRatio,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    boundary: rect(boundary.getBoundingClientRect()),
    rects: elements.map(element => rect(element.getBoundingClientRect())),
    scroll: scroller ? { left: scroller.scrollLeft, top: scroller.scrollTop } : null
  };
})()`;

function assertFiniteRect(rect, label) {
  if (!rect || ['x', 'y', 'width', 'height'].some(key => !Number.isFinite(rect[key]))) {
    throw new Error(`${label} is invalid`);
  }
  if (rect.width <= 0 || rect.height <= 0) throw new Error(`${label} is empty`);
  return rectLiteral(rect);
}

function evidenceSnapshotsEqual(left, right, tolerance = EVIDENCE_STABILITY.tolerance) {
  if (!left || !right || left.error || right.error) return false;
  if (left.rects?.length !== right.rects?.length) return false;
  const close = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance;
  const sameRect = (a, b) => ['x', 'y', 'width', 'height'].every(key => close(a?.[key], b?.[key]));
  if (!close(left.dpr, right.dpr) || !sameRect(left.boundary, right.boundary)) return false;
  if (!left.rects.every((rect, index) => sameRect(rect, right.rects[index]))) return false;
  if (Boolean(left.scroll) !== Boolean(right.scroll)) return false;
  return !left.scroll || (close(left.scroll.left, right.scroll.left) && close(left.scroll.top, right.scroll.top));
}

async function waitForStableEvidence(webContents, evidence, dependencies = {}) {
  const delay = dependencies.delay || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const measure = dependencies.measure || (() => webContents.executeJavaScript(
    EVIDENCE_MEASURE_SCRIPT(evidence),
    true
  ));
  const policy = { ...EVIDENCE_STABILITY, ...(dependencies.policy || {}) };
  let previous = null;
  let stableSamples = 0;
  for (let attempt = 0; attempt < policy.attempts; attempt += 1) {
    const current = await measure();
    if (current?.error) throw new Error(`Promo evidence is unavailable: ${current.error}`);
    if (evidenceSnapshotsEqual(previous, current, policy.tolerance)) stableSamples += 1;
    else stableSamples = 1;
    if (stableSamples >= policy.samples) return current;
    previous = current;
    await delay(policy.intervalMs);
  }
  throw new Error(`Promo evidence did not settle after ${policy.attempts} measurements`);
}

function evidenceCropBox(snapshot, frameSize, evidence) {
  const dpr = snapshot?.dpr;
  if (!Number.isFinite(dpr) || dpr <= 0) throw new Error('Promo evidence device scale is invalid');
  const boundary = assertFiniteRect(snapshot.boundary, 'Promo evidence boundary');
  if (!Array.isArray(snapshot.rects) || snapshot.rects.length !== evidence.selectors.length) {
    throw new Error('Promo evidence selector count does not match its geometry');
  }
  const rects = snapshot.rects.map((rect, index) => assertFiniteRect(rect, `Promo evidence rect ${index + 1}`));
  const left = Math.min(...rects.map(rect => rect.x));
  const top = Math.min(...rects.map(rect => rect.y));
  const right = Math.max(...rects.map(rect => rect.x + rect.width));
  const bottom = Math.max(...rects.map(rect => rect.y + rect.height));
  const paddingX = evidence.paddingCss.x;
  const paddingY = evidence.paddingCss.y;
  const padded = {
    left: left - paddingX,
    top: top - paddingY,
    right: right + paddingX,
    bottom: bottom + paddingY,
  };
  const boundaryRight = boundary.x + boundary.width;
  const boundaryBottom = boundary.y + boundary.height;
  if (
    padded.left < boundary.x
    || padded.top < boundary.y
    || padded.right > boundaryRight
    || padded.bottom > boundaryBottom
  ) {
    throw new Error('Promo evidence cannot retain its safe margin inside the claim boundary');
  }
  const box = {
    x: Math.floor(padded.left * dpr),
    y: Math.floor(padded.top * dpr),
    width: Math.ceil(padded.right * dpr) - Math.floor(padded.left * dpr),
    height: Math.ceil(padded.bottom * dpr) - Math.floor(padded.top * dpr),
  };
  if (box.x < 0 || box.y < 0 || box.x + box.width > frameSize.width || box.y + box.height > frameSize.height) {
    throw new Error('Promo evidence crop falls outside the captured frame');
  }
  const unionArea = (right - left) * (bottom - top);
  const cropCssArea = (padded.right - padded.left) * (padded.bottom - padded.top);
  return { ...box, claimCoverage: Number((unionArea / cropCssArea).toFixed(4)) };
}

async function capturePromoFrames(browserWindow, options, dependencies = {}) {
  if (!browserWindow || browserWindow.isDestroyed?.()) {
    throw new Error('Promo capture requires a live BrowserWindow');
  }
  const outputDir = options?.outputDir;
  if (!outputDir) throw new Error('Promo capture output directory is required');

  const scale = options.scale || 1;
  const zoom = options.zoom || 1;
  const expected = { width: options.width * scale, height: options.height * scale };

  const mkdir = dependencies.mkdir || fs.mkdir;
  const writeFile = dependencies.writeFile || fs.writeFile;
  const delay = dependencies.delay || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const executeJavaScript = dependencies.executeJavaScript
    || ((script) => browserWindow.webContents.executeJavaScript(script, true));
  const stabilizeEvidence = dependencies.stabilizeEvidence
    || ((evidence) => waitForStableEvidence(browserWindow.webContents, evidence, { delay }));
  const measureEvidence = dependencies.measureEvidence
    || ((evidence) => executeJavaScript(EVIDENCE_MEASURE_SCRIPT(evidence)));
  await mkdir(outputDir, { recursive: true });
  if (zoom !== 1) browserWindow.webContents.setZoomFactor?.(zoom);
  await delay(350);
  await executeJavaScript(BOOTSTRAP_SCRIPT);
  await executeJavaScript(FONTS_READY_SCRIPT);
  await delay(250);

  const frames = [];
  for (const step of FRAME_STEPS) {
    const state = await executeJavaScript(step.script);
    await delay(step.settleMs || 300);
    if (options.details && step.evidence) {
      const staged = await executeJavaScript(EVIDENCE_STAGE_SCRIPT(step.evidence));
      if (staged?.error) throw new Error(`Promo detail staging failed for ${step.file}: ${staged.error}`);
      await stabilizeEvidence(step.evidence);
    }
    // A hidden BrowserWindow can retain the previous compositor frame even
    // after the DOM has settled. Invalidate and discard one capture so the
    // artifact always reflects the state named by this step.
    browserWindow.webContents.invalidate?.();
    await browserWindow.capturePage();
    await delay(100);
    const evidenceSnapshot = options.details && step.evidence
      ? await stabilizeEvidence(step.evidence)
      : null;
    // A scaled window can round its content size up by a device pixel per
    // axis. Trim that overshoot so receipts stay exact; anything larger means
    // the window is not the size this capture claims and must fail.
    const captured = await browserWindow.capturePage();
    if (evidenceSnapshot) {
      const afterCapture = await measureEvidence(step.evidence);
      if (!evidenceSnapshotsEqual(evidenceSnapshot, afterCapture)) {
        throw new Error(`Promo evidence moved while ${step.file} was captured`);
      }
    }
    const capturedSize = captured.getSize();
    const overshoot = {
      width: capturedSize.width - expected.width,
      height: capturedSize.height - expected.height,
    };
    if (overshoot.width < 0 || overshoot.height < 0 || overshoot.width > scale || overshoot.height > scale) {
      throw new Error(
        `Promo frame ${step.file} is ${capturedSize.width}x${capturedSize.height}; expected ${expected.width}x${expected.height}`
      );
    }
    const image = overshoot.width || overshoot.height
      ? captured.crop({ x: 0, y: 0, ...expected })
      : captured;
    const png = image.toPNG();
    const size = image.getSize();
    await writeFile(path.join(outputDir, step.file), png);
    frames.push({
      file: step.file,
      label: step.label,
      claim: step.claim,
      state,
      width: size.width,
      height: size.height,
      sha256: sha256(png),
    });

    if (options.details && step.evidence) {
      const box = evidenceCropBox(evidenceSnapshot, size, step.evidence);
      const crop = { x: box.x, y: box.y, width: box.width, height: box.height };
      const detail = image.crop(crop);
      const detailPng = detail.toPNG();
      const detailFile = step.file.replace(/\.png$/, DETAIL_SUFFIX);
      await writeFile(path.join(outputDir, detailFile), detailPng);
      frames.push({
        file: detailFile,
        label: `${step.label} — detail`,
        width: box.width,
        height: box.height,
        detailOf: step.file,
        derivation: {
          method: 'lossless-parent-crop',
          crop,
          evidenceSelectors: [...step.evidence.selectors],
          boundarySelector: step.evidence.boundary,
          paddingCss: { ...step.evidence.paddingCss },
          claimCoverage: box.claimCoverage,
        },
        sha256: sha256(detailPng),
      });
    }
  }

  const manifest = {
    schemaVersion: 2,
    source: 'Agent Orchestrator isolated visual fixture',
    capture: {
      scale,
      zoom,
      motion: 'frozen',
      detailDerivation: 'lossless-parent-crop',
    },
    disclosure: 'Real renderer UI with inert fixture state; no PTY or agent was launched, and no account or production data was read.',
    viewport: { width: options.width, height: options.height },
    frames,
  };
  await writeFile(
    path.join(outputDir, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8'
  );
  return manifest;
}

module.exports = {
  CAPTURE_SIZE,
  CAPTURE_LIMITS,
  EVIDENCE_STABILITY,
  FRAME_STEPS,
  evidenceCropBox,
  evidenceSnapshotsEqual,
  waitForStableEvidence,
  capturePromoFrames,
  parsePromoCaptureOptions,
};
