// ============================================================
// Run Journal (main process)
//
// Durable, privacy-conscious execution history for workflow runs. The main
// process owns every journal identity, timestamp, revision, and event number.
// Renderer-provided workflow/result bodies are either encrypted independently
// or retained only in a bounded in-memory store; plaintext bodies are never
// written to disk.
// ============================================================
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  readJsonDir,
  readJsonStrict,
  writeJsonAtomic,
} = require('./store');
const { assessResumeEvidence } = require('./resume-evidence');
const { inspectResumeRun } = require('./resume-preflight');

const SCHEMA_VERSION = 2;
const LEGACY_SCHEMA_VERSION = 1;
const ENCRYPTED_ENVELOPE_VERSION = 1;
const CONTROL_CHECKPOINT_VERSION = 1;

const RUN_STATUS = Object.freeze({
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  INTERRUPTED: 'interrupted',
});
const RUN_TERMINAL_STATES = Object.freeze([
  RUN_STATUS.COMPLETED,
  RUN_STATUS.FAILED,
  RUN_STATUS.CANCELLED,
  RUN_STATUS.INTERRUPTED,
]);
const RUN_FINISH_STATES = Object.freeze([
  RUN_STATUS.COMPLETED,
  RUN_STATUS.FAILED,
  RUN_STATUS.CANCELLED,
]);

const BLOCK_STATUS = Object.freeze({
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  INTERRUPTED: 'interrupted',
});
const BLOCK_TERMINAL_STATES = Object.freeze([
  BLOCK_STATUS.COMPLETED,
  BLOCK_STATUS.FAILED,
  BLOCK_STATUS.CANCELLED,
  BLOCK_STATUS.INTERRUPTED,
]);
const BLOCK_FINISH_STATES = Object.freeze([
  BLOCK_STATUS.COMPLETED,
  BLOCK_STATUS.FAILED,
  BLOCK_STATUS.CANCELLED,
]);

const RESULT_STATUS = Object.freeze({
  COMPLETE: 'complete',
  PARTIAL: 'partial',
});
const STORAGE = Object.freeze({
  ENCRYPTED: 'encrypted',
  MEMORY: 'memory',
});
const BOUNDARY_DISPOSITION = Object.freeze({
  ABORT: 'abort',
  SKIP: 'skip',
  RETRY: 'retry',
});

/** Renderer result protocol limits, exported so the IPC layer can agree. */
const MAX_RESULT_BYTES_PER_LANE = 32 * 1024;
const MAX_HANDOFF_BYTES = 128 * 1024;
/** One encrypted envelope may include framing/JSON overhead above handoff text. */
const MAX_RESULT_BYTES = 256 * 1024;
/** Aggregate plaintext result bodies retained by one run. */
const MAX_RUN_RESULT_BYTES = 1024 * 1024;
const MAX_WORKFLOW_BYTES = 4 * 1024 * 1024;
const MAX_CONTROL_CHECKPOINT_BYTES = 256 * 1024;

const MAX_MEMORY_BYTES = 8 * 1024 * 1024;
// One workflow body + every operation proof + every result body must fit when
// OS encryption is unavailable. Keep this above the logical record maxima so
// the byte budget, not an inconsistent entry count, is the fallback limit.
const MAX_MEMORY_ENTRIES = 32 * 1024;
// safeStorage returns binary ciphertext which the Electron adapter base64
// encodes. The protected envelope also JSON-escapes its body. A canonical
// workflow snapshot can approach 2x before base64; an arbitrary result body
// can approach 6x when it is made of C0 controls. These caps include that
// worst-case expansion plus generous room for the OS encryption envelope, so
// a valid maximum-size payload does not silently degrade to memory-only.
const MAX_WORKFLOW_CIPHERTEXT_BYTES = 16 * 1024 * 1024;
const MAX_RESULT_CIPHERTEXT_BYTES = 4 * 1024 * 1024;
const MAX_OPERATION_CIPHERTEXT_BYTES = 4096;
const MAX_CONTROL_CHECKPOINT_CIPHERTEXT_BYTES = 4 * 1024 * 1024;
// A record is preflighted with the same pretty-printed representation used by
// writeJsonAtomic, and every read stops after this many bytes. This shared
// invariant prevents either malformed files or schema-valid metadata growth
// from creating an unbounded allocation or a write-once/read-never record.
const MAX_RUN_RECORD_BYTES = 64 * 1024 * 1024;
// The metadata index is a rebuildable cache, never the source of truth. It is
// deliberately separate from run records so a page can be served without
// parsing every protected record again.
const RUN_INDEX_SCHEMA_VERSION = 2;
const RUN_INDEX_DIRECTORY = '.index';
const RUN_INDEX_FILE = 'runs-v2.json';
const RUN_INDEX_DIRTY_FILE = 'dirty-v2.json';
const LEGACY_RUN_INDEX_FILES = Object.freeze(['runs-v1.json', 'dirty-v1.json']);
const RETENTION_DIRECTORY = '.retention';
const RETENTION_TRANSACTION_FILE = 'prune-v1.json';
const RETENTION_RECEIPTS_FILE = 'receipts-v1.json';
const DELETE_TRANSACTION_FILE = 'delete-v1.json';
const RETENTION_TRANSACTION_SCHEMA_VERSION = 1;
const MIGRATION_DIRECTORY = '.migration';
const V1_MIGRATION_DIRECTORY = 'v1';
const MAX_RUN_INDEX_BYTES = 128 * 1024 * 1024;
const MAX_RETENTION_TRANSACTION_BYTES = 64 * 1024 * 1024;
const MAX_RETENTION_RECEIPTS_BYTES = 1024 * 1024;
const MAX_RETENTION_RECEIPTS = 128;
const MAX_RUN_INDEX_ENTRIES = 250_000;
const MAX_RETENTION_RUNS = 1_000_000;
const MAX_RETENTION_AGE_DAYS = 36_500;
const RETENTION_PREVIEW_TTL_MS = 10 * 60 * 1000;
const MAX_BLOCK_VISITS = 10_000;
const MAX_RESULTS = 4096;
const MAX_OPERATIONS = 25_000;
const MAX_EVENTS = 25_000;
const MAX_LANES = 128;
const MAX_ITERATION_DEPTH = 32;
const MAX_BOUNDARY_REVIEWS = 1024;
const TERMINAL_CAPACITY_TIMESTAMP = '9999-12-31T23:59:59.999Z';
const TERMINAL_CAPACITY_OP_ID = 'x'.repeat(256);
const TERMINAL_CAPACITY_CIPHERTEXT = 'A'.repeat(MAX_OPERATION_CIPHERTEXT_BYTES);
// Worst-case truncation reason reserved by the terminal projection so the
// one-time truncated marker can always be written to an active record.
const TERMINAL_CAPACITY_REASON = 'x'.repeat(128);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PUBLIC_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const OP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,512}$/;
const PREVIEW_TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ASSURANCE_VALUES = new Set(['L1-routed', 'L2-env', 'L0-native']);
const RUN_STATUS_VALUES = new Set(Object.values(RUN_STATUS));
const RUN_TERMINAL_VALUES = new Set(RUN_TERMINAL_STATES);
const RUN_FINISH_VALUES = new Set(RUN_FINISH_STATES);
const BLOCK_STATUS_VALUES = new Set(Object.values(BLOCK_STATUS));
const BLOCK_TERMINAL_VALUES = new Set(BLOCK_TERMINAL_STATES);
const BLOCK_FINISH_VALUES = new Set(BLOCK_FINISH_STATES);
const RESULT_STATUS_VALUES = new Set(Object.values(RESULT_STATUS));
const BOUNDARY_DISPOSITION_VALUES = new Set(Object.values(BOUNDARY_DISPOSITION));
const RETENTION_TRANSACTION_STATUS = Object.freeze({
  PREPARED: 'prepared',
  APPLYING: 'applying',
  COMMITTED: 'committed',
  ABORTED: 'aborted',
});
const DELETE_TRANSACTION_STATUS = Object.freeze({
  APPLYING: 'applying',
  COMMITTED: 'committed',
});
const OPERATION_ACTIONS = new Set([
  'start-run',
  'start-block',
  'finish-block',
  'store-result',
  'finish-run',
  'store-control-checkpoint',
  'record-boundary-disposition',
]);
const EVENT_TYPES = new Set([
  'run.started',
  'block.started',
  'block.finished',
  'result.stored',
  'run.finished',
  'run.interrupted',
  'control.checkpoint-stored',
  'boundary.disposition-recorded',
]);

class RunJournalError extends Error {
  constructor(message, code = 'run-journal-error') {
    super(message);
    this.name = 'RunJournalError';
    this.code = code;
  }
}

/**
 * Tag a capacity failure that should degrade an active run to a truncated
 * journal instead of failing the workflow mid-run. `journalCapacity` names
 * the exhausted budget and becomes the recorded truncation reason.
 */
function capacityError(message, capacity) {
  const error = new RunJournalError(message, 'size-limit');
  error.journalCapacity = capacity;
  return error;
}

class BoundedMemoryStore {
  constructor({ maxBytes = MAX_MEMORY_BYTES, maxEntries = MAX_MEMORY_ENTRIES } = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new RunJournalError('memoryMaxBytes must be a positive safe integer', 'invalid-input');
    }
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new RunJournalError('memoryMaxEntries must be a positive safe integer', 'invalid-input');
    }
    this.maxBytes = maxBytes;
    this.maxEntries = maxEntries;
    this.bytes = 0;
    this.entries = new Map();
  }

  set(key, value) {
    if (typeof key !== 'string' || typeof value !== 'string') {
      throw new RunJournalError('Memory journal entries must be string keyed text', 'invalid-input');
    }
    if (!this.canSet(key, value)) {
      throw new RunJournalError(
        'Run Journal memory-only storage is full; no plaintext was persisted',
        'memory-capacity'
      );
    }
    const bytes = utf8ByteLength(value);
    const previous = this.entries.get(key);
    const nextBytes = this.bytes - (previous?.bytes || 0) + bytes;
    this.entries.set(key, { value, bytes });
    this.bytes = nextBytes;
  }

  canSet(key, value) {
    if (typeof key !== 'string' || typeof value !== 'string') return false;
    const bytes = utf8ByteLength(value);
    const previous = this.entries.get(key);
    const nextBytes = this.bytes - (previous?.bytes || 0) + bytes;
    const nextEntries = this.entries.size + (previous ? 0 : 1);
    return nextBytes <= this.maxBytes && nextEntries <= this.maxEntries;
  }

  canSetAfterDeletingPrefixes(key, value, prefixes) {
    if (typeof key !== 'string' || typeof value !== 'string') return false;
    const removals = Array.isArray(prefixes) ? prefixes : [];
    let projectedBytes = this.bytes;
    let projectedEntries = this.entries.size;
    let existing = this.entries.get(key);
    for (const [entryKey, entry] of this.entries) {
      if (!removals.some(prefix => entryKey.startsWith(prefix))) continue;
      projectedBytes -= entry.bytes;
      projectedEntries -= 1;
      if (entryKey === key) existing = undefined;
    }
    projectedBytes = projectedBytes - (existing?.bytes || 0) + utf8ByteLength(value);
    projectedEntries += existing ? 0 : 1;
    return projectedBytes <= this.maxBytes && projectedEntries <= this.maxEntries;
  }

  get(key) {
    return this.entries.get(key)?.value;
  }

  delete(key) {
    const previous = this.entries.get(key);
    if (!previous) return false;
    this.entries.delete(key);
    this.bytes -= previous.bytes;
    return true;
  }

  deletePrefix(prefix) {
    const removed = [];
    for (const key of [...this.entries.keys()]) {
      if (!key.startsWith(prefix)) continue;
      const entry = this.entries.get(key);
      removed.push({ key, value: entry.value });
      this.delete(key);
    }
    return removed;
  }

  hasPrefix(prefix) {
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  }

  restore(removed) {
    if (!Array.isArray(removed)) return;
    for (const entry of removed) {
      if (!entry || typeof entry.key !== 'string' || typeof entry.value !== 'string') {
        throw new RunJournalError('Invalid memory rollback entry', 'memory-rollback-failed');
      }
      this.set(entry.key, entry.value);
    }
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function asObject(value, what) {
  if (!isPlainObject(value)) {
    throw new RunJournalError(`${what} must be an object`, 'invalid-input');
  }
  return value;
}

function assertOnlyKeys(value, allowed, what) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new RunJournalError(
        `${what} contains unsupported field "${key}"`,
        'invalid-input'
      );
    }
  }
}

function utf8ByteLength(value) {
  return Buffer.byteLength(String(value), 'utf8');
}

function asText(value, what, {
  maxBytes,
  minBytes = 1,
  trim = false,
  controls = false,
  pattern = null,
} = {}) {
  if (typeof value !== 'string') {
    throw new RunJournalError(`${what} must be a string`, 'invalid-input');
  }
  const text = trim ? value.trim() : value;
  const bytes = utf8ByteLength(text);
  if (bytes < minBytes || (maxBytes !== undefined && bytes > maxBytes)) {
    const range = maxBytes === undefined
      ? `at least ${minBytes}`
      : `${minBytes}-${maxBytes}`;
    throw new RunJournalError(
      `${what} must be ${range} UTF-8 bytes`,
      'size-limit'
    );
  }
  if (!controls && /[\u0000-\u001f\u007f]/.test(text)) {
    throw new RunJournalError(`${what} contains control characters`, 'invalid-input');
  }
  if (pattern && !pattern.test(text)) {
    throw new RunJournalError(`${what} has an invalid format`, 'invalid-input');
  }
  return text;
}

function asPublicId(value, what = 'id') {
  return asText(value, what, {
    maxBytes: 128,
    trim: true,
    pattern: PUBLIC_ID_PATTERN,
  });
}

function asOptionalPublicId(value, what = 'id') {
  if (value === undefined || value === null || value === '') return null;
  return asPublicId(value, what);
}

function asRunId(value, what = 'runId') {
  return asText(value, what, {
    maxBytes: 36,
    trim: true,
    pattern: UUID_PATTERN,
  }).toLowerCase();
}

function asOpId(value) {
  return asText(value, 'opId', {
    maxBytes: 256,
    trim: true,
    pattern: OP_ID_PATTERN,
  });
}

function asSlug(value, what, { optional = false } = {}) {
  if (optional && (value === undefined || value === null || value === '')) return null;
  return asText(value, what, {
    maxBytes: 128,
    trim: true,
    pattern: SLUG_PATTERN,
  });
}

function asNonNegativeInt(value, what, { max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new RunJournalError(
      `${what} must be an integer from 0 to ${max}`,
      'invalid-input'
    );
  }
  return value;
}

function asPositiveInt(value, what, { max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new RunJournalError(
      `${what} must be an integer from 1 to ${max}`,
      'invalid-input'
    );
  }
  return value;
}

