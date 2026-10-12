// Compare real renderer snapshots without production IPC, PTYs, or user data.
// Historical source is materialized into a temporary directory, never checked out.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const baseline = 'e0cca66';
const current = '3873319';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-compare-'));
const output = path.join(root, 'docs', 'ui-comparison');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(temp, 'user-data'));
app.disableHardwareAcceleration();
function materialize(ref, name) {
  const source = path.join(temp, name);
  const files = execFileSync('git', ['ls-tree', '-r', '--name-only', ref, '--', 'src'], { cwd: root, encoding: 'utf8' }).trim().split('\n');
  for (const file of files) {
    const destination = path.join(source, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, execFileSync('git', ['show', `${ref}:${file}`], { cwd: root }));
  }
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(source, 'node_modules'), 'junction');
  return source;
}
const oldRoot = materialize(baseline, 'before');
const rejectedRoot = materialize(current, 'rejected');
const errors = [];
const windows = [];
const evaluate = (win, fn) => win.webContents.executeJavaScript(`(${fn.toString()})()`);
async function settle(win) {
  await evaluate(win, () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await evaluate(win, () => Promise.all(document.getAnimations().filter(a => a.effect?.getComputedTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))));
}
async function capture(win, file) {
  await settle(win);
  fs.writeFileSync(path.join(output, file), (await win.webContents.capturePage()).toPNG());
}
async function create(source) {
  const win = new BrowserWindow({ show: false, webPreferences: {
    preload: path.join(root, 'scripts/ui-preview-preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
  } });
  windows.push(win);
  win.setContentSize(1440, 900);
  win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  await win.loadFile(path.join(source, 'src/index.html'));
  await settle(win);
  return win;
}
function fixture() {
  window.app._setDirty(false);
  window.app._applyTemplate({ name: 'Scheduled hello', blocks: [
    { type: 'schedule', params: { datetime: '2030-01-15T05:30', mode: 'once' } },
    { type: 'directory', params: { path: '.' } },
    { type: 'agentStart', params: { profileId: 'codex:demo', settleMs: 8000 } },
    { type: 'agentWait', params: { profileId: 'codex:demo', idleMs: 1000, pattern: '', timeoutMs: 60000 } },
    { type: 'agentSend', params: { profileId: 'codex:demo', text: 'hello. reply ok only.', pressEnter: true } },
    { type: 'log', params: { message: 'Scheduled hello sent.' } },
  ] }, { silent: true });
  window.app._applyTerminalTheme('dark');
  window.app.term.reset();
  window.app.term.write('PowerShell\r\n\r\nPS > ');
  document.getElementById('output-log').innerHTML = '<div class="log-line system">Ready. Waiting for scheduled workflow.</div>';
  document.getElementById('editor-canvas').scrollTop = 0;
}
function measure() {
  const canvas = document.getElementById('editor-canvas').getBoundingClientRect();
  const blocks = [...document.querySelectorAll('.workflow-block')].map(el => el.getBoundingClientRect());
  return {
    viewport: [innerWidth, innerHeight],
    fullyVisibleSteps: blocks.filter(r => r.top >= canvas.top && r.bottom <= canvas.bottom).length,
    stepHeights: blocks.map(r => Math.round(r.height)),
    paletteWidth: document.getElementById('palette-panel').offsetWidth,
    editorWidth: document.getElementById('editor-panel').offsetWidth,
    terminalWidth: document.getElementById('terminal-panel').offsetWidth,
    headerHeight: document.getElementById('titlebar').offsetHeight,
    shellOverflow: document.documentElement.scrollWidth > innerWidth,
  };
}
async function board(name, left, right, width, height, subtitle, leftLabel = `BEFORE · ${baseline}`, rightLabel = `REJECTED · ${current}`) {
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>UI comparison</title><style>
    *{box-sizing:border-box}body{margin:0;padding:24px;background:#f0f1f3;color:#17212c;font-family:'Segoe UI',sans-serif;width:${width * 2 + 72}px}
    header{height:92px}h1{font-size:26px;margin:0 0 10px;font-weight:600}p{font-size:16px;margin:0;color:#4d5a67}
    main{display:grid;grid-template-columns:1fr 1fr;gap:24px}.label{height:42px;font-size:17px;font-weight:600}img{display:block;width:${width}px;height:${height}px;box-shadow:0 2px 8px #0002}
    </style><header><h1>Agent Orchestrator — UI comparison</h1><p>${subtitle}</p></header><main><section><div class="label">${leftLabel}</div><img src="${left}"></section><section><div class="label">${rightLabel}</div><img src="${right}"></section></main></html>`;
  const htmlFile = path.join(output, `${name}.html`);
  fs.writeFileSync(htmlFile, html);
  const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
  windows.push(win);
  win.setContentSize(width * 2 + 72, height + 182);
  await win.loadFile(htmlFile);
  await capture(win, `${name}.png`);
  win.destroy();
}
async function run() {
  const before = await create(oldRoot);
  const after = await create(rejectedRoot);
  const restored = await create(root);
  // Default startup intentionally shows each version's actual first-run surface.
  await evaluate(before, () => { window.app._applyTerminalTheme('ps'); document.getElementById('theme-selector').value = 'ps'; window.app.term.write('PowerShell\r\n\r\nPS > '); });
  await evaluate(after, () => window.app.term.write('PowerShell\r\n\r\nPS > '));
  await capture(before, 'before-startup.png');
  await capture(after, 'current-startup.png');
  await evaluate(restored, () => { window.app._applyTerminalTheme('ps'); document.getElementById('theme-selector').value = 'ps'; window.app.term.write('PowerShell\r\n\r\nPS > '); });
  await capture(restored, 'restored-startup.png');
  const metrics = { baseline, current, scenarios: [] };
  for (const [width, height] of [[1440, 900], [1100, 700]]) {
    before.setContentSize(width, height); after.setContentSize(width, height); restored.setContentSize(width, height);
    await evaluate(before, fixture); await evaluate(after, fixture); await evaluate(restored, fixture);
    const oldFile = `before-${width}.png`, newFile = `current-${width}.png`;
    await capture(before, oldFile); await capture(after, newFile);
    const restoredFile = `restored-${width}.png`;
    await capture(restored, restoredFile);
    metrics.scenarios.push({ size: `${width}x${height}`, before: await evaluate(before, measure), rejected: await evaluate(after, measure), restored: await evaluate(restored, measure) });
    await board(`workflow-${width}`, oldFile, newFile, width, height, `Same six-step workflow · ${width} × ${height} · Same dark terminal · Synthetic account · No commands executed`);
    await board(`restored-vs-current-${width}`, newFile, restoredFile, width, height, `Same six-step workflow · ${width} × ${height} · Original visual style restored; new features retained`, `REJECTED · ${current}`, 'RESTORED · classic visuals + new features');
  }
  await board('startup', 'before-startup.png', 'current-startup.png', 1440, 900, 'Default startup · 1440 × 900 · Each version retains its original first-run behavior and default terminal theme');
  if (errors.length) throw new Error(errors.join('\n'));
  fs.writeFileSync(path.join(output, 'metrics.json'), JSON.stringify(metrics, null, 2));
  console.log(JSON.stringify(metrics, null, 2));
  console.log(`Comparison artifacts: ${output}`);
}
app.whenReady().then(run).then(() => { windows.forEach(w => { if (!w.isDestroyed()) w.destroy(); }); app.exit(0); }).catch(error => {
  console.error(error); windows.forEach(w => { if (!w.isDestroyed()) w.destroy(); }); app.exit(1);
});
