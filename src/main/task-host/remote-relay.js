// Controller side of an unattended remote start (W2b).
//
// One task request, one launch transmission. The controller checks the
// target through Matrix, records a private attempt checkpoint, mints a
// 60-second authorization from a fresh sample of the target host's clock,
// and sends the request body once over Matrix's bounded stdin carrier. An
// answer that does not settle the outcome is reconciled by reading the same
// launch ID's status, never by minting another authorization or launch ID.
//
// Matrix owns the transport (route, SSH, timeouts); this module only builds
// its argv from a private binding and reads its structured observation.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { parseStrictJson } = require('./strict-json');
const { taskRequestDigest, validateTaskRequest } = require('./request');
const { MAX_REMOTE_BODY_BYTES } = require('./remote-adapter');

const BINDING_KIND = 'agent-orchestrator.remote-binding';
const ATTEMPT_KIND = 'agent-orchestrator.remote-attempt';
const MATRIX_TIMEOUT_SECONDS = 20;
const MATRIX_OUTPUT_BYTES = 65_536;
const OUTER_DEADLINE_MS = 30_000;
const MAX_OBSERVATION_BYTES = 512 * 1024;
const MAX_SAMPLE_AGE_MS = 5_000;
const AUTHORIZATION_MS = 60_000;
const CLOCK_MARGIN_MS = 1_000;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/**
 * Refusals the target gives before it records anything: the launch did not
 * happen and a later deliberate attempt may be made. Any other answer that is
 * not a valid acknowledgement leaves acceptance unknown.
 */
const PRE_ADMISSION_REFUSALS = new Set([
  // host policy and authorization
  'remote-starts-disabled', 'wrong-destination', 'digest-mismatch', 'invalid-authorization',
  'authorization-expired', 'session-owner-mismatch', 'process-ownership-unavailable',
  // host admission
  'host-closing', 'host-suspending', 'battery-disallowed', 'power-state-unknown',
  'session-state-unknown', 'session-not-interactive', 'provider-unavailable', 'provider-unqualified',
  'provider-session-unqualified', 'unknown-workspace', 'workspace-trust-not-granted',
  'workspace-busy', 'host-busy', 'daily-limit-reached', 'launch-id-conflict',
  // the target adapter, before it wrote anything to the ingress
  'host-unavailable', 'invalid-arguments', 'unknown-op', 'body-incomplete', 'body-too-large',
  'body-unreadable', 'invalid-utf8', 'invalid-json', 'duplicate-key', 'invalid-body',
  'invalid-digest', 'request-too-large',
]);

class RelayError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function absolute(value) {
  return typeof value === 'string' && path.isAbsolute(value);
}

/**
 * The owner's private application binding over Matrix: which Matrix to run,
 * which node and named workspace hold the target's agent-orchestrator
 * checkout, and the destination hostId enrolled for it. No SSH argv, address,
 * credential or token.
 */
function loadBinding(file, { readFile = fs.readFileSync } = {}) {
  let raw;
  try {
    raw = parseStrictJson(readFile(file, 'utf8'));
  } catch (_error) {
    throw new RelayError('invalid-binding');
  }
  const allowed = ['schema', 'kind', 'matrix', 'hostsFile', 'node', 'workspace', 'hostId', 'dataDir'];
  if (
    !raw || raw.schema !== 1 || raw.kind !== BINDING_KIND ||
    Object.keys(raw).some(key => !allowed.includes(key)) ||
    !Array.isArray(raw.matrix) || raw.matrix.length < 1 || raw.matrix.length > 4 ||
    !absolute(raw.matrix[0]) || raw.matrix.some(part => typeof part !== 'string' || !part) ||
    (raw.hostsFile !== undefined && !absolute(raw.hostsFile)) ||
    !LABEL.test(raw.node || '') || !LABEL.test(raw.workspace || '') || !LABEL.test(raw.hostId || '') ||
    (raw.dataDir !== undefined && typeof raw.dataDir !== 'string')
  ) {
    throw new RelayError('invalid-binding');
  }
  return raw;
}

