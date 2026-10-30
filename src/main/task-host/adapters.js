// Task-launch adapters: how one fresh provider receives its instruction and
// what lifecycle evidence it can produce.
//
// Both adapters use argv-pointer delivery: the instruction lives in a private
// per-launch file outside the worktree, and the provider's initial prompt is a
// fixed sentence naming that file. Task text never enters argv, the clipboard,
// or an existing PTY.
//
// The report comes back on one of two channels. `pty-frame`: the agent prints
// a marked frame that the host captures from the terminal stream; fine for a
// line-oriented agent. `file`: the agent writes its report to a private
// per-launch outbox; required for a full-screen TUI such as Codex, whose
// redraws do not survive as recoverable bytes.

const fs = require('fs');
const path = require('path');
const { createHash, randomBytes } = require('crypto');

const { parseStrictJson } = require('./strict-json');

const MAX_SUMMARY_CHARS = 4000;
/**
 * Bump when the Codex adapter changes how it launches or delivers, so an old
 * qualification receipt stops admitting it.
 */
const CODEX_ADAPTER_CONTRACT = 1;
const CODEX_VERSION_PATTERN = /^codex-cli ([0-9A-Za-z][0-9A-Za-z.+-]{0,63})$/;
// Codex's -c key parser splits on '.', but the value is TOML, so the trust
// root travels as a literal-string key of an inline table. A TOML literal
// string cannot hold an apostrophe or a control character.
const CODEX_TRUST_ROOT_PATTERN = /^[a-z]:\\[^'\u0000-\u001f\u007f]*$/;
// Options a task launch sets itself. A routed spec that already carries one
// would make the task's behaviour depend on argument order, so it is refused.
const CODEX_TASK_OWNED_OPTIONS = new Set([
  '-a', '--ask-for-approval', '--add-dir', '--remote', '--no-daemon',
]);

/** Windows folds ASCII case only; Codex keys projects by that folded path. */
function codexTrustRoot(repositoryRoot) {
  const folded = String(repositoryRoot || '').replace(/[A-Z]/g, letter => letter.toLowerCase());
  return CODEX_TRUST_ROOT_PATTERN.test(folded) ? folded : null;
}
const MAX_CLAIMED_CHECKS = 16;
const CLAIM_OUTCOMES = new Set(['passed', 'failed', 'not-run']);

function pointerPrompt(promptFile) {
  return `Your complete task is in the file ${promptFile} . Read that file first and follow it exactly.`;
}

/**
 * The lifecycle receipt that completes a task must be for the turn whose
 * input is this exact pointer sentence (it names the launch's own prompt).
 */
function pointerDigest(promptFile) {
  return createHash('sha256').update(pointerPrompt(promptFile).trim(), 'utf8').digest('hex');
}

/** Per-launch secrets that appear only inside the private prompt file. */
function createResultFrame() {
  const frameId = randomBytes(8).toString('hex');
  return {
    nonce: randomBytes(16).toString('hex'),
    startMarker: `AO-TASK-RESULT-BEGIN-${frameId}`,
    endMarker: `AO-TASK-RESULT-END-${frameId}`,
  };
}

/**
 * Render the private prompt. `resultFile` selects the file result channel:
 * the agent writes its report there instead of printing a marked frame.
 */
function renderPromptFile(request, frame, { resultFile = null } = {}) {
  const checks = request.checks.length
    ? request.checks.map(check => `- \`${check.name}\` (run it as \`npm run ${check.name}\`)`).join('\n')
    : '- (none requested)';
  const example = request.checks.length ? request.checks[0].name : 'test';
  const body = `{"nonce":"${frame.nonce}","summary":"<one paragraph>","checks":[{"name":"${example}","outcome":"passed|failed|not-run"}]}`;
  const report = resultFile
    ? [
      'When you are finished, write exactly one JSON object, and nothing else, to',
      `this file (create it; it is outside your working directory but writable): ${resultFile}`,
      '',
      body,
      '',
      'Name each check exactly as it is listed above, without `npm run`.',
    ]
    : [
      'When you are finished, print exactly one result block as plain text, with',
      'each marker alone on its own line and one line of JSON between them:',
      '',
      frame.startMarker,
      body,
      frame.endMarker,
      '',
      'Name each check exactly as it is listed above, without `npm run`.',
    ];
  return [
    `# Task ${request.taskId}`,
    '',
    'You are running in a fresh Git worktree created only for this task. It is',
    'your current working directory.',
    '',
    '## Instruction',
    '',
    request.instruction,
    '',
    '## Rules',
    '',
    '- Change files only inside the current working directory.',
    '- Do not commit, push, merge, or deploy. Leave every change uncommitted; the',
    '  host collects the diff for review.',
    '- Ask in this window if a decision is outside the instruction.',
    '',
    '## Checks',
    '',
    'Run these if you can. The host will also run them itself after you finish,',
    'and will report your claims and its own observations separately.',
    '',
    checks,
    '',
    '## Report',
    '',
    ...report,
    '',
  ].join('\n');
}

/**
 * Read a file-channel report as a capture. Only a regular file within the
 * size bound counts; a link or directory is invalid, an oversize file is
 * truncated, an absent one is missing. The content stays AI-reported.
 */
function readResultFile(file, maxBytes) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (_error) {
    return null;
  }
  if (!stat.isFile() || stat.nlink !== 1) return { complete: true, text: '' };
  // Bound the read itself, not only the size seen a moment earlier.
  const buffer = Buffer.alloc(maxBytes + 1);
  let length;
  const fd = fs.openSync(file, 'r');
  try {
    length = fs.readSync(fd, buffer, 0, buffer.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (length > maxBytes) return { complete: false, missingStart: false };
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
  } catch (_error) {
    return { complete: true, text: '' };
  }
  // PowerShell's UTF-8 writers often prepend a byte-order mark.
  return { complete: true, text: text.replace(/^\uFEFF/, '') };
}

/**
 * Interpret a captured frame body. Everything in it is AI-reported and
 * untrusted; this only bounds and types it.
 */
function parseResultFrame(capture, frame) {
  if (!capture) return { frame: 'missing', nonce: 'not-observed', aiReported: null };
  if (!capture.complete) {
    // A frame that began but never ended is partial output, not an absent one.
    return {
      frame: capture.missingStart ? 'missing' : 'truncated',
      nonce: 'not-observed',
      aiReported: null,
    };
  }
  let body;
  try {
    body = parseStrictJson(capture.text.replace(/\s+/g, ' ').trim(), { maxDepth: 4 });
  } catch (_error) {
    return { frame: 'invalid', nonce: 'not-observed', aiReported: null };
  }
  const keys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body).sort() : [];
  if (keys.join(',') !== 'checks,nonce,summary') return { frame: 'invalid', nonce: 'not-observed', aiReported: null };
  const nonce = body.nonce === frame.nonce ? 'echoed' : 'mismatch';
  if (
    typeof body.summary !== 'string' || body.summary.length > MAX_SUMMARY_CHARS ||
    !Array.isArray(body.checks) || body.checks.length > MAX_CLAIMED_CHECKS ||
    !body.checks.every(check => check && typeof check === 'object' && !Array.isArray(check) &&
      Object.keys(check).sort().join(',') === 'name,outcome' &&
      typeof check.name === 'string' && check.name.length <= 64 && CLAIM_OUTCOMES.has(check.outcome)) ||
    new Set(body.checks.map(check => check.name)).size !== body.checks.length
  ) {
    return { frame: 'invalid', nonce, aiReported: null };
  }
  return {
    frame: 'complete',
    nonce,
    aiReported: {
      summary: body.summary,
      checks: body.checks.map(check => ({ name: check.name, outcome: check.outcome })),
    },
  };
}

