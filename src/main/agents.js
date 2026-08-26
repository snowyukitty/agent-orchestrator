// ============================================================
// Agent Profiles (main process)
//
// A profile is "which agent, as which account". There are two kinds, and
// the difference in guarantee between them is real, so it is carried
// explicitly rather than smoothed over:
//
//   routed (L1) — a Codex alias owned by ai-agent-entrypoint. We discover
//                 aliases through its `codex doctor --all --json` route and
//                 launch through `codex shell <alias>`. This app never
//                 constructs the account environment and never reads the
//                 manifest itself; it is a launch surface, not a source of
//                 account truth.
//
//   local (L2)  — an orchestrator-local profile that sets a state-home
//                 environment variable (CLAUDE_CONFIG_DIR, GROK_HOME, …) on
//                 the child process only. ai-agent-entrypoint does not manage
//                 those CLIs yet, so this is a weaker, env-only guarantee and
//                 must never be described as account isolation.
//
// Boundaries this module enforces:
//   • profile env may hold paths and flags, never secrets (see SECRET_KEY_PATTERN);
//   • doctor output carries canonical account-home paths — sanitizeDoctorReport
//     strips them before anything leaves this module;
//   • an unresolvable routed alias fails closed instead of falling back to a
//     native login.
// ============================================================
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const { readJson, writeJsonAtomic } = require('./store');

const SCHEMA_VERSION = 1;

/** Profile ids appear in workflow JSON and DOM attributes; keep them tame. */
const PROFILE_ID_PATTERN = /^[A-Za-z0-9_:.-]{1,64}$/;
const ROUTED_PROFILE_PREFIX = 'codex:';
const ROUTED_ALIAS_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const CODEX_ROUTING_ENV = new Set(['CODEX_HOME', 'CODEX_SQLITE_HOME']);
const ROUTED_STATUS_VALUES = new Set(['ok', 'warning', 'error', 'unavailable', 'unknown']);

/**
 * Environment keys a profile may never set. Credentials belong in the tool's
 * own state directory (which is exactly what the *_HOME / *_CONFIG_DIR
 * variables select), not in this app's config file.
 */
const SECRET_KEY_PATTERN = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API[_-]?KEY|APIKEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY)/i;

/** Known CLI agents and the env var that selects their state directory. */
const AGENT_KINDS = Object.freeze({
  claude: { label: 'Claude Code', icon: '◆', command: 'claude', homeEnv: 'CLAUDE_CONFIG_DIR' },
  codex:  { label: 'Codex',       icon: '◇', command: 'codex',  homeEnv: 'CODEX_HOME' },
  grok:   { label: 'Grok',        icon: '▲', command: 'grok',   homeEnv: 'GROK_HOME' },
  gemini: { label: 'Gemini',      icon: '●', command: 'gemini', homeEnv: 'GEMINI_CONFIG_DIR' },
  shell:  { label: 'Shell',       icon: '⬡', command: '',       homeEnv: null },
});

const ASSURANCE = Object.freeze({
  ROUTED: 'L1-routed',
  ENV: 'L2-env',
  NATIVE: 'L0-native',
});

/** Human wording for each level. Never call L2 "isolated". */
const ASSURANCE_LABEL = Object.freeze({
  [ASSURANCE.ROUTED]: 'routed by ai-agent-entrypoint',
  [ASSURANCE.ENV]: 'env-only — a weaker guarantee than routed',
  [ASSURANCE.NATIVE]: 'native login, no account selected',
});

/**
 * Result contracts are executable terminal input, so a local workflow may
 * receive them only while PowerShell owns one conservative agent invocation.
 * This intentionally accepts fewer custom commands than PowerShell can parse:
 * false negatives disable result handoff, while a false positive could execute
 * untrusted result text at a shell prompt.
 */
