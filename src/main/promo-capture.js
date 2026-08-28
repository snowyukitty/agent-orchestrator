const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const CAPTURE_SIZE = Object.freeze({ width: 1600, height: 1000 });

const FRAME_STEPS = Object.freeze([
  {
    file: '01-workflow-editor.png',
    label: 'Parallel workflow in the real editor',
    script: `(() => {
      document.querySelectorAll('.modal-overlay').forEach((modal) => modal.classList.add('hidden'));
      document.querySelectorAll('.workflow-block').forEach((block) => block.classList.remove('done', 'error', 'executing'));
      const blocks = [...document.querySelectorAll('.workflow-block')];
      blocks.slice(0, 4).forEach((block) => block.classList.add('done'));
      const join = document.querySelector('[data-type="agentJoin"]');
      join?.classList.add('executing');
      if (join) {
        const header = join.querySelector('.block-header');
        const badge = document.createElement('span');
        badge.className = 'agent-join-progress';
        badge.textContent = '2/3 ready';
        header?.appendChild(badge);
        join.scrollIntoView({ block: 'center' });
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
    script: `(() => {
      const blocks = [...document.querySelectorAll('.workflow-block')];
      const join = document.querySelector('[data-type="agentJoin"]');
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
      join?.scrollIntoView({ block: 'center' });
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

function parsePromoCaptureOptions(argv, cwd = process.cwd()) {
  if (!Array.isArray(argv) || !argv.includes('--promo-capture')) return null;
  const outputArg = argv.find((arg) => arg.startsWith('--promo-output='));
  const raw = outputArg?.slice('--promo-output='.length).trim();
  if (!raw) throw new Error('--promo-capture requires --promo-output=<directory>');
  const outputDir = path.resolve(cwd, raw);
  if (path.parse(outputDir).root === outputDir) {
    throw new Error('Promo capture output cannot be a filesystem root');
  }
  return { outputDir, ...CAPTURE_SIZE };
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function capturePromoFrames(browserWindow, options, dependencies = {}) {
  if (!browserWindow || browserWindow.isDestroyed?.()) {
    throw new Error('Promo capture requires a live BrowserWindow');
  }
  const outputDir = options?.outputDir;
  if (!outputDir) throw new Error('Promo capture output directory is required');

  const mkdir = dependencies.mkdir || fs.mkdir;
  const writeFile = dependencies.writeFile || fs.writeFile;
  const delay = dependencies.delay || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  await mkdir(outputDir, { recursive: true });
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
    const image = await browserWindow.capturePage();
    const png = image.toPNG();
    const size = image.getSize();
    if (size.width !== options.width || size.height !== options.height) {
      throw new Error(
        `Promo frame ${step.file} is ${size.width}x${size.height}; expected ${options.width}x${options.height}`
      );
    }
    await writeFile(path.join(outputDir, step.file), png);
    frames.push({
      file: step.file,
      label: step.label,
      width: size.width,
      height: size.height,
      sha256: sha256(png),
    });
  }

  const manifest = {
    schemaVersion: 1,
    source: 'Agent Orchestrator isolated visual fixture',
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
  FRAME_STEPS,
  capturePromoFrames,
  parsePromoCaptureOptions,
};
