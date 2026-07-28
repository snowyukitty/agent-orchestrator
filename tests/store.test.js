// Unit tests for the atomic JSON store and the settings normalizer.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../src/main/store');
const settings = require('../src/main/settings');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agents-orch-test-'));
}

test('writeJsonAtomic round-trips and leaves no temp file behind', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'nested', 'data.json');
  store.writeJsonAtomic(file, { hello: 'world', n: 1 });

  assert.deepEqual(store.readJson(file), { hello: 'world', n: 1 });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['data.json']);
});

test('writeJsonAtomic overwrites without a partial-write window', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'data.json');
  store.writeJsonAtomic(file, { v: 1 });
  store.writeJsonAtomic(file, { v: 2 });
  assert.deepEqual(store.readJson(file), { v: 2 });
  assert.deepEqual(fs.readdirSync(dir), ['data.json']);
});

test('readJson falls back instead of throwing on missing or corrupt files', () => {
  const dir = tmpDir();
  assert.equal(store.readJson(path.join(dir, 'missing.json'), null), null);
  assert.deepEqual(store.readJson(path.join(dir, 'missing.json'), { d: 1 }), { d: 1 });

  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, '{ not json');
  assert.equal(store.readJson(bad, null), null);
  assert.throws(() => store.readJsonStrict(bad));
});

test('readJsonDir skips one malformed file without losing the rest', () => {
  const dir = tmpDir();
  store.writeJsonAtomic(path.join(dir, 'a.json'), { n: 'a' });
  fs.writeFileSync(path.join(dir, 'b.json'), '{ broken');
  store.writeJsonAtomic(path.join(dir, 'c.json'), { n: 'c' });
  fs.writeFileSync(path.join(dir, 'ignored.txt'), 'not json');

  const errors = [];
  const found = store.readJsonDir(dir, (file) => errors.push(file));
  assert.deepEqual(found.map(f => f.data.n).sort(), ['a', 'c']);
  assert.deepEqual(errors, ['b.json']);
});

test('readJsonDir returns empty for a directory that does not exist', () => {
  assert.deepEqual(store.readJsonDir(path.join(tmpDir(), 'nope')), []);
});

test('settings normalize to defaults for junk input', () => {
  for (const junk of [null, undefined, 'str', 42, []]) {
    assert.deepEqual(settings.normalizeSettings(junk), settings.DEFAULTS);
  }
});

test('settings reject an unknown theme but keep valid ones', () => {
  assert.equal(settings.normalizeSettings({ theme: 'dark' }).theme, 'dark');
  assert.equal(settings.normalizeSettings({ theme: 'neon' }).theme, settings.DEFAULTS.theme);
});

test('settings reject implausible window bounds', () => {
  const good = settings.normalizeSettings({ windowBounds: { x: 10, y: 20, width: 1440, height: 920 } });
  assert.deepEqual(good.windowBounds, { x: 10, y: 20, width: 1440, height: 920 });

  assert.equal(settings.normalizeSettings({ windowBounds: { width: 10, height: 10 } }).windowBounds, null);
  assert.equal(settings.normalizeSettings({ windowBounds: 'maximized' }).windowBounds, null);
  assert.equal(settings.normalizeSettings({ windowBounds: { width: NaN, height: 900 } }).windowBounds, null);
});

test('settings round-trip a patch through disk', () => {
  const file = path.join(tmpDir(), 'settings.json');
  assert.deepEqual(settings.loadSettings(file), settings.DEFAULTS);

  const saved = settings.saveSettings(file, {
    theme: 'light',
    terminalPanelWidth: 520,
    entrypointPath: ' C:/tools/ai-agent-entrypoint ',
  });
  assert.equal(saved.theme, 'light');
  assert.equal(saved.terminalPanelWidth, 520);
  assert.equal(saved.entrypointPath, 'C:/tools/ai-agent-entrypoint');

  const reloaded = settings.loadSettings(file);
  assert.equal(reloaded.theme, 'light');
  assert.equal(reloaded.terminalPanelWidth, 520);
  assert.equal(reloaded.entrypointPath, 'C:/tools/ai-agent-entrypoint');

  // A later patch merges rather than replacing.
  const merged = settings.saveSettings(file, { theme: 'dark' });
  assert.equal(merged.theme, 'dark');
  assert.equal(merged.terminalPanelWidth, 520);
});

test('a corrupt settings file degrades to defaults instead of blocking startup', () => {
  const file = path.join(tmpDir(), 'settings.json');
  fs.writeFileSync(file, 'not json at all');
  assert.deepEqual(settings.loadSettings(file), settings.DEFAULTS);
});
