// Unit tests for agent profiles: validation, the credential boundary,
// launch-spec construction, and the ai-agent-entrypoint integration.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const agents = require('../src/main/agents');

function tmpFile(name = 'agents.json') {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agents-orch-')), name);
}

const CLAUDE_WORK = {
  id: 'claude-work',
  agent: 'claude',
  displayName: 'Claude · work',
  env: { CLAUDE_CONFIG_DIR: 'C:/state/claude-work' },
};

// ── The credential boundary ──────────────────────────────────

test('env rejects credential-shaped keys with actionable guidance', () => {
  const rejected = [
    'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY', 'GEMINI_API_KEY',
    'CODEX_ACCESS_TOKEN', 'GITHUB_TOKEN', 'MY_SECRET', 'DB_PASSWORD',
    'AWS_SECRET_ACCESS_KEY', 'SOME_CREDENTIAL', 'apikey', 'private_key',
  ];
  for (const key of rejected) {
    assert.throws(
      () => agents.assertSafeEnv({ [key]: 'x' }),
      /looks like a credential/,
      `${key} should be rejected`
    );
  }
});

test('env accepts the state-home variables account switching actually needs', () => {
  const safe = {
    CLAUDE_CONFIG_DIR: 'C:/state/claude-work',
    CODEX_HOME: 'C:/state/codex-a',
    GROK_HOME: 'C:/state/grok',
    GEMINI_CONFIG_DIR: 'C:/state/gemini',
    NO_COLOR: '1',
  };
  assert.deepEqual(agents.assertSafeEnv(safe), safe);
});

test('env rejects malformed variable names and non-objects', () => {
  assert.throws(() => agents.assertSafeEnv({ 'has space': 'x' }), /Invalid environment variable name/);
  assert.throws(() => agents.assertSafeEnv({ '1LEADING': 'x' }), /Invalid environment variable name/);
  assert.throws(() => agents.assertSafeEnv('nope'), /must be an object/);
  assert.throws(() => agents.assertSafeEnv([1, 2]), /must be an object/);
  assert.deepEqual(agents.assertSafeEnv(null), {});
  assert.deepEqual(agents.assertSafeEnv(undefined), {});
});

test('env coerces values to strings', () => {
  assert.deepEqual(agents.assertSafeEnv({ NO_COLOR: 1, EMPTY: null }), { NO_COLOR: '1', EMPTY: '' });
});

// ── Profile normalization ────────────────────────────────────

test('normalizeProfile fills the agent default command', () => {
  const p = agents.normalizeProfile(CLAUDE_WORK);
  assert.equal(p.command, 'claude');
  assert.equal(p.kind, 'local');
  assert.equal(p.agent, 'claude');
});

test('normalizeProfile keeps an explicit command', () => {
  const p = agents.normalizeProfile({ ...CLAUDE_WORK, command: 'claude --permission-mode bypassPermissions' });
  assert.equal(p.command, 'claude --permission-mode bypassPermissions');
});

test('normalizeProfile rejects bad ids, unknown agents, and missing names', () => {
  assert.throws(() => agents.normalizeProfile({ ...CLAUDE_WORK, id: '' }), /Profile id/);
  assert.throws(() => agents.normalizeProfile({ ...CLAUDE_WORK, id: 'has space' }), /Profile id/);
  assert.throws(() => agents.normalizeProfile({ ...CLAUDE_WORK, id: '../escape' }), /Profile id/);
  assert.throws(() => agents.normalizeProfile({ ...CLAUDE_WORK, agent: 'skynet' }), /Unknown agent/);
  assert.throws(() => agents.normalizeProfile({ ...CLAUDE_WORK, displayName: '  ' }), /display name/);
  assert.throws(() => agents.normalizeProfile(null), /must be an object/);
});

// ── Local profile store ──────────────────────────────────────

test('local profiles round-trip through disk', () => {
  const file = tmpFile();
  assert.deepEqual(agents.loadLocalProfiles(file), []);

  agents.saveLocalProfile(file, CLAUDE_WORK);
  agents.saveLocalProfile(file, { ...CLAUDE_WORK, id: 'claude-personal', displayName: 'Claude · personal', env: { CLAUDE_CONFIG_DIR: 'C:/state/claude-personal' } });

  const loaded = agents.loadLocalProfiles(file);
  assert.deepEqual(loaded.map(p => p.id), ['claude-work', 'claude-personal']);
  // Two accounts of the same agent must keep distinct state homes.
  assert.notEqual(loaded[0].env.CLAUDE_CONFIG_DIR, loaded[1].env.CLAUDE_CONFIG_DIR);
});

