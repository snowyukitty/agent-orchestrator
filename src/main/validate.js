// ============================================================
// IPC Payload Validation (main process)
//
// The renderer is not a trust boundary we want to lean on: a bug there
// should surface as a clear rejected IPC call, not a main-process crash.
// Before this existed, `send-input` called `text.replace(...)` on whatever
// arrived and threw a TypeError on any non-string.
//
// Every helper either returns a normalized value or throws an Error whose
// message is safe to show the user.
// ============================================================

/** Session and process ids we mint ourselves; keep the charset tight. */
const ID_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;

/** A single write to a PTY. Generous, but bounded — a paste, not a file. */
const MAX_INPUT_CHARS = 100_000;

/** Terminal geometry bounds. ConPTY misbehaves outside a sane range. */
const MIN_COLS = 2, MAX_COLS = 1000;
const MIN_ROWS = 1, MAX_ROWS = 500;

function asPlainObject(value, what = 'payload') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${what}: expected an object`);
  }
  return value;
}

function asId(value, what = 'id') {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new Error(`Invalid ${what}: expected 1-128 chars of [A-Za-z0-9_.-]`);
  }
  return value;
}

/** Optional id — returns null when absent rather than throwing. */
function asOptionalId(value, what = 'id') {
  if (value === undefined || value === null || value === '') return null;
  return asId(value, what);
}

function asText(value, { max = MAX_INPUT_CHARS, what = 'text' } = {}) {
  if (typeof value !== 'string') {
    throw new Error(`Invalid ${what}: expected a string`);
  }
  if (value.length > max) {
    throw new Error(`Invalid ${what}: exceeds ${max} characters`);
  }
  return value;
}

/**
 * Clamp a dimension into range, falling back when it is not a real number.
 * `null` and `''` coerce to 0 through Number(), which would silently clamp to
 * the minimum, so they are treated as absent instead.
 */
function clampInt(value, min, max, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function asCols(value, fallback = 80) {
  return clampInt(value, MIN_COLS, MAX_COLS, fallback);
}

function asRows(value, fallback = 24) {
  return clampInt(value, MIN_ROWS, MAX_ROWS, fallback);
}

module.exports = {
  ID_PATTERN,
  MAX_INPUT_CHARS,
  asPlainObject,
  asId,
  asOptionalId,
  asText,
  clampInt,
  asCols,
  asRows,
};
