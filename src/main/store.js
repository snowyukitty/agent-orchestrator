// ============================================================
// Atomic JSON Store (main process)
//
// One place for "read a JSON file, write it without risking a truncated
// file on crash". Used by the workflow store, the agent profile store, and
// the settings file. The write path (temp file + rename) was previously
// inlined in main.js's save-workflow handler.
// ============================================================
const fs = require('fs');
const path = require('path');

/** Create `dir` (and parents) if missing. Returns the directory path. */
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Read and parse a JSON file.
 * Returns `fallback` when the file is missing, unreadable, or malformed —
 * a corrupt settings file should never stop the app from starting.
 */
function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (_e) {
    return fallback;
  }
}

function fileTooLargeError() {
  const error = new Error('JSON file exceeds the configured read limit');
  error.code = 'json-file-too-large';
  return error;
}

function normalizeMaxFileBytes(options) {
  if (options === undefined || options === null) return null;
  if (typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('JSON read options must be an object');
  }
  const { maxFileBytes } = options;
  if (maxFileBytes === undefined || maxFileBytes === null) return null;
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes <= 0) {
    throw new TypeError('maxFileBytes must be a positive safe integer');
  }
  return maxFileBytes;
}

/**
 * Read at most `maxFileBytes + 1` bytes from one file. Reading through the
 * opened descriptor and stopping at the limit keeps a file-growth race from
 * turning the pre-read size check into an unbounded allocation.
 */
function readUtf8Bounded(filePath, maxFileBytes) {
  const fd = fs.openSync(filePath, 'r');
  const chunks = [];
  let total = 0;
  try {
    if (fs.fstatSync(fd).size > maxFileBytes) throw fileTooLargeError();
    while (total <= maxFileBytes) {
      const remaining = maxFileBytes + 1 - total;
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
      const bytesRead = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      chunks.push(chunk.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  if (total > maxFileBytes) throw fileTooLargeError();
  return Buffer.concat(chunks, total).toString('utf8');
}

/** Read a JSON file, throwing on missing/malformed/oversized content. */
function readJsonStrict(filePath, options = undefined) {
  const maxFileBytes = normalizeMaxFileBytes(options);
  const payload = maxFileBytes === null
    ? fs.readFileSync(filePath, 'utf-8')
    : readUtf8Bounded(filePath, maxFileBytes);
  return JSON.parse(payload);
}

/**
 * Write JSON to `filePath` atomically: serialize to a sibling temp file,
 * fsync it, then rename over the target. A crash mid-write leaves either the
 * old file or the new one, never a half-written one.
 */
function writeJsonAtomic(filePath, data) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.${process.pid}.tmp`;
  const payload = JSON.stringify(data, null, 2);
  let fd;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeFileSync(fd, payload, 'utf-8');
    fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
  return filePath;
}

/**
 * Read every `*.json` file in a directory.
 * Returns `[{ file, data }]`, skipping unreadable entries and reporting them
 * through `onError` so one malformed file never breaks the whole listing.
 */
function readJsonDir(dir, onError = null, options = undefined) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
    const full = path.join(dir, file);
    try {
      out.push({ file, data: readJsonStrict(full, options) });
    } catch (err) {
      if (onError) onError(file, err);
    }
  }
  return out;
}

module.exports = { ensureDir, readJson, readJsonStrict, writeJsonAtomic, readJsonDir };