/** Fixture provider: a local script that behaves like a scripted agent. */
function createFixtureAdapter({
  script, execPath = process.execPath, baseEnv = process.env, resultChannel = 'pty-frame',
} = {}) {
  if (!script || !path.isAbsolute(script)) throw new TypeError('Fixture adapter needs an absolute script path');
  return {
    id: 'fixture',
    qualification: 'fixture-only',
    delivery: 'argv-pointer',
    resultChannel,
    lifecycle: 'authenticated-turn-complete',
    async buildSpec({ route, worktree, promptFile }) {
      return {
        providerVersion: null,
        spec: {
          file: execPath,
          args: [script, '--scenario', route, pointerPrompt(promptFile)],
          env: { ...baseEnv },
          cwd: worktree,
          profileId: `fixture:${route}`,
          agent: 'fixture',
          label: `fixture · ${route}`,
          assurance: 'L0-native',
          resultInputCapable: false,
          sessionMode: 'direct-agent',
          initialTurnSubmitted: true,
          initialInputDigest: pointerDigest(promptFile),
        },
      };
    },
  };
}

function adapterError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

/**
 * Ask the routed provider for its version through the exact launch path the
 * task will use: the router's `target run <route> --` prefix, then
 * `--version`. No model turn is made.
 */
async function probeCodexVersion(spec, runVersion) {
  const separator = spec.args.indexOf('--');
  if (separator < 0) return null;
  let output;
  try {
    output = await runVersion(spec.file, [...spec.args.slice(0, separator + 1), '--version'], {
      env: spec.env,
      cwd: spec.cwd,
    });
  } catch (_error) {
    return null;
  }
  return CODEX_VERSION_PATTERN.exec(String(output).trim())?.[1] ?? null;
}