/** The Matrix argv for one target-client operation. */
function matrixArgv(binding, clientArgs, { stdin = false } = {}) {
  return [
    ...binding.matrix,
    'remote',
    ...(binding.hostsFile ? ['--hosts', binding.hostsFile] : []),
    'exec', binding.node,
    '--cwd', binding.workspace,
    '--json',
    '--timeout', String(MATRIX_TIMEOUT_SECONDS),
    '--max-output-bytes', String(MATRIX_OUTPUT_BYTES),
    ...(stdin ? ['--stdin-file', '-'] : []),
    '--',
    'node', 'scripts/task-host-client.mjs',
    ...clientArgs,
    ...(binding.dataDir ? ['--data-dir', binding.dataDir] : []),
  ];
}

/**
 * Run Matrix once with an argument array (no shell), feeding `input` bytes
 * when given. Resolves `{ started, stdout }`; `started: false` means no
 * transport process was created.
 */
function runMatrix(argv, { input = null, deadlineMs = OUTER_DEADLINE_MS } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), {
        stdio: [input ? 'pipe' : 'ignore', 'pipe', 'ignore'],
        windowsHide: true,
        shell: false,
      });
    } catch (_error) {
      resolve({ started: false, stdout: null });
      return;
    }
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch (_error) { /* already gone */ }
      finish({ started: true, stdout: null });
    }, deadlineMs);
    child.on('error', () => finish({ started: false, stdout: null }));
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size <= MAX_OBSERVATION_BYTES) chunks.push(chunk);
    });
    child.on('close', () => finish({
      started: true,
      stdout: size <= MAX_OBSERVATION_BYTES ? Buffer.concat(chunks, size) : null,
    }));
    if (input) {
      child.stdin.on('error', () => { /* the transport closed early; judged by its observation */ });
      child.stdin.end(input);
    }
  });
}

/**
 * Read Matrix's observation and the target client's one JSON answer.
 * Returns `{ answer }`, or `{ uncertain: reason }` when the call cannot be
 * read as a complete answer from the target client.
 */
function readObservation(run) {
  if (!run.started) return { notStarted: true };
  if (!run.stdout) return { uncertain: 'transport-unreadable' };
  let observation;
  try {
    observation = parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(run.stdout).trim());
  } catch (_error) {
    return { uncertain: 'transport-unreadable' };
  }
  if (!observation || observation.schema !== 1 || typeof observation.status !== 'string') {
    return { uncertain: 'transport-unreadable' };
  }
  if (observation.status !== 'exited' || !Number.isInteger(observation.child_exit)) {
    return { uncertain: `transport-${observation.status}` };
  }
  if (observation.stdout_truncated !== false || typeof observation.stdout !== 'string') {
    return { uncertain: 'answer-truncated' };
  }
  let answer;
  try {
    answer = parseStrictJson(observation.stdout.trim());
  } catch (_error) {
    return { uncertain: 'answer-unreadable' };
  }
  if (!answer || typeof answer !== 'object' || Array.isArray(answer) || typeof answer.ok !== 'boolean') {
    return { uncertain: 'answer-unreadable' };
  }
  return { answer };
}

function attemptFile(dir, launchId) {
  return path.join(dir, `${launchId}.json`);
}

function writeAttempt(dir, record, { exclusive = false } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = attemptFile(dir, record.launchId);
  const text = `${JSON.stringify({ schema: 1, kind: ATTEMPT_KIND, ...record }, null, 2)}\n`;
  if (exclusive) {
    fs.writeFileSync(file, text, { flag: 'wx' });
    return;
  }
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, text);
  fs.renameSync(temp, file);
}

/**
 * Ask the local Matrix whether `remote exec` can carry a body, from its own
 * help text. Nothing reaches the target. A Matrix without `--stdin-file` would
 * reject the argument before SSH starts, which the observation alone could not
 * tell apart from a lost answer, so it is refused here as never sent.
 */
