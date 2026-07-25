// ============================================================
// Persisted App Settings (main process)
//
// Small preferences that used to reset on every launch (terminal theme,
// window size, panel widths) plus the one piece of machine-local wiring the
// agent layer needs: where ai-agent-entrypoint lives.
//
// This file holds preferences and paths. It must never hold credentials —
// see AGENTS.md.
// ============================================================
const { readJson, writeJsonAtomic } = require('./store');

const SCHEMA_VERSION = 1;

const DEFAULTS = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
  theme: 'ps',
  /** Absolute path to the ai-agent-entrypoint checkout; '' = auto-detect. */
  entrypointPath: '',
  /** { x, y, width, height } or null to let Electron centre a default. */
  windowBounds: null,
  /** Right-hand panel width in px, or null for the CSS default. */
  terminalPanelWidth: null,
  /** Log pane height in px within the right panel, or null. */
  logPaneHeight: null,
});

const THEMES = new Set(['ps', 'dark', 'light']);

/** Coerce arbitrary stored JSON into a known-good settings object. */
function normalizeSettings(raw) {
  const src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const out = { ...DEFAULTS };

  if (THEMES.has(src.theme)) out.theme = src.theme;
  if (typeof src.entrypointPath === 'string') out.entrypointPath = src.entrypointPath.trim();

  const b = src.windowBounds;
  if (b && typeof b === 'object'
      && Number.isFinite(b.width) && Number.isFinite(b.height)
      && b.width >= 400 && b.height >= 300) {
    out.windowBounds = {
      x: Number.isFinite(b.x) ? Math.round(b.x) : undefined,
      y: Number.isFinite(b.y) ? Math.round(b.y) : undefined,
      width: Math.round(b.width),
      height: Math.round(b.height),
    };
  }

  for (const key of ['terminalPanelWidth', 'logPaneHeight']) {
    const v = Number(src[key]);
    if (Number.isFinite(v) && v > 0) out[key] = Math.round(v);
  }

  return out;
}

function loadSettings(filePath) {
  return normalizeSettings(readJson(filePath, null));
}

/** Merge a patch over the stored settings and persist. Returns the result. */
function saveSettings(filePath, patch) {
  const merged = normalizeSettings({ ...loadSettings(filePath), ...(patch || {}) });
  writeJsonAtomic(filePath, merged);
  return merged;
}

module.exports = { DEFAULTS, THEMES, SCHEMA_VERSION, normalizeSettings, loadSettings, saveSettings };
