const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  CANONICAL_STORAGE_NAME,
  LEGACY_STORAGE_NAME,
  MIGRATION_MARKER,
  prepareUserData,
} = require('../src/main/user-data');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-orchestrator-migration-'));
  const appDataRoot = path.join(root, 'app-data');
  const tempRoot = path.join(root, 'temp');
  fs.mkdirSync(appDataRoot, { recursive: true });
  fs.mkdirSync(tempRoot, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    appDataRoot,
    tempRoot,
    legacy: path.join(appDataRoot, LEGACY_STORAGE_NAME),
    canonical: path.join(appDataRoot, CANONICAL_STORAGE_NAME),
  };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value), 'utf8');
}

test('legacy app-owned JSON migrates atomically while cache and source remain', (t) => {
  const fx = fixture(t);
  writeJson(path.join(fx.legacy, 'settings.json'), { theme: 'dark' });
  writeJson(path.join(fx.legacy, 'agents.json'), { schemaVersion: 1, profiles: [] });
  writeJson(path.join(fx.legacy, 'runs.json'), { schemaVersion: 1, records: [] });
  writeJson(path.join(fx.legacy, 'workflows', 'daily.json'), { id: 'daily', blocks: [] });
  fs.mkdirSync(path.join(fx.legacy, 'GPUCache'), { recursive: true });
  fs.writeFileSync(path.join(fx.legacy, 'GPUCache', 'cache.bin'), 'cache');

  const result = prepareUserData({
    appDataRoot: fx.appDataRoot,
    tempRoot: fx.tempRoot,
    pid: 42,
    now: () => 1_900_000_000_000,
  });

  assert.equal(result.path, fx.canonical);
  assert.equal(result.migrated, true);
  assert.equal(result.copied, 4);
  assert.equal(result.skipped, 0);
  assert.equal(fs.existsSync(fx.legacy), true);
  assert.equal(fs.existsSync(path.join(fx.canonical, 'GPUCache')), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fx.canonical, 'settings.json'))), { theme: 'dark' });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fx.canonical, MIGRATION_MARKER))), {
    schemaVersion: 1,
    migratedFrom: LEGACY_STORAGE_NAME,
    migratedAt: 1_900_000_000_000,
    copiedFiles: 4,
    skippedFiles: 0,
  });
});

test('migration is idempotent and never overwrites canonical data', (t) => {
  const fx = fixture(t);
  writeJson(path.join(fx.legacy, 'settings.json'), { theme: 'dark' });
  const first = prepareUserData({ appDataRoot: fx.appDataRoot, tempRoot: fx.tempRoot, pid: 43 });
  assert.equal(first.migrated, true);

  writeJson(path.join(fx.legacy, 'settings.json'), { theme: 'light' });
  const second = prepareUserData({ appDataRoot: fx.appDataRoot, tempRoot: fx.tempRoot, pid: 44 });
  assert.equal(second.migrated, false);
  assert.equal(second.conflict, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fx.canonical, 'settings.json'))), { theme: 'dark' });
});

test('pre-existing canonical and legacy data report a conflict without merging', (t) => {
  const fx = fixture(t);
  writeJson(path.join(fx.legacy, 'workflows', 'legacy.json'), { id: 'legacy' });
  writeJson(path.join(fx.canonical, 'workflows', 'canonical.json'), { id: 'canonical' });

  const result = prepareUserData({ appDataRoot: fx.appDataRoot, tempRoot: fx.tempRoot, pid: 45 });
  assert.equal(result.migrated, false);
  assert.equal(result.conflict, true);
  assert.equal(fs.existsSync(path.join(fx.canonical, 'workflows', 'legacy.json')), false);
});

test('invalid legacy JSON is skipped without deleting the source', (t) => {
  const fx = fixture(t);
  fs.mkdirSync(fx.legacy, { recursive: true });
  fs.writeFileSync(path.join(fx.legacy, 'settings.json'), '{ broken', 'utf8');
  writeJson(path.join(fx.legacy, 'workflows', 'valid.json'), { id: 'valid' });

  const result = prepareUserData({ appDataRoot: fx.appDataRoot, tempRoot: fx.tempRoot, pid: 46 });
  assert.equal(result.migrated, true);
  assert.equal(result.copied, 1);
  assert.equal(result.skipped, 1);
  assert.equal(fs.existsSync(path.join(fx.canonical, 'settings.json')), false);
  assert.equal(fs.existsSync(path.join(fx.legacy, 'settings.json')), true);
});

test('smoke and self-test storage is isolated from production data', (t) => {
  const fx = fixture(t);
  writeJson(path.join(fx.legacy, 'settings.json'), { theme: 'dark' });

  const result = prepareUserData({
    appDataRoot: fx.appDataRoot,
    tempRoot: fx.tempRoot,
    testMode: true,
    pid: 47,
  });
  assert.equal(result.temporary, true);
  assert.equal(result.path, path.join(fx.tempRoot, 'agent-orchestrator-tests', '47'));
  assert.equal(fs.existsSync(fx.canonical), false);
});
