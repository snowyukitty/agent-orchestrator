// ============================================================
// Canonical user-data location and one-time identity migration.
//
// The product was historically stored under the plural package slug. The
// singular rename must not strand workflows or machine-local agent settings,
// so the first singular build copies only app-owned JSON into a staged
// directory and atomically promotes it. The legacy directory is retained as a
// rollback backup; Chromium caches are deliberately not copied.
// ============================================================
const fs = require('node:fs');
const path = require('node:path');

const CANONICAL_STORAGE_NAME = 'agent-orchestrator';
const LEGACY_STORAGE_NAME = 'agents-orchestrator';
const MIGRATION_MARKER = 'identity-migration.json';
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const ROOT_JSON_FILES = ['agents.json', 'runs.json', 'settings.json'];

class UserDataMigrationError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'UserDataMigrationError';
    this.code = code;
  }
}

function fail(code, message, cause) {
  throw new UserDataMigrationError(code, message, cause ? { cause } : undefined);
}

function isDirectory(fsImpl, value) {
  try { return fsImpl.statSync(value).isDirectory(); } catch (_error) { return false; }
}

function isFile(fsImpl, value) {
  try { return fsImpl.statSync(value).isFile(); } catch (_error) { return false; }
}

function hasOwnedData(fsImpl, pathImpl, dir) {
  if (!isDirectory(fsImpl, dir)) return false;
  if (ROOT_JSON_FILES.some(name => isFile(fsImpl, pathImpl.join(dir, name)))) return true;
  const workflows = pathImpl.join(dir, 'workflows');
  if (!isDirectory(fsImpl, workflows)) return false;
  return fsImpl.readdirSync(workflows).some(name => name.toLowerCase().endsWith('.json'));
}

function copyValidatedJson({ fsImpl, pathImpl, source, target, relative, copied, skipped }) {
  try {
    const stat = fsImpl.statSync(source);
    if (!stat.isFile() || stat.size > MAX_JSON_BYTES) throw new Error('invalid JSON file size');
    JSON.parse(fsImpl.readFileSync(source, 'utf8'));
    fsImpl.mkdirSync(pathImpl.dirname(target), { recursive: true });
    fsImpl.copyFileSync(source, target);
    copied.push(relative);
  } catch (_error) {
    skipped.push(relative);
  }
}

function migrateLegacyData({
  fsImpl,
  pathImpl,
  legacyPath,
  canonicalPath,
  pid,
  now,
}) {
  const stagingPath = pathImpl.join(
    pathImpl.dirname(canonicalPath),
    `.${CANONICAL_STORAGE_NAME}-migrating-${pid}`
  );
  if (fsImpl.existsSync(stagingPath)) {
    fail('USER_DATA_STAGING_EXISTS', 'A previous user-data migration staging directory still exists.');
  }

  const copied = [];
  const skipped = [];
  try {
    fsImpl.mkdirSync(stagingPath, { recursive: false });
    for (const name of ROOT_JSON_FILES) {
      const source = pathImpl.join(legacyPath, name);
      if (!isFile(fsImpl, source)) continue;
      copyValidatedJson({
        fsImpl,
        pathImpl,
        source,
        target: pathImpl.join(stagingPath, name),
        relative: name,
        copied,
        skipped,
      });
    }

    const legacyWorkflows = pathImpl.join(legacyPath, 'workflows');
    if (isDirectory(fsImpl, legacyWorkflows)) {
      for (const name of fsImpl.readdirSync(legacyWorkflows).filter(item => item.toLowerCase().endsWith('.json'))) {
        copyValidatedJson({
          fsImpl,
          pathImpl,
          source: pathImpl.join(legacyWorkflows, name),
          target: pathImpl.join(stagingPath, 'workflows', name),
          relative: `workflows/${name}`,
          copied,
          skipped,
        });
      }
    }

    const marker = {
      schemaVersion: 1,
      migratedFrom: LEGACY_STORAGE_NAME,
      migratedAt: now(),
      copiedFiles: copied.length,
      skippedFiles: skipped.length,
    };
    fsImpl.writeFileSync(
      pathImpl.join(stagingPath, MIGRATION_MARKER),
      JSON.stringify(marker, null, 2),
      'utf8'
    );
    fsImpl.renameSync(stagingPath, canonicalPath);
    return { copied: copied.length, skipped: skipped.length };
  } catch (cause) {
    fail('USER_DATA_MIGRATION_FAILED', 'Legacy user data could not be migrated safely.', cause);
  }
}

/**
 * Prepare and return the directory Electron should use for `userData`.
 * This function is synchronous because Electron paths must be configured
 * before `ready` and before the single-instance lock is acquired.
 */
function prepareUserData({
  appDataRoot,
  tempRoot,
  testMode = false,
  pid = process.pid,
  now = () => Date.now(),
  fsImpl = fs,
  pathImpl = path,
} = {}) {
  if (!pathImpl.isAbsolute(appDataRoot || '') || !pathImpl.isAbsolute(tempRoot || '')) {
    fail('USER_DATA_PATH_INVALID', 'Application data roots must be absolute paths.');
  }

  if (testMode) {
    const testPath = pathImpl.join(tempRoot, 'agent-orchestrator-tests', String(pid));
    fsImpl.mkdirSync(testPath, { recursive: true });
    return {
      path: testPath,
      temporary: true,
      migrated: false,
      conflict: false,
      copied: 0,
      skipped: 0,
    };
  }

  const canonicalPath = pathImpl.join(appDataRoot, CANONICAL_STORAGE_NAME);
  const legacyPath = pathImpl.join(appDataRoot, LEGACY_STORAGE_NAME);
  if (isDirectory(fsImpl, canonicalPath)) {
    const markerExists = isFile(fsImpl, pathImpl.join(canonicalPath, MIGRATION_MARKER));
    return {
      path: canonicalPath,
      temporary: false,
      migrated: false,
      conflict: !markerExists && hasOwnedData(fsImpl, pathImpl, legacyPath),
      copied: 0,
      skipped: 0,
    };
  }

  if (isDirectory(fsImpl, legacyPath)) {
    const result = migrateLegacyData({
      fsImpl,
      pathImpl,
      legacyPath,
      canonicalPath,
      pid,
      now,
    });
    return {
      path: canonicalPath,
      temporary: false,
      migrated: true,
      conflict: false,
      ...result,
    };
  }

  fsImpl.mkdirSync(canonicalPath, { recursive: true });
  return {
    path: canonicalPath,
    temporary: false,
    migrated: false,
    conflict: false,
    copied: 0,
    skipped: 0,
  };
}

module.exports = {
  CANONICAL_STORAGE_NAME,
  LEGACY_STORAGE_NAME,
  MAX_JSON_BYTES,
  MIGRATION_MARKER,
  UserDataMigrationError,
  hasOwnedData,
  prepareUserData,
};
