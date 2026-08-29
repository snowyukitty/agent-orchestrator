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
// A detail crop is grown around its focus element to at least this much CSS
// area so the surrounding context still reads as the product, not a fragment.
const DETAIL_MIN_CSS = Object.freeze({ width: 720, height: 460 });

const FRAME_STEPS = Object.freeze([
  {
    file: '01-workflow-editor.png',
    label: 'Parallel workflow in the real editor',
    focus: '.workflow-block[data-type="agentJoin"]',
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
      const canvas = document.getElementById('editor-canvas');
      if (canvas && join) {
        canvas.scrollTop += join.getBoundingClientRect().top - canvas.getBoundingClientRect().top - 130;
      }
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
      return { workflow: document.getElementById('workflow-name')?.value, blockCount: blocks.length };
    })()`,
  },
  {
    file: '02-join-and-handoff.png',
    label: 'Join completion and explicit result handoff',
    focus: '.workflow-block[data-type="agentJoin"]',
    script: `(() => {
      const blocks = [...document.querySelectorAll('.workflow-block')];
      const join = document.querySelector('.workflow-block[data-type="agentJoin"]');
      const next = join?.nextElementSibling?.matches('.workflow-connector')
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
      const canvas = document.getElementById('editor-canvas');
      if (canvas && join) {
        canvas.scrollTop += join.getBoundingClientRect().top - canvas.getBoundingClientRect().top - 130;
      }
      document.getElementById('status-text').textContent = 'Result bundle attached · synthesis running';
      document.getElementById('output-log').innerHTML = [
        '<div class="log-line system">❯ Product capture fixture — no agent or account was launched.</div>',
        '<div class="log-line">✓ Three explicit results captured inside bounded frames.</div>',
        '<div class="log-line system">◇ Join Agents · 3/3 ready.</div>',
        '<div class="log-line">↳ Complete research bundle attached to the synthesis prompt.</div>',
        '<div class="log-line system">▶ Downstream synthesis stage admitted.</div>'
      ].join('');
      return { ready: 3, total: 3 };
    })()`,
  },
  {
    file: '03-run-journal.png',
    label: 'Protected Run Journal evidence',
    focus: '#runs-modal .modal-card',
    script: `(() => {
      document.getElementById('btn-runs')?.click();
      return { modalOpen: !document.getElementById('runs-modal')?.classList.contains('hidden') };
    })()`,
    settleMs: 900,
  },
]);

const BOOTSTRAP_SCRIPT = `(() => {
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

// Chromium reports device-scale and page-zoom together, so one read of
// devicePixelRatio converts a CSS rect into output pixels regardless of which
// dial produced the magnification.
const FOCUS_RECT_SCRIPT = (selector) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height, dpr: window.devicePixelRatio };
})()`;

function detailCropBox(rect, frameSize) {
  // Grow the focus rect to the minimum context box, then clamp it inside the
  // frame without changing its size, so the crop keeps a stable aspect.
  const dpr = rect.dpr || 1;
  const width = Math.min(Math.max(rect.width, DETAIL_MIN_CSS.width * 1) * dpr, frameSize.width);
  const height = Math.min(Math.max(rect.height, DETAIL_MIN_CSS.height * 1) * dpr, frameSize.height);
  const centerX = (rect.x + rect.width / 2) * dpr;
  const centerY = (rect.y + rect.height / 2) * dpr;
  const x = Math.round(Math.min(Math.max(centerX - width / 2, 0), frameSize.width - width));
  const y = Math.round(Math.min(Math.max(centerY - height / 2, 0), frameSize.height - height));
  return { x, y, width: Math.round(width), height: Math.round(height) };
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
  await mkdir(outputDir, { recursive: true });
  if (zoom !== 1) browserWindow.webContents.setZoomFactor?.(zoom);
  await delay(350);
  await browserWindow.webContents.executeJavaScript(BOOTSTRAP_SCRIPT, true);
  await delay(250);

  const frames = [];
  for (const step of FRAME_STEPS) {
    await browserWindow.webContents.executeJavaScript(step.script, true);
    await delay(step.settleMs || 300);
    // A hidden BrowserWindow can retain the previous compositor frame even
    // after the DOM has settled. Invalidate and discard one capture so the
    // artifact always reflects the state named by this step.
    browserWindow.webContents.invalidate?.();
    await browserWindow.capturePage();
    await delay(100);
    // A scaled window can round its content size up by a device pixel per
    // axis. Trim that overshoot so receipts stay exact; anything larger means
    // the window is not the size this capture claims and must fail.
    const captured = await browserWindow.capturePage();
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
      width: size.width,
      height: size.height,
      sha256: sha256(png),
    });

    if (options.details && step.focus) {
      const rect = await browserWindow.webContents.executeJavaScript(
        FOCUS_RECT_SCRIPT(step.focus),
        true
      );
      if (!rect) throw new Error(`Promo detail focus not found for ${step.file}: ${step.focus}`);
      const box = detailCropBox(rect, size);
      const detail = image.crop(box);
      const detailPng = detail.toPNG();
      const detailFile = step.file.replace(/\.png$/, DETAIL_SUFFIX);
      await writeFile(path.join(outputDir, detailFile), detailPng);
      frames.push({
        file: detailFile,
        label: `${step.label} — detail`,
        width: box.width,
        height: box.height,
        detailOf: step.file,
        sha256: sha256(detailPng),
      });
    }
  }

  const manifest = {
    schemaVersion: 1,
    source: 'Agent Orchestrator isolated visual fixture',
    capture: { scale, zoom },
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
  FRAME_STEPS,
  detailCropBox,
  capturePromoFrames,
  parsePromoCaptureOptions,
};