async function transportCarriesBody(binding, { run }) {
  const help = await run([...binding.matrix, 'remote', 'exec', '--help']);
  if (!help.started || !help.stdout) return false;
  return /(^|\s)--stdin-file(\s|$)/m.test(help.stdout.toString('utf8'));
}

/** Read the target's capabilities with a timed clock sample. */
async function sample(binding, { run, monotonic }) {
  const m0 = monotonic();
  const read = readObservation(await run(matrixArgv(binding, ['capabilities'])));
  const m1 = monotonic();
  if (read.notStarted) return { refusal: 'matrix-unavailable' };
  if (read.uncertain) return { refusal: 'preflight-unavailable' };
  const caps = read.answer;
  if (!caps.ok) return { refusal: typeof caps.error === 'string' ? caps.error : 'preflight-unavailable' };
  if (caps.policy?.hostId !== binding.hostId) return { refusal: 'wrong-destination' };
  if (!ISO.test(caps.observedAt || '') || m1 - m0 > MAX_SAMPLE_AGE_MS) return { refusal: 'clock-sample-unavailable' };
  return { caps, hostTime: Date.parse(caps.observedAt), sampledAt: m1 };
}

/** Advisory preflight: refuse locally what the host would certainly refuse. */
function preflightRefusal(caps, request) {
  if (caps.policy?.remoteStarts !== 'enabled') return 'remote-starts-disabled';
  if (caps.admission !== 'open') return 'host-closing';
  if (caps.power !== 'ac') return caps.power === 'battery' ? 'battery-disallowed' : 'power-state-unknown';
  const provider = Array.isArray(caps.providers) ? caps.providers.find(p => p?.provider === request.provider) : null;
  if (!provider) return 'provider-unavailable';
  if (!provider.admitted) return 'provider-unqualified';
  if (caps.session === 'locked' && !provider.lockedSession) return 'provider-session-unqualified';
  if (caps.session !== 'unlocked' && caps.session !== 'locked') return 'session-state-unknown';
  if (!Array.isArray(caps.workspaces) || !caps.workspaces.includes(request.workspace)) return 'unknown-workspace';
  return null;
}

/** Mint from the target clock: never later than the target's now, 60 s long. */
function mintAuthorization({ hostTime, sampledAt, now, destination, digest }) {
  const issued = hostTime + Math.floor(now - sampledAt) - CLOCK_MARGIN_MS;
  return {
    destination,
    requestDigest: digest,
    issuedAt: new Date(issued).toISOString(),
    expiresAt: new Date(issued + AUTHORIZATION_MS).toISOString(),
  };
}

/** One status read for reconciliation. */
async function remoteStatus(binding, launchId, { run = runMatrix } = {}) {
  const read = readObservation(await run(matrixArgv(binding, ['status', '--launch', launchId])));
  if (read.notStarted) return { outcome: 'unavailable', reason: 'matrix-unavailable' };
  if (read.uncertain) return { outcome: 'unavailable', reason: read.uncertain };
  return { outcome: 'answer', answer: read.answer };
}

async function remoteList(binding, { run = runMatrix, origin = 'remote', limit = 64 } = {}) {
  const read = readObservation(await run(matrixArgv(binding, ['list', '--origin', origin, '--limit', String(limit)])));
  if (read.notStarted) return { outcome: 'unavailable', reason: 'matrix-unavailable' };
  if (read.uncertain) return { outcome: 'unavailable', reason: read.uncertain };
  return { outcome: 'answer', answer: read.answer };
}

/**
 * Classify a remote-start answer. `accepted` needs a valid acknowledgement
 * for this launch; `refused` only a known pre-admission code; everything else
 * leaves acceptance `unknown`.
 */
function classifyStart(read, launchId) {
  if (read.notStarted) return { outcome: 'not-sent', reason: 'matrix-unavailable' };
  if (read.uncertain) return { outcome: 'unknown', reason: read.uncertain };
  const answer = read.answer;
  if (answer.ok) {
    if (answer.launchId === launchId) return { outcome: 'accepted', duplicate: answer.duplicate === true, state: answer.state };
    return { outcome: 'unknown', reason: 'acknowledgement-mismatch' };
  }
  if (typeof answer.error === 'string' && PRE_ADMISSION_REFUSALS.has(answer.error)) {
    return { outcome: 'refused', reason: answer.error };
  }
  return { outcome: 'unknown', reason: typeof answer.error === 'string' ? answer.error : 'answer-unreadable' };
}