test('saving an existing id replaces rather than duplicates', () => {
  const file = tmpFile();
  agents.saveLocalProfile(file, CLAUDE_WORK);
  agents.saveLocalProfile(file, { ...CLAUDE_WORK, displayName: 'Claude · day job' });
  const loaded = agents.loadLocalProfiles(file);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].displayName, 'Claude · day job');
});

test('omitting env on an update keeps the stored value; {} clears it', () => {
  // Env values never reach the renderer, so the editor cannot echo them back
  // on a rename. Omission has to mean "unchanged".
  const file = tmpFile();
  agents.saveLocalProfile(file, CLAUDE_WORK);

  const renamed = agents.saveLocalProfile(file, { id: 'claude-work', agent: 'claude', displayName: 'Claude · day job' });
  assert.deepEqual(renamed.env, { CLAUDE_CONFIG_DIR: 'C:/state/claude-work' });

  const cleared = agents.saveLocalProfile(file, { id: 'claude-work', agent: 'claude', displayName: 'Claude · day job', env: {} });
  assert.deepEqual(cleared.env, {});
  // Clearing the account selection must show up honestly in the assurance level.
  assert.equal(agents.describeProfile(cleared).assurance, agents.ASSURANCE.NATIVE);
});

test('a brand-new profile with no env is native, not silently inherited', () => {
  const file = tmpFile();
  const created = agents.saveLocalProfile(file, { id: 'fresh', agent: 'claude', displayName: 'Fresh' });
  assert.deepEqual(created.env, {});
});

test('deleteLocalProfile removes only the named profile', () => {
  const file = tmpFile();
  agents.saveLocalProfile(file, CLAUDE_WORK);
  agents.saveLocalProfile(file, { ...CLAUDE_WORK, id: 'grok-main', agent: 'grok', displayName: 'Grok' });

  assert.equal(agents.deleteLocalProfile(file, 'claude-work'), true);
  assert.deepEqual(agents.loadLocalProfiles(file).map(p => p.id), ['grok-main']);
  assert.equal(agents.deleteLocalProfile(file, 'nonexistent'), false);
});

test('one malformed stored profile does not hide the others', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 1,
    profiles: [CLAUDE_WORK, { id: 'broken', agent: 'nope', displayName: 'x' }, { ...CLAUDE_WORK, id: 'grok-main', agent: 'grok' }],
  }));
  const errors = [];
  const loaded = agents.loadLocalProfiles(file, (id) => errors.push(id));
  assert.deepEqual(loaded.map(p => p.id), ['claude-work', 'grok-main']);
  assert.deepEqual(errors, ['broken']);
});

test('a saved profile file never contains a credential-shaped key', () => {
  const file = tmpFile();
  assert.throws(
    () => agents.saveLocalProfile(file, { ...CLAUDE_WORK, env: { ANTHROPIC_API_KEY: 'sk-live-123' } }),
    /looks like a credential/
  );
  assert.equal(fs.existsSync(file), false, 'nothing should have been written');
});

// ── Entrypoint discovery ─────────────────────────────────────

test('resolveEntrypointPath prefers the configured path, then a sibling', () => {
  const exists = (p) => p.replace(/\\/g, '/').includes('/workspace/ai-agent-entrypoint/bin/');
  assert.equal(
    agents.resolveEntrypointPath({ configured: 'C:/workspace/ai-agent-entrypoint', appRoot: 'C:/elsewhere/app', exists }),
    'C:/workspace/ai-agent-entrypoint'
  );
  assert.equal(
    agents.resolveEntrypointPath({ appRoot: 'C:/workspace/agent-orchestrator', exists }).replace(/\\/g, '/'),
    'C:/workspace/ai-agent-entrypoint'
  );
  assert.equal(agents.resolveEntrypointPath({ appRoot: 'C:/nowhere', exists: () => false }), null);
});

/** A doctor report as ai-agent-entrypoint actually emits it. */
const DOCTOR_REPORT = {
  Alias: 'a',
  DisplayName: 'Codex A',
  Assurance: 'L1 ready when invoked through run/login/status',
  Status: 'ok',
  Home: 'C:/private/vault/codex-accounts/a',
  ManifestPath: 'C:/Users/someone/AppData/Local/ai-agent-entrypoint/accounts.json',
  ConfigPresent: true,
  CredentialStore: 'file',
  AuthenticationStatePresent: true,
  Errors: [],
  Warnings: [],
};