function stableJson(value, what = 'value') {
  const seen = new Set();

  function encode(entry, location) {
    if (entry === null) return 'null';
    switch (typeof entry) {
      case 'string':
      case 'boolean':
        return JSON.stringify(entry);
      case 'number':
        if (!Number.isFinite(entry)) {
          throw new RunJournalError(`${location} contains a non-finite number`, 'invalid-input');
        }
        return JSON.stringify(entry);
      case 'object': {
        if (seen.has(entry)) {
          throw new RunJournalError(`${location} contains a cycle`, 'invalid-input');
        }
        if (!Array.isArray(entry) && !isPlainObject(entry)) {
          throw new RunJournalError(`${location} must contain JSON data only`, 'invalid-input');
        }
        seen.add(entry);
        let encoded;
        if (Array.isArray(entry)) {
          encoded = `[${entry.map((item, index) => {
            if (item === undefined) {
              throw new RunJournalError(
                `${location}[${index}] cannot be undefined`,
                'invalid-input'
              );
            }
            return encode(item, `${location}[${index}]`);
          }).join(',')}]`;
        } else {
          const fields = [];
          for (const key of Object.keys(entry).sort()) {
            const item = entry[key];
            if (item === undefined) {
              throw new RunJournalError(
                `${location}.${key} cannot be undefined`,
                'invalid-input'
              );
            }
            fields.push(`${JSON.stringify(key)}:${encode(item, `${location}.${key}`)}`);
          }
          encoded = `{${fields.join(',')}}`;
        }
        seen.delete(entry);
        return encoded;
      }
      default:
        throw new RunJournalError(`${location} must contain JSON data only`, 'invalid-input');
    }
  }

  return encode(value, what);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function isRetentionPending(transaction) {
  return transaction?.status === RETENTION_TRANSACTION_STATUS.PREPARED
    || transaction?.status === RETENTION_TRANSACTION_STATUS.APPLYING;
}

function isRetentionTerminal(transaction) {
  return transaction?.status === RETENTION_TRANSACTION_STATUS.COMMITTED
    || transaction?.status === RETENTION_TRANSACTION_STATUS.ABORTED;
}

function deterministicUuid(value) {
  const digest = sha256(value);
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `4${digest.slice(13, 16)}`,
    `8${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join('-');
}

function normalizeEncryptionContext(context) {
  const raw = asObject(context, 'encryption context');
  if (raw.kind === 'workflow') {
    assertOnlyKeys(raw, new Set(['kind', 'runId']), 'workflow encryption context');
    return { kind: 'workflow', runId: asRunId(raw.runId) };
  }
  if (raw.kind === 'result') {
    assertOnlyKeys(
      raw,
      new Set(['kind', 'runId', 'resultId']),
      'result encryption context'
    );
    return {
      kind: 'result',
      runId: asRunId(raw.runId),
      resultId: asRunId(raw.resultId, 'resultId'),
    };
  }
  if (raw.kind === 'operation') {
    assertOnlyKeys(
      raw,
      new Set(['kind', 'runId', 'opId']),
      'operation encryption context'
    );
    return {
      kind: 'operation',
      runId: asRunId(raw.runId),
      opId: asOpId(raw.opId),
    };
  }
  if (raw.kind === 'control-checkpoint') {
    assertOnlyKeys(
      raw,
      new Set(['kind', 'runId', 'visitId', 'sourceRevision', 'checkpointId']),
      'control checkpoint encryption context'
    );
    return {
      kind: 'control-checkpoint',
      runId: asRunId(raw.runId),
      visitId: asRunId(raw.visitId, 'visitId'),
      sourceRevision: asPositiveInt(raw.sourceRevision, 'sourceRevision'),
      checkpointId: asRunId(raw.checkpointId, 'checkpointId'),
    };
  }
  throw new RunJournalError('Encryption context kind is invalid', 'invalid-input');
}

/**
 * Put binding metadata inside the encrypted bytes. Electron safeStorage does
 * not accept associated data, so passing context to the adapter alone cannot
 * detect ciphertext copied between records.
 */
function encodeEncryptedEnvelope(plaintext, context) {
  if (typeof plaintext !== 'string') {
    throw new RunJournalError('Encrypted envelope body must be text', 'invalid-input');
  }
  return stableJson({
    version: ENCRYPTED_ENVELOPE_VERSION,
    context: normalizeEncryptionContext(context),
    body: plaintext,
  }, 'encrypted envelope');
}

function decodeEncryptedEnvelope(serialized, expectedContext) {
  if (typeof serialized !== 'string') {
    throw new RunJournalError('Decrypted envelope must be text', 'decrypt-failed');
  }
  let envelope;
  try {
    envelope = JSON.parse(serialized);
  } catch (_error) {
    throw new RunJournalError('Decrypted envelope is invalid', 'decrypt-failed');
  }
  try {
    asObject(envelope, 'encrypted envelope');
    assertOnlyKeys(
      envelope,
      new Set(['version', 'context', 'body']),
      'encrypted envelope'
    );
    if (envelope.version !== ENCRYPTED_ENVELOPE_VERSION) {
      throw new RunJournalError('Encrypted envelope version is unsupported', 'decrypt-failed');
    }
    if (typeof envelope.body !== 'string') {
      throw new RunJournalError('Encrypted envelope body is invalid', 'decrypt-failed');
    }
    const actual = normalizeEncryptionContext(envelope.context);
    const expected = normalizeEncryptionContext(expectedContext);
    if (stableJson(actual) !== stableJson(expected)) {
      throw new RunJournalError('Encrypted envelope context does not match', 'context-mismatch');
    }
    return envelope.body;
  } catch (error) {
    if (error instanceof RunJournalError) throw error;
    throw new RunJournalError('Decrypted envelope is invalid', 'decrypt-failed');
  }
}

function normalizeWorkflowSnapshot(workflow) {
  asObject(workflow, 'workflow');
  const id = asPublicId(workflow.id, 'workflow.id');
  const name = asText(workflow.name, 'workflow.name', {
    maxBytes: 512,
    trim: true,
  });
  const formatVersion = asNonNegativeInt(
    workflow.formatVersion,
    'workflow.formatVersion',
    { max: 1_000_000 }
  );
  if (!Array.isArray(workflow.blocks)) {
    throw new RunJournalError('workflow.blocks must be an array', 'invalid-input');
  }
  if (workflow.blocks.length > MAX_BLOCK_VISITS) {
    throw new RunJournalError(
      `workflow.blocks exceeds ${MAX_BLOCK_VISITS} entries`,
      'size-limit'
    );
  }

  const plaintext = stableJson(workflow, 'workflow');
  const byteLength = utf8ByteLength(plaintext);
  if (byteLength > MAX_WORKFLOW_BYTES) {
    throw new RunJournalError(
      `Workflow snapshot is ${byteLength} UTF-8 bytes; the limit is ${MAX_WORKFLOW_BYTES}`,
      'size-limit'
    );
  }
  return {
    plaintext,
    byteLength,
    metadata: {
      id,
      name,
      formatVersion,
      blockCount: workflow.blocks.length,
    },
  };
}

function normalizeTrigger(trigger = { kind: 'manual' }) {
  const raw = trigger === undefined || trigger === null
    ? { kind: 'manual' }
    : asObject(trigger, 'trigger');
  assertOnlyKeys(raw, new Set(['kind', 'scheduledFor']), 'trigger');
  const kind = asSlug(raw.kind ?? 'manual', 'trigger.kind');
  const normalized = { kind };
  if (raw.scheduledFor !== undefined && raw.scheduledFor !== null) {
    if (typeof raw.scheduledFor !== 'string') {
      throw new RunJournalError('trigger.scheduledFor must be an ISO timestamp', 'invalid-input');
    }
    const parsed = new Date(raw.scheduledFor);
    if (!Number.isFinite(parsed.getTime())) {
      throw new RunJournalError('trigger.scheduledFor must be an ISO timestamp', 'invalid-input');
    }
    normalized.scheduledFor = parsed.toISOString();
  }
  return normalized;
}

function normalizeLaneDescriptors(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new RunJournalError('lanes must be an array', 'invalid-input');
  }
  if (value.length > MAX_LANES) {
    throw new RunJournalError(`lanes exceeds ${MAX_LANES} entries`, 'size-limit');
  }
  return value.map((entry, index) => {
    const lane = asObject(entry, `lanes[${index}]`);
    // Unknown fields (cwd, env, command, sessionId, etc.) are deliberately
    // discarded. Only identity already intended for public UI survives.
    const normalized = {};
    const laneId = asOptionalPublicId(lane.laneId, `lanes[${index}].laneId`);
    const profileId = asOptionalPublicId(lane.profileId, `lanes[${index}].profileId`);
    if (laneId) normalized.laneId = laneId;
    if (profileId) normalized.profileId = profileId;
    if (lane.agent !== undefined && lane.agent !== null && lane.agent !== '') {
      normalized.agent = asSlug(lane.agent, `lanes[${index}].agent`);
    }
    const displayValue = lane.displayName ?? lane.label;
    if (displayValue !== undefined && displayValue !== null && displayValue !== '') {
      normalized.displayName = asText(
        displayValue,
        `lanes[${index}].displayName`,
        { maxBytes: 512, trim: true }
      );
    }
    if (lane.assurance !== undefined && lane.assurance !== null && lane.assurance !== '') {
      if (!ASSURANCE_VALUES.has(lane.assurance)) {
        throw new RunJournalError(
          `lanes[${index}].assurance is not a public assurance level`,
          'invalid-input'
        );
      }
      normalized.assurance = lane.assurance;
    }
    if (Object.keys(normalized).length === 0) {
      throw new RunJournalError(
        `lanes[${index}] needs at least one public identity field`,
        'invalid-input'
      );
    }
    return normalized;
  });
}

function normalizeControlCheckpointState(value) {
  const raw = asObject(value, 'control checkpoint state');
  assertOnlyKeys(
    raw,
    new Set(['version', 'sessions', 'pendingLanes', 'pendingJoinBlockId']),
    'control checkpoint state'
  );
  if (raw.version !== CONTROL_CHECKPOINT_VERSION) {
    throw new RunJournalError('Control checkpoint version is unsupported', 'invalid-input');
  }
  if (!Array.isArray(raw.sessions) || raw.sessions.length > MAX_LANES) {
    throw new RunJournalError('Control checkpoint sessions are invalid', 'invalid-input');
  }
  const sessionRefs = new Set();
  const laneIds = new Set();
  const sessions = raw.sessions.map((entry, index) => {
    const session = asObject(entry, `control checkpoint sessions[${index}]`);
    assertOnlyKeys(
      session,
      new Set(['sessionRef', 'lane', 'resultInputCapable', 'outputSeq']),
      `control checkpoint sessions[${index}]`
    );
    const sessionRef = asPublicId(
      session.sessionRef,
      `control checkpoint sessions[${index}].sessionRef`
    );
    if (sessionRefs.has(sessionRef)) {
      throw new RunJournalError('Control checkpoint repeats a session reference', 'invalid-input');
    }
    sessionRefs.add(sessionRef);
    const laneInput = asObject(
      session.lane,
      `control checkpoint sessions[${index}].lane`
    );
    const lane = normalizeLaneDescriptors([laneInput])[0];
    if (stableJson(Object.keys(laneInput).sort()) !== stableJson(Object.keys(lane).sort())) {
      throw new RunJournalError(
        `control checkpoint sessions[${index}].lane contains non-public fields`,
        'invalid-input'
      );
    }
    if (lane.laneId) {
      if (laneIds.has(lane.laneId)) {
        throw new RunJournalError(
          'Control checkpoint repeats a lane id',
          'invalid-input'
        );
      }
      laneIds.add(lane.laneId);
    }
    if (typeof session.resultInputCapable !== 'boolean') {
      throw new RunJournalError(
        `control checkpoint sessions[${index}].resultInputCapable must be boolean`,
        'invalid-input'
      );
    }
    const outputSeq = session.outputSeq === null || session.outputSeq === undefined
      ? null
      : asNonNegativeInt(
          session.outputSeq,
          `control checkpoint sessions[${index}].outputSeq`
        );
    return {
      sessionRef,
      lane,
      resultInputCapable: session.resultInputCapable,
      outputSeq,
    };
  });
  if (!Array.isArray(raw.pendingLanes) || raw.pendingLanes.length > MAX_LANES) {
    throw new RunJournalError('Control checkpoint pending lanes are invalid', 'invalid-input');
  }
  const pendingLaneRefs = new Set();
  const pendingLanes = raw.pendingLanes.map((value, index) => {
    const sessionRef = asPublicId(
      value,
      `control checkpoint pendingLanes[${index}]`
    );
    if (!sessionRefs.has(sessionRef)) {
      throw new RunJournalError(
        'Control checkpoint pending lane references an unknown session',
        'invalid-input'
      );
    }
    if (pendingLaneRefs.has(sessionRef)) {
      throw new RunJournalError('Control checkpoint repeats a pending lane', 'invalid-input');
    }
    pendingLaneRefs.add(sessionRef);
    return sessionRef;
  });
  const pendingJoinBlockId = asOptionalPublicId(
    raw.pendingJoinBlockId,
    'control checkpoint pendingJoinBlockId'
  );
  const normalized = {
    version: CONTROL_CHECKPOINT_VERSION,
    sessions,
    pendingLanes,
    pendingJoinBlockId,
  };
  const plaintext = stableJson(normalized, 'control checkpoint state');
  const byteLength = utf8ByteLength(plaintext);
  if (byteLength > MAX_CONTROL_CHECKPOINT_BYTES) {
    throw new RunJournalError(
      `Control checkpoint is ${byteLength} UTF-8 bytes; the limit is ${MAX_CONTROL_CHECKPOINT_BYTES}`,
      'size-limit'
    );
  }
  return { state: normalized, plaintext, byteLength };
}

function normalizeIterationPath(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new RunJournalError('block.iterationPath must be an array', 'invalid-input');
  }
  if (value.length > MAX_ITERATION_DEPTH) {
    throw new RunJournalError(
      `block.iterationPath exceeds ${MAX_ITERATION_DEPTH} loop frames`,
      'size-limit'
    );
  }
  return value.map((entry, index) => {
    const frame = asObject(entry, `block.iterationPath[${index}]`);
    assertOnlyKeys(
      frame,
      new Set(['loopBlockId', 'iteration', 'total']),
      `block.iterationPath[${index}]`
    );
    const iteration = asPositiveInt(
      frame.iteration,
      `block.iterationPath[${index}].iteration`,
      { max: 1_000_000 }
    );
    const total = asPositiveInt(
      frame.total,
      `block.iterationPath[${index}].total`,
      { max: 1_000_000 }
    );
    if (iteration > total) {
      throw new RunJournalError(
        `block.iterationPath[${index}].iteration cannot exceed total`,
        'invalid-input'
      );
    }
    return {
      loopBlockId: asPublicId(
        frame.loopBlockId,
        `block.iterationPath[${index}].loopBlockId`
      ),
      iteration,
      total,
    };
  });
}

function normalizeBlockInput(input) {
  const nested = input.block;
  if (nested !== undefined) {
    if (
      input.blockId !== undefined
      || input.blockIndex !== undefined
      || input.blockType !== undefined
      || input.iterationPath !== undefined
    ) {
      throw new RunJournalError(
        'startBlock must use either block or flat block fields, not both',
        'invalid-input'
      );
    }
    const block = asObject(nested, 'block');
    assertOnlyKeys(block, new Set(['id', 'index', 'type', 'iterationPath']), 'block');
    return {
      blockId: asPublicId(block.id, 'block.id'),
      blockIndex: block.index === undefined || block.index === null
        ? null
        : asNonNegativeInt(block.index, 'block.index', { max: MAX_BLOCK_VISITS - 1 }),
      blockType: block.type === undefined || block.type === null || block.type === ''
        ? null
        : asSlug(block.type, 'block.type'),
      iterationPath: normalizeIterationPath(block.iterationPath),
    };
  }
  return {
    blockId: asPublicId(input.blockId, 'blockId'),
    blockIndex: input.blockIndex === undefined || input.blockIndex === null
      ? null
      : asNonNegativeInt(input.blockIndex, 'blockIndex', { max: MAX_BLOCK_VISITS - 1 }),
    blockType: input.blockType === undefined || input.blockType === null || input.blockType === ''
      ? null
      : asSlug(input.blockType, 'blockType'),
    iterationPath: normalizeIterationPath(input.iterationPath),
  };
}

function normalizeLanesFromInput(input) {
  if (input.lanes !== undefined && input.laneDescriptors !== undefined) {
    throw new RunJournalError(
      'Use lanes or laneDescriptors, not both',
      'invalid-input'
    );
  }
  return normalizeLaneDescriptors(input.lanes ?? input.laneDescriptors);
}

function isBoundedBase64(value, maxBytes) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length % 4 !== 0
    || value.length > maxBytes
  ) {
    return false;
  }

  let contentLength = value.length;
  if (value.endsWith('=')) contentLength -= 1;
  if (value.endsWith('==')) contentLength -= 1;
  for (let index = 0; index < contentLength; index++) {
    const code = value.charCodeAt(index);
    const valid = (
      (code >= 0x41 && code <= 0x5A)
      || (code >= 0x61 && code <= 0x7A)
      || (code >= 0x30 && code <= 0x39)
      || code === 0x2B
      || code === 0x2F
    );
    if (!valid) return false;
  }
  for (let index = contentLength; index < value.length; index++) {
    if (value[index] !== '=') return false;
  }
  return true;
}

function assertCiphertext(value, what, maxBytes) {
  if (!isBoundedBase64(value, maxBytes)) {
    throw new RunJournalError(
      `${what} did not return bounded base64 ciphertext`,
      'encryption-failed'
    );
  }
  return value;
}

function isIsoTimestamp(value) {
  if (typeof value !== 'string' || !ISO_PATTERN.test(value)) return false;
  return Number.isFinite(new Date(value).getTime());
}

function clonePublic(value) {
  return JSON.parse(JSON.stringify(value));
}

function publicResult(result) {
  return {
    id: result.id,
    producerBlockId: result.producerBlockId,
    visitId: result.visitId,
    name: result.name,
    status: result.status,
    lanes: clonePublic(result.lanes),
    createdAt: result.createdAt,
    byteLength: result.byteLength,
    storage: result.storage,
  };
}

function publicBlock(block) {
  return {
    visitId: block.visitId,
    blockId: block.blockId,
    blockIndex: block.blockIndex,
    blockType: block.blockType,
    iterationPath: clonePublic(block.iterationPath),
    lanes: clonePublic(block.lanes),
    status: block.status,
    startedAt: block.startedAt,
    finishedAt: block.finishedAt,
    reasonCode: block.reasonCode,
  };
}

function publicControlCheckpoint(checkpoint) {
  if (!checkpoint) return null;
  return {
    id: checkpoint.id,
    stateVersion: checkpoint.stateVersion,
    sourceRunId: checkpoint.sourceRunId,
    sourceRevision: checkpoint.sourceRevision,
    afterVisitId: checkpoint.afterVisitId,
    storage: checkpoint.storage,
    byteLength: checkpoint.byteLength,
    createdAt: checkpoint.createdAt,
  };
}

function publicBoundaryReview(review) {
  return {
    visitId: review.visitId,
    sourceRevision: review.sourceRevision,
    disposition: review.disposition,
    reviewedAt: review.reviewedAt,
  };
}

function publicEvent(event) {
  const out = {
    seq: event.seq,
    type: event.type,
    at: event.at,
  };
  for (const key of [
    'visitId',
    'blockId',
    'resultId',
    'checkpointId',
    'producerBlockId',
    'status',
    'reasonCode',
    'closedVisitCount',
    'disposition',
  ]) {
    if (event[key] !== undefined && event[key] !== null) out[key] = event[key];
  }
  return out;
}

function publicRun(run) {
  return {
    schemaVersion: run.schemaVersion,
    id: run.id,
    rootRunId: run.rootRunId,
    parentRunId: run.parentRunId,
    attempt: run.attempt,
    revision: run.revision,
    eventSeq: run.eventSeq,
    status: run.status,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    finishedAt: run.finishedAt,
    workflow: clonePublic(run.workflow),
    trigger: clonePublic(run.trigger),
    snapshot: {
      storage: run.snapshot.storage,
      byteLength: run.snapshot.byteLength,
    },
    migration: run.migration ? clonePublic(run.migration) : null,
    controlCheckpoint: publicControlCheckpoint(run.controlCheckpoints.at(-1)),
    controlCheckpointCount: run.controlCheckpoints.length,
    boundaryReviews: run.boundaryReviews.map(publicBoundaryReview),
    truncated: run.truncated ? clonePublic(run.truncated) : null,
    blocks: run.blocks.map(publicBlock),
    results: run.results.map(publicResult),
    events: run.events.map(publicEvent),
    resumeEvidence: assessResumeEvidence(run),
  };
}

function runSummary(run) {
  return {
    schemaVersion: run.schemaVersion,
    id: run.id,
    rootRunId: run.rootRunId,
    parentRunId: run.parentRunId,
    attempt: run.attempt,
    revision: run.revision,
    eventSeq: run.eventSeq,
    status: run.status,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    finishedAt: run.finishedAt,
    workflow: clonePublic(run.workflow),
    trigger: clonePublic(run.trigger),
    snapshot: {
      storage: run.snapshot.storage,
      byteLength: run.snapshot.byteLength,
    },
    migration: run.migration ? clonePublic(run.migration) : null,
    controlCheckpoint: publicControlCheckpoint(run.controlCheckpoints.at(-1)),
    controlCheckpointCount: run.controlCheckpoints.length,
    boundaryReviewCount: run.boundaryReviews.length,
    lastBoundaryReview: run.boundaryReviews.length
      ? publicBoundaryReview(run.boundaryReviews.at(-1))
      : null,
    truncated: run.truncated ? clonePublic(run.truncated) : null,
    blockVisitCount: run.blocks.length,
    resultCount: run.results.length,
    resultBytes: run.results.reduce((sum, result) => sum + result.byteLength, 0),
  };
}

const RUN_SUMMARY_KEYS = new Set([
  'schemaVersion',
  'id',
  'rootRunId',
  'parentRunId',
  'attempt',
  'revision',
  'eventSeq',
  'status',
  'startedAt',
  'updatedAt',
  'finishedAt',
  'workflow',
  'trigger',
  'snapshot',
  'migration',
  'controlCheckpoint',
  'controlCheckpointCount',
  'boundaryReviewCount',
  'lastBoundaryReview',
  'truncated',
  'blockVisitCount',
  'resultCount',
  'resultBytes',
]);

function compareRunSummaries(left, right) {
  const byStart = right.startedAt.localeCompare(left.startedAt);
  return byStart || right.id.localeCompare(left.id);
}

function assertLineage(record, runId, what) {
  const rootRunId = asRunId(record.rootRunId, `${what} rootRunId`);
  const parentRunId = record.parentRunId === null
    ? null
    : asRunId(record.parentRunId, `${what} parentRunId`);
  const attempt = asPositiveInt(record.attempt, `${what} attempt`);
  if (attempt === 1) {
    if (rootRunId !== runId || parentRunId !== null) {
      throw new RunJournalError(`${what} root lineage is invalid`, 'invalid-input');
    }
    return;
  }
  if (rootRunId === runId || parentRunId === null || parentRunId === runId) {
    throw new RunJournalError(`${what} child lineage is invalid`, 'invalid-input');
  }
}

function lineageGraphErrors(records, code) {
  const byId = new Map(records.map(record => [record.id, record]));
  const errors = new Map();
  const reject = (record, message) => {
    if (!errors.has(record.id)) {
      errors.set(record.id, new RunJournalError(message, code));
    }
  };

  for (const record of records) {
    if (record.attempt === 1) continue;
    const root = byId.get(record.rootRunId);
    const parent = byId.get(record.parentRunId);
    if (!root || root.attempt !== 1 || root.rootRunId !== root.id || root.parentRunId !== null) {
      reject(record, 'Run lineage root is missing or invalid');
      continue;
    }
    if (
      !parent
      || parent.rootRunId !== record.rootRunId
      || parent.attempt !== record.attempt - 1
      || !RUN_TERMINAL_VALUES.has(parent.status)
    ) {
      reject(record, 'Run lineage parent is missing or invalid');
    }
  }

  const attempts = new Map();
  for (const record of records) {
    const key = `${record.rootRunId}:${record.attempt}`;
    const group = attempts.get(key) || [];
    group.push(record);
    attempts.set(key, group);
  }
  for (const group of attempts.values()) {
    if (group.length < 2) continue;
    for (const record of group) {
      reject(record, 'Run lineage repeats an attempt number');
    }
  }

  // A locally well-shaped child still belongs to an invalid graph when its
  // parent was rejected. Propagate that fact from roots toward descendants.
  let changed = true;
  while (changed) {
    changed = false;
    for (const record of records) {
      if (record.attempt === 1 || errors.has(record.id)) continue;
      if (errors.has(record.parentRunId)) {
        reject(record, 'Run lineage descends from an invalid parent');
        changed = true;
      }
    }
  }
  return errors;
}

function assertLineageGraph(records, code) {
  const errors = lineageGraphErrors(records, code);
  if (errors.size) throw errors.values().next().value;
}

function assertMigrationMetadata(migration, what) {
  if (migration === null) return;
  asObject(migration, what);
  assertOnlyKeys(
    migration,
    new Set(['fromSchemaVersion', 'sourceRevision', 'migratedAt']),
    what
  );
  if (migration.fromSchemaVersion !== LEGACY_SCHEMA_VERSION) {
    throw new RunJournalError(`${what} source schema is invalid`, 'invalid-input');
  }
  asPositiveInt(migration.sourceRevision, `${what} sourceRevision`);
  if (!isIsoTimestamp(migration.migratedAt)) {
    throw new RunJournalError(`${what} timestamp is invalid`, 'invalid-input');
  }
}

function assertPublicControlCheckpoint(checkpoint, what) {
  if (checkpoint === null) return;
  asObject(checkpoint, what);
  assertOnlyKeys(
    checkpoint,
    new Set([
      'id',
      'stateVersion',
      'sourceRunId',
      'sourceRevision',
      'afterVisitId',
      'storage',
      'byteLength',
      'createdAt',
    ]),
    what
  );
  asRunId(checkpoint.id, `${what} id`);
  if (checkpoint.stateVersion !== CONTROL_CHECKPOINT_VERSION) {
    throw new RunJournalError(`${what} version is invalid`, 'invalid-input');
  }
  asRunId(checkpoint.sourceRunId, `${what} sourceRunId`);
  asPositiveInt(checkpoint.sourceRevision, `${what} sourceRevision`);
  asRunId(checkpoint.afterVisitId, `${what} afterVisitId`);
  if (checkpoint.storage !== STORAGE.ENCRYPTED) {
    throw new RunJournalError(`${what} storage is invalid`, 'invalid-input');
  }
  asNonNegativeInt(checkpoint.byteLength, `${what} byteLength`, {
    max: MAX_CONTROL_CHECKPOINT_BYTES,
  });
  if (!isIsoTimestamp(checkpoint.createdAt)) {
    throw new RunJournalError(`${what} timestamp is invalid`, 'invalid-input');
  }
}

function assertBoundaryReview(review, what) {
  asObject(review, what);
  assertOnlyKeys(
    review,
    new Set(['visitId', 'sourceRevision', 'disposition', 'reviewedAt']),
    what
  );
  asRunId(review.visitId, `${what} visitId`);
  asPositiveInt(review.sourceRevision, `${what} sourceRevision`);
  if (!BOUNDARY_DISPOSITION_VALUES.has(review.disposition)) {
    throw new RunJournalError(`${what} disposition is invalid`, 'invalid-input');
  }
  if (!isIsoTimestamp(review.reviewedAt)) {
    throw new RunJournalError(`${what} timestamp is invalid`, 'invalid-input');
  }
}

function assertRunSummary(summary) {
  asObject(summary, 'run summary');
  assertOnlyKeys(summary, RUN_SUMMARY_KEYS, 'run summary');
  if (summary.schemaVersion !== SCHEMA_VERSION) {
    throw new RunJournalError('Run index contains an unsupported summary', 'corrupt-index');
  }
  const summaryId = asRunId(summary.id, 'run summary id');
  assertLineage(summary, summaryId, 'run summary');
  asPositiveInt(summary.revision, 'run summary revision');
  asPositiveInt(summary.eventSeq, 'run summary event sequence');
  if (!RUN_STATUS_VALUES.has(summary.status)) {
    throw new RunJournalError('Run index contains an invalid status', 'corrupt-index');
  }
  if (
    !isIsoTimestamp(summary.startedAt)
    || !isIsoTimestamp(summary.updatedAt)
    || (summary.finishedAt !== null && !isIsoTimestamp(summary.finishedAt))
  ) {
    throw new RunJournalError('Run index contains an invalid timestamp', 'corrupt-index');
  }
  if (summary.status === RUN_STATUS.RUNNING && summary.finishedAt !== null) {
    throw new RunJournalError('Run index marks an active run as finished', 'corrupt-index');
  }
  if (RUN_TERMINAL_VALUES.has(summary.status) && summary.finishedAt === null) {
    throw new RunJournalError('Run index omits a terminal timestamp', 'corrupt-index');
  }

  asObject(summary.workflow, 'run summary workflow');
  assertOnlyKeys(
    summary.workflow,
    new Set(['id', 'name', 'formatVersion', 'blockCount']),
    'run summary workflow'
  );
  asPublicId(summary.workflow.id, 'run summary workflow id');
  asText(summary.workflow.name, 'run summary workflow name', {
    maxBytes: 512,
    trim: true,
  });
  asNonNegativeInt(
    summary.workflow.formatVersion,
    'run summary workflow format version',
    { max: 1_000_000 }
  );
  asNonNegativeInt(
    summary.workflow.blockCount,
    'run summary workflow block count',
    { max: MAX_BLOCK_VISITS }
  );
  const normalizedTrigger = normalizeTrigger(summary.trigger);
  if (stableJson(normalizedTrigger) !== stableJson(summary.trigger)) {
    throw new RunJournalError('Run index trigger is not canonical', 'corrupt-index');
  }

  asObject(summary.snapshot, 'run summary snapshot');
  assertOnlyKeys(
    summary.snapshot,
    new Set(['storage', 'byteLength']),
    'run summary snapshot'
  );
  if (!Object.values(STORAGE).includes(summary.snapshot.storage)) {
    throw new RunJournalError('Run index snapshot storage is invalid', 'corrupt-index');
  }
  asNonNegativeInt(
    summary.snapshot.byteLength,
    'run summary snapshot byte length',
    { max: MAX_WORKFLOW_BYTES }
  );
  assertMigrationMetadata(summary.migration, 'run summary migration');
  assertPublicControlCheckpoint(summary.controlCheckpoint, 'run summary control checkpoint');
  asNonNegativeInt(
    summary.controlCheckpointCount,
    'run summary control checkpoint count',
    { max: MAX_BLOCK_VISITS }
  );
  if (
    summary.controlCheckpoint
    && summary.controlCheckpoint.sourceRunId !== summaryId
  ) {
    throw new RunJournalError('Run summary control checkpoint source is invalid', 'corrupt-index');
  }
  if (
    (summary.controlCheckpoint === null && summary.controlCheckpointCount !== 0)
    || (summary.controlCheckpoint !== null && summary.controlCheckpointCount === 0)
  ) {
    throw new RunJournalError('Run summary control checkpoint count is invalid', 'corrupt-index');
  }
  asNonNegativeInt(
    summary.boundaryReviewCount,
    'run summary boundary review count',
    { max: MAX_BOUNDARY_REVIEWS }
  );
  if (summary.lastBoundaryReview !== null) {
    assertBoundaryReview(summary.lastBoundaryReview, 'run summary last boundary review');
    if (summary.boundaryReviewCount === 0) {
      throw new RunJournalError('Run summary boundary review count is invalid', 'corrupt-index');
    }
  } else if (summary.boundaryReviewCount !== 0) {
    throw new RunJournalError('Run summary omits its last boundary review', 'corrupt-index');
  }

  if (summary.truncated !== null) {
    asObject(summary.truncated, 'run summary truncation');
    assertOnlyKeys(
      summary.truncated,
      new Set(['reason', 'at']),
      'run summary truncation'
    );
    asSlug(summary.truncated.reason, 'run summary truncation reason');
    if (!isIsoTimestamp(summary.truncated.at)) {
      throw new RunJournalError('Run index truncation timestamp is invalid', 'corrupt-index');
    }
  }

  asNonNegativeInt(
    summary.blockVisitCount,
    'run summary block visit count',
    { max: MAX_BLOCK_VISITS }
  );
  asNonNegativeInt(
    summary.resultCount,
    'run summary result count',
    { max: MAX_RESULTS }
  );
  asNonNegativeInt(
    summary.resultBytes,
    'run summary result bytes',
    { max: MAX_RUN_RESULT_BYTES }
  );
}

function assertRunIndex(index) {
  asObject(index, 'run index');
  assertOnlyKeys(index, new Set(['schemaVersion', 'runs']), 'run index');
  if (index.schemaVersion !== RUN_INDEX_SCHEMA_VERSION) {
    throw new RunJournalError('Run index schema is unsupported', 'corrupt-index');
  }
  if (!Array.isArray(index.runs) || index.runs.length > MAX_RUN_INDEX_ENTRIES) {
    throw new RunJournalError('Run index entry count is invalid', 'corrupt-index');
  }
  const ids = new Set();
  for (let position = 0; position < index.runs.length; position += 1) {
    const summary = index.runs[position];
    assertRunSummary(summary);
    if (ids.has(summary.id)) {
      throw new RunJournalError('Run index repeats a run id', 'corrupt-index');
    }
    ids.add(summary.id);
    if (
      position > 0
      && compareRunSummaries(index.runs[position - 1], summary) > 0
    ) {
      throw new RunJournalError('Run index order is invalid', 'corrupt-index');
    }
  }
  assertLineageGraph(index.runs, 'corrupt-index');
}

function assertRetentionPolicy(policy, what) {
  asObject(policy, what);
  assertOnlyKeys(policy, new Set(['maxRuns', 'maxAgeDays', 'cutoff']), what);
  if (policy.maxRuns !== null) {
    asPositiveInt(policy.maxRuns, `${what} maxRuns`, { max: MAX_RETENTION_RUNS });
  }
  if (policy.maxAgeDays !== null) {
    asPositiveInt(policy.maxAgeDays, `${what} maxAgeDays`, {
      max: MAX_RETENTION_AGE_DAYS,
    });
    if (!isIsoTimestamp(policy.cutoff)) {
      throw new RunJournalError(`${what} cutoff is invalid`, 'corrupt-retention');
    }
  } else if (policy.cutoff !== null) {
    throw new RunJournalError(`${what} cutoff is unexpected`, 'corrupt-retention');
  }
  if (policy.maxRuns === null && policy.maxAgeDays === null) {
    throw new RunJournalError(`${what} has no limit`, 'corrupt-retention');
  }
}

function assertRetentionTransaction(transaction) {
  asObject(transaction, 'retention transaction');
  assertOnlyKeys(
    transaction,
    new Set([
      'schemaVersion',
      'status',
      'opId',
      'fingerprint',
      'policy',
      'previewToken',
      'planDigest',
      'candidates',
      'startedAt',
      'committedAt',
      'result',
    ]),
    'retention transaction'
  );
  if (transaction.schemaVersion !== RETENTION_TRANSACTION_SCHEMA_VERSION) {
    throw new RunJournalError(
      'Retention transaction schema is unsupported',
      'corrupt-retention'
    );
  }
  if (!Object.values(RETENTION_TRANSACTION_STATUS).includes(transaction.status)) {
    throw new RunJournalError('Retention transaction status is invalid', 'corrupt-retention');
  }
  asOpId(transaction.opId);
  asText(transaction.fingerprint, 'retention transaction fingerprint', {
    maxBytes: 64,
    trim: true,
    pattern: PREVIEW_TOKEN_PATTERN,
  });
  assertRetentionPolicy(transaction.policy, 'retention transaction policy');
  asText(transaction.previewToken, 'retention transaction preview token', {
    maxBytes: 64,
    trim: true,
    pattern: PREVIEW_TOKEN_PATTERN,
  });
  asText(transaction.planDigest, 'retention transaction plan digest', {
    maxBytes: 64,
    trim: true,
    pattern: PREVIEW_TOKEN_PATTERN,
  });
  if (
    !Array.isArray(transaction.candidates)
    || transaction.candidates.length > MAX_RUN_INDEX_ENTRIES
  ) {
    throw new RunJournalError('Retention transaction candidates are invalid', 'corrupt-retention');
  }
  const ids = new Set();
  for (const candidate of transaction.candidates) {
    asObject(candidate, 'retention transaction candidate');
    assertOnlyKeys(
      candidate,
      new Set(['id', 'revision']),
      'retention transaction candidate'
    );
    const id = asRunId(candidate.id, 'retention transaction candidate id');
    asPositiveInt(candidate.revision, 'retention transaction candidate revision');
    if (ids.has(id)) {
      throw new RunJournalError(
        'Retention transaction repeats a candidate',
        'corrupt-retention'
      );
    }
    ids.add(id);
  }
  const expectedPlanDigest = retentionPlanDigest(
    transaction.policy,
    transaction.candidates
  );
  const expectedFingerprint = operationFingerprint('prune-runs', {
    policy: transaction.policy,
    previewToken: transaction.previewToken,
    planDigest: expectedPlanDigest,
  });
  if (
    transaction.planDigest !== expectedPlanDigest
    || transaction.fingerprint !== expectedFingerprint
  ) {
    throw new RunJournalError(
      'Retention transaction integrity is invalid',
      'corrupt-retention'
    );
  }
  if (!isIsoTimestamp(transaction.startedAt)) {
    throw new RunJournalError('Retention transaction timestamp is invalid', 'corrupt-retention');
  }
  if (
    transaction.status === RETENTION_TRANSACTION_STATUS.PREPARED
    || transaction.status === RETENTION_TRANSACTION_STATUS.APPLYING
  ) {
    if (transaction.committedAt !== null || transaction.result !== null) {
      throw new RunJournalError('Pending retention transaction is invalid', 'corrupt-retention');
    }
    return;
  }
  if (!isIsoTimestamp(transaction.committedAt)) {
    throw new RunJournalError('Retention commit timestamp is invalid', 'corrupt-retention');
  }
  asObject(transaction.result, 'retention transaction result');
  assertOnlyKeys(
    transaction.result,
    new Set(['preview', 'deletedCount', 'remainingCount', 'previewToken', 'aborted']),
    'retention transaction result'
  );
  if (transaction.result.preview !== false) {
    throw new RunJournalError('Retention transaction result is invalid', 'corrupt-retention');
  }
  asNonNegativeInt(
    transaction.result.deletedCount,
    'retention transaction deleted count',
    { max: MAX_RUN_INDEX_ENTRIES }
  );
  asNonNegativeInt(
    transaction.result.remainingCount,
    'retention transaction remaining count',
    { max: MAX_RUN_INDEX_ENTRIES }
  );
  if (transaction.result.previewToken !== transaction.previewToken) {
    throw new RunJournalError('Retention transaction result does not match', 'corrupt-retention');
  }
  if (transaction.status === RETENTION_TRANSACTION_STATUS.ABORTED) {
    if (transaction.result.deletedCount !== 0 || transaction.result.aborted !== true) {
      throw new RunJournalError('Retention abort result is invalid', 'corrupt-retention');
    }
  } else if (
    transaction.status !== RETENTION_TRANSACTION_STATUS.COMMITTED
    || transaction.result.deletedCount !== transaction.candidates.length
    || transaction.result.aborted !== undefined
  ) {
    throw new RunJournalError('Retention commit result is invalid', 'corrupt-retention');
  }
}

function assertRetentionReceiptIndex(index) {
  asObject(index, 'retention receipt index');
  assertOnlyKeys(index, new Set(['schemaVersion', 'receipts']), 'retention receipt index');
  if (index.schemaVersion !== RETENTION_TRANSACTION_SCHEMA_VERSION) {
    throw new RunJournalError('Retention receipt schema is unsupported', 'corrupt-retention');
  }
  if (!Array.isArray(index.receipts) || index.receipts.length > MAX_RETENTION_RECEIPTS) {
    throw new RunJournalError('Retention receipt count is invalid', 'corrupt-retention');
  }
  const operationIds = new Set();
  for (const receipt of index.receipts) {
    asObject(receipt, 'retention receipt');
    assertOnlyKeys(
      receipt,
      new Set([
        'opId',
        'fingerprint',
        'policy',
        'previewToken',
        'planDigest',
        'result',
        'committedAt',
      ]),
      'retention receipt'
    );
    const opId = asOpId(receipt.opId);
    if (operationIds.has(opId)) {
      throw new RunJournalError('Retention receipt repeats an operation id', 'corrupt-retention');
    }
    operationIds.add(opId);
    assertRetentionPolicy(receipt.policy, 'retention receipt policy');
    for (const [value, what] of [
      [receipt.fingerprint, 'retention receipt fingerprint'],
      [receipt.previewToken, 'retention receipt preview token'],
      [receipt.planDigest, 'retention receipt plan digest'],
    ]) {
      asText(value, what, {
        maxBytes: 64,
        trim: true,
        pattern: PREVIEW_TOKEN_PATTERN,
      });
    }
    if (receipt.fingerprint !== operationFingerprint('prune-runs', {
      policy: receipt.policy,
      previewToken: receipt.previewToken,
      planDigest: receipt.planDigest,
    })) {
      throw new RunJournalError('Retention receipt integrity is invalid', 'corrupt-retention');
    }
    asObject(receipt.result, 'retention receipt result');
    assertOnlyKeys(
      receipt.result,
      new Set(['preview', 'deletedCount', 'remainingCount', 'previewToken', 'aborted']),
      'retention receipt result'
    );
    if (
      receipt.result.preview !== false
      || receipt.result.previewToken !== receipt.previewToken
    ) {
      throw new RunJournalError('Retention receipt result is invalid', 'corrupt-retention');
    }
    asNonNegativeInt(receipt.result.deletedCount, 'retention receipt deleted count', {
      max: MAX_RUN_INDEX_ENTRIES,
    });
    asNonNegativeInt(receipt.result.remainingCount, 'retention receipt remaining count', {
      max: MAX_RUN_INDEX_ENTRIES,
    });
    if (
      Object.hasOwn(receipt.result, 'aborted')
      && receipt.result.aborted !== true
    ) {
      throw new RunJournalError('Retention receipt abort marker is invalid', 'corrupt-retention');
    }
    if (receipt.result.aborted === true && receipt.result.deletedCount !== 0) {
      throw new RunJournalError('Retention receipt abort count is invalid', 'corrupt-retention');
    }
    if (!isIsoTimestamp(receipt.committedAt)) {
      throw new RunJournalError('Retention receipt timestamp is invalid', 'corrupt-retention');
    }
  }
}

function assertDeleteTransaction(transaction) {
  asObject(transaction, 'delete transaction');
  assertOnlyKeys(
    transaction,
    new Set([
      'schemaVersion',
      'status',
      'runId',
      'revision',
      'opId',
      'fingerprint',
      'startedAt',
      'committedAt',
      'result',
    ]),
    'delete transaction'
  );
  if (transaction.schemaVersion !== RETENTION_TRANSACTION_SCHEMA_VERSION) {
    throw new RunJournalError('Delete transaction schema is unsupported', 'corrupt-retention');
  }
  if (!Object.values(DELETE_TRANSACTION_STATUS).includes(transaction.status)) {
    throw new RunJournalError('Delete transaction status is invalid', 'corrupt-retention');
  }
  const runId = asRunId(transaction.runId, 'delete transaction run id');
  asPositiveInt(transaction.revision, 'delete transaction revision');
  asOpId(transaction.opId);
  asText(transaction.fingerprint, 'delete transaction fingerprint', {
    maxBytes: 64,
    trim: true,
    pattern: PREVIEW_TOKEN_PATTERN,
  });
  if (transaction.fingerprint !== operationFingerprint('delete-run', { runId })) {
    throw new RunJournalError('Delete transaction integrity is invalid', 'corrupt-retention');
  }
  if (!isIsoTimestamp(transaction.startedAt)) {
    throw new RunJournalError('Delete transaction timestamp is invalid', 'corrupt-retention');
  }
  if (transaction.status === DELETE_TRANSACTION_STATUS.APPLYING) {
    if (transaction.committedAt !== null || transaction.result !== null) {
      throw new RunJournalError('Applying delete transaction is invalid', 'corrupt-retention');
    }
  } else if (!isIsoTimestamp(transaction.committedAt) || transaction.result !== true) {
    throw new RunJournalError('Committed delete transaction is invalid', 'corrupt-retention');
  }
}

function makeRunIndex(runs) {
  return makeSummaryIndex(runs.map(run => runSummary(run)));
}

function makeSummaryIndex(summaries) {
  const index = {
    schemaVersion: RUN_INDEX_SCHEMA_VERSION,
    runs: summaries.map(summary => clonePublic(summary)).sort(compareRunSummaries),
  };
  assertRunIndex(index);
  return index;
}

function encodeRunCursor(summary) {
  return Buffer.from(JSON.stringify({
    version: 1,
    startedAt: summary.startedAt,
    id: summary.id,
  }), 'utf8').toString('base64url');
}

function decodeRunCursor(value) {
  const encoded = asText(value, 'cursor', {
    maxBytes: 512,
    trim: true,
    pattern: CURSOR_PATTERN,
  });
  let cursor;
  try {
    cursor = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch (_error) {
    throw new RunJournalError('cursor is invalid', 'invalid-input');
  }
  try {
    asObject(cursor, 'cursor');
    assertOnlyKeys(cursor, new Set(['version', 'startedAt', 'id']), 'cursor');
    if (cursor.version !== 1 || !isIsoTimestamp(cursor.startedAt)) {
      throw new RunJournalError('cursor is invalid', 'invalid-input');
    }
    cursor.id = asRunId(cursor.id, 'cursor id');
    if (encodeRunCursor(cursor) !== encoded) {
      throw new RunJournalError('cursor is invalid', 'invalid-input');
    }
    return cursor;
  } catch (error) {
    if (error instanceof RunJournalError && error.code === 'invalid-input') throw error;
    throw new RunJournalError('cursor is invalid', 'invalid-input');
  }
}

function pageStartAfterCursor(runs, cursor) {
  if (!cursor) return 0;
  let low = 0;
  let high = runs.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (compareRunSummaries(runs[middle], cursor) <= 0) low = middle + 1;
    else high = middle;
  }
  return low;
}

function assertStoredLane(lane, what) {
  const normalized = normalizeLaneDescriptors([lane]);
  const keys = Object.keys(lane).sort();
  const normalizedKeys = Object.keys(normalized[0]).sort();
  if (stableJson(keys) !== stableJson(normalizedKeys)) {
    throw new RunJournalError(`${what} contains non-public fields`, 'corrupt-run');
  }
}

function assertStoredRun(run) {
  if (!isPlainObject(run)) throw new RunJournalError('Run record is not an object', 'corrupt-run');
  assertOnlyKeys(
    run,
    new Set([
      'schemaVersion',
      'id',
      'rootRunId',
      'parentRunId',
      'attempt',
      'revision',
      'eventSeq',
      'status',
      'startedAt',
      'updatedAt',
      'finishedAt',
      'workflow',
      'trigger',
      'snapshot',
      'migration',
      'controlCheckpoints',
      'boundaryReviews',
      'truncated',
      'blocks',
      'results',
      'operations',
      'events',
    ]),
    'run record'
  );
  if (run.schemaVersion !== SCHEMA_VERSION) {
    throw new RunJournalError('Unsupported Run Journal schema', 'unsupported-schema');
  }
  const runId = asRunId(run.id, 'run.id');
  assertLineage(run, runId, 'run');
  asPositiveInt(run.revision, 'run.revision');
  asPositiveInt(run.eventSeq, 'run.eventSeq');
  if (!RUN_STATUS_VALUES.has(run.status)) {
    throw new RunJournalError('Run record has an invalid status', 'corrupt-run');
  }
  if (
    !isIsoTimestamp(run.startedAt)
    || !isIsoTimestamp(run.updatedAt)
    || (run.finishedAt !== null && !isIsoTimestamp(run.finishedAt))
  ) {
    throw new RunJournalError('Run record has an invalid timestamp', 'corrupt-run');
  }
  if (run.status === RUN_STATUS.RUNNING && run.finishedAt !== null) {
    throw new RunJournalError('Running run has a finish timestamp', 'corrupt-run');
  }
  if (RUN_TERMINAL_VALUES.has(run.status) && run.finishedAt === null) {
    throw new RunJournalError('Terminal run is missing its finish timestamp', 'corrupt-run');
  }
  assertMigrationMetadata(run.migration, 'run.migration');
  if (run.migration && run.migration.sourceRevision >= run.revision) {
    throw new RunJournalError('Run migration revision is invalid', 'corrupt-run');
  }
  if (Object.hasOwn(run, 'truncated')) {
    asObject(run.truncated, 'run.truncated');
    assertOnlyKeys(run.truncated, new Set(['reason', 'at']), 'run.truncated');
    asSlug(run.truncated.reason, 'run.truncated.reason');
    if (!isIsoTimestamp(run.truncated.at)) {
      throw new RunJournalError('Run truncation timestamp is invalid', 'corrupt-run');
    }
  }

  asObject(run.workflow, 'run.workflow');
  assertOnlyKeys(
    run.workflow,
    new Set(['id', 'name', 'formatVersion', 'blockCount']),
    'run.workflow'
  );
  asPublicId(run.workflow.id, 'run.workflow.id');
  asText(run.workflow.name, 'run.workflow.name', { maxBytes: 512, trim: true });
  asNonNegativeInt(run.workflow.formatVersion, 'run.workflow.formatVersion', { max: 1_000_000 });
  asNonNegativeInt(run.workflow.blockCount, 'run.workflow.blockCount', { max: MAX_BLOCK_VISITS });
  const normalizedTrigger = normalizeTrigger(run.trigger);
  if (stableJson(normalizedTrigger) !== stableJson(run.trigger)) {
    throw new RunJournalError('Run trigger is not canonical', 'corrupt-run');
  }

  asObject(run.snapshot, 'run.snapshot');
  assertOnlyKeys(
    run.snapshot,
    new Set(['storage', 'byteLength', 'ciphertext']),
    'run.snapshot'
  );
  if (!Object.values(STORAGE).includes(run.snapshot.storage)) {
    throw new RunJournalError('Snapshot storage is invalid', 'corrupt-run');
  }
  asNonNegativeInt(run.snapshot.byteLength, 'run.snapshot.byteLength', { max: MAX_WORKFLOW_BYTES });
  if (run.snapshot.storage === STORAGE.ENCRYPTED) {
    assertCiphertext(
      run.snapshot.ciphertext,
      'stored workflow encryption',
      MAX_WORKFLOW_CIPHERTEXT_BYTES
    );
  } else if (Object.hasOwn(run.snapshot, 'ciphertext')) {
    throw new RunJournalError('Memory snapshot contains ciphertext', 'corrupt-run');
  }

  if (!Array.isArray(run.controlCheckpoints) || run.controlCheckpoints.length > MAX_BLOCK_VISITS) {
    throw new RunJournalError('Run control checkpoints are invalid', 'corrupt-run');
  }
  const checkpointIds = new Set();
  const checkpointVisitIds = new Set();
  let priorCheckpointRevision = 0;
  for (let index = 0; index < run.controlCheckpoints.length; index++) {
    const checkpoint = asObject(
      run.controlCheckpoints[index],
      `run.controlCheckpoints[${index}]`
    );
    assertOnlyKeys(
      checkpoint,
      new Set([
        'id',
        'stateVersion',
        'sourceRunId',
        'sourceRevision',
        'afterVisitId',
        'storage',
        'byteLength',
        'createdAt',
        'ciphertext',
      ]),
      `run.controlCheckpoints[${index}]`
    );
    assertPublicControlCheckpoint(
      publicControlCheckpoint(checkpoint),
      `run.controlCheckpoints[${index}]`
    );
    if (checkpointIds.has(checkpoint.id)) {
      throw new RunJournalError('Run repeats a control checkpoint id', 'corrupt-run');
    }
    checkpointIds.add(checkpoint.id);
    if (checkpointVisitIds.has(checkpoint.afterVisitId)) {
      throw new RunJournalError('Run repeats a control checkpoint visit', 'corrupt-run');
    }
    checkpointVisitIds.add(checkpoint.afterVisitId);
    if (checkpoint.sourceRunId !== runId || checkpoint.sourceRevision >= run.revision) {
      throw new RunJournalError('Control checkpoint source binding is invalid', 'corrupt-run');
    }
    if (checkpoint.sourceRevision <= priorCheckpointRevision) {
      throw new RunJournalError('Control checkpoint revisions are not ordered', 'corrupt-run');
    }
    priorCheckpointRevision = checkpoint.sourceRevision;
    assertCiphertext(
      checkpoint.ciphertext,
      'stored control checkpoint encryption',
      MAX_CONTROL_CHECKPOINT_CIPHERTEXT_BYTES
    );
  }

  if (!Array.isArray(run.boundaryReviews) || run.boundaryReviews.length > MAX_BOUNDARY_REVIEWS) {
    throw new RunJournalError('Run boundary reviews are invalid', 'corrupt-run');
  }
  const reviewedVisitIds = new Set();
  let priorReviewRevision = 0;
  for (let index = 0; index < run.boundaryReviews.length; index++) {
    const review = run.boundaryReviews[index];
    assertBoundaryReview(review, `run.boundaryReviews[${index}]`);
    if (review.sourceRevision >= run.revision) {
      throw new RunJournalError('Boundary review source revision is invalid', 'corrupt-run');
    }
    if (reviewedVisitIds.has(review.visitId)) {
      throw new RunJournalError('Run repeats a boundary review visit', 'corrupt-run');
    }
    reviewedVisitIds.add(review.visitId);
    if (review.sourceRevision <= priorReviewRevision) {
      throw new RunJournalError('Boundary review revisions are not ordered', 'corrupt-run');
    }
    priorReviewRevision = review.sourceRevision;
  }

  if (!Array.isArray(run.blocks) || run.blocks.length > MAX_BLOCK_VISITS) {
    throw new RunJournalError('Run block visits are invalid', 'corrupt-run');
  }
  const visitIds = new Set();
  for (const block of run.blocks) {
    asObject(block, 'block visit');
    assertOnlyKeys(
      block,
      new Set([
        'visitId',
        'blockId',
        'blockIndex',
        'blockType',
        'iterationPath',
        'lanes',
        'status',
        'startedAt',
        'finishedAt',
        'reasonCode',
      ]),
      'block visit'
    );
    const visitId = asRunId(block.visitId, 'block.visitId');
    if (visitIds.has(visitId)) {
      throw new RunJournalError('Run repeats a block visit id', 'corrupt-run');
    }
    visitIds.add(visitId);
    asPublicId(block.blockId, 'block.blockId');
    if (block.blockIndex !== null) {
      asNonNegativeInt(block.blockIndex, 'block.blockIndex', { max: MAX_BLOCK_VISITS - 1 });
      if (block.blockIndex >= run.workflow.blockCount) {
        throw new RunJournalError('Block index exceeds workflow metadata', 'corrupt-run');
      }
    }
    if (block.blockType !== null) asSlug(block.blockType, 'block.blockType');
    const normalizedPath = normalizeIterationPath(block.iterationPath);
    if (stableJson(normalizedPath) !== stableJson(block.iterationPath)) {
      throw new RunJournalError('Block iteration path is not canonical', 'corrupt-run');
    }
    if (!Array.isArray(block.lanes)) {
      throw new RunJournalError('Block lanes are invalid', 'corrupt-run');
    }
    for (let index = 0; index < block.lanes.length; index++) {
      assertStoredLane(block.lanes[index], `block.lanes[${index}]`);
    }
    if (!BLOCK_STATUS_VALUES.has(block.status)) {
      throw new RunJournalError('Block visit status is invalid', 'corrupt-run');
    }
    if (
      !isIsoTimestamp(block.startedAt)
      || (block.finishedAt !== null && !isIsoTimestamp(block.finishedAt))
    ) {
      throw new RunJournalError('Block visit timestamp is invalid', 'corrupt-run');
    }
    if (block.status === BLOCK_STATUS.RUNNING && block.finishedAt !== null) {
      throw new RunJournalError('Running block has a finish timestamp', 'corrupt-run');
    }
    if (BLOCK_TERMINAL_VALUES.has(block.status) && block.finishedAt === null) {
      throw new RunJournalError('Terminal block is missing its finish timestamp', 'corrupt-run');
    }
    if (block.reasonCode !== null) asSlug(block.reasonCode, 'block.reasonCode');
  }
  if (
    RUN_TERMINAL_VALUES.has(run.status)
    && run.blocks.some(block => block.status === BLOCK_STATUS.RUNNING)
  ) {
    throw new RunJournalError('Terminal run contains an active block visit', 'corrupt-run');
  }
  for (const checkpoint of run.controlCheckpoints) {
    const checkpointVisit = run.blocks.find(
      block => block.visitId === checkpoint.afterVisitId
    );
    if (!checkpointVisit || !BLOCK_TERMINAL_VALUES.has(checkpointVisit.status)) {
      throw new RunJournalError('Control checkpoint visit binding is invalid', 'corrupt-run');
    }
  }
  for (const review of run.boundaryReviews) {
    const visit = run.blocks.find(block => block.visitId === review.visitId);
    if (!visit || ![
      BLOCK_STATUS.FAILED,
      BLOCK_STATUS.CANCELLED,
      BLOCK_STATUS.INTERRUPTED,
    ].includes(visit.status)) {
      throw new RunJournalError('Boundary review does not reference an uncertain visit', 'corrupt-run');
    }
  }

  if (!Array.isArray(run.results) || run.results.length > MAX_RESULTS) {
    throw new RunJournalError('Run results are invalid', 'corrupt-run');
  }
  let resultBytes = 0;
  const resultIds = new Set();
  for (const result of run.results) {
    asObject(result, 'result');
    assertOnlyKeys(
      result,
      new Set([
        'id',
        'producerBlockId',
        'visitId',
        'name',
        'status',
        'lanes',
        'createdAt',
        'byteLength',
        'storage',
        'ciphertext',
      ]),
      'result'
    );
    const resultId = asRunId(result.id, 'result.id');
    if (resultIds.has(resultId)) {
      throw new RunJournalError('Run repeats a result id', 'corrupt-run');
    }
    resultIds.add(resultId);
    asPublicId(result.producerBlockId, 'result.producerBlockId');
    const resultVisitId = asRunId(result.visitId, 'result.visitId');
    const visit = run.blocks.find(block => block.visitId === resultVisitId);
    if (!visit || visit.blockId !== result.producerBlockId) {
      throw new RunJournalError('Result points to an unknown producer visit', 'corrupt-run');
    }
    asText(result.name, 'result.name', { maxBytes: 512, trim: true });
    if (!RESULT_STATUS_VALUES.has(result.status)) {
      throw new RunJournalError('Result status is invalid', 'corrupt-run');
    }
    if (!Array.isArray(result.lanes)) {
      throw new RunJournalError('Result lanes are invalid', 'corrupt-run');
    }
    for (let index = 0; index < result.lanes.length; index++) {
      assertStoredLane(result.lanes[index], `result.lanes[${index}]`);
    }
    if (!isIsoTimestamp(result.createdAt)) {
      throw new RunJournalError('Result timestamp is invalid', 'corrupt-run');
    }
    asNonNegativeInt(result.byteLength, 'result.byteLength', { max: MAX_RESULT_BYTES });
    resultBytes += result.byteLength;
    if (resultBytes > MAX_RUN_RESULT_BYTES) {
      throw new RunJournalError('Result byte accounting is invalid', 'corrupt-run');
    }
    if (!Object.values(STORAGE).includes(result.storage)) {
      throw new RunJournalError('Result storage is invalid', 'corrupt-run');
    }
    if (result.storage === STORAGE.ENCRYPTED) {
      assertCiphertext(
        result.ciphertext,
        'stored result encryption',
        MAX_RESULT_CIPHERTEXT_BYTES
      );
    } else if (Object.hasOwn(result, 'ciphertext')) {
      throw new RunJournalError('Memory result contains ciphertext', 'corrupt-run');
    }
    if (Object.hasOwn(result, 'body')) {
      throw new RunJournalError('Result plaintext appears in the journal', 'corrupt-run');
    }
  }

  if (!Array.isArray(run.operations) || run.operations.length > MAX_OPERATIONS) {
    throw new RunJournalError('Run operations are invalid', 'corrupt-run');
  }
  const operationIds = new Set();
  for (const operation of run.operations) {
    asObject(operation, 'operation');
    assertOnlyKeys(
      operation,
      new Set(['opId', 'action', 'proof', 'at', 'refId']),
      'operation'
    );
    const opId = asOpId(operation.opId);
    if (operationIds.has(opId)) {
      throw new RunJournalError('Run repeats an operation id', 'corrupt-run');
    }
    operationIds.add(opId);
    asSlug(operation.action, 'operation.action');
    if (!OPERATION_ACTIONS.has(operation.action)) {
      throw new RunJournalError('Operation action is invalid', 'corrupt-run');
    }
    if (!isIsoTimestamp(operation.at)) {
      throw new RunJournalError('Operation metadata is invalid', 'corrupt-run');
    }
    asObject(operation.proof, 'operation.proof');
    assertOnlyKeys(
      operation.proof,
      new Set(['storage', 'ciphertext']),
      'operation.proof'
    );
    if (!Object.values(STORAGE).includes(operation.proof.storage)) {
      throw new RunJournalError('Operation proof storage is invalid', 'corrupt-run');
    }
    if (operation.proof.storage === STORAGE.ENCRYPTED) {
      assertCiphertext(
        operation.proof.ciphertext,
        'stored operation proof encryption',
        MAX_OPERATION_CIPHERTEXT_BYTES
      );
    } else if (Object.hasOwn(operation.proof, 'ciphertext')) {
      throw new RunJournalError('Memory operation proof contains ciphertext', 'corrupt-run');
    }
    if (operation.refId !== null) {
      const refId = asRunId(operation.refId, 'operation.refId');
      const expectsVisit = operation.action === 'start-block'
        || operation.action === 'finish-block'
        || operation.action === 'record-boundary-disposition';
      const expectsResult = operation.action === 'store-result';
      const expectsCheckpoint = operation.action === 'store-control-checkpoint';
      if (
        (expectsVisit && !visitIds.has(refId))
        || (expectsResult && !resultIds.has(refId))
        || (expectsCheckpoint && !checkpointIds.has(refId))
        || (!expectsVisit && !expectsResult && !expectsCheckpoint)
      ) {
        throw new RunJournalError('Operation points to an unknown record', 'corrupt-run');
      }
    } else if (
      operation.action === 'start-block'
      || operation.action === 'finish-block'
      || operation.action === 'store-control-checkpoint'
      || operation.action === 'record-boundary-disposition'
      || operation.action === 'store-result'
    ) {
      throw new RunJournalError('Operation is missing its record reference', 'corrupt-run');
    }
  }

  if (!Array.isArray(run.events) || run.events.length > MAX_EVENTS) {
    throw new RunJournalError('Run events are invalid', 'corrupt-run');
  }
  if (run.events.length === 0 || run.events.length !== run.eventSeq) {
    throw new RunJournalError('Run event sequence is incomplete', 'corrupt-run');
  }
  for (let index = 0; index < run.events.length; index++) {
    const event = run.events[index];
    asObject(event, 'event');
    assertOnlyKeys(
      event,
      new Set([
        'seq',
        'type',
        'at',
        'visitId',
        'blockId',
        'resultId',
        'checkpointId',
        'producerBlockId',
        'status',
        'reasonCode',
        'closedVisitCount',
        'disposition',
      ]),
      'event'
    );
    if (
      event.seq !== index + 1
      || !isIsoTimestamp(event.at)
      || !EVENT_TYPES.has(event.type)
    ) {
      throw new RunJournalError('Run event sequence is invalid', 'corrupt-run');
    }
    if (event.visitId !== undefined) {
      const visitId = asRunId(event.visitId, 'event.visitId');
      if (!visitIds.has(visitId)) {
        throw new RunJournalError('Event points to an unknown block visit', 'corrupt-run');
      }
    }
    if (event.resultId !== undefined) {
      const resultId = asRunId(event.resultId, 'event.resultId');
      if (!resultIds.has(resultId)) {
        throw new RunJournalError('Event points to an unknown result', 'corrupt-run');
      }
    }
    if (event.checkpointId !== undefined) {
      const checkpointId = asRunId(event.checkpointId, 'event.checkpointId');
      if (!checkpointIds.has(checkpointId)) {
        throw new RunJournalError('Event points to an unknown control checkpoint', 'corrupt-run');
      }
    }
    if (event.blockId !== undefined) asPublicId(event.blockId, 'event.blockId');
    if (event.producerBlockId !== undefined) {
      asPublicId(event.producerBlockId, 'event.producerBlockId');
    }
    if (
      event.status !== undefined
      && !RUN_STATUS_VALUES.has(event.status)
      && !BLOCK_STATUS_VALUES.has(event.status)
      && !RESULT_STATUS_VALUES.has(event.status)
    ) {
      throw new RunJournalError('Event status is invalid', 'corrupt-run');
    }
    if (event.reasonCode !== undefined) asSlug(event.reasonCode, 'event.reasonCode');
    if (
      event.disposition !== undefined
      && !BOUNDARY_DISPOSITION_VALUES.has(event.disposition)
    ) {
      throw new RunJournalError('Event disposition is invalid', 'corrupt-run');
    }
    if (event.closedVisitCount !== undefined) {
      asNonNegativeInt(
        event.closedVisitCount,
        'event.closedVisitCount',
        { max: MAX_BLOCK_VISITS }
      );
    }
  }
  return run;
}

const V1_RUN_KEYS = new Set([
  'schemaVersion',
  'id',
  'revision',
  'eventSeq',
  'status',
  'startedAt',
  'updatedAt',
  'finishedAt',
  'workflow',
  'trigger',
  'snapshot',
  'truncated',
  'blocks',
  'results',
  'operations',
  'events',
]);

function migrateStoredRunV1(run, migratedAt) {
  if (!isPlainObject(run) || run.schemaVersion !== LEGACY_SCHEMA_VERSION) {
    throw new RunJournalError('Run is not a v1 journal record', 'unsupported-schema');
  }
  assertOnlyKeys(run, V1_RUN_KEYS, 'v1 run record');
  const sourceRevision = asPositiveInt(run.revision, 'v1 run revision');
  if (sourceRevision >= Number.MAX_SAFE_INTEGER) {
    throw new RunJournalError('V1 run revision cannot be migrated', 'size-limit');
  }
  if (!isIsoTimestamp(migratedAt)) {
    throw new RunJournalError('Migration timestamp is invalid', 'clock-error');
  }
  const runId = asRunId(run.id, 'v1 run id');
  const migrated = {
    ...run,
    schemaVersion: SCHEMA_VERSION,
    rootRunId: runId,
    parentRunId: null,
    attempt: 1,
    revision: sourceRevision + 1,
    updatedAt: migratedAt,
    migration: {
      fromSchemaVersion: LEGACY_SCHEMA_VERSION,
      sourceRevision,
      migratedAt,
    },
    controlCheckpoints: [],
    boundaryReviews: [],
  };
  if (migrated.truncated === null) delete migrated.truncated;
  assertStoredRun(migrated);
  return migrated;
}

function appendEvent(run, type, at, fields = {}) {
  if (run.events.length >= MAX_EVENTS || run.eventSeq >= Number.MAX_SAFE_INTEGER) {
    throw capacityError('Run event capacity has been reached', 'event-capacity');
  }
  run.eventSeq += 1;
  run.events.push({ seq: run.eventSeq, type, at, ...fields });
}

/**
 * Project the largest terminal write an app-generated active record must still
 * be able to accept. It dominates both crash recovery and an explicit
 * finishRun: interrupted is the longest status/reason, every live visit is
 * closed, and one maximum-size encrypted operation proof is reserved.
 */
function terminalCapacityProjection(run) {
  const closedVisitCount = run.blocks.reduce(
    (count, visit) => count + (visit.status === BLOCK_STATUS.RUNNING ? 1 : 0),
    0
  );
  return {
    ...run,
    revision: run.revision + 1,
    eventSeq: run.eventSeq + 1,
    status: RUN_STATUS.INTERRUPTED,
    updatedAt: TERMINAL_CAPACITY_TIMESTAMP,
    finishedAt: TERMINAL_CAPACITY_TIMESTAMP,
    // Reserve room for the one-time truncated marker a capacity degrade
    // writes to an active record. An actual marker is never larger.
    truncated: run.truncated ?? {
      reason: TERMINAL_CAPACITY_REASON,
      at: TERMINAL_CAPACITY_TIMESTAMP,
    },
    blocks: run.blocks.map(visit => (
      visit.status === BLOCK_STATUS.RUNNING
        ? {
            ...visit,
            status: BLOCK_STATUS.INTERRUPTED,
            finishedAt: TERMINAL_CAPACITY_TIMESTAMP,
            reasonCode: 'process-recovery',
          }
        : visit
    )),
    operations: [
      ...run.operations,
      {
        opId: TERMINAL_CAPACITY_OP_ID,
        action: 'finish-run',
        proof: {
          storage: STORAGE.ENCRYPTED,
          ciphertext: TERMINAL_CAPACITY_CIPHERTEXT,
        },
        at: TERMINAL_CAPACITY_TIMESTAMP,
        refId: null,
      },
    ],
    events: [
      ...run.events,
      {
        seq: run.eventSeq + 1,
        type: 'run.interrupted',
        at: TERMINAL_CAPACITY_TIMESTAMP,
        status: RUN_STATUS.INTERRUPTED,
        reasonCode: 'process-recovery',
        closedVisitCount,
      },
    ],
  };
}

function operationFingerprint(action, payload) {
  return sha256(stableJson({ action, payload }, `${action} operation`));
}

function retentionPlanDigest(policy, candidates) {
  return sha256(stableJson({
    version: 1,
    policy,
    candidates: candidates.map(candidate => ({
      id: candidate.id,
      revision: candidate.revision,
    })),
  }, 'retention preview'));
}

class RunJournal {
  constructor({
    dir,
    encryption = null,
    now = () => new Date(),
    randomUUID = () => crypto.randomUUID(),
    onError = null,
    memoryMaxBytes = MAX_MEMORY_BYTES,
    memoryMaxEntries = MAX_MEMORY_ENTRIES,
    recordMaxBytes = MAX_RUN_RECORD_BYTES,
    writeRecord = writeJsonAtomic,
    writeMigrationBackup = writeJsonAtomic,
    writeRetentionTransaction = writeJsonAtomic,
    writeRetentionReceipts = writeJsonAtomic,
    writeDeleteTransaction = writeJsonAtomic,
    deleteRecord = file => fs.unlinkSync(file),
    deleteMigrationBackup = file => fs.unlinkSync(file),
    deleteLegacyIndex = file => fs.unlinkSync(file),
    onMutationBoundary = null,
  } = {}) {
    if (typeof dir !== 'string' || !dir.trim()) {
      throw new RunJournalError('Run Journal dir is required', 'invalid-input');
    }
    if (typeof now !== 'function' || typeof randomUUID !== 'function') {
      throw new RunJournalError('Run Journal clock and UUID source must be functions', 'invalid-input');
    }
    if (onError !== null && typeof onError !== 'function') {
      throw new RunJournalError('Run Journal onError must be a function', 'invalid-input');
    }
    if (onMutationBoundary !== null && typeof onMutationBoundary !== 'function') {
      throw new RunJournalError(
        'Run Journal mutation boundary hook must be a function',
        'invalid-input'
      );
    }
    if (
      typeof writeRecord !== 'function'
      || typeof writeMigrationBackup !== 'function'
      || typeof writeRetentionTransaction !== 'function'
      || typeof writeRetentionReceipts !== 'function'
      || typeof writeDeleteTransaction !== 'function'
      || typeof deleteRecord !== 'function'
      || typeof deleteMigrationBackup !== 'function'
      || typeof deleteLegacyIndex !== 'function'
    ) {
      throw new RunJournalError(
        'Run Journal storage adapters must be functions',
        'invalid-input'
      );
    }
    if (
      !Number.isSafeInteger(recordMaxBytes)
      || recordMaxBytes <= 0
      || recordMaxBytes > MAX_RUN_RECORD_BYTES
    ) {
      throw new RunJournalError(
        'Run Journal recordMaxBytes is outside the supported range',
        'invalid-input'
      );
    }
    this.dir = path.resolve(dir);
    this.encryption = encryption;
    this.now = now;
    this.randomUUID = randomUUID;
    this.onError = onError;
    this.writeRecord = writeRecord;
    this.writeMigrationBackup = writeMigrationBackup;
    this.writeRetentionTransaction = writeRetentionTransaction;
    this.writeRetentionReceipts = writeRetentionReceipts;
    this.writeDeleteTransaction = writeDeleteTransaction;
    this.deleteRecord = deleteRecord;
    this.deleteMigrationBackup = deleteMigrationBackup;
    this.deleteLegacyIndex = deleteLegacyIndex;
    this.onMutationBoundary = onMutationBoundary;
    this.recordMaxBytes = recordMaxBytes;
    this.memory = new BoundedMemoryStore({
      maxBytes: memoryMaxBytes,
      maxEntries: memoryMaxEntries,
    });
    this._locks = new Map();
    this._pruned = new Map();
    this._retentionPreviews = new Map();
    this._retentionTransactionCache = null;
    this._deleteTransactionCache = null;
    this._index = null;
    this._indexEntries = new Map();
  }

  async migrateV1Records() {
    return this._withLock('retention', () => this._withLock('migration', async () => {
      let skippedCount = 0;
      let entries;
      try {
        entries = readJsonDir(
          this.dir,
          (file, error) => {
            this._report(file, error);
            skippedCount += 1;
          },
          { maxFileBytes: this.recordMaxBytes }
        );
      } catch (_error) {
        throw new RunJournalError(
          'Run Journal records could not be listed for migration',
          'migration-failed'
        );
      }

      const migratedRunIds = [];
      for (const { file, data } of entries) {
        if (!isPlainObject(data)) {
          skippedCount += 1;
          this._report(
            file,
            new RunJournalError('Run Journal migration found an invalid record', 'corrupt-run')
          );
          continue;
        }
        if (data.schemaVersion === SCHEMA_VERSION) {
          try {
            assertStoredRun(data);
            if (file !== `${data.id}.json`) {
              throw new RunJournalError('Run id does not match its filename', 'corrupt-run');
            }
          } catch (error) {
            skippedCount += 1;
            this._report(file, error);
          }
          continue;
        }
        if (data.schemaVersion !== LEGACY_SCHEMA_VERSION) {
          skippedCount += 1;
          this._report(
            file,
            new RunJournalError(
              'Run Journal migration found an unsupported schema',
              'unsupported-schema'
            )
          );
          continue;
        }

        const migratedAt = this._timestamp();
        let migrated;
        try {
          migrated = migrateStoredRunV1(data, migratedAt);
          if (file !== `${migrated.id}.json`) {
            throw new RunJournalError('V1 run id does not match its filename', 'corrupt-run');
          }
        } catch (error) {
          skippedCount += 1;
          this._report(file, error);
          continue;
        }

        await this._withLock(`run:${migrated.id}`, async () => {
          let current;
          try {
            current = readJsonStrict(this._filePath(migrated.id), {
              maxFileBytes: this.recordMaxBytes,
            });
          } catch (_error) {
            throw new RunJournalError(
              'The v1 Run Journal record changed during migration',
              'migration-failed'
            );
          }
          if (stableJson(current) !== stableJson(data)) {
            throw new RunJournalError(
              'The v1 Run Journal record changed during migration',
              'migration-failed'
            );
          }

          const backupPath = this._v1MigrationBackupPath(migrated.id);
          if (fs.existsSync(backupPath)) {
            let backup;
            try {
              backup = readJsonStrict(backupPath, { maxFileBytes: this.recordMaxBytes });
            } catch (_error) {
              throw new RunJournalError(
                'The existing v1 migration backup is unreadable',
                'migration-failed'
              );
            }
            if (stableJson(backup) !== stableJson(data)) {
              throw new RunJournalError(
                'The existing v1 migration backup does not match its source record',
                'migration-failed'
              );
            }
          } else {
            this._mutationBoundary('migration-backup', 'before', migrated.id);
            try {
              this.writeMigrationBackup(backupPath, data);
            } catch (_error) {
              throw new RunJournalError(
                'The v1 Run Journal backup could not be written',
                'migration-failed'
              );
            }
            this._mutationBoundary('migration-backup', 'after', migrated.id);
          }

          this._markIndexDirty();
          this._mutationBoundary('migration-record', 'before', migrated.id);
          try {
            this.writeRecord(this._filePath(migrated.id), migrated);
          } catch (_error) {
            throw new RunJournalError(
              'The v2 Run Journal record could not be written',
              'migration-failed'
            );
          }
          this._mutationBoundary('migration-record', 'after', migrated.id);
        });
        migratedRunIds.push(migrated.id);
      }

      if (migratedRunIds.length) {
        this._clearIndex();
        this._rebuildIndex();
      }
      const legacyIndexCleanup = this._removeLegacyIndexFiles();
      return {
        fromSchemaVersion: LEGACY_SCHEMA_VERSION,
        toSchemaVersion: SCHEMA_VERSION,
        migratedRunIds,
        migratedCount: migratedRunIds.length,
        skippedCount,
        removedLegacyIndexFiles: legacyIndexCleanup.removed,
        legacyIndexCleanupFailures: legacyIndexCleanup.failed,
      };
    }));
  }

  async startRun(input) {
    const raw = asObject(input, 'startRun payload');
    assertOnlyKeys(raw, new Set(['workflow', 'trigger', 'opId']), 'startRun payload');
    const opId = asOpId(raw.opId);
    const workflow = normalizeWorkflowSnapshot(raw.workflow);
    const trigger = normalizeTrigger(raw.trigger);
    const fingerprint = operationFingerprint('start-run', {
      workflowSnapshot: workflow.plaintext,
      workflow: workflow.metadata,
      trigger,
    });

    return this._withLock('retention', () => this._withLock(
      'start',
      () => this._withLock('memory', async () => {
      this._assertNoPendingRetentionMutation();
      for (const run of this._loadAllRuns()) {
        const operation = run.operations.find(entry => entry.opId === opId);
        if (!operation) continue;
        await this._assertReplay(run, operation, 'start-run', fingerprint);
        return publicRun(run);
      }

      const runId = this._newUuid(new Set(), { mustNotExist: true });
      // Validate the clock before any memory-only allocation can evict older
      // terminal payloads. Everything after the allocations is either
      // non-throwing record assembly or covered by the rollback around write.
      const at = this._timestamp();
      const secured = await this._securePayload(
        workflow.plaintext,
        { kind: 'workflow', runId },
        this._workflowMemoryKey(runId),
        MAX_WORKFLOW_CIPHERTEXT_BYTES
      );
      let proof;
      try {
        proof = await this._secureOperationProof(runId, opId, fingerprint);
      } catch (error) {
        if (secured.rollback) secured.rollback();
        throw error;
      }
      const run = {
        schemaVersion: SCHEMA_VERSION,
        id: runId,
        rootRunId: runId,
        parentRunId: null,
        attempt: 1,
        revision: 1,
        eventSeq: 0,
        status: RUN_STATUS.RUNNING,
        startedAt: at,
        updatedAt: at,
        finishedAt: null,
        workflow: workflow.metadata,
        trigger,
        snapshot: {
          storage: secured.storage,
          byteLength: workflow.byteLength,
          ...(secured.ciphertext ? { ciphertext: secured.ciphertext } : {}),
        },
        migration: null,
        controlCheckpoints: [],
        boundaryReviews: [],
        blocks: [],
        results: [],
        operations: [{
          opId,
          action: 'start-run',
          proof: {
            storage: proof.storage,
            ...(proof.ciphertext ? { ciphertext: proof.ciphertext } : {}),
          },
          at,
          refId: null,
        }],
        events: [],
      };
      appendEvent(run, 'run.started', at);
      try {
        this._writeRun(run);
      } catch (error) {
        if (proof.rollback) proof.rollback();
        if (secured.rollback) secured.rollback();
        throw error;
      }
      return publicRun(run);
      })
    ));
  }

  async startBlock(input) {
    const raw = asObject(input, 'startBlock payload');
    assertOnlyKeys(
      raw,
      new Set([
        'runId',
        'opId',
        'block',
        'blockId',
        'blockIndex',
        'blockType',
        'iterationPath',
        'lanes',
        'laneDescriptors',
      ]),
      'startBlock payload'
    );
    const runId = asRunId(raw.runId);
    const opId = asOpId(raw.opId);
    const block = normalizeBlockInput(raw);
    const lanes = normalizeLanesFromInput(raw);
    const fingerprint = operationFingerprint('start-block', { block, lanes });

    return this._mutate({
      runId,
      opId,
      action: 'start-block',
      fingerprint,
      replay: (run, operation) => {
        const visit = run.blocks.find(entry => entry.visitId === operation.refId);
        if (!visit) throw new RunJournalError('Replayed block visit is missing', 'corrupt-run');
        return publicBlock(visit);
      },
      degraded: (run, at, context) => ({
        visitId: context.id,
        blockId: block.blockId,
        blockIndex: block.blockIndex,
        blockType: block.blockType,
        iterationPath: clonePublic(block.iterationPath),
        lanes: clonePublic(lanes),
        status: BLOCK_STATUS.RUNNING,
        startedAt: at,
        finishedAt: null,
        reasonCode: null,
        truncated: true,
        durable: false,
      }),
      apply: async (run, at) => {
        this._assertActive(run);
        if (run.blocks.length >= MAX_BLOCK_VISITS) {
          throw capacityError('Run block visit capacity has been reached', 'visit-capacity');
        }
        if (block.blockIndex !== null && block.blockIndex >= run.workflow.blockCount) {
          throw new RunJournalError('block index is outside the workflow snapshot', 'invalid-input');
        }
        const visitId = this._newUuid(new Set(run.blocks.map(entry => entry.visitId)));
        const visit = {
          visitId,
          blockId: block.blockId,
          blockIndex: block.blockIndex,
          blockType: block.blockType,
          iterationPath: block.iterationPath,
          lanes,
          status: BLOCK_STATUS.RUNNING,
          startedAt: at,
          finishedAt: null,
          reasonCode: null,
        };
        run.blocks.push(visit);
        appendEvent(run, 'block.started', at, {
          visitId,
          blockId: block.blockId,
        });
        return { refId: visitId, value: () => publicBlock(visit) };
      },
    });
  }

  async finishBlock(input) {
    const raw = asObject(input, 'finishBlock payload');
    assertOnlyKeys(
      raw,
      new Set(['runId', 'visitId', 'status', 'reasonCode', 'opId']),
      'finishBlock payload'
    );
    const runId = asRunId(raw.runId);
    const visitId = asRunId(raw.visitId, 'visitId');
    const opId = asOpId(raw.opId);
    if (!BLOCK_FINISH_VALUES.has(raw.status)) {
      throw new RunJournalError(
        `Block status must be one of: ${BLOCK_FINISH_STATES.join(', ')}`,
        'invalid-state'
      );
    }
    const status = raw.status;
    const reasonCode = asSlug(raw.reasonCode, 'reasonCode', { optional: true });
    const fingerprint = operationFingerprint('finish-block', {
      visitId,
      status,
      reasonCode,
    });

    return this._mutate({
      runId,
      opId,
      action: 'finish-block',
      fingerprint,
      replay: (run) => {
        const visit = run.blocks.find(entry => entry.visitId === visitId);
        if (!visit) throw new RunJournalError('Replayed block visit is missing', 'corrupt-run');
        return publicBlock(visit);
      },
      degraded: (run, at) => {
        const visit = run.blocks.find(entry => entry.visitId === visitId);
        if (visit && visit.status !== BLOCK_STATUS.RUNNING) {
          return { ...publicBlock(visit), truncated: true, durable: false };
        }
        return {
          visitId,
          blockId: visit ? visit.blockId : null,
          blockIndex: visit ? visit.blockIndex : null,
          blockType: visit ? visit.blockType : null,
          iterationPath: visit ? clonePublic(visit.iterationPath) : [],
          lanes: visit ? clonePublic(visit.lanes) : [],
          status,
          startedAt: visit ? visit.startedAt : at,
          finishedAt: at,
          reasonCode,
          truncated: true,
          durable: false,
        };
      },
      apply: async (run, at) => {
        this._assertActive(run);
        const visit = run.blocks.find(entry => entry.visitId === visitId);
        if (!visit) throw new RunJournalError('Block visit was not found', 'not-found');
        if (visit.status !== BLOCK_STATUS.RUNNING) {
          throw new RunJournalError('Block visit is already terminal', 'invalid-state');
        }
        visit.status = status;
        visit.finishedAt = at;
        visit.reasonCode = reasonCode;
        appendEvent(run, 'block.finished', at, {
          visitId,
          blockId: visit.blockId,
          status,
          ...(reasonCode ? { reasonCode } : {}),
        });
        return { refId: visitId, value: () => publicBlock(visit) };
      },
    });
  }

  async storeResult(input) {
    const raw = asObject(input, 'storeResult payload');
    assertOnlyKeys(
      raw,
      new Set([
        'runId',
        'producerBlockId',
        'visitId',
        'name',
        'status',
        'lanes',
        'laneDescriptors',
        'body',
        'opId',
      ]),
      'storeResult payload'
    );
    const runId = asRunId(raw.runId);
    const producerBlockId = asPublicId(raw.producerBlockId, 'producerBlockId');
    const visitId = asRunId(raw.visitId, 'visitId');
    const name = asText(raw.name, 'result name', { maxBytes: 512, trim: true });
    if (!RESULT_STATUS_VALUES.has(raw.status)) {
      throw new RunJournalError(
        'Result status must be "complete" or "partial"',
        'invalid-state'
      );
    }
    const status = raw.status;
    const lanes = normalizeLanesFromInput(raw);
    const body = asText(raw.body, 'result body', {
      maxBytes: MAX_RESULT_BYTES,
      minBytes: 0,
      controls: true,
    });
    const byteLength = utf8ByteLength(body);
    const opId = asOpId(raw.opId);
    const fingerprint = operationFingerprint('store-result', {
      producerBlockId,
      visitId,
      name,
      status,
      lanes,
      byteLength,
      body,
    });

    return this._mutate({
      runId,
      opId,
      action: 'store-result',
      fingerprint,
      replay: (run, operation) => {
        const result = run.results.find(entry => entry.id === operation.refId);
        if (!result) throw new RunJournalError('Replayed result is missing', 'corrupt-run');
        return publicResult(result);
      },
      degraded: (run, at, context) => ({
        id: context.id,
        producerBlockId,
        visitId,
        name,
        status,
        lanes: clonePublic(lanes),
        createdAt: at,
        byteLength,
        storage: null,
        truncated: true,
        durable: false,
      }),
      apply: async (run, at) => {
        this._assertActive(run);
        if (run.results.length >= MAX_RESULTS) {
          throw new RunJournalError('Run result capacity has been reached', 'size-limit');
        }
        const aggregateBytes = run.results.reduce(
          (sum, result) => sum + result.byteLength,
          0
        );
        if (aggregateBytes + byteLength > MAX_RUN_RESULT_BYTES) {
          throw new RunJournalError(
            `Run result bodies would exceed ${MAX_RUN_RESULT_BYTES} UTF-8 bytes`,
            'size-limit'
          );
        }
        if (run.events.length >= MAX_EVENTS) {
          throw capacityError('Run event capacity has been reached', 'event-capacity');
        }
        const visit = run.blocks.find(entry => entry.visitId === visitId);
        if (!visit) {
          throw new RunJournalError('Result producer visit was not found', 'not-found');
        }
        if (visit.blockId !== producerBlockId) {
          throw new RunJournalError(
            'Result producerBlockId does not match its visit',
            'invalid-input'
          );
        }

        const resultId = this._newUuid(new Set(run.results.map(entry => entry.id)));
        const secured = await this._securePayload(
          body,
          { kind: 'result', runId, resultId },
          this._resultMemoryKey(runId, resultId),
          MAX_RESULT_CIPHERTEXT_BYTES
        );
        const result = {
          id: resultId,
          producerBlockId,
          visitId,
          name,
          status,
          lanes,
          createdAt: at,
          byteLength,
          storage: secured.storage,
          ...(secured.ciphertext ? { ciphertext: secured.ciphertext } : {}),
        };
        run.results.push(result);
        appendEvent(run, 'result.stored', at, {
          resultId,
          producerBlockId,
          visitId,
          status,
        });
        return {
          refId: resultId,
          rollback: secured.rollback,
          value: () => publicResult(result),
        };
      },
    });
  }

  async storeControlCheckpoint(input) {
    const raw = asObject(input, 'storeControlCheckpoint payload');
    assertOnlyKeys(
      raw,
      new Set(['runId', 'sourceRevision', 'afterVisitId', 'state', 'opId']),
      'storeControlCheckpoint payload'
    );
    const runId = asRunId(raw.runId);
    const sourceRevision = asPositiveInt(raw.sourceRevision, 'sourceRevision');
    const afterVisitId = asRunId(raw.afterVisitId, 'afterVisitId');
    const opId = asOpId(raw.opId);
    const checkpoint = normalizeControlCheckpointState(raw.state);
    const fingerprint = operationFingerprint('store-control-checkpoint', {
      sourceRevision,
      afterVisitId,
      state: checkpoint.plaintext,
    });

    return this._mutate({
      runId,
      opId,
      action: 'store-control-checkpoint',
      mutationKind: 'control-checkpoint',
      fingerprint,
      replay: (run, operation) => {
        const stored = run.controlCheckpoints.find(entry => entry.id === operation.refId);
        if (!stored) {
          throw new RunJournalError('Replayed control checkpoint is missing', 'corrupt-run');
        }
        return publicControlCheckpoint(stored);
      },
      apply: async (run, at) => {
        this._assertActive(run);
        if (run.truncated) {
          throw new RunJournalError(
            'A truncated run cannot accept a control checkpoint',
            'invalid-state'
          );
        }
        if (run.revision !== sourceRevision) {
          throw new RunJournalError(
            'The source run changed before its control checkpoint was stored',
            'stale-source'
          );
        }
        if (run.controlCheckpoints.length >= MAX_BLOCK_VISITS) {
          throw new RunJournalError('Control checkpoint capacity has been reached', 'size-limit');
        }
        const visit = run.blocks.find(entry => entry.visitId === afterVisitId);
        if (
          !visit
          || !BLOCK_TERMINAL_VALUES.has(visit.status)
          || run.blocks.at(-1)?.visitId !== afterVisitId
        ) {
          throw new RunJournalError(
            'Control checkpoint must follow the last committed block visit',
            'invalid-state'
          );
        }
        if (run.controlCheckpoints.some(entry => entry.afterVisitId === afterVisitId)) {
          throw new RunJournalError(
            'The last committed visit already has a control checkpoint',
            'invalid-state'
          );
        }
        const checkpointId = this._newUuid(
          new Set([
            run.id,
            ...run.blocks.map(entry => entry.visitId),
            ...run.results.map(entry => entry.id),
            ...run.controlCheckpoints.map(entry => entry.id),
          ])
        );
        const context = {
          kind: 'control-checkpoint',
          runId,
          visitId: afterVisitId,
          sourceRevision,
          checkpointId,
        };
        const secured = await this._secureEncryptedPayload(
          checkpoint.plaintext,
          context,
          MAX_CONTROL_CHECKPOINT_CIPHERTEXT_BYTES
        );
        const stored = {
          id: checkpointId,
          stateVersion: CONTROL_CHECKPOINT_VERSION,
          sourceRunId: runId,
          sourceRevision,
          afterVisitId,
          storage: STORAGE.ENCRYPTED,
          byteLength: checkpoint.byteLength,
          createdAt: at,
          ciphertext: secured.ciphertext,
        };
        run.controlCheckpoints.push(stored);
        appendEvent(run, 'control.checkpoint-stored', at, {
          visitId: afterVisitId,
          checkpointId,
        });
        return {
          refId: checkpointId,
          value: () => publicControlCheckpoint(stored),
        };
      },
    });
  }

  async recordBoundaryDisposition(input) {
    const raw = asObject(input, 'recordBoundaryDisposition payload');
    assertOnlyKeys(
      raw,
      new Set(['runId', 'sourceRevision', 'visitId', 'disposition', 'opId']),
      'recordBoundaryDisposition payload'
    );
    const runId = asRunId(raw.runId);
    const sourceRevision = asPositiveInt(raw.sourceRevision, 'sourceRevision');
    const visitId = asRunId(raw.visitId, 'visitId');
    if (!BOUNDARY_DISPOSITION_VALUES.has(raw.disposition)) {
      throw new RunJournalError(
        'Boundary disposition must be abort, skip, or retry',
        'invalid-input'
      );
    }
    const disposition = raw.disposition;
    const opId = asOpId(raw.opId);
    const fingerprint = operationFingerprint('record-boundary-disposition', {
      sourceRevision,
      visitId,
      disposition,
    });

    return this._mutate({
      runId,
      opId,
      action: 'record-boundary-disposition',
      mutationKind: 'boundary-disposition',
      fingerprint,
      replay: (run, operation) => {
        const review = run.boundaryReviews.find(entry => (
          entry.visitId === operation.refId
          && entry.sourceRevision === sourceRevision
          && entry.disposition === disposition
        ));
        if (!review) {
          throw new RunJournalError('Replayed boundary review is missing', 'corrupt-run');
        }
        return publicBoundaryReview(review);
      },
      apply: async (run, at) => {
        if (run.revision !== sourceRevision) {
          throw new RunJournalError(
            'The source run changed before its boundary disposition was recorded',
            'stale-source'
          );
        }
        if (run.status !== RUN_STATUS.INTERRUPTED) {
          throw new RunJournalError(
            'Boundary disposition requires an interrupted source run',
            'invalid-state'
          );
        }
        if (run.boundaryReviews.length >= MAX_BOUNDARY_REVIEWS) {
          throw new RunJournalError('Boundary review capacity has been reached', 'size-limit');
        }
        if (run.boundaryReviews.some(review => review.visitId === visitId)) {
          throw new RunJournalError(
            'The uncertain visit already has a boundary disposition',
            'invalid-state'
          );
        }
        const visit = run.blocks.find(entry => entry.visitId === visitId);
        if (
          !visit
          || run.blocks.at(-1)?.visitId !== visitId
          || ![
            BLOCK_STATUS.FAILED,
            BLOCK_STATUS.CANCELLED,
            BLOCK_STATUS.INTERRUPTED,
          ].includes(visit.status)
        ) {
          throw new RunJournalError(
            'Boundary disposition requires the final uncertain visit',
            'invalid-state'
          );
        }
        const review = {
          visitId,
          sourceRevision,
          disposition,
          reviewedAt: at,
        };
        run.boundaryReviews.push(review);
        appendEvent(run, 'boundary.disposition-recorded', at, {
          visitId,
          disposition,
        });
        return {
          refId: visitId,
          value: () => publicBoundaryReview(review),
        };
      },
    });
  }

  async finishRun(input) {
    const raw = asObject(input, 'finishRun payload');
    assertOnlyKeys(raw, new Set(['runId', 'status', 'opId']), 'finishRun payload');
    const runId = asRunId(raw.runId);
    const opId = asOpId(raw.opId);
    if (!RUN_FINISH_VALUES.has(raw.status)) {
      throw new RunJournalError(
        `Run status must be one of: ${RUN_FINISH_STATES.join(', ')}`,
        'invalid-state'
      );
    }
    const status = raw.status;
    const fingerprint = operationFingerprint('finish-run', { status });

    return this._mutate({
      runId,
      opId,
      action: 'finish-run',
      fingerprint,
      replay: run => publicRun(run),
      apply: async (run, at) => {
        this._assertActive(run);
        const activeVisits = run.blocks.filter(
          block => block.status === BLOCK_STATUS.RUNNING
        );
        if (status === RUN_STATUS.COMPLETED && activeVisits.length > 0 && !run.truncated) {
          throw new RunJournalError(
            'A completed run cannot contain running block visits',
            'invalid-state'
          );
        }
        // A truncated journal stopped observing its visits: they may well
        // have finished, so close them as interrupted rather than claiming
        // a failure or cancellation the journal never saw.
        const childStatus = run.truncated
          ? BLOCK_STATUS.INTERRUPTED
          : status === RUN_STATUS.CANCELLED
            ? BLOCK_STATUS.CANCELLED
            : BLOCK_STATUS.FAILED;
        for (const visit of activeVisits) {
          visit.status = childStatus;
          visit.finishedAt = at;
          visit.reasonCode = run.truncated ? 'journal-truncated' : 'run-finished';
        }
        run.status = status;
        run.finishedAt = at;
        appendEvent(run, 'run.finished', at, {
          status,
          closedVisitCount: activeVisits.length,
        });
        return { refId: null, value: () => publicRun(run) };
      },
    });
  }

  async listRuns(options = {}) {
    const raw = options === undefined || options === null
      ? {}
      : asObject(options, 'listRuns options');
    assertOnlyKeys(raw, new Set(['limit', 'cursor']), 'listRuns options');
    const limit = raw.limit === undefined
      ? 100
      : asPositiveInt(raw.limit, 'limit', { max: 1000 });
    const cursor = raw.cursor === undefined || raw.cursor === null || raw.cursor === ''
      ? null
      : decodeRunCursor(raw.cursor);
    const index = this._ensureIndex();
    const start = pageStartAfterCursor(index.runs, cursor);
    const page = index.runs.slice(start, start + limit);
    return {
      runs: page.map(summary => clonePublic(summary)),
      nextCursor: start + page.length < index.runs.length && page.length > 0
        ? encodeRunCursor(page.at(-1))
        : null,
      total: index.runs.length,
    };
  }

  async pruneRuns(input) {
    return this._withLock('retention', () => this._pruneRuns(input));
  }

  async recoverPrune() {
    return this._withLock('retention', async () => {
      const deletion = this._readDeleteTransaction();
      if (deletion?.status === DELETE_TRANSACTION_STATUS.APPLYING) {
        throw new RunJournalError(
          'A confirmed delete transaction still needs recovery',
          'delete-incomplete'
        );
      }
      const transaction = this._readRetentionTransaction();
      if (!transaction) return { recovered: false, result: null };
      if (isRetentionTerminal(transaction)) {
        this._recordRetentionReceipt(transaction);
        return { recovered: false, result: clonePublic(transaction.result) };
      }
      const result = this._applyRetentionTransaction(transaction);
      return { recovered: true, result };
    });
  }

  async recoverDelete() {
    return this._withLock('retention', async () => {
      const transaction = this._readDeleteTransaction();
      if (!transaction || transaction.status === DELETE_TRANSACTION_STATUS.COMMITTED) {
        return { recovered: false, result: transaction?.result || null };
      }
      const result = this._applyDeleteTransaction(transaction);
      return { recovered: true, result };
    });
  }

  async _pruneRuns(input) {
    const deletion = this._readDeleteTransaction();
    if (deletion?.status === DELETE_TRANSACTION_STATUS.APPLYING) {
      throw new RunJournalError(
        'A confirmed delete transaction still needs recovery',
        'delete-incomplete'
      );
    }
    const raw = input === undefined || input === null
      ? {}
      : asObject(input, 'pruneRuns payload');
    assertOnlyKeys(
      raw,
      new Set([
        'maxRuns',
        'maxAgeDays',
        'preview',
        'cutoff',
        'previewToken',
        'opId',
      ]),
      'pruneRuns payload'
    );
    const maxRuns = raw.maxRuns === undefined || raw.maxRuns === null
      ? null
      : asPositiveInt(raw.maxRuns, 'maxRuns', { max: MAX_RETENTION_RUNS });
    const maxAgeDays = raw.maxAgeDays === undefined || raw.maxAgeDays === null
      ? null
      : asPositiveInt(raw.maxAgeDays, 'maxAgeDays', { max: MAX_RETENTION_AGE_DAYS });
    if (maxRuns === null && maxAgeDays === null) {
      throw new RunJournalError(
        'At least one retention limit is required',
        'invalid-input'
      );
    }
    const preview = raw.preview === undefined ? true : raw.preview;
    if (typeof preview !== 'boolean') {
      throw new RunJournalError('preview must be a boolean', 'invalid-input');
    }

    let cutoff = null;
    if (maxAgeDays !== null) {
      if (preview) {
        const evaluatedAt = this._timestamp();
        cutoff = new Date(
          Date.parse(evaluatedAt) - maxAgeDays * 24 * 60 * 60 * 1000
        ).toISOString();
      } else {
        if (!isIsoTimestamp(raw.cutoff)) {
          throw new RunJournalError(
            'A valid preview cutoff is required to prune by age',
            'invalid-input'
          );
        }
        cutoff = raw.cutoff;
      }
    } else if (raw.cutoff !== undefined && raw.cutoff !== null) {
      throw new RunJournalError(
        'cutoff is only valid with maxAgeDays',
        'invalid-input'
      );
    }

    const policy = { maxRuns, maxAgeDays, cutoff };
    const transaction = this._readRetentionTransaction();
    if (preview) {
      if (isRetentionPending(transaction)) {
        throw new RunJournalError(
          'A confirmed retention transaction still needs recovery',
          'prune-incomplete'
        );
      }
      const snapshot = this._retentionSnapshot();
      const plan = this._retentionPlan(snapshot.index, policy);
      const previewToken = this._issueRetentionPreview(policy, plan.candidates);
      return {
        preview: true,
        candidateCount: plan.candidates.length,
        terminalCount: plan.terminalCount,
        activeCount: plan.activeCount,
        protectedAncestorCount: plan.protectedAncestorCount,
        total: snapshot.index.runs.length,
        cutoff,
        previewToken,
      };
    }

    const suppliedToken = asText(raw.previewToken, 'previewToken', {
      maxBytes: 64,
      trim: true,
      pattern: PREVIEW_TOKEN_PATTERN,
    });
    const opId = asOpId(raw.opId);
    if (transaction?.opId === opId) {
      const fingerprint = operationFingerprint('prune-runs', {
        policy,
        previewToken: suppliedToken,
        planDigest: transaction.planDigest,
      });
      if (transaction.fingerprint !== fingerprint) {
        throw new RunJournalError(
          'Operation id was reused with a different retention plan',
          'op-conflict'
        );
      }
      if (isRetentionTerminal(transaction)) {
        this._recordRetentionReceipt(transaction);
        this._rememberPrune(opId, {
          fingerprint,
          planDigest: transaction.planDigest,
          result: transaction.result,
        });
        return clonePublic(transaction.result);
      }
      return this._applyRetentionTransaction(transaction);
    }
    if (isRetentionPending(transaction)) {
      throw new RunJournalError(
        'A confirmed retention transaction still needs recovery',
        'prune-incomplete'
      );
    }
    if (isRetentionTerminal(transaction)) this._recordRetentionReceipt(transaction);
    const durableReplay = this._findRetentionReceipt(opId);
    if (durableReplay) {
      const fingerprint = operationFingerprint('prune-runs', {
        policy,
        previewToken: suppliedToken,
        planDigest: durableReplay.planDigest,
      });
      if (durableReplay.fingerprint !== fingerprint) {
        throw new RunJournalError(
          'Operation id was reused with a different retention plan',
          'op-conflict'
        );
      }
      this._rememberPrune(opId, {
        fingerprint,
        planDigest: durableReplay.planDigest,
        result: durableReplay.result,
      });
      return clonePublic(durableReplay.result);
    }
    const replay = this._pruned.get(opId);
    if (replay) {
      const fingerprint = operationFingerprint('prune-runs', {
        policy,
        previewToken: suppliedToken,
        planDigest: replay.planDigest,
      });
      if (replay.fingerprint !== fingerprint) {
        throw new RunJournalError(
          'Operation id was reused with a different retention plan',
          'op-conflict'
        );
      }
      return clonePublic(replay.result);
    }

    const snapshot = this._retentionSnapshot();
    const plan = this._retentionPlan(snapshot.index, policy);
    this._assertRetentionPreview(suppliedToken, policy, plan.candidates);
    const previewToken = suppliedToken;
    const planDigest = this._retentionPlanDigest(policy, plan.candidates);
    const fingerprint = operationFingerprint('prune-runs', {
      policy,
      previewToken,
      planDigest,
    });

    const prepared = {
      schemaVersion: RETENTION_TRANSACTION_SCHEMA_VERSION,
      status: RETENTION_TRANSACTION_STATUS.PREPARED,
      opId,
      fingerprint,
      policy,
      previewToken,
      planDigest,
      candidates: plan.candidates.map(summary => ({
        id: summary.id,
        revision: summary.revision,
      })),
      startedAt: this._timestamp(),
      committedAt: null,
      result: null,
    };
    this._mutationBoundary('prune-transaction', 'before', null);
    this._writeRetentionTransaction(prepared);
    this._retentionPreviews.delete(previewToken);
    this._mutationBoundary('prune-transaction', 'after', null);
    return this._applyRetentionTransaction(prepared);
  }

  async getRun(input) {
    const runId = typeof input === 'string'
      ? asRunId(input)
      : (() => {
        const raw = asObject(input, 'getRun payload');
        assertOnlyKeys(raw, new Set(['runId']), 'getRun payload');
        return asRunId(raw.runId);
      })();
    return this._withLock('retention', () => {
      const run = this._readRunWithLineage(runId);
      return run ? publicRun(run) : null;
    });
  }

  /**
   * Explicit, revision-bound inspection of one interrupted run. Protected
   * bodies stay inside main; inspectResumeRun returns counts, stage states,
   * and redacted control addresses only. No session or execution is created.
   */
  async preflightResume(input, {
    resolveProfile = null,
    isDirectory = null,
  } = {}) {
    const raw = asObject(input, 'preflightResume payload');
    assertOnlyKeys(
      raw,
      new Set(['runId', 'sourceRevision']),
      'preflightResume payload'
    );
    const runId = asRunId(raw.runId);
    const sourceRevision = asPositiveInt(raw.sourceRevision, 'sourceRevision');

    return this._withLock('retention', () => this._withLock(`run:${runId}`, async () => {
      const run = this._readRunWithLineage(runId);
      if (!run) throw new RunJournalError('Run was not found', 'not-found');
      if (run.revision !== sourceRevision) {
        throw new RunJournalError(
          'The source run changed; reload it before inspecting resume evidence',
          'stale-source'
        );
      }
      return inspectResumeRun({
        run,
        readWorkflow: () => this._readWorkflowSnapshot(run),
        readResult: result => this._readResultBody(run, result),
        resolveProfile,
        isDirectory,
      });
    }));
  }

  async getResult(input) {
    const raw = asObject(input, 'getResult payload');
    assertOnlyKeys(raw, new Set(['runId', 'resultId']), 'getResult payload');
    const runId = asRunId(raw.runId);
    const resultId = asRunId(raw.resultId, 'resultId');
    return this._withLock('retention', () => this._withLock(`run:${runId}`, async () => {
      const run = this._readRunWithLineage(runId);
      if (!run) return null;
      const result = run.results.find(entry => entry.id === resultId);
      if (!result) return null;

      const body = await this._readResultBody(run, result);
      return { ...publicResult(result), body };
    }));
  }

  async _readWorkflowSnapshot(run) {
    if (run.snapshot.storage === STORAGE.MEMORY) {
      throw new RunJournalError('Workflow snapshot is unavailable', 'body-unavailable');
    }
    if (!await this._encryptionAvailable({ decrypt: true })) {
      throw new RunJournalError(
        'Encrypted workflow snapshot is unavailable on this system',
        'body-unavailable'
      );
    }

    let body;
    try {
      const context = { kind: 'workflow', runId: run.id };
      const decrypted = await this.encryption.decrypt(
        run.snapshot.ciphertext,
        context
      );
      body = decodeEncryptedEnvelope(decrypted, context);
    } catch (_error) {
      throw new RunJournalError(
        'Encrypted workflow snapshot could not be decrypted',
        'decrypt-failed'
      );
    }
    if (typeof body !== 'string' || utf8ByteLength(body) !== run.snapshot.byteLength) {
      throw new RunJournalError(
        'Workflow snapshot failed its integrity check',
        'integrity-failed'
      );
    }

    try {
      const workflow = JSON.parse(body);
      const normalized = normalizeWorkflowSnapshot(workflow);
      if (
        normalized.plaintext !== body
        || stableJson(normalized.metadata) !== stableJson(run.workflow)
      ) {
        throw new Error('snapshot metadata mismatch');
      }
      return workflow;
    } catch (_error) {
      throw new RunJournalError(
        'Workflow snapshot failed its integrity check',
        'integrity-failed'
      );
    }
  }

  async _readResultBody(run, result) {
    let body;
    if (result.storage === STORAGE.MEMORY) {
      body = await this._withLock('memory', async () => {
        const stored = this.memory.get(this._resultMemoryKey(run.id, result.id));
        if (stored === undefined) {
          throw new RunJournalError(
            'Result body is unavailable',
            'body-unavailable'
          );
        }
        return stored;
      });
    } else {
      if (!await this._encryptionAvailable({ decrypt: true })) {
        throw new RunJournalError(
          'Encrypted result body is unavailable on this system',
          'body-unavailable'
        );
      }
      try {
        const context = { kind: 'result', runId: run.id, resultId: result.id };
        const decrypted = await this.encryption.decrypt(
          result.ciphertext,
          context
        );
        body = decodeEncryptedEnvelope(decrypted, context);
      } catch (_error) {
        throw new RunJournalError(
          'Encrypted result body could not be decrypted',
          'decrypt-failed'
        );
      }
      if (typeof body !== 'string') {
        throw new RunJournalError(
          'Encryption adapter returned a non-text result body',
          'decrypt-failed'
        );
      }
    }

    if (utf8ByteLength(body) !== result.byteLength) {
      throw new RunJournalError(
        'Result body failed its integrity check',
        'integrity-failed'
      );
    }
    return body;
  }

  async _readControlCheckpoint(run, checkpoint) {
    if (checkpoint.storage !== STORAGE.ENCRYPTED) {
      throw new RunJournalError(
        'Control checkpoint is not durably protected',
        'body-unavailable'
      );
    }
    if (!await this._encryptionAvailable({ decrypt: true })) {
      throw new RunJournalError(
        'Encrypted control checkpoint is unavailable on this system',
        'body-unavailable'
      );
    }

    const context = {
      kind: 'control-checkpoint',
      runId: run.id,
      visitId: checkpoint.afterVisitId,
      sourceRevision: checkpoint.sourceRevision,
      checkpointId: checkpoint.id,
    };
    let body;
    try {
      const decrypted = await this.encryption.decrypt(
        checkpoint.ciphertext,
        context
      );
      body = decodeEncryptedEnvelope(decrypted, context);
    } catch (_error) {
      throw new RunJournalError(
        'Encrypted control checkpoint could not be decrypted',
        'decrypt-failed'
      );
    }
    if (utf8ByteLength(body) !== checkpoint.byteLength) {
      throw new RunJournalError(
        'Control checkpoint failed its integrity check',
        'integrity-failed'
      );
    }

    try {
      const normalized = normalizeControlCheckpointState(JSON.parse(body));
      if (
        normalized.plaintext !== body
        || normalized.state.version !== checkpoint.stateVersion
      ) {
        throw new Error('control checkpoint metadata mismatch');
      }
      return normalized.state;
    } catch (_error) {
      throw new RunJournalError(
        'Control checkpoint failed its integrity check',
        'integrity-failed'
      );
    }
  }

  async recoverInterrupted() {
    return this._withLock('retention', () => this._recoverInterrupted());
  }

  async _recoverInterrupted() {
    const recovered = [];
    let failureCount = 0;
    // Recovery already has to validate every durable record to contain an
    // unknown active run. Reuse that one sweep to refresh the derived index,
    // rather than making the first Runs view pay a second full scan.
    this._markIndexDirty();
    this._clearIndex();
    // A record rejected by the initial scan could itself be a durable active
    // run. Recover every valid candidate we can, then fail containment closed
    // if any record's disposition remained unknowable.
    const candidates = this._loadAllRuns({
      onRecordError: () => {
        failureCount += 1;
      },
    });
    const summaries = new Map(
      candidates.map(candidate => [candidate.id, runSummary(candidate)])
    );
    for (const candidate of candidates) {
      if (candidate.status !== RUN_STATUS.RUNNING) continue;
      try {
        const outcome = await this._withLock(`run:${candidate.id}`, async () => {
          // The initial scan established that this was a valid active record.
          // A missing file no longer represents active durable state, but any
          // other re-read failure leaves its disposition unknown and must fail
          // renderer-loss containment closed.
          const run = this._readRun(candidate.id, { throwOnError: true });
          if (!run) return { missing: true };
          if (run.status !== RUN_STATUS.RUNNING) {
            return { summary: runSummary(run), recovered: null };
          }
          const at = this._timestamp();
          let closedVisitCount = 0;
          for (const visit of run.blocks) {
            if (visit.status !== BLOCK_STATUS.RUNNING) continue;
            visit.status = BLOCK_STATUS.INTERRUPTED;
            visit.finishedAt = at;
            visit.reasonCode = 'process-recovery';
            closedVisitCount += 1;
          }
          run.status = RUN_STATUS.INTERRUPTED;
          run.finishedAt = at;
          run.updatedAt = at;
          this._advanceRevision(run);
          appendEvent(run, 'run.interrupted', at, { closedVisitCount });
          this._writeRun(run);
          return { summary: runSummary(run), recovered: publicRun(run) };
        });
        if (outcome?.missing) summaries.delete(candidate.id);
        if (outcome?.summary) summaries.set(candidate.id, outcome.summary);
        if (outcome?.recovered) recovered.push(outcome.recovered);
      } catch (error) {
        failureCount += 1;
        this._report(`${candidate.id}.json`, error);
      }
    }
    if (failureCount > 0) {
      throw new RunJournalError(
        'One or more active runs could not be recovered',
        'recovery-failed'
      );
    }
    this._persistIndex(makeSummaryIndex([...summaries.values()]));
    return recovered;
  }

  async deleteRun(input) {
    const raw = asObject(input, 'deleteRun payload');
    assertOnlyKeys(raw, new Set(['runId', 'opId']), 'deleteRun payload');
    const runId = asRunId(raw.runId);
    const opId = asOpId(raw.opId);
    const fingerprint = operationFingerprint('delete-run', { runId });
    return this._withLock('retention', () => this._withLock(
      `run:${runId}`,
      () => this._withLock('memory', async () => {
        const deletion = this._readDeleteTransaction();
        if (deletion?.status === DELETE_TRANSACTION_STATUS.APPLYING) {
          if (
            deletion.runId === runId
            && deletion.opId === opId
            && deletion.fingerprint === fingerprint
          ) {
            return this._applyDeleteTransaction(deletion);
          }
          throw new RunJournalError(
            'A confirmed delete transaction still needs recovery',
            'delete-incomplete'
          );
        }
        const retention = this._readRetentionTransaction();
        if (isRetentionPending(retention)) {
          throw new RunJournalError(
            'A confirmed retention transaction still needs recovery',
            'prune-incomplete'
          );
        }
        const snapshot = this._retentionSnapshot();
        const run = snapshot.runs.find(entry => entry.id === runId) || null;
        if (!run) return false;
        const prior = run.operations.find(operation => operation.opId === opId);
        if (prior) await this._assertReplay(run, prior, 'delete-run', fingerprint);
        if (run.status === RUN_STATUS.RUNNING) {
          throw new RunJournalError('An active run cannot be deleted', 'active-run');
        }
        if (snapshot.runs.some(entry => entry.parentRunId === runId)) {
          throw new RunJournalError(
            'A run with retained descendants cannot be deleted',
            'lineage-retained'
          );
        }
        const prepared = {
          schemaVersion: RETENTION_TRANSACTION_SCHEMA_VERSION,
          status: DELETE_TRANSACTION_STATUS.APPLYING,
          runId,
          revision: run.revision,
          opId,
          fingerprint,
          startedAt: this._timestamp(),
          committedAt: null,
          result: null,
        };
        this._mutationBoundary('delete-transaction', 'before', runId);
        this._writeDeleteTransaction(prepared);
        this._mutationBoundary('delete-transaction', 'after', runId);
        return this._applyDeleteTransaction(prepared);
      })
    ));
  }

  async _mutate({
    runId,
    opId,
    action,
    mutationKind = null,
    fingerprint,
    replay,
    apply,
    degraded,
  }) {
    return this._withLock('retention', () => this._withLock(
      `run:${runId}`,
      () => this._withLock('memory', async () => {
      this._assertNoPendingRetentionMutation();
      const run = this._readRunWithLineage(runId);
      if (!run) throw new RunJournalError('Run was not found', 'not-found');
      const operation = run.operations.find(entry => entry.opId === opId);
      if (operation) {
        await this._assertReplay(run, operation, action, fingerprint);
        return replay(run, operation);
      }
      // A truncated active run accepts every non-terminal mutation as a
      // successful no-op: the workflow keeps running while the journal keeps
      // only what it recorded before capacity was reached.
      if (run.truncated && degraded && run.status === RUN_STATUS.RUNNING) {
        return this._degradedMutation(run, {
          opId,
          action,
          fingerprint,
          degraded,
        });
      }
      try {
        if (run.operations.length >= MAX_OPERATIONS) {
          throw capacityError('Run operation capacity has been reached', 'operation-capacity');
        }
        const at = this._timestamp();
        const mutation = await apply(run, at);
        let proof;
        try {
          proof = await this._secureOperationProof(runId, opId, fingerprint);
        } catch (error) {
          if (mutation.rollback) mutation.rollback();
          throw error;
        }
        try {
          run.operations.push({
            opId,
            action,
            proof: {
              storage: proof.storage,
              ...(proof.ciphertext ? { ciphertext: proof.ciphertext } : {}),
            },
            at,
            refId: mutation.refId ?? null,
          });
          run.updatedAt = at;
          this._advanceRevision(run);
          if (mutationKind) this._mutationBoundary(mutationKind, 'before', runId);
          this._writeRun(run);
          if (mutationKind) this._mutationBoundary(mutationKind, 'after', runId);
        } catch (error) {
          if (proof.rollback) proof.rollback();
          if (mutation.rollback) mutation.rollback();
          throw error;
        }
        return mutation.value(run);
      } catch (error) {
        if (
          !degraded
          || !(error instanceof RunJournalError)
          || !error.journalCapacity
        ) {
          throw error;
        }
        return this._degradeTruncated(runId, error, {
          opId,
          action,
          fingerprint,
          degraded,
        });
      }
      })
    ));
  }

  /**
   * A journal capacity was reached mid-run. Reload the last persisted state
   * (every rollback above already ran), stamp the one-time truncated marker
   * inside the byte/entry room the terminal projection reserved for it, and
   * answer the mutation as a successful no-op. Terminal recording via
   * finishRun/recoverInterrupted keeps working from its own reservation.
   */
  _degradeTruncated(runId, cause, mutation) {
    const run = this._readRun(runId);
    if (!run || run.status !== RUN_STATUS.RUNNING) throw cause;
    if (!run.truncated) {
      const at = this._timestamp();
      run.truncated = { reason: cause.journalCapacity, at };
      run.updatedAt = at;
      this._advanceRevision(run);
      this._writeRun(run);
    }
    return this._degradedMutation(run, mutation);
  }

  _degradedMutation(run, { opId, action, fingerprint, degraded }) {
    const id = deterministicUuid(stableJson({
      kind: 'truncated-operation',
      runId: run.id,
      opId,
      action,
      fingerprint,
    }));
    return degraded(run, run.truncated.at, { id });
  }

  async _assertReplay(run, operation, action, fingerprint) {
    if (operation.action !== action) {
      throw new RunJournalError(
        `Operation id "${operation.opId}" was reused with a different payload`,
        'op-conflict'
      );
    }
    let stored;
    if (operation.proof.storage === STORAGE.MEMORY) {
      stored = this.memory.get(this._operationMemoryKey(run.id, operation.opId));
      if (stored === undefined) {
        throw new RunJournalError(
          'Operation replay proof is unavailable',
          'op-proof-unavailable'
        );
      }
    } else {
      if (!await this._encryptionAvailable({ decrypt: true })) {
        throw new RunJournalError(
          'Operation replay proof is unavailable',
          'op-proof-unavailable'
        );
      }
      const context = {
        kind: 'operation',
        runId: run.id,
        opId: operation.opId,
      };
      try {
        const decrypted = await this.encryption.decrypt(
          operation.proof.ciphertext,
          context
        );
        stored = decodeEncryptedEnvelope(decrypted, context);
      } catch (_error) {
        throw new RunJournalError(
          'Operation replay proof is unavailable',
          'op-proof-unavailable'
        );
      }
    }
    if (stored !== fingerprint) {
      throw new RunJournalError(
        `Operation id "${operation.opId}" was reused with a different payload`,
        'op-conflict'
      );
    }
  }

  _assertActive(run) {
    if (run.status !== RUN_STATUS.RUNNING) {
      throw new RunJournalError('Run is already terminal', 'invalid-state');
    }
  }

  _advanceRevision(run) {
    if (run.revision >= Number.MAX_SAFE_INTEGER) {
      throw new RunJournalError('Run revision capacity has been reached', 'size-limit');
    }
    run.revision += 1;
  }

  _timestamp() {
    const value = this.now();
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) {
      throw new RunJournalError('Run Journal clock returned an invalid time', 'clock-error');
    }
    return date.toISOString();
  }

  _newUuid(existing, { mustNotExist = false } = {}) {
    for (let attempt = 0; attempt < 16; attempt++) {
      const id = asRunId(this.randomUUID(), 'generated UUID');
      if (existing.has(id)) continue;
      if (mustNotExist && fs.existsSync(this._filePath(id))) continue;
      return id;
    }
    throw new RunJournalError('Could not allocate a unique journal UUID', 'uuid-collision');
  }

  async _encryptionAvailable({ decrypt = false } = {}) {
    const adapter = this.encryption;
    if (
      !adapter
      || typeof adapter.isAvailable !== 'function'
      || typeof adapter.encrypt !== 'function'
      || (decrypt && typeof adapter.decrypt !== 'function')
    ) {
      return false;
    }
    try {
      return await adapter.isAvailable() === true;
    } catch (_error) {
      return false;
    }
  }

  async _secureEncryptedPayload(plaintext, context, maxCiphertextBytes) {
    const normalizedContext = normalizeEncryptionContext(context);
    if (!await this._encryptionAvailable()) {
      throw new RunJournalError(
        'OS-backed encryption is required for control checkpoints',
        'encryption-unavailable'
      );
    }
    const envelope = encodeEncryptedEnvelope(plaintext, normalizedContext);
    try {
      const ciphertext = await this.encryption.encrypt(envelope, normalizedContext);
      return {
        storage: STORAGE.ENCRYPTED,
        ciphertext: assertCiphertext(
          ciphertext,
          `${normalizedContext.kind} encryption`,
          maxCiphertextBytes
        ),
      };
    } catch (error) {
      if (error instanceof RunJournalError) throw error;
      throw new RunJournalError(
        'Control checkpoint encryption failed',
        'encryption-failed'
      );
    }
  }

  async _securePayload(plaintext, context, memoryKey, maxCiphertextBytes) {
    const normalizedContext = normalizeEncryptionContext(context);
    const envelope = encodeEncryptedEnvelope(plaintext, normalizedContext);
    if (await this._encryptionAvailable()) {
      try {
        const ciphertext = await this.encryption.encrypt(envelope, normalizedContext);
        return {
          storage: STORAGE.ENCRYPTED,
          ciphertext: assertCiphertext(
            ciphertext,
            `${normalizedContext.kind} encryption`,
            maxCiphertextBytes
          ),
          memoryKey: null,
          rollback: null,
        };
      } catch (_error) {
        // Encryption failure degrades to bounded memory. The exception is not
        // forwarded because adapter errors may echo input; privacy wins.
      }
    }
    const rollback = this._storeMemoryWithEviction(
      memoryKey,
      plaintext,
      normalizedContext.runId
    );
    return {
      storage: STORAGE.MEMORY,
      ciphertext: null,
      memoryKey,
      rollback,
    };
  }

  _secureOperationProof(runId, opId, fingerprint) {
    return this._securePayload(
      fingerprint,
      { kind: 'operation', runId, opId },
      this._operationMemoryKey(runId, opId),
      MAX_OPERATION_CIPHERTEXT_BYTES
    );
  }

  _storeMemoryWithEviction(memoryKey, plaintext, protectedRunId) {
    // Callers hold the global `memory` lock across every payload/proof pair
    // and its disk commit. That makes the rollback below a real transaction:
    // another run cannot consume capacity or observe temporarily evicted data.
    if (this.memory.canSet(memoryKey, plaintext)) {
      this.memory.set(memoryKey, plaintext);
      return this._memoryRollback(memoryKey, []);
    }
    if (utf8ByteLength(plaintext) > this.memory.maxBytes) {
      // Do not destroy recoverable terminal-run payloads for an allocation
      // that cannot fit even in an otherwise empty store.
      this.memory.set(memoryKey, plaintext);
      return;
    }

    const candidates = this._loadAllRuns()
      .filter(run => (
        run.id !== protectedRunId
        && RUN_TERMINAL_VALUES.has(run.status)
        && (
          this.memory.hasPrefix(`workflow:${run.id}`)
          || this.memory.hasPrefix(`result:${run.id}:`)
          || this.memory.hasPrefix(`operation:${run.id}:`)
        )
      ))
      .sort((left, right) => (
        (left.finishedAt || left.updatedAt || left.startedAt)
          .localeCompare(right.finishedAt || right.updatedAt || right.startedAt)
      ));

    const removablePrefixes = candidates.flatMap(run => [
      `workflow:${run.id}`,
      `result:${run.id}:`,
      `operation:${run.id}:`,
    ]);
    if (!this.memory.canSetAfterDeletingPrefixes(
      memoryKey,
      plaintext,
      removablePrefixes
    )) {
      this.memory.set(memoryKey, plaintext);
      return;
    }

    const evicted = [];
    for (const run of candidates) {
      evicted.push(
        ...this.memory.deletePrefix(`workflow:${run.id}`),
        ...this.memory.deletePrefix(`result:${run.id}:`),
        ...this.memory.deletePrefix(`operation:${run.id}:`)
      );
      if (this.memory.canSet(memoryKey, plaintext)) {
        try {
          this.memory.set(memoryKey, plaintext);
        } catch (error) {
          this.memory.restore(evicted);
          throw error;
        }
        return this._memoryRollback(memoryKey, evicted);
      }
    }

    // BoundedMemoryStore owns the final error wording/code. Reaching this line
    // means every remaining payload belongs to an active run (or the incoming
    // body itself exceeds the configured global capacity).
    this.memory.set(memoryKey, plaintext);
  }

  _memoryRollback(memoryKey, evicted) {
    let pending = true;
    return () => {
      if (!pending) return;
      pending = false;
      this.memory.delete(memoryKey);
      this.memory.restore(evicted);
    };
  }

  _filePath(runId) {
    return path.join(this.dir, `${runId}.json`);
  }

  _v1MigrationBackupPath(runId) {
    return path.join(
      this.dir,
      MIGRATION_DIRECTORY,
      V1_MIGRATION_DIRECTORY,
      `${runId}.json`
    );
  }

  _retentionTransactionPath() {
    return path.join(
      this.dir,
      RETENTION_DIRECTORY,
      RETENTION_TRANSACTION_FILE
    );
  }

  _retentionReceiptsPath() {
    return path.join(this.dir, RETENTION_DIRECTORY, RETENTION_RECEIPTS_FILE);
  }

  _deleteTransactionPath() {
    return path.join(this.dir, RETENTION_DIRECTORY, DELETE_TRANSACTION_FILE);
  }

  _retentionReportFile() {
    return path.join(RETENTION_DIRECTORY, RETENTION_TRANSACTION_FILE);
  }

  _retentionReceiptsReportFile() {
    return path.join(RETENTION_DIRECTORY, RETENTION_RECEIPTS_FILE);
  }

  _deleteTransactionReportFile() {
    return path.join(RETENTION_DIRECTORY, DELETE_TRANSACTION_FILE);
  }

  _coordinationFileSignature(file) {
    // App-owned updates use atomic rename (changing file identity); in-place
    // changes normally move size or high-resolution timestamps. This is a
    // cache invalidator for main-owned state, not an authenticity boundary.
    const stats = fs.statSync(file, { bigint: true });
    return [
      stats.dev,
      stats.ino,
      stats.size,
      stats.mtimeNs,
      stats.ctimeNs,
    ].join(':');
  }

  _readRetentionTransaction() {
    const transactionPath = this._retentionTransactionPath();
    try {
      const before = this._coordinationFileSignature(transactionPath);
      if (this._retentionTransactionCache?.signature === before) {
        return this._retentionTransactionCache.transaction;
      }
      const transaction = readJsonStrict(transactionPath, {
        maxFileBytes: MAX_RETENTION_TRANSACTION_BYTES,
      });
      try {
        assertRetentionTransaction(transaction);
      } catch (_error) {
        throw new RunJournalError(
          'Retention transaction is invalid',
          'corrupt-retention'
        );
      }
      const after = this._coordinationFileSignature(transactionPath);
      if (before !== after) {
        throw new RunJournalError(
          'Retention transaction changed while it was read',
          'corrupt-retention'
        );
      }
      this._retentionTransactionCache = { signature: after, transaction };
      return transaction;
    } catch (error) {
      if (error?.code === 'ENOENT') {
        this._retentionTransactionCache = null;
        return null;
      }
      this._retentionTransactionCache = null;
      this._report(this._retentionReportFile(), error);
      if (error instanceof RunJournalError && error.code === 'corrupt-retention') {
        throw error;
      }
      throw new RunJournalError(
        'Retention transaction could not be read',
        'corrupt-retention'
      );
    }
  }

  _assertNoPendingRetentionMutation() {
    const transaction = this._readRetentionTransaction();
    if (isRetentionPending(transaction)) {
      throw new RunJournalError(
        'A confirmed retention transaction still needs recovery',
        'prune-incomplete'
      );
    }
    const deletion = this._readDeleteTransaction();
    if (deletion?.status === DELETE_TRANSACTION_STATUS.APPLYING) {
      throw new RunJournalError(
        'A confirmed delete transaction still needs recovery',
        'delete-incomplete'
      );
    }
  }

  _readDeleteTransaction() {
    const transactionPath = this._deleteTransactionPath();
    try {
      const before = this._coordinationFileSignature(transactionPath);
      if (this._deleteTransactionCache?.signature === before) {
        return this._deleteTransactionCache.transaction;
      }
      const transaction = readJsonStrict(transactionPath, {
        maxFileBytes: 64 * 1024,
      });
      try {
        assertDeleteTransaction(transaction);
      } catch (_error) {
        throw new RunJournalError('Delete transaction is invalid', 'corrupt-retention');
      }
      const after = this._coordinationFileSignature(transactionPath);
      if (before !== after) {
        throw new RunJournalError(
          'Delete transaction changed while it was read',
          'corrupt-retention'
        );
      }
      this._deleteTransactionCache = { signature: after, transaction };
      return transaction;
    } catch (error) {
      if (error?.code === 'ENOENT') {
        this._deleteTransactionCache = null;
        return null;
      }
      this._deleteTransactionCache = null;
      this._report(this._deleteTransactionReportFile(), error);
      if (error instanceof RunJournalError && error.code === 'corrupt-retention') {
        throw error;
      }
      throw new RunJournalError('Delete transaction could not be read', 'corrupt-retention');
    }
  }

  _writeDeleteTransaction(transaction) {
    assertDeleteTransaction(transaction);
    this._deleteTransactionCache = null;
    try {
      this.writeDeleteTransaction(this._deleteTransactionPath(), transaction);
    } catch (_error) {
      throw new RunJournalError('Delete transaction could not be written', 'storage-write-failed');
    }
  }

  _readRetentionReceipts() {
    try {
      const index = readJsonStrict(this._retentionReceiptsPath(), {
        maxFileBytes: MAX_RETENTION_RECEIPTS_BYTES,
      });
      try {
        assertRetentionReceiptIndex(index);
      } catch (_error) {
        throw new RunJournalError('Retention receipts are invalid', 'corrupt-retention');
      }
      return index;
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return { schemaVersion: RETENTION_TRANSACTION_SCHEMA_VERSION, receipts: [] };
      }
      this._report(this._retentionReceiptsReportFile(), error);
      if (error instanceof RunJournalError && error.code === 'corrupt-retention') {
        throw error;
      }
      throw new RunJournalError('Retention receipts could not be read', 'corrupt-retention');
    }
  }

  _writeRetentionReceipts(index) {
    assertRetentionReceiptIndex(index);
    if (
      Buffer.byteLength(JSON.stringify(index, null, 2), 'utf8')
      > MAX_RETENTION_RECEIPTS_BYTES
    ) {
      throw new RunJournalError('Retention receipts exceed their storage limit', 'size-limit');
    }
    try {
      this.writeRetentionReceipts(this._retentionReceiptsPath(), index);
    } catch (_error) {
      throw new RunJournalError('Retention receipts could not be written', 'storage-write-failed');
    }
  }

  _findRetentionReceipt(opId) {
    return this._readRetentionReceipts().receipts.find(receipt => receipt.opId === opId) || null;
  }

  _recordRetentionReceipt(transaction) {
    if (!isRetentionTerminal(transaction)) return false;
    const index = this._readRetentionReceipts();
    const existing = index.receipts.find(receipt => receipt.opId === transaction.opId);
    if (existing) {
      if (existing.fingerprint !== transaction.fingerprint) {
        throw new RunJournalError(
          'Retention receipt conflicts with its transaction',
          'corrupt-retention'
        );
      }
      return false;
    }
    const receipt = {
      opId: transaction.opId,
      fingerprint: transaction.fingerprint,
      policy: clonePublic(transaction.policy),
      previewToken: transaction.previewToken,
      planDigest: transaction.planDigest,
      result: clonePublic(transaction.result),
      committedAt: transaction.committedAt,
    };
    const next = {
      schemaVersion: RETENTION_TRANSACTION_SCHEMA_VERSION,
      receipts: [...index.receipts, receipt].slice(-MAX_RETENTION_RECEIPTS),
    };
    this._mutationBoundary('prune-receipt', 'before', null);
    this._writeRetentionReceipts(next);
    this._mutationBoundary('prune-receipt', 'after', null);
    return true;
  }

  _writeRetentionTransaction(transaction) {
    assertRetentionTransaction(transaction);
    if (
      Buffer.byteLength(JSON.stringify(transaction, null, 2), 'utf8')
      > MAX_RETENTION_TRANSACTION_BYTES
    ) {
      throw new RunJournalError(
        'Retention transaction exceeds its storage limit',
        'size-limit'
      );
    }
    this._retentionTransactionCache = null;
    try {
      this.writeRetentionTransaction(this._retentionTransactionPath(), transaction);
    } catch (_error) {
      throw new RunJournalError(
        'Retention transaction could not be written',
        'storage-write-failed'
      );
    }
  }

  _deleteV1MigrationBackup(runId) {
    try {
      this.deleteMigrationBackup(this._v1MigrationBackupPath(runId));
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw new RunJournalError(
        'Run Journal migration backup could not be deleted',
        'storage-delete-failed'
      );
    }
    return true;
  }

  _indexDirectoryPath() {
    return path.join(this.dir, RUN_INDEX_DIRECTORY);
  }

  _removeLegacyIndexFiles() {
    this._mutationBoundary('migration-index-cleanup', 'before', null);
    let removed = 0;
    let failed = 0;
    for (const file of LEGACY_RUN_INDEX_FILES) {
      try {
        this.deleteLegacyIndex(path.join(this._indexDirectoryPath(), file));
        removed += 1;
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        failed += 1;
        this._report(
          this._indexReportFile(file),
          new RunJournalError(
            'A rebuildable legacy Run Journal index could not be removed',
            'storage-delete-failed'
          )
        );
      }
    }
    this._mutationBoundary('migration-index-cleanup', 'after', null);
    return { removed, failed };
  }

  _indexFilePath() {
    return path.join(this._indexDirectoryPath(), RUN_INDEX_FILE);
  }

  _indexDirtyPath() {
    return path.join(this._indexDirectoryPath(), RUN_INDEX_DIRTY_FILE);
  }

  _indexReportFile(file = RUN_INDEX_FILE) {
    return path.join(RUN_INDEX_DIRECTORY, file);
  }

  _readStoredIndex() {
    if (fs.existsSync(this._indexDirtyPath())) return null;
    try {
      const index = readJsonStrict(this._indexFilePath(), {
        maxFileBytes: MAX_RUN_INDEX_BYTES,
      });
      assertRunIndex(index);
      return index;
    } catch (error) {
      if (error?.code !== 'ENOENT') this._report(this._indexReportFile(), error);
      return null;
    }
  }

  _prepareIndexMutation() {
    if (this._index) return this._index;
    const stored = this._readStoredIndex();
    if (stored) this._adoptIndex(stored);
    return stored;
  }

  _adoptIndex(index) {
    this._index = index;
    this._indexEntries = new Map(index.runs.map(summary => [summary.id, summary]));
    return index;
  }

  _clearIndex() {
    this._index = null;
    this._indexEntries.clear();
  }

  _upsertIndexSummary(index, summary) {
    const next = clonePublic(summary);
    assertRunSummary(next);
    const existing = this._indexEntries.get(next.id);
    if (existing) {
      if (existing.startedAt !== next.startedAt) {
        throw new RunJournalError(
          'Run index cannot reorder an existing run',
          'corrupt-index'
        );
      }
      for (const key of RUN_SUMMARY_KEYS) existing[key] = next[key];
      return index;
    }

    let low = 0;
    let high = index.runs.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (compareRunSummaries(index.runs[middle], next) <= 0) low = middle + 1;
      else high = middle;
    }
    index.runs.splice(low, 0, next);
    this._indexEntries.set(next.id, next);
    return index;
  }

  _markIndexDirty({ required = true } = {}) {
    try {
      writeJsonAtomic(this._indexDirtyPath(), {
        schemaVersion: RUN_INDEX_SCHEMA_VERSION,
        dirty: true,
      });
      return true;
    } catch (error) {
      this._report(this._indexReportFile(RUN_INDEX_DIRTY_FILE), error);
      if (!required) return false;
      throw new RunJournalError(
        'Run Journal metadata index could not be prepared',
        'storage-write-failed'
      );
    }
  }

  _persistIndex(index) {
    this._adoptIndex(index);
    try {
      assertRunIndex(index);
      if (Buffer.byteLength(JSON.stringify(index, null, 2), 'utf8') > MAX_RUN_INDEX_BYTES) {
        throw new RunJournalError(
          'Run Journal metadata index exceeds its rebuildable cache limit',
          'index-capacity'
        );
      }
      writeJsonAtomic(this._indexFilePath(), index);
      try {
        fs.unlinkSync(this._indexDirtyPath());
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          this._report(this._indexReportFile(RUN_INDEX_DIRTY_FILE), error);
        }
      }
      return true;
    } catch (error) {
      // A cache failure never rewinds a successfully committed run record.
      // Keep the valid in-memory projection and leave a durable dirty marker
      // so the next process rebuilds from source records.
      this._report(this._indexReportFile(), error);
      this._markIndexDirty({ required: false });
      return false;
    }
  }

  _rebuildIndex() {
    let recordErrors = 0;
    const runs = this._loadAllRuns({
      onRecordError: () => {
        recordErrors += 1;
      },
    });
    const index = makeRunIndex(runs);
    this._adoptIndex(index);
    if (recordErrors === 0) this._persistIndex(index);
    else this._markIndexDirty({ required: false });
    return index;
  }

  _ensureIndex() {
    if (this._index) return this._index;
    const stored = this._readStoredIndex();
    if (stored) {
      this._adoptIndex(stored);
      return stored;
    }
    return this._rebuildIndex();
  }

  _retentionSnapshot() {
    let recordErrors = 0;
    const runs = this._loadAllRuns({
      onRecordError: () => {
        recordErrors += 1;
      },
    });
    if (recordErrors > 0) {
      throw new RunJournalError(
        'Run Journal retention cannot prove every source record',
        'retention-source-uncertain'
      );
    }
    return { runs, index: makeRunIndex(runs) };
  }

  _retentionPlan(index, { maxRuns, maxAgeDays, cutoff }) {
    const terminal = index.runs.filter(summary => RUN_TERMINAL_VALUES.has(summary.status));
    const beyondCount = maxRuns === null
      ? new Set()
      : new Set(terminal.slice(maxRuns).map(summary => summary.id));
    const initialCandidates = terminal.filter(summary => (
      beyondCount.has(summary.id)
      || (
        maxAgeDays !== null
        && summary.finishedAt.localeCompare(cutoff) < 0
      )
    ));
    const initialIds = new Set(initialCandidates.map(summary => summary.id));
    const byId = new Map(index.runs.map(summary => [summary.id, summary]));
    const protectedAncestors = new Set();
    for (const summary of index.runs) {
      if (initialIds.has(summary.id)) continue;
      let parentId = summary.parentRunId;
      while (parentId !== null) {
        protectedAncestors.add(parentId);
        parentId = byId.get(parentId)?.parentRunId ?? null;
      }
    }
    const candidates = initialCandidates
      .filter(summary => !protectedAncestors.has(summary.id))
      // Delete descendants before ancestors so an interrupted transaction
      // never leaves a surviving child whose source was already removed.
      .sort((left, right) => (
        right.attempt - left.attempt || compareRunSummaries(left, right)
      ));
    return {
      candidates,
      terminalCount: terminal.length,
      activeCount: index.runs.length - terminal.length,
      protectedAncestorCount: initialCandidates.length - candidates.length,
    };
  }

  _retentionPlanDigest(policy, candidates) {
    return retentionPlanDigest(policy, candidates);
  }

  _issueRetentionPreview(policy, candidates) {
    let token;
    do {
      token = crypto.randomBytes(32).toString('hex');
    } while (this._retentionPreviews.has(token));
    this._retentionPreviews.set(token, {
      policy: clonePublic(policy),
      planDigest: this._retentionPlanDigest(policy, candidates),
      issuedAt: this._timestamp(),
    });
    while (this._retentionPreviews.size > 128) {
      this._retentionPreviews.delete(this._retentionPreviews.keys().next().value);
    }
    return token;
  }

  _assertRetentionPreview(token, policy, candidates) {
    const preview = this._retentionPreviews.get(token);
    if (!preview) {
      throw new RunJournalError(
        'The retention preview is absent or expired; preview again',
        'prune-preview-stale'
      );
    }
    const checkedAt = this._timestamp();
    const age = Date.parse(checkedAt) - Date.parse(preview.issuedAt);
    if (
      age < 0
      || age > RETENTION_PREVIEW_TTL_MS
      || stableJson(preview.policy) !== stableJson(policy)
      || preview.planDigest !== this._retentionPlanDigest(policy, candidates)
    ) {
      this._retentionPreviews.delete(token);
      throw new RunJournalError(
        'Run history changed after the retention preview; preview again',
        'prune-preview-stale'
      );
    }
  }

  _applyDeleteTransaction(transaction) {
    assertDeleteTransaction(transaction);
    if (transaction.status === DELETE_TRANSACTION_STATUS.COMMITTED) return false;
    const snapshot = this._retentionSnapshot();
    const run = snapshot.runs.find(entry => entry.id === transaction.runId) || null;
    if (run) {
      if (
        !RUN_TERMINAL_VALUES.has(run.status)
        || run.revision !== transaction.revision
        || snapshot.runs.some(entry => entry.parentRunId === run.id)
      ) {
        throw new RunJournalError(
          'Run history changed during delete recovery',
          'delete-stale'
        );
      }
      this._markIndexDirty();
      this._mutationBoundary('delete-record', 'before', run.id);
      try {
        this.deleteRecord(this._filePath(run.id));
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          this._clearIndex();
          throw new RunJournalError(
            'Run Journal record could not be deleted',
            'storage-delete-failed'
          );
        }
      }
      this._mutationBoundary('delete-record', 'after', run.id);
    }

    this.memory.deletePrefix(`workflow:${transaction.runId}`);
    this.memory.deletePrefix(`result:${transaction.runId}:`);
    this.memory.deletePrefix(`operation:${transaction.runId}:`);
    this._mutationBoundary('delete-backup', 'before', transaction.runId);
    this._deleteV1MigrationBackup(transaction.runId);
    this._mutationBoundary('delete-backup', 'after', transaction.runId);

    const remaining = this._retentionSnapshot();
    if (remaining.runs.some(entry => entry.id === transaction.runId)) {
      throw new RunJournalError(
        'Run Journal delete left its selected record behind',
        'storage-delete-failed'
      );
    }
    this._persistIndex(remaining.index);
    const committed = {
      ...transaction,
      status: DELETE_TRANSACTION_STATUS.COMMITTED,
      committedAt: this._timestamp(),
      result: true,
    };
    this._mutationBoundary('delete-commit', 'before', transaction.runId);
    this._writeDeleteTransaction(committed);
    this._mutationBoundary('delete-commit', 'after', transaction.runId);
    return true;
  }

  _applyRetentionTransaction(initialTransaction) {
    let transaction = initialTransaction;
    assertRetentionTransaction(transaction);
    if (isRetentionTerminal(transaction)) {
      return clonePublic(transaction.result);
    }

    const snapshot = this._retentionSnapshot();
    const candidates = new Map(
      transaction.candidates.map(candidate => [candidate.id, candidate])
    );
    const byId = new Map(snapshot.runs.map(run => [run.id, run]));
    let stale = false;
    for (const candidate of transaction.candidates) {
      const run = byId.get(candidate.id);
      if (!run) {
        if (transaction.status === RETENTION_TRANSACTION_STATUS.PREPARED) stale = true;
        continue;
      }
      if (!RUN_TERMINAL_VALUES.has(run.status) || run.revision !== candidate.revision) {
        stale = true;
      }
    }
    for (const run of snapshot.runs) {
      if (candidates.has(run.id)) continue;
      let parentId = run.parentRunId;
      while (parentId !== null) {
        if (candidates.has(parentId)) {
          stale = true;
          break;
        }
        parentId = byId.get(parentId)?.parentRunId ?? null;
      }
    }
    if (stale) {
      if (transaction.status === RETENTION_TRANSACTION_STATUS.PREPARED) {
        return this._abortRetentionTransaction(transaction, snapshot.index.runs.length);
      }
      throw new RunJournalError(
        'Run history changed during retention recovery',
        'prune-preview-stale'
      );
    }
    if (transaction.status === RETENTION_TRANSACTION_STATUS.PREPARED) {
      const applying = {
        ...transaction,
        status: RETENTION_TRANSACTION_STATUS.APPLYING,
      };
      this._mutationBoundary('prune-apply', 'before', null);
      this._writeRetentionTransaction(applying);
      this._mutationBoundary('prune-apply', 'after', null);
      transaction = applying;
    }

    this._markIndexDirty();
    for (const candidate of transaction.candidates) {
      const run = this._readRun(candidate.id, { throwOnError: true });
      if (run) {
        if (!RUN_TERMINAL_VALUES.has(run.status) || run.revision !== candidate.revision) {
          throw new RunJournalError(
            'Run history changed during retention recovery',
            'prune-preview-stale'
          );
        }
        this._mutationBoundary('prune-record', 'before', candidate.id);
        try {
          this.deleteRecord(this._filePath(candidate.id));
        } catch (error) {
          if (error?.code !== 'ENOENT') {
            this._clearIndex();
            throw new RunJournalError(
              'Run Journal retention could not delete a selected record',
              'storage-delete-failed'
            );
          }
        }
        this._mutationBoundary('prune-record', 'after', candidate.id);
      }
      this.memory.deletePrefix(`workflow:${candidate.id}`);
      this.memory.deletePrefix(`result:${candidate.id}:`);
      this.memory.deletePrefix(`operation:${candidate.id}:`);

      this._mutationBoundary('prune-backup', 'before', candidate.id);
      this._deleteV1MigrationBackup(candidate.id);
      this._mutationBoundary('prune-backup', 'after', candidate.id);
    }

    const remaining = this._retentionSnapshot();
    for (const candidate of transaction.candidates) {
      if (remaining.runs.some(run => run.id === candidate.id)) {
        throw new RunJournalError(
          'Run Journal retention left a selected record behind',
          'storage-delete-failed'
        );
      }
    }
    this._persistIndex(remaining.index);
    const result = {
      preview: false,
      deletedCount: transaction.candidates.length,
      remainingCount: remaining.index.runs.length,
      previewToken: transaction.previewToken,
    };
    const committed = {
      ...transaction,
      status: RETENTION_TRANSACTION_STATUS.COMMITTED,
      committedAt: this._timestamp(),
      result,
    };
    this._mutationBoundary('prune-commit', 'before', null);
    this._writeRetentionTransaction(committed);
    this._mutationBoundary('prune-commit', 'after', null);
    this._recordRetentionReceipt(committed);
    this._rememberPrune(transaction.opId, {
      fingerprint: transaction.fingerprint,
      planDigest: transaction.planDigest,
      result,
    });
    return clonePublic(result);
  }

  _abortRetentionTransaction(transaction, remainingCount) {
    if (transaction.status !== RETENTION_TRANSACTION_STATUS.PREPARED) {
      throw new RunJournalError(
        'An applying retention transaction cannot be aborted',
        'prune-preview-stale'
      );
    }
    const result = {
      preview: false,
      deletedCount: 0,
      remainingCount,
      previewToken: transaction.previewToken,
      aborted: true,
    };
    const aborted = {
      ...transaction,
      status: RETENTION_TRANSACTION_STATUS.ABORTED,
      committedAt: this._timestamp(),
      result,
    };
    this._mutationBoundary('prune-abort', 'before', null);
    this._writeRetentionTransaction(aborted);
    this._mutationBoundary('prune-abort', 'after', null);
    this._recordRetentionReceipt(aborted);
    this._rememberPrune(transaction.opId, {
      fingerprint: transaction.fingerprint,
      planDigest: transaction.planDigest,
      result,
    });
    return clonePublic(result);
  }

  _workflowMemoryKey(runId) {
    return `workflow:${runId}`;
  }

  _resultMemoryKey(runId, resultId) {
    return `result:${runId}:${resultId}`;
  }

  _operationMemoryKey(runId, opId) {
    return `operation:${runId}:${opId}`;
  }

  _writeRun(run) {
    assertStoredRun(run);
    if (run.status === RUN_STATUS.RUNNING) {
      if (run.operations.length >= MAX_OPERATIONS) {
        throw capacityError(
          'Run Journal terminal capacity has been reached',
          'operation-capacity'
        );
      }
      if (run.events.length >= MAX_EVENTS) {
        throw capacityError(
          'Run Journal terminal capacity has been reached',
          'event-capacity'
        );
      }
      if (
        run.eventSeq >= Number.MAX_SAFE_INTEGER
        || run.revision >= Number.MAX_SAFE_INTEGER
      ) {
        throw capacityError(
          'Run Journal terminal capacity has been reached',
          'revision-capacity'
        );
      }
    }
    const capacityRecord = run.status === RUN_STATUS.RUNNING
      ? terminalCapacityProjection(run)
      : run;
    if (
      Buffer.byteLength(JSON.stringify(capacityRecord, null, 2), 'utf8')
      > this.recordMaxBytes
    ) {
      throw capacityError(
        'Run Journal record capacity has been reached',
        'record-capacity'
      );
    }
    const index = this._prepareIndexMutation();
    this._markIndexDirty();
    try {
      this.writeRecord(this._filePath(run.id), run);
    } catch (_error) {
      this._clearIndex();
      // Node filesystem errors include their absolute target path. Keep that
      // machine-local path out of renderer-visible IPC rejection messages.
      throw new RunJournalError(
        'Run Journal record could not be written',
        'storage-write-failed'
      );
    }
    if (index) {
      try {
        const nextIndex = this._upsertIndexSummary(index, runSummary(run));
        // Active runs may change on every block event. Keep their current
        // summary in memory while the durable dirty marker forces a rebuild
        // after a crash; one terminal commit writes and cleans the full index.
        if (RUN_TERMINAL_VALUES.has(run.status)) this._persistIndex(nextIndex);
      } catch (error) {
        this._clearIndex();
        this._report(this._indexReportFile(), error);
        this._markIndexDirty({ required: false });
      }
    } else {
      this._clearIndex();
    }
  }

  _readRun(runId, { throwOnError = false } = {}) {
    const file = this._filePath(runId);
    try {
      const run = readJsonStrict(file, { maxFileBytes: this.recordMaxBytes });
      assertStoredRun(run);
      if (run.id !== runId) {
        throw new RunJournalError('Run id does not match its filename', 'corrupt-run');
      }
      return run;
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      if (throwOnError) throw error;
      this._report(`${runId}.json`, error);
      return null;
    }
  }

  _readRunWithLineage(runId) {
    const run = this._readRun(runId);
    if (!run || run.attempt === 1) return run;
    return this._loadAllRuns().find(candidate => candidate.id === runId) || null;
  }

  _loadAllRuns({ onRecordError = null } = {}) {
    const reportRecordError = (file, error) => {
      this._report(file, error);
      if (onRecordError) onRecordError(file, error);
    };
    let entries;
    try {
      entries = readJsonDir(
        this.dir,
        reportRecordError,
        { maxFileBytes: this.recordMaxBytes }
      );
    } catch (_error) {
      // Directory enumeration errors include the absolute journal path. IPC
      // callers receive a stable code/message instead.
      throw new RunJournalError(
        'Run Journal records could not be listed',
        'storage-read-failed'
      );
    }
    const runs = [];
    for (const { file, data } of entries) {
      try {
        assertStoredRun(data);
        if (file !== `${data.id}.json`) {
          throw new RunJournalError('Run id does not match its filename', 'corrupt-run');
        }
        runs.push(data);
      } catch (error) {
        reportRecordError(file, error);
      }
    }
    const lineageErrors = lineageGraphErrors(runs, 'corrupt-run');
    for (const [runId, error] of lineageErrors) {
      reportRecordError(`${runId}.json`, error);
    }
    return runs.filter(run => !lineageErrors.has(run.id));
  }

  _report(file, error) {
    if (!this.onError) return;
    try {
      this.onError(file, error);
    } catch (_ignored) {
      // Diagnostics must never make journal reads fatal.
    }
  }

  _withLock(key, work) {
    const previous = this._locks.get(key) || Promise.resolve();
    const current = previous
      .catch(() => {})
      .then(work);
    this._locks.set(key, current);
    return current.finally(() => {
      if (this._locks.get(key) === current) this._locks.delete(key);
    });
  }

  _mutationBoundary(kind, phase, runId) {
    if (!this.onMutationBoundary) return;
    this.onMutationBoundary({ kind, phase, runId });
  }

  _rememberPrune(opId, entry) {
    this._pruned.delete(opId);
    this._pruned.set(opId, {
      fingerprint: entry.fingerprint,
      planDigest: entry.planDigest,
      result: clonePublic(entry.result),
    });
    while (this._pruned.size > 128) {
      this._pruned.delete(this._pruned.keys().next().value);
    }
  }
}

module.exports = {
  SCHEMA_VERSION,
  LEGACY_SCHEMA_VERSION,
  ENCRYPTED_ENVELOPE_VERSION,
  CONTROL_CHECKPOINT_VERSION,
  RUN_STATUS,
  RUN_TERMINAL_STATES,
  RUN_FINISH_STATES,
  BLOCK_STATUS,
  BLOCK_TERMINAL_STATES,
  BLOCK_FINISH_STATES,
  RESULT_STATUS,
  STORAGE,
  BOUNDARY_DISPOSITION,
  MAX_RESULT_BYTES_PER_LANE,
  MAX_HANDOFF_BYTES,
  MAX_RESULT_BYTES,
  MAX_RUN_RESULT_BYTES,
  MAX_WORKFLOW_BYTES,
  MAX_CONTROL_CHECKPOINT_BYTES,
  MAX_MEMORY_BYTES,
  MAX_RUN_RECORD_BYTES,
  MAX_MEMORY_ENTRIES,
  MAX_RESULTS,
  MAX_OPERATIONS,
  UUID_PATTERN,
  PUBLIC_ID_PATTERN,
  OP_ID_PATTERN,
  RunJournalError,
  BoundedMemoryStore,
  RunJournal,
  utf8ByteLength,
  stableJson,
  encodeEncryptedEnvelope,
  decodeEncryptedEnvelope,
  normalizeWorkflowSnapshot,
  normalizeTrigger,
  normalizeLaneDescriptors,
  normalizeControlCheckpointState,
  normalizeIterationPath,
  migrateStoredRunV1,
  assertStoredRun,
  publicRun,
  publicResult,
};