/**
 * Start one task on the bound target. Returns
 * `{ outcome: 'accepted'|'refused'|'unknown'|'not-sent', reason?, launchId }`.
 */
async function startRemote({
  binding, request: rawRequest, attemptsDir,
  run = runMatrix, monotonic = () => performance.now(),
}) {
  let request;
  try {
    request = validateTaskRequest(rawRequest);
  } catch (error) {
    return { outcome: 'not-sent', reason: typeof error.code === 'string' ? error.code : 'invalid-request' };
  }
  const digest = taskRequestDigest(request);
  const { launchId } = request;
  const result = (outcome, extra = {}) => ({ outcome, launchId, ...extra });

  if (fs.existsSync(attemptFile(attemptsDir, launchId))) {
    // A launch ID is sent at most once. Reconcile it with `status` instead.
    return result('not-sent', { reason: 'attempt-exists' });
  }
  if (!await transportCarriesBody(binding, { run })) return result('not-sent', { reason: 'matrix-lacks-body-input' });
  const first = await sample(binding, { run, monotonic });
  if (first.refusal) return result('not-sent', { reason: first.refusal });
  const local = preflightRefusal(first.caps, request);
  if (local) return result('not-sent', { reason: local });

  // Checkpoint before anything that could reach the target with a body.
  try {
    writeAttempt(attemptsDir, {
      launchId, requestDigest: digest, destination: binding.hostId, node: binding.node,
      state: 'dispatching', recordedAt: new Date().toISOString(),
    }, { exclusive: true });
  } catch (_error) {
    return result('not-sent', { reason: 'attempt-exists' });
  }
  const settle = (outcome, extra = {}) => {
    writeAttempt(attemptsDir, {
      launchId, requestDigest: digest, destination: binding.hostId, node: binding.node,
      state: outcome, reason: extra.reason ?? null, recordedAt: new Date().toISOString(),
    });
    return result(outcome, extra);
  };

  const now = monotonic();
  if (now - first.sampledAt > MAX_SAMPLE_AGE_MS) return settle('not-sent', { reason: 'clock-sample-unavailable' });
  const authorization = mintAuthorization({
    hostTime: first.hostTime, sampledAt: first.sampledAt, now, destination: binding.hostId, digest,
  });
  const body = Buffer.from(JSON.stringify({ request, digest, authorization }), 'utf8');
  if (body.length > MAX_REMOTE_BODY_BYTES) return settle('not-sent', { reason: 'request-too-large' });

  const sent = classifyStart(readObservation(await run(matrixArgv(binding, ['remote-start', '--stdin'], { stdin: true }), { input: body })), launchId);
  if (sent.outcome !== 'unknown') return settle(sent.outcome, sent.outcome === 'accepted' ? { state: sent.state, duplicate: sent.duplicate } : { reason: sent.reason });

  // Acceptance unknown: read the same launch ID once. Only a matching record
  // settles it; not-found does not mean it never ran.
  const status = await remoteStatus(binding, launchId, { run });
  if (status.outcome === 'answer' && status.answer.ok) {
    if (status.answer.requestDigest !== digest) return settle('unknown', { reason: 'launch-id-conflict' });
    if (status.answer.hostId !== binding.hostId) return settle('unknown', { reason: 'wrong-destination' });
    return settle('accepted', { state: status.answer.state, reconciled: true });
  }
  return settle('unknown', { reason: sent.reason });
}

module.exports = {
  BINDING_KIND,
  PRE_ADMISSION_REFUSALS,
  RelayError,
  classifyStart,
  loadBinding,
  matrixArgv,
  mintAuthorization,
  preflightRefusal,
  readObservation,
  remoteList,
  remoteStatus,
  runMatrix,
  startRemote,
};