/**
 * Routed Codex through ai-agent-entrypoint's direct-agent contract.
 *
 * Admitted only with a qualification receipt for this adapter contract (see
 * qualification.js). Every launch probes the route's provider version first;
 * a qualified adapter refuses a version other than the one qualified.
 */
function createCodexAdapter({
  resolveProfile, buildLaunchSpec, launchContext, runVersion = null, qualification = null,
} = {}) {
  if (typeof resolveProfile !== 'function' || typeof buildLaunchSpec !== 'function') {
    throw new TypeError('Codex adapter needs profile resolution and launch-spec construction');
  }
  const qualifiedVersion = qualification?.status === 'qualified' ? qualification.providerVersion : null;
  return {
    id: 'codex',
    contract: CODEX_ADAPTER_CONTRACT,
    qualification: qualifiedVersion ? 'qualified' : 'unqualified',
    qualifiedVersion,
    delivery: 'argv-pointer',
    resultChannel: 'file',
    requiresProjectTrust: true,
    lifecycle: 'authenticated-turn-complete',
    async buildSpec({ route, worktree, promptFile, resultDir, repositoryRoot }) {
      // The owner opted this workspace into Codex project trust when
      // registering it (admission checks that). Codex gets that trust for this
      // one invocation only; its config is never written.
      const trustRoot = codexTrustRoot(repositoryRoot);
      if (!trustRoot) throw adapterError('provider-trust-unexpressible');
      if (!resultDir || !path.isAbsolute(resultDir)) throw adapterError('route-unavailable');
      const profile = await resolveProfile(route);
      if (!profile || profile.kind !== 'routed') throw adapterError('route-unavailable');
      const routed = buildLaunchSpec(profile, { ...(await launchContext()), sessionMode: 'direct-agent' });
      if (routed.sessionMode !== 'direct-agent' || routed.agent !== 'codex') throw adapterError('route-unavailable');
      const separator = routed.args.indexOf('--');
      if (separator < 0) throw adapterError('route-unavailable');
      if (routed.args.slice(separator + 1).some(arg => CODEX_TASK_OWNED_OPTIONS.has(arg.split('=')[0]))) {
        throw adapterError('route-policy-conflict');
      }
      const spec = {
        ...routed,
        args: [
          ...routed.args,
          // The task's own backend, not a shared app-server daemon.
          '--no-daemon',
          // Nothing waits for an approval nobody is there to give: a request
          // that needs one is denied. The sandbox stays the account's own
          // policy; the host claims no containment (docs/task-host.md).
          '-c', 'approval_policy="never"',
          // The outbox is writable even under a sandboxed account policy.
          '--add-dir', resultDir,
          '-c', `projects={'${trustRoot}'={trust_level="trusted"}}`,
          pointerPrompt(promptFile),
        ],
        cwd: worktree,
        initialTurnSubmitted: true,
        initialInputDigest: pointerDigest(promptFile),
      };
      const providerVersion = runVersion ? await probeCodexVersion(spec, runVersion) : null;
      if (qualifiedVersion && providerVersion === null) throw adapterError('provider-version-unknown');
      if (qualifiedVersion && providerVersion !== qualifiedVersion) throw adapterError('provider-version-changed');
      return { spec, providerVersion };
    },
  };
}

module.exports = {
  CODEX_ADAPTER_CONTRACT,
  createCodexAdapter,
  createFixtureAdapter,
  createResultFrame,
  parseResultFrame,
  pointerDigest,
  pointerPrompt,
  readResultFile,
  renderPromptFile,
};
