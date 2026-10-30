// Typed task-launch requests and ingress envelopes.
//
// Every accepted shape is exact: unknown keys, wrong types, and oversize
// fields reject the whole message. No field names a path, an executable, an
// environment variable, or shell text.

const { createHash } = require('crypto');
const { canonicalJson } = require('./strict-json');

const TASK_REQUEST_SCHEMA = 1;
const TASK_REQUEST_KIND = 'agent-orchestrator.task-launch';
const MAX_REQUEST_BYTES = 128 * 1024;
const MAX_INSTRUCTION_CHARS = 64 * 1024;
const MAX_CHECKS = 8;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
// npm script names only; excludes every cmd.exe and PowerShell metacharacter.
const SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,63}$/;
// Instruction text may carry newlines and tabs, nothing else below U+0020.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

const REQUEST_KEYS = [
  'schema', 'kind', 'launchId', 'taskId', 'provider', 'route', 'workspace',
  'baseRevision', 'presentation', 'instruction', 'checks', 'gitEffects',
];

class TaskRequestError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, keys, code) {
  if (!isPlainObject(value)) throw new TaskRequestError(code);
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) {
    throw new TaskRequestError(code);
  }
}

function asLabel(value, code) {
  if (typeof value !== 'string' || !LABEL.test(value)) throw new TaskRequestError(code);
  return value;
}

function asLaunchId(value) {
  if (typeof value !== 'string' || !UUID_V4.test(value)) throw new TaskRequestError('invalid-launch-id');
  return value;
}

function validateTaskRequest(value) {
  exactKeys(value, REQUEST_KEYS, 'invalid-request-shape');
  if (value.schema !== TASK_REQUEST_SCHEMA) throw new TaskRequestError('unsupported-schema');
  if (value.kind !== TASK_REQUEST_KIND) throw new TaskRequestError('unsupported-kind');
  const instruction = value.instruction;
  if (
    typeof instruction !== 'string' || !instruction.trim() ||
    instruction.length > MAX_INSTRUCTION_CHARS || CONTROL.test(instruction)
  ) {
    throw new TaskRequestError('invalid-instruction');
  }
  if (typeof value.baseRevision !== 'string' || !COMMIT.test(value.baseRevision)) {
    throw new TaskRequestError('invalid-base-revision');
  }
  if (value.presentation !== 'task-window') throw new TaskRequestError('unsupported-presentation');
  if (value.gitEffects !== 'edits-only') throw new TaskRequestError('unsupported-git-effects');
  if (!Array.isArray(value.checks) || value.checks.length > MAX_CHECKS) {
    throw new TaskRequestError('invalid-checks');
  }
  const seen = new Set();
  const checks = value.checks.map((check) => {
    exactKeys(check, ['kind', 'name'], 'invalid-checks');
    if (check.kind !== 'npm-script') throw new TaskRequestError('unsupported-check-kind');
    if (typeof check.name !== 'string' || !SCRIPT_NAME.test(check.name) || seen.has(check.name)) {
      throw new TaskRequestError('invalid-checks');
    }
    seen.add(check.name);
    return { kind: check.kind, name: check.name };
  });
  return {
    schema: TASK_REQUEST_SCHEMA,
    kind: TASK_REQUEST_KIND,
    launchId: asLaunchId(value.launchId),
    taskId: asLabel(value.taskId, 'invalid-task-id'),
    provider: asLabel(value.provider, 'invalid-provider'),
    route: asLabel(value.route, 'invalid-route'),
    workspace: asLabel(value.workspace, 'invalid-workspace'),
    baseRevision: value.baseRevision,
    presentation: value.presentation,
    instruction,
    checks,
    gitEffects: value.gitEffects,
  };
}

function taskRequestDigest(request) {
  return createHash('sha256').update(canonicalJson(request), 'utf8').digest('hex');
}

const OP_KEYS = {
  capabilities: ['token', 'op'],
  start: ['token', 'op', 'request', 'digest'],
  status: ['token', 'op', 'launchId'],
  result: ['token', 'op', 'launchId'],
  diff: ['token', 'op', 'launchId'],
  stop: ['token', 'op', 'launchId'],
  show: ['token', 'op', 'launchId'],
};

/**
 * Validate an already token-checked envelope. Returns a normalized command;
 * throws TaskRequestError with a fixed code otherwise.
 */
function validateEnvelope(value) {
  if (!isPlainObject(value) || typeof value.op !== 'string' || !Object.hasOwn(OP_KEYS, value.op)) {
    throw new TaskRequestError('unknown-op');
  }
  exactKeys(value, OP_KEYS[value.op], 'invalid-envelope');
  if (value.op === 'capabilities') return { op: 'capabilities' };
  if (value.op === 'start') {
    if (typeof value.digest !== 'string' || !DIGEST.test(value.digest)) {
      throw new TaskRequestError('invalid-digest');
    }
    const request = validateTaskRequest(value.request);
    if (taskRequestDigest(request) !== value.digest) throw new TaskRequestError('digest-mismatch');
    return { op: 'start', request, digest: value.digest };
  }
  return { op: value.op, launchId: asLaunchId(value.launchId) };
}

module.exports = {
  MAX_CHECKS,
  MAX_INSTRUCTION_CHARS,
  MAX_REQUEST_BYTES,
  TASK_REQUEST_KIND,
  TASK_REQUEST_SCHEMA,
  TaskRequestError,
  taskRequestDigest,
  validateEnvelope,
  validateTaskRequest,
};