test('sanitizeDoctorReport drops canonical account-home paths', () => {
  const clean = agents.sanitizeDoctorReport(DOCTOR_REPORT);
  const serialized = JSON.stringify(clean);

  assert.equal(clean.id, 'codex:a');
  assert.equal(clean.kind, 'routed');
  assert.equal(clean.alias, 'a');
  assert.equal(clean.displayName, 'Codex A');
  assert.equal(clean.assurance, agents.ASSURANCE.ROUTED);
  assert.equal(clean.authenticated, true);

  // These are secret-adjacent per ai-agent-entrypoint and must not escape.
  assert.equal(clean.Home, undefined);
  assert.equal(clean.ManifestPath, undefined);
  assert.ok(!serialized.includes('vault'));
  assert.ok(!serialized.includes('accounts.json'));
  assert.ok(!serialized.includes('AppData'));
});

test('sanitizeDoctorReport carries the health signal through', () => {
  const bad = agents.sanitizeDoctorReport({
    ...DOCTOR_REPORT, Alias: 'c', Status: 'error',
    AuthenticationStatePresent: false, Errors: ['home is missing'],
  });
  assert.equal(bad.status, 'error');
  assert.equal(bad.authenticated, false);
  assert.deepEqual(bad.errors, ['home is missing']);
  assert.equal(agents.sanitizeDoctorReport({ Alias: '' }), null);
  assert.equal(agents.sanitizeDoctorReport(null), null);
});

test('parseDoctorOutput handles the array doctor always returns', () => {
  const many = agents.parseDoctorOutput(JSON.stringify([
    DOCTOR_REPORT, { ...DOCTOR_REPORT, Alias: 'b', DisplayName: 'Codex B' },
  ]));
  assert.deepEqual(many.map(p => p.id), ['codex:a', 'codex:b']);
  // Tolerate a single object too.
  assert.deepEqual(agents.parseDoctorOutput(JSON.stringify(DOCTOR_REPORT)).map(p => p.id), ['codex:a']);
});

test('discovery reports a missing entrypoint instead of throwing', async () => {
  const r = await agents.discoverRoutedProfiles({ entrypointPath: null });
  assert.deepEqual(r.profiles, []);
  assert.match(r.error, /not found/);
  assert.match(r.error, /Routed account source/);
});

test('discovery surfaces a failed doctor run as an error, not a crash', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-orch-ep-'));
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(agents.entrypointScript(dir), '# fake');

  const run = (_file, _args, _opts, cb) => cb(new Error('AAE_MANIFEST_INVALID'), '', 'manifest is invalid');
  const r = await agents.discoverRoutedProfiles({ entrypointPath: dir, run });
  assert.deepEqual(r.profiles, []);
  assert.match(r.error, /manifest is invalid/);
});

test('discovery parses a successful doctor run', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-orch-ep-'));
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(agents.entrypointScript(dir), '# fake');

  const run = (file, args, _opts, cb) => {
    assert.equal(file, 'pwsh');
    assert.deepEqual(args.slice(-4), ['codex', 'doctor', '--all', '--json']);
    cb(null, JSON.stringify([DOCTOR_REPORT]), '');
  };
  const r = await agents.discoverRoutedProfiles({ entrypointPath: dir, run });
  assert.equal(r.error, null);
  assert.deepEqual(r.profiles.map(p => p.id), ['codex:a']);
});

// ── Launch specs ─────────────────────────────────────────────

test('a local profile launches PowerShell with its env overlaid', () => {
  const spec = agents.buildLaunchSpec(CLAUDE_WORK, {
    baseEnv: { PATH: '/bin', EXISTING: 'keep' },
    defaultCwd: 'C:/work',
  });
  assert.equal(spec.file, 'powershell.exe');
  assert.deepEqual(spec.args, ['-NoExit', '-Command', 'claude']);
  assert.equal(spec.env.CLAUDE_CONFIG_DIR, 'C:/state/claude-work');
  assert.equal(spec.env.EXISTING, 'keep', 'inherited variables survive');
  assert.equal(spec.cwd, 'C:/work');
  assert.equal(spec.assurance, agents.ASSURANCE.ENV);
  assert.equal(spec.agent, 'claude');
});