function isConservativeAgentInvocation(command, agent) {
  if (!Object.hasOwn(AGENT_KINDS, agent) || agent === 'shell' || agent === 'codex') {
    return false;
  }
  const text = String(command ?? '').trim();
  if (!text || /[\u0000-\u001F\u007F]/.test(text)) return false;

  const tokens = text.split(/\s+/);
  const expected = AGENT_KINDS[agent].command.toLowerCase();
  const executable = tokens.shift().toLowerCase();
  if (![expected, `${expected}.exe`, `${expected}.cmd`].includes(executable)) {
    return false;
  }

  // Quotes, substitutions, redirections, pipelines, statement separators,
  // splats, comments, wildcards, and expression syntax are all outside this
  // deliberately small grammar. Plain flags and path/model values remain okay.
  return tokens.every(token => /^[A-Za-z0-9._:/\\=+-]+$/.test(token));
}

// ── Validation ───────────────────────────────────────────────

/**
 * Reject secret-shaped environment keys.
 * @throws Error naming the offending key.
 */
function assertSafeEnv(env) {
  if (env === undefined || env === null) return {};
  if (typeof env !== 'object' || Array.isArray(env)) {
    throw new Error('Profile env must be an object of NAME → value');
  }
  const out = {};
  for (const [rawKey, rawValue] of Object.entries(env)) {
    const key = String(rawKey).trim();
    if (!key) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Invalid environment variable name: "${key}"`);
    }
    if (CODEX_ROUTING_ENV.has(key.toUpperCase())) {
      throw new Error(
        `"${key}" is owned by ai-agent-entrypoint. Local profiles cannot select ` +
        'Codex accounts; choose a discovered routed Codex account instead.'
      );
    }
    if (SECRET_KEY_PATTERN.test(key)) {
      throw new Error(
        `"${key}" looks like a credential. This app stores paths and flags only — ` +
        `point the agent at its own state directory instead (for example CLAUDE_CONFIG_DIR) ` +
        `and log in inside that session.`
      );
    }
    out[key] = String(rawValue ?? '');
  }
  return out;
}

/** Coerce stored/incoming profile JSON into a known-good record. */
function normalizeProfile(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Profile must be an object');
  }
  const id = String(raw.id ?? '').trim();
  if (!PROFILE_ID_PATTERN.test(id)) {
    throw new Error('Profile id must be 1-64 chars of letters, digits, and _ : . -');
  }
  if (id.toLowerCase().startsWith(ROUTED_PROFILE_PREFIX)) {
    throw new Error(`Local profile ids cannot use the reserved "${ROUTED_PROFILE_PREFIX}" namespace`);
  }
  const agent = String(raw.agent ?? 'shell').trim();
  if (!Object.hasOwn(AGENT_KINDS, agent)) {
    throw new Error(`Unknown agent "${agent}". Known: ${Object.keys(AGENT_KINDS).join(', ')}`);
  }
  if (agent === 'codex') {
    throw new Error(
      'Local Codex profiles are not allowed; choose a discovered routed Codex account. ' +
      'A legacy local Codex profile stays in agents.json untouched — recreate the ' +
      'account as a routed alias in ai-agent-entrypoint.'
    );
  }
  const displayName = String(raw.displayName ?? '').trim();
  if (!displayName) throw new Error('Profile needs a display name');
  if (displayName.length > 80) throw new Error('Display name is limited to 80 characters');

  const command = String(raw.command ?? '').trim();
  if (command.length > 2000) throw new Error('Command is too long');

  const cwd = String(raw.cwd ?? '').trim();

  return {
    id,
    kind: 'local',
    agent,
    displayName,
    command: command || AGENT_KINDS[agent].command || '',
    env: assertSafeEnv(raw.env),
    cwd,
  };
}

function assuranceForLocalProfile(profile) {
  const homeEnv = Object.hasOwn(AGENT_KINDS, profile?.agent)
    ? AGENT_KINDS[profile.agent].homeEnv
    : null;
  if (!homeEnv) return ASSURANCE.NATIVE;
  const selected = Object.entries(profile.env || {}).find(
    ([key]) => key.toUpperCase() === homeEnv.toUpperCase()
  );
  return selected && String(selected[1]).trim() ? ASSURANCE.ENV : ASSURANCE.NATIVE;
}

// ── Local profile store ──────────────────────────────────────

function emptyProfileFile() {
  return { schemaVersion: SCHEMA_VERSION, profiles: [] };
}

/**
 * Read the profile file, separating loadable profiles from entries the
 * current rules reject (for example a legacy local Codex profile saved by an
 * older version). Rejected entries are preserved verbatim so a rules change
 * never destroys user data on the next write.
 */
function readProfileFile(filePath) {
  const raw = readJson(filePath, null);
  const list = Array.isArray(raw?.profiles) ? raw.profiles : [];
  const valid = [];
  const rejected = [];
  for (const entry of list) {
    try {
      valid.push(normalizeProfile(entry));
    } catch (err) {
      rejected.push({ entry, error: err });
    }
  }
  return { valid, rejected };
}

function rejectedEntryId(rejectedItem) {
  const id = rejectedItem?.entry?.id;
  return typeof id === 'string' ? id.trim() : null;
}

/**
 * Read local profiles. A malformed entry is skipped rather than failing the
 * whole list, so one bad profile never hides the rest.
 */
function loadLocalProfiles(filePath, onError = null) {
  const { valid, rejected } = readProfileFile(filePath);
  if (onError) {
    for (const item of rejected) {
      onError(rejectedEntryId(item) ?? '(unnamed)', item.error);
    }
  }
  return valid;
}

/**
 * Insert or replace one profile by id. Returns the saved profile.
 *
 * Omitting `env` on an existing profile keeps the stored env. That matters
 * because env *values* are never sent to the renderer (they are machine-local
 * paths), so the editor cannot echo them back on a rename — an omitted field
 * means "unchanged", while an explicit `{}` clears the account selection.
 */
function saveLocalProfile(filePath, raw) {
  const { valid: profiles, rejected } = readProfileFile(filePath);
  const existing = profiles.find(p => p.id === String(raw?.id ?? '').trim());
  const incoming = (raw && raw.env === undefined && existing)
    ? { ...raw, env: existing.env }
    : raw;

  const profile = normalizeProfile(incoming);
  const idx = profiles.findIndex(p => p.id === profile.id);
  if (idx >= 0) profiles[idx] = profile;
  else profiles.push(profile);
  // Preserve entries the current rules reject (legacy formats) instead of
  // erasing them on rewrite — except one being deliberately replaced by id.
  const preserved = rejected
    .filter(item => rejectedEntryId(item) !== profile.id)
    .map(item => item.entry);
  writeJsonAtomic(filePath, {
    schemaVersion: SCHEMA_VERSION,
    profiles: [...profiles, ...preserved],
  });
  return profile;
}

/** Remove one profile by id. Returns true when something was removed. */
function deleteLocalProfile(filePath, id) {
  const { valid: profiles, rejected } = readProfileFile(filePath);
  const kept = profiles.filter(p => p.id !== id);
  const keptRejected = rejected.filter(item => rejectedEntryId(item) !== id);
  if (kept.length === profiles.length && keptRejected.length === rejected.length) {
    return false;
  }
  writeJsonAtomic(filePath, {
    schemaVersion: SCHEMA_VERSION,
    profiles: [...kept, ...keptRejected.map(item => item.entry)],
  });
  return true;
}

// ── ai-agent-entrypoint integration ──────────────────────────

/**
 * Locate the ai-agent-entrypoint checkout.
 * Prefers an explicit setting; otherwise looks for a sibling of the app
 * directory. No absolute path is baked in — the workspace root's drive and
 * location are not fixed.
 *
 * @returns {string|null} the repo root, or null when it cannot be found.
 */
function resolveEntrypointPath({ configured, appRoot, exists = fs.existsSync } = {}) {
  const explicit = configured && String(configured).trim();
  if (explicit) {
    return exists(entrypointScript(explicit)) ? explicit : null;
  }
  const candidates = [];
  if (appRoot) {
    candidates.push(path.resolve(appRoot, '..', 'ai-agent-entrypoint'));
    candidates.push(path.resolve(appRoot, '..', '..', 'ai-agent-entrypoint'));
  }
  for (const candidate of candidates) {
    if (exists(entrypointScript(candidate))) return candidate;
  }
  return null;
}

function entrypointScript(repoRoot) {
  return path.join(repoRoot, 'bin', 'agent-entrypoint.ps1');
}

/**
 * Strip a doctor report down to what the UI may see.
 *
 * `Home` and `ManifestPath` are canonical account-home paths. The entrypoint
 * project classifies them as secret-adjacent metadata, so they are dropped
 * here and never reach the renderer, a log line, or an exported workflow.
 */
function sanitizeDoctorReport(report) {
  if (!report || typeof report !== 'object') return null;
  const alias = String(report.Alias ?? '').trim();
  if (!ROUTED_ALIAS_PATTERN.test(alias)) return null;
  const hasErrors = Array.isArray(report.Errors) && report.Errors.length > 0;
  const hasWarnings = Array.isArray(report.Warnings) && report.Warnings.length > 0;
  const displayName = String(report.DisplayName ?? `Codex ${alias}`)
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .trim()
    .slice(0, 80) || `Codex ${alias}`;
  const rawStatus = String(report.Status ?? 'unknown').trim().toLowerCase();
  const status = ROUTED_STATUS_VALUES.has(rawStatus) ? rawStatus : 'unknown';
  return {
    id: `codex:${alias}`,
    kind: 'routed',
    agent: 'codex',
    alias,
    displayName,
    assurance: ASSURANCE.ROUTED,
    status,
    authenticated: report.AuthenticationStatePresent === true,
    // Doctor diagnostics are free-form and may repeat canonical Home or
    // ManifestPath values. Preserve the health signal, never the raw text.
    errors: hasErrors
      ? ['Account routing reported an error. Run codex doctor in a trusted terminal for details.']
      : [],
    warnings: hasWarnings
      ? ['Account routing reported a warning. Run codex doctor in a trusted terminal for details.']
      : [],
  };
}

/** Parse a doctor `--json` payload into sanitized routed profiles. */
function parseDoctorOutput(stdout) {
  const parsed = JSON.parse(stdout);
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list.map(sanitizeDoctorReport).filter(Boolean);
}

/**
 * Discover routed Codex accounts by asking ai-agent-entrypoint.
 * Never throws: returns `{ profiles, error }` so a missing or invalid
 * manifest shows up in the UI as "unavailable" instead of breaking startup.
 */
function discoverRoutedProfiles({ entrypointPath, timeoutMs = 20_000, run = execFile } = {}) {
  return new Promise((resolve) => {
    if (!entrypointPath) {
      resolve({ profiles: [], error: 'ai-agent-entrypoint was not found. Choose its folder under Agent Accounts → Routed account source to use routed Codex accounts.' });
      return;
    }
    const script = entrypointScript(entrypointPath);
    if (!fs.existsSync(script)) {
      resolve({ profiles: [], error: 'The configured routed account source does not contain agent-entrypoint.ps1.' });
      return;
    }

    run(
      'pwsh',
      ['-NoLogo', '-NoProfile', '-File', script, 'codex', 'doctor', '--all', '--json'],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && !stdout) {
          resolve({
            profiles: [],
            error: 'Codex account discovery failed. Run codex doctor in a trusted terminal for details.',
          });
          return;
        }
        try {
          resolve({ profiles: parseDoctorOutput(stdout), error: null });
        } catch (parseErr) {
          resolve({ profiles: [], error: 'Could not read the routed account list because its JSON was invalid.' });
        }
      }
    );
  });
}

// ── Launch spec ──────────────────────────────────────────────

/**
 * Turn a profile into everything SessionRegistry.create() needs.
 *
 * @param {object} profile  a local profile, or a routed one from discovery
 * @param {object} ctx
 * @param {object} ctx.baseEnv        environment to inherit (usually process.env)
 * @param {string} [ctx.entrypointPath] required for routed profiles
 * @param {string} [ctx.defaultCwd]   used when the profile sets none
 * @param {function} [ctx.exists]     injected for tests
 * @param {boolean} [ctx.workflowSession] true only for workflow Agent Session blocks
 * @returns {{file, args, env, cwd, profileId, agent, label, assurance, resultInputCapable}}
 */
function buildLaunchSpec(profile, ctx = {}) {
  if (!profile || typeof profile !== 'object') {
    throw new Error('No agent profile given');
  }
  const {
    baseEnv = {},
    entrypointPath = null,
    defaultCwd = undefined,
    exists = fs.existsSync,
  } = ctx;
  const workflowSession = ctx.workflowSession === true;

  if (profile.kind === 'routed') {
    // Fail closed. Silently starting a native Codex when a managed account was
    // requested would hand the wrong identity to whatever runs next.
    if (!entrypointPath) {
      throw new Error(
        `Cannot start "${profile.displayName}": ai-agent-entrypoint was not found, ` +
        `and a routed account must never fall back to the native login.`
      );
    }
    const script = entrypointScript(entrypointPath);
    if (!exists(script)) {
      throw new Error(`Cannot start "${profile.displayName}": the configured routed account source is unavailable.`);
    }
    if (!profile.alias) {
      throw new Error(`Cannot start "${profile.displayName}": the account alias is missing.`);
    }
    return {
      // The entrypoint constructs the child environment itself; we pass ours
      // through untouched rather than second-guessing its routing.
      file: 'pwsh.exe',
      args: ['-NoLogo', '-NoProfile', '-File', script, 'codex', 'shell', profile.alias],
      env: { ...baseEnv },
      cwd: profile.cwd || defaultCwd,
      profileId: profile.id,
      agent: 'codex',
      label: profile.displayName,
      assurance: ASSURANCE.ROUTED,
      // The workflow bootstrap starts Codex and then exits the account shell.
      // Manual routed tabs remain ordinary account shells and cannot receive
      // generated result contracts through the privileged input channel.
      resultInputCapable: workflowSession,
    };
  }

  const local = normalizeProfile(profile);
  const overrides = local.env;

  return {
    file: 'powershell.exe',
    // A workflow wrapper must disappear when its agent exits; otherwise later
    // result text could land at the PowerShell prompt. Manual tabs retain their
    // long-lived -NoExit behavior.
    args: workflowSession
      ? (local.command ? ['-Command', local.command] : [])
      : (local.command ? ['-NoExit', '-Command', local.command] : ['-NoExit']),
    env: { ...baseEnv, ...overrides },
    cwd: local.cwd || defaultCwd,
    profileId: local.id,
    agent: local.agent,
    label: local.displayName,
    // Only the agent's own non-empty state-home variable selects an account.
    // Cosmetic flags such as NO_COLOR do not raise the assurance level.
    assurance: assuranceForLocalProfile(local),
    resultInputCapable: workflowSession
      && isConservativeAgentInvocation(local.command, local.agent),
  };
}

/** Public metadata for a profile — safe to send to the renderer. */
function describeProfile(profile) {
  if (!profile) return null;
  const kind = profile.kind === 'routed' ? 'routed' : 'local';
  const agent = Object.hasOwn(AGENT_KINDS, profile.agent) ? profile.agent : 'shell';
  const base = {
    id: profile.id,
    kind,
    agent,
    icon: AGENT_KINDS[agent].icon,
    agentLabel: AGENT_KINDS[agent].label,
    displayName: profile.displayName,
    assurance: kind === 'routed'
      ? ASSURANCE.ROUTED
      : assuranceForLocalProfile(profile),
  };
  base.assuranceLabel = ASSURANCE_LABEL[base.assurance];
  if (kind === 'routed') {
    return { ...base, alias: profile.alias, status: profile.status, authenticated: profile.authenticated, errors: profile.errors, warnings: profile.warnings };
  }
  return {
    ...base,
    command: profile.command,
    cwd: profile.cwd,
    // Names only — values can be machine-local paths the user may not want on screen.
    envKeys: Object.keys(profile.env || {}),
  };
}

module.exports = {
  SCHEMA_VERSION,
  PROFILE_ID_PATTERN,
  ROUTED_PROFILE_PREFIX,
  ROUTED_ALIAS_PATTERN,
  CODEX_ROUTING_ENV,
  SECRET_KEY_PATTERN,
  AGENT_KINDS,
  ASSURANCE,
  ASSURANCE_LABEL,
  assertSafeEnv,
  normalizeProfile,
  assuranceForLocalProfile,
  emptyProfileFile,
  loadLocalProfiles,
  saveLocalProfile,
  deleteLocalProfile,
  resolveEntrypointPath,
  entrypointScript,
  sanitizeDoctorReport,
  parseDoctorOutput,
  discoverRoutedProfiles,
  isConservativeAgentInvocation,
  buildLaunchSpec,
  describeProfile,
};
