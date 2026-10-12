// Real Chromium layout and interaction checks with a sealed local UI fixture.
// Run with Electron. No production state, provider calls, or real PTYs.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-orchestrator-ui-'));
app.setPath('userData', path.join(temp, 'user-data'));
app.disableHardwareAcceleration();
let win;
const errors = [];
const evaluate = fn => win.webContents.executeJavaScript(`(${fn.toString()})()`);
const settle = () => evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function capture(name) {
  await settle();
  await evaluate(() => Promise.all(document.getAnimations().filter(a => a.effect?.getComputedTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))));
  fs.writeFileSync(path.join(temp, `${name}.png`), (await win.webContents.capturePage()).toPNG());
}
async function run() {
  win = new BrowserWindow({ width: 1440, height: 900, show: false, webPreferences: {
    preload: path.join(__dirname, 'ui-preview-preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
  } });
  win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  await win.loadFile(path.join(__dirname, '../src/index.html'));
  await settle();
  assert.equal(await evaluate(() => window.app.workflow.blocks.length), 0, 'Launch must show the welcome screen');
  await evaluate(() => window.app.term.write('\x1b[38;2;162;217;189mAgent Orchestrator\x1b[0m\r\nYour sessions appear here.\r\n\r\nPS > '));
  await capture('welcome');
  for (const [width, height] of [[1440, 900], [1100, 700], [900, 700], [760, 600]]) {
    win.setContentSize(width, height);
    await settle();
    const layout = await evaluate(() => {
      const run = document.getElementById('btn-run').getBoundingClientRect();
      return { overflow: document.documentElement.scrollWidth > innerWidth, runVisible: run.bottom <= innerHeight && run.left >= 0 && run.right <= innerWidth };
    });
    assert.equal(layout.overflow, false, `Shell must fit ${width}px`);
    assert.equal(layout.runVisible, true, `Run must stay visible at ${width}px`);
    if (width === 900 || width === 760) await capture(`welcome-${width}`);
  }
  await evaluate(() => { window.app._sleepTarget = Date.now() + 600000; window.app._renderSleepBanner(); });
  await settle();
  assert.equal(await evaluate(() => document.getElementById('btn-run').getBoundingClientRect().bottom <= innerHeight), true, 'Hibernate banner must not clip the toolbar');
  await evaluate(() => { window.app._sleepTarget = null; window.app._renderSleepBanner(); });
  win.setContentSize(1440, 900);
  await evaluate(() => { document.getElementById('block-search').value = 'no such block'; document.getElementById('block-search').dispatchEvent(new Event('input')); });
  assert.equal(await evaluate(() => document.querySelectorAll('.palette-block:not(.hidden)').length), 0);
  await evaluate(() => { document.getElementById('block-search').value = ''; document.getElementById('block-search').dispatchEvent(new Event('input')); document.querySelector('.palette-block[data-type="log"]').focus(); });
  assert.equal(await evaluate(() => document.activeElement.tagName), 'BUTTON', 'Palette actions must be native buttons');
  await evaluate(() => document.activeElement.click());
  await settle();
  assert.equal(await evaluate(() => window.app.workflow.blocks[0]?.type), 'log', 'Palette activation must add a block');
  await evaluate(() => { window.app._setDirty(false); window.app._newWorkflow(); document.getElementById('btn-scheduled-hello').focus(); document.getElementById('btn-scheduled-hello').click(); });
  await settle();
  assert.equal(await evaluate(() => document.getElementById('hello-modal').contains(document.activeElement)), true, 'Dialog must receive focus');
  await capture('scheduled-hello');
  await evaluate(() => { document.getElementById('hello-account').value = 'codex:demo'; document.getElementById('hello-form').requestSubmit(); });
  await settle();
  assert.equal(await evaluate(() => window.app.workflow.scheduleEnabled), false, 'Hello must begin as a disabled draft');
  const countVisibleSteps = await evaluate(() => {
    const canvas = document.getElementById('editor-canvas').getBoundingClientRect();
    return [...document.querySelectorAll('.workflow-block')].filter(el => {
      const r = el.getBoundingClientRect(); return r.top >= canvas.top && r.bottom <= canvas.bottom;
    }).length;
  });
  assert.equal(countVisibleSteps, 6, 'Compact 1440px workspace must show all six hello steps');
  const callsBefore = await evaluate(() => window.api.testFixture.snapshot());
  await evaluate(() => {
    const savedTime = window.app.workflow.blocks[0].params.datetime;
    window.app.workflow.blocks[0].params.datetime = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    window.app._tickSchedules();
    window.app.workflow.blocks[0].params.datetime = savedTime;
  });
  assert.deepEqual((await evaluate(() => window.api.testFixture.snapshot())).calls, callsBefore.calls, 'Due draft must not launch or send');
  await evaluate(async () => { await window.api.testFixture.setSaveFailure(true); await window.app.saveWorkflow(); });
  assert.equal(await evaluate(() => window.app.workflow.scheduleEnabled), false, 'Failed save must leave draft disabled');
  await evaluate(() => { document.getElementById('output-log').querySelectorAll('.log-line').forEach(el => el.remove()); });
  await capture('workflow');
  await evaluate(async () => { await window.api.testFixture.setSaveFailure(false); await window.app.saveWorkflow(); });
  assert.equal(await evaluate(() => window.app.workflow.scheduleEnabled), true);
  assert.equal((await evaluate(() => window.api.testFixture.snapshot())).workflows[0].scheduleEnabled, true);
  await evaluate(() => {
    const block = window.app.workflow.blocks.find(b => b.type === 'agentSend');
    block.params.text = 'Unsaved prompt edit';
    window.app._markDirty();
  });
  await evaluate(() => document.getElementById('btn-schedules').click());
  await settle();
  await evaluate(() => document.querySelector('[data-toggle-schedule]').click());
  await settle();
  assert.equal(await evaluate(() => window.app.workflow.scheduleEnabled), false, 'Pause must disable the schedule');
  assert.equal((await evaluate(() => window.api.testFixture.snapshot())).workflows[0].scheduleEnabled, false, 'Pause must survive a restart');
  assert.equal((await evaluate(() => window.api.testFixture.snapshot())).workflows[0].blocks.find(b => b.type === 'agentSend').params.text, 'hello. reply ok only.', 'Pause must not save unrelated edits');
  assert.equal(await evaluate(() => window.app._dirty), true, 'Pause must preserve the dirty flag');
  await capture('schedules');
  await evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await settle();
  assert.equal(await evaluate(() => document.getElementById('schedule-modal').classList.contains('hidden')), true);
  await evaluate(() => { document.getElementById('btn-templates').click(); });
  await settle();
  assert.equal(await evaluate(() => document.querySelectorAll('.tpl-warning').length), 3, 'Legacy bypass templates must be labeled');
  await capture('templates');
  await evaluate(() => { document.getElementById('btn-agents').focus(); document.getElementById('btn-agents').click(); });
  await settle();
  await evaluate(() => { document.getElementById('agent-edit-modal').classList.remove('hidden'); });
  await settle();
  await evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await settle();
  assert.equal(await evaluate(() => document.getElementById('agents-modal').classList.contains('hidden')), false, 'Escape closes only the top dialog');
  await evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true })));
  assert.equal(await evaluate(() => document.getElementById('agents-modal').contains(document.activeElement)), true, 'Focus stays inside the dialog');
  const snapshot = await evaluate(() => window.api.testFixture.snapshot());
  assert.equal(snapshot.calls.createSession, 0);
  assert.equal(snapshot.calls.sendInput, 0);
  assert.deepEqual(errors, [], 'Renderer must not report runtime errors');
  console.log(`UI checks passed. Screenshots: ${temp}`);
}
app.whenReady().then(run).then(() => { win?.destroy(); app.exit(0); }).catch(err => {
  console.error(err);
  console.error(`UI artifacts: ${temp}`);
  win?.destroy(); app.exit(1);
});