test('two accounts of one agent produce different child environments', () => {
  const work = agents.buildLaunchSpec(CLAUDE_WORK, { baseEnv: {} });
  const personal = agents.buildLaunchSpec(
    { ...CLAUDE_WORK, id: 'claude-personal', displayName: 'Claude · personal', env: { CLAUDE_CONFIG_DIR: 'C:/state/claude-personal' } },
    { baseEnv: {} }
  );
  assert.notEqual(work.env.CLAUDE_CONFIG_DIR, personal.env.CLAUDE_CONFIG_DIR);
});

test('a profile with no env overrides is honestly labelled native, not L2', () => {
  const spec = agents.buildLaunchSpec({ id: 'plain', agent: 'claude', displayName: 'Claude (native)' }, { baseEnv: {} });
  assert.equal(spec.assurance, agents.ASSURANCE.NATIVE);
});

test('a profile cwd wins over the workflow default', () => {
  const spec = agents.buildLaunchSpec({ ...CLAUDE_WORK, cwd: 'C:/repo' }, { baseEnv: {}, defaultCwd: 'C:/work' });
  assert.equal(spec.cwd, 'C:/repo');
});

const ROUTED = { id: 'codex:a', kind: 'routed', agent: 'codex', alias: 'a', displayName: 'Codex A' };

test('a routed profile launches through agent-entrypoint codex shell', () => {
  const spec = agents.buildLaunchSpec(ROUTED, {
    baseEnv: { PATH: '/bin' },
    entrypointPath: 'C:/AI_Projects/ai-agent-entrypoint',
    exists: () => true,
  });
  assert.equal(spec.file, 'pwsh.exe');
  assert.deepEqual(spec.args.slice(-3), ['codex', 'shell', 'a']);
  assert.ok(spec.args.includes('-NoProfile'));
  assert.equal(spec.assurance, agents.ASSURANCE.ROUTED);
  // We must not construct the account environment ourselves; the entrypoint owns it.
  assert.equal(spec.env.CODEX_HOME, undefined);
  assert.equal(spec.env.CODEX_SQLITE_HOME, undefined);
  assert.deepEqual(spec.env, { PATH: '/bin' });
});

test('a routed profile fails closed rather than falling back to the native login', () => {
  assert.throws(
    () => agents.buildLaunchSpec(ROUTED, { baseEnv: {}, entrypointPath: null }),
    /never fall back to the native login/
  );
  assert.throws(
    () => agents.buildLaunchSpec(ROUTED, { baseEnv: {}, entrypointPath: 'C:/gone', exists: () => false }),
    /no agent-entrypoint\.ps1/
  );
  assert.throws(
    () => agents.buildLaunchSpec({ ...ROUTED, alias: '' }, { baseEnv: {}, entrypointPath: 'C:/ep', exists: () => true }),
    /alias is missing/
  );
});

test('buildLaunchSpec re-validates env, so a hand-edited file cannot smuggle a key', () => {
  assert.throws(
    () => agents.buildLaunchSpec({ ...CLAUDE_WORK, env: { ANTHROPIC_API_KEY: 'sk-1' } }, { baseEnv: {} }),
    /looks like a credential/
  );
});

// ── Renderer-facing description ──────────────────────────────

test('describeProfile exposes env keys but never env values', () => {
  const d = agents.describeProfile(agents.normalizeProfile(CLAUDE_WORK));
  assert.deepEqual(d.envKeys, ['CLAUDE_CONFIG_DIR']);
  assert.ok(!JSON.stringify(d).includes('C:/state/claude-work'));
  assert.equal(d.assurance, agents.ASSURANCE.ENV);
  assert.match(d.assuranceLabel, /env-only/);
});

test('assurance wording never claims isolation for an env-only profile', () => {
  assert.ok(!/isolat/i.test(agents.ASSURANCE_LABEL[agents.ASSURANCE.ENV]));
  assert.match(agents.ASSURANCE_LABEL[agents.ASSURANCE.ROUTED], /ai-agent-entrypoint/);
});

test('describeProfile passes routed health through for the UI', () => {
  const d = agents.describeProfile(agents.sanitizeDoctorReport(DOCTOR_REPORT));
  assert.equal(d.kind, 'routed');
  assert.equal(d.alias, 'a');
  assert.equal(d.status, 'ok');
  assert.equal(d.assurance, agents.ASSURANCE.ROUTED);
});
