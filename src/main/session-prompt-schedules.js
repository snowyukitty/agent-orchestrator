// Durable, fail-closed schedules for prompts bound to one live session incarnation.
//
// This store is intentionally separate from workflow files. A workflow schedule
// launches new work; these records may only continue the exact direct-agent PTY
// whose backend-owned identity was captured at creation time.

const fs = require('fs');
const { randomUUID } = require('crypto');

const { readJsonStrict, writeJsonAtomic } = require('./store');

const SCHEMA_VERSION = 2;
const LEGACY_SCHEMA_VERSION = 1;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SCHEDULES = 100;
const MAX_PROMPT_CHARS = 16_000;
const MAX_REPEAT_MINUTES = 365 * 24 * 60;
const CLAIM_STALE_MS = 60_000;
const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const AGENT_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RESULT_VALUES = new Set(['sent', 'busy', 'unavailable', 'session_changed', 'error']);
const RECORD_KEYS = new Set([
  'id', 'backendId', 'sessionId', 'sessionIncarnationId', 'expectedProfileId',
  'expectedAgent', 'prompt', 'nextOccurrenceAt', 'repeatIntervalMinutes', 'enabled',
  'createdAt', 'updatedAt', 'lastResult', 'deliveryClaim',
]);
const LEGACY_RECORD_KEYS = new Set([...RECORD_KEYS].filter(key => key !== 'backendId'));

class SessionPromptScheduleError extends Error {
  constructor(message, code = 'invalid-input') {
    super(message);
    this.name = 'SessionPromptScheduleError';
    this.code = code;
  }
}

function fail(message, code = 'invalid-input') {
  throw new SessionPromptScheduleError(message, code);
}

function assertObject(value, what) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${what} must be an object`);
  }
  return value;
}

function assertOnlyKeys(value, allowed, what) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${what} contains an unknown field`, 'store-corrupt');
  }
}

function asId(value, what) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    fail(`${what} is invalid`);
  }
  return value;
}

function asAgent(value) {
  if (typeof value !== 'string' || !AGENT_PATTERN.test(value)) {
    fail('Expected agent identity is invalid');
  }
  return value;
}

function asUuid(value, what) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    fail(`${what} is invalid`);
  }
  return value.toLowerCase();
}

function asTimestamp(value, what, { futureOf = null } = {}) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${what} must be an epoch-millisecond integer`);
  if (futureOf !== null && value <= futureOf) fail(`${what} must be in the future`);
  return value;
}

function asRepeatMinutes(value) {
  if (value === undefined || value === null || value === '') return null;
  if (!Number.isInteger(value) || value < 1 || value > MAX_REPEAT_MINUTES) {
    fail(`Repeat interval must be an integer from 1 to ${MAX_REPEAT_MINUTES} minutes`);
  }
  return value;
}

function normalizePrompt(value) {
  if (typeof value !== 'string') fail('Prompt must be a string');
  const prompt = value.replace(/\r\n?/g, '\n');
  if (!prompt.trim()) fail('Prompt cannot be empty');
  if (prompt.length > MAX_PROMPT_CHARS) {
    fail(`Prompt exceeds ${MAX_PROMPT_CHARS} characters`);
  }
  for (const character of prompt) {
    const code = character.codePointAt(0);
    if ((code < 0x20 && character !== '\n' && character !== '\t') ||
        code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      fail('Prompt contains unsafe terminal control characters');
    }
  }
  return prompt;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function serializedFileBytes(file) {
  return Buffer.byteLength(JSON.stringify(file, null, 2), 'utf8');
}

function lastResult(status, at, occurrenceAt) {
  return { status, at, occurrenceAt };
}

function normalizeClaim(raw) {
  const claim = assertObject(raw, 'Delivery claim');
  assertOnlyKeys(claim, new Set(['token', 'occurrenceAt', 'startedAt']), 'Delivery claim');
  return {
    token: asUuid(claim.token, 'Delivery claim token'),
    occurrenceAt: asTimestamp(claim.occurrenceAt, 'Delivery claim occurrence'),
    startedAt: asTimestamp(claim.startedAt, 'Delivery claim start'),
  };
}

function normalizeLastResult(raw) {
  const result = assertObject(raw, 'Last result');
  assertOnlyKeys(result, new Set(['status', 'at', 'occurrenceAt']), 'Last result');
  if (!RESULT_VALUES.has(result.status)) fail('Last result status is invalid', 'store-corrupt');
  return {
    status: result.status,
    at: asTimestamp(result.at, 'Last result time'),
    occurrenceAt: asTimestamp(result.occurrenceAt, 'Last result occurrence'),
  };
}

function normalizeStoredRecord(raw, now, { legacyBackendId = null } = {}) {
  const record = assertObject(raw, 'Schedule record');
  assertOnlyKeys(record, legacyBackendId ? LEGACY_RECORD_KEYS : RECORD_KEYS, 'Schedule record');

  const normalized = {
    id: asUuid(record.id, 'Schedule id'),
    backendId: asId(legacyBackendId || record.backendId, 'Continuation backend id'),
    sessionId: asId(record.sessionId, 'Session id'),
    sessionIncarnationId: null,
    expectedProfileId: asId(record.expectedProfileId, 'Expected profile id'),
    expectedAgent: asAgent(record.expectedAgent),
    prompt: normalizePrompt(record.prompt),
    nextOccurrenceAt: asTimestamp(record.nextOccurrenceAt, 'Next occurrence'),
    repeatIntervalMinutes: asRepeatMinutes(record.repeatIntervalMinutes),
    enabled: record.enabled === true,
    createdAt: asTimestamp(record.createdAt, 'Created time'),
    updatedAt: asTimestamp(record.updatedAt, 'Updated time'),
  };
  if (record.sessionIncarnationId !== undefined && record.sessionIncarnationId !== null) {
    normalized.sessionIncarnationId = asUuid(record.sessionIncarnationId, 'Session incarnation');
  }
  if (record.lastResult !== undefined && record.lastResult !== null) {
    normalized.lastResult = normalizeLastResult(record.lastResult);
  }
  if (record.deliveryClaim !== undefined && record.deliveryClaim !== null) {
    normalized.deliveryClaim = normalizeClaim(record.deliveryClaim);
  }

  // A pre-incarnation row is evidence, not a binding opportunity. Keep it
  // manageable, but derive the permanent terminal state without guessing.
  if (!normalized.sessionIncarnationId) {
    normalized.enabled = false;
    normalized.lastResult = lastResult('session_changed', now, normalized.nextOccurrenceAt);
    delete normalized.deliveryClaim;
  }
  return normalized;
}

function validateFile(raw, now) {
  const file = assertObject(raw, 'Schedule store');
  assertOnlyKeys(file, new Set(['schemaVersion', 'schedules']), 'Schedule store');
  if (file.schemaVersion !== SCHEMA_VERSION) {
    fail('Schedule store schema is unsupported', 'store-unsupported');
  }
  if (!Array.isArray(file.schedules) || file.schedules.length > MAX_SCHEDULES) {
    fail('Schedule store record count is invalid', 'store-corrupt');
  }
  const schedules = file.schedules.map(record => normalizeStoredRecord(record, now));
  const ids = new Set();
  for (const schedule of schedules) {
    if (ids.has(schedule.id)) fail('Schedule store repeats an id', 'store-corrupt');
    ids.add(schedule.id);
  }
  return { schemaVersion: SCHEMA_VERSION, schedules };
}

function migrateLegacyFile(raw, now, backendId) {
  const file = assertObject(raw, 'Schedule store');
  assertOnlyKeys(file, new Set(['schemaVersion', 'schedules']), 'Schedule store');
  if (file.schemaVersion !== LEGACY_SCHEMA_VERSION) {
    fail('Schedule store schema is unsupported', 'store-unsupported');
  }
  if (!Array.isArray(file.schedules) || file.schedules.length > MAX_SCHEDULES) {
    fail('Schedule store record count is invalid', 'store-corrupt');
  }
  const legacyBackendId = asId(backendId, 'Legacy backend id');
  const schedules = file.schedules.map(record => (
    normalizeStoredRecord(record, now, { legacyBackendId })
  ));
  const ids = new Set();
  for (const schedule of schedules) {
    if (ids.has(schedule.id)) fail('Schedule store repeats an id', 'store-corrupt');
    ids.add(schedule.id);
  }
  return { schemaVersion: SCHEMA_VERSION, schedules };
}

function bindingMatches(schedule, binding) {
  return !!binding &&
    binding.backendId === schedule.backendId &&
    binding.sessionId === schedule.sessionId &&
    binding.incarnationId === schedule.sessionIncarnationId &&
    binding.profileId === schedule.expectedProfileId &&
    binding.agent === schedule.expectedAgent &&
    binding.sessionMode === 'direct-agent';
}

function bindingInspection(schedule, inspection) {
  if (!inspection || typeof inspection !== 'object') return 'unavailable';
  if (inspection.status === 'unavailable') return 'unavailable';
  if (inspection.status === 'session_changed') return 'session_changed';
  if (inspection.status !== 'matched') return 'unavailable';
  return bindingMatches(schedule, inspection.binding) ? 'matched' : 'session_changed';
}

function advanceOccurrence(schedule, status, now) {
  const next = {
    ...schedule,
    updatedAt: now,
    lastResult: lastResult(status, now, schedule.deliveryClaim?.occurrenceAt ?? schedule.nextOccurrenceAt),
  };
  delete next.deliveryClaim;
  if (status === 'busy' || status === 'unavailable') return next;
  if (status === 'session_changed') {
    next.enabled = false;
    return next;
  }
  if (next.repeatIntervalMinutes) {
    next.nextOccurrenceAt = nextFutureRepeat(next, now);
  } else {
    next.enabled = false;
  }
  return next;
}

function isConsumedOneShot(schedule) {
  return !schedule.repeatIntervalMinutes &&
    (schedule.lastResult?.status === 'sent' || schedule.lastResult?.status === 'error');
}

function nextFutureRepeat(schedule, now) {
  const step = schedule.repeatIntervalMinutes * 60_000;
  const elapsed = Math.max(0, now - schedule.nextOccurrenceAt);
  return schedule.nextOccurrenceAt + (Math.floor(elapsed / step) + 1) * step;
}

class SessionPromptScheduleStore {
  constructor({ filePath, now = Date.now, uuid = randomUUID, onChange = null } = {}) {
    if (typeof filePath !== 'string' || !filePath) throw new TypeError('Schedule store needs a file path');
    this.filePath = filePath;
    this._now = now;
    this._uuid = uuid;
    this._onChange = typeof onChange === 'function' ? onChange : null;
    this._queue = Promise.resolve();
    this._diagnostic = null;
    // A claim minted by this store instance is live process state, not crash
    // residue. Only a future process (with an empty set) may recover it stale.
    this._ownedClaimTokens = new Set();
  }

  _serialize(task) {
    const run = this._queue.then(task, task);
    this._queue = run.then(() => undefined, () => undefined);
    return run;
  }

  _read() {
    if (!fs.existsSync(this.filePath)) {
      this._diagnostic = null;
      return { schemaVersion: SCHEMA_VERSION, schedules: [] };
    }
    try {
      if (this._diagnostic?.code === 'store_limit') {
        fail('Schedule store migration exceeds its serialized byte limit', 'store-limit');
      }
      const raw = readJsonStrict(this.filePath, { maxFileBytes: MAX_FILE_BYTES });
      const parsed = validateFile(raw, this._now());
      this._diagnostic = null;
      return parsed;
    } catch (error) {
      throw this._diagnose(error);
    }
  }

  _diagnose(error) {
    const code = error?.code === 'store-unsupported'
      ? 'store_unsupported'
      : error?.code === 'store-limit'
        ? 'store_limit'
        : 'store_corrupt';
    this._diagnostic = {
      code,
      message: code === 'store_unsupported'
        ? 'Scheduled prompts are unavailable because the local store uses an unsupported schema.'
        : code === 'store_limit'
          ? 'Scheduled prompts are unavailable because migration would exceed the local store size limit. The original file was preserved.'
        : 'Scheduled prompts are unavailable because the local store is unreadable. The original file was preserved.',
    };
    return new SessionPromptScheduleError(this._diagnostic.message, code);
  }

  _write(file) {
    if (serializedFileBytes(file) > MAX_FILE_BYTES) {
      fail('Schedule store exceeds its serialized byte limit', 'store-limit');
    }
    writeJsonAtomic(this.filePath, file);
    this._onChange?.();
  }

  async migrateV1(backendId) {
    return this._serialize(() => {
      if (!fs.existsSync(this.filePath)) {
        this._diagnostic = null;
        return { migrated: false, migratedCount: 0 };
      }
      try {
        const raw = readJsonStrict(this.filePath, { maxFileBytes: MAX_FILE_BYTES });
        if (raw?.schemaVersion === SCHEMA_VERSION) {
          validateFile(raw, this._now());
          this._diagnostic = null;
          return { migrated: false, migratedCount: 0 };
        }
        const migrated = migrateLegacyFile(raw, this._now(), backendId);
        this._write(migrated);
        this._diagnostic = null;
        return { migrated: true, migratedCount: migrated.schedules.length };
      } catch (error) {
        throw this._diagnose(error);
      }
    });
  }

  async list() {
    return this._serialize(() => {
      try {
        const file = this._read();
        return { schedules: clone(file.schedules), diagnostic: null };
      } catch (_error) {
        return { schedules: [], diagnostic: clone(this._diagnostic) };
      }
    });
  }

  async get(id) {
    return this._serialize(() => {
      const scheduleId = asUuid(id, 'Schedule id');
      const file = this._read();
      return clone(file.schedules.find(schedule => schedule.id === scheduleId) || null);
    });
  }

  async create(input) {
    return this._serialize(() => {
      const now = this._now();
      const file = this._read();
      if (file.schedules.length >= MAX_SCHEDULES) fail(`At most ${MAX_SCHEDULES} schedules are allowed`, 'limit');
      const schedule = {
        id: asUuid(this._uuid(), 'Schedule id'),
        backendId: asId(input?.backendId, 'Continuation backend id'),
        sessionId: asId(input?.sessionId, 'Session id'),
        sessionIncarnationId: asUuid(input?.sessionIncarnationId, 'Session incarnation'),
        expectedProfileId: asId(input?.expectedProfileId, 'Expected profile id'),
        expectedAgent: asAgent(input?.expectedAgent),
        prompt: normalizePrompt(input?.prompt),
        nextOccurrenceAt: asTimestamp(input?.nextOccurrenceAt, 'Next occurrence', { futureOf: now }),
        repeatIntervalMinutes: asRepeatMinutes(input?.repeatIntervalMinutes),
        enabled: true,
        createdAt: now,
        updatedAt: now,
      };
      file.schedules.push(schedule);
      this._write(file);
      return clone(schedule);
    });
  }

  async setEnabled(id, enabled, inspectBinding = null) {
    return this._serialize(async () => {
      const scheduleId = asUuid(id, 'Schedule id');
      if (typeof enabled !== 'boolean') fail('Enabled state must be a boolean');
      const file = this._read();
      const index = file.schedules.findIndex(schedule => schedule.id === scheduleId);
      if (index < 0) fail('Schedule was not found', 'not-found');
      const current = file.schedules[index];
      const now = this._now();
      if (current.deliveryClaim) fail('Schedule delivery is already in flight', 'delivery-in-flight');
      let nextOccurrenceAt = current.nextOccurrenceAt;
      if (enabled) {
        if (isConsumedOneShot(current)) {
          fail('This one-shot occurrence was consumed; create a new future schedule', 'occurrence-consumed');
        }
        if (current.lastResult?.status === 'session_changed') {
          fail('The original session changed; recreate this schedule', 'session_changed');
        }
        const inspection = typeof inspectBinding === 'function'
          ? await inspectBinding(current)
          : inspectBinding;
        const inspectionStatus = bindingInspection(current, inspection);
        if (inspectionStatus === 'unavailable') {
          fail('The continuation backend is temporarily unavailable', 'backend-unavailable');
        }
        if (inspectionStatus === 'session_changed') {
          fail('The original session changed; recreate this schedule', 'session_changed');
        }
        if (current.repeatIntervalMinutes && current.nextOccurrenceAt <= now) {
          nextOccurrenceAt = nextFutureRepeat(current, now);
        }
      }
      file.schedules[index] = {
        ...current,
        enabled,
        nextOccurrenceAt,
        updatedAt: now,
      };
      this._write(file);
      return clone(file.schedules[index]);
    });
  }

  async delete(id) {
    return this._serialize(() => {
      const scheduleId = asUuid(id, 'Schedule id');
      const file = this._read();
      const index = file.schedules.findIndex(schedule => schedule.id === scheduleId);
      if (index < 0) return false;
      if (file.schedules[index].deliveryClaim) {
        fail('Schedule delivery is already in flight', 'delivery-in-flight');
      }
      file.schedules.splice(index, 1);
      this._write(file);
      return true;
    });
  }

  async prepareTick(inspectBinding) {
    return this._serialize(async () => {
      const now = this._now();
      const file = this._read();
      let changed = false;
      const reconciled = [];
      const inspections = await Promise.all(file.schedules.map(async (schedule) => {
        if (!schedule.enabled || schedule.deliveryClaim) return null;
        return bindingInspection(schedule, await inspectBinding(schedule));
      }));
      for (let index = 0; index < file.schedules.length; index += 1) {
        const schedule = file.schedules[index];
        if (
          schedule.deliveryClaim &&
          !this._ownedClaimTokens.has(schedule.deliveryClaim.token) &&
          now - schedule.deliveryClaim.startedAt >= CLAIM_STALE_MS
        ) {
          changed = true;
          reconciled.push(advanceOccurrence(schedule, 'error', now));
          continue;
        }
        if (inspections[index] === 'session_changed') {
          changed = true;
          reconciled.push(advanceOccurrence(schedule, 'session_changed', now));
          continue;
        }
        reconciled.push(schedule);
      }
      file.schedules = reconciled;
      if (changed) this._write(file);
      return file.schedules
        .filter(schedule => schedule.enabled && !schedule.deliveryClaim && schedule.nextOccurrenceAt <= now)
        .sort((a, b) => a.nextOccurrenceAt - b.nextOccurrenceAt || a.createdAt - b.createdAt)
        .map(schedule => clone(schedule));
    });
  }

  async claimDue(id) {
    return this._serialize(() => {
      const now = this._now();
      const scheduleId = asUuid(id, 'Schedule id');
      const file = this._read();
      const index = file.schedules.findIndex(schedule => schedule.id === scheduleId);
      const current = file.schedules[index];
      if (!current?.enabled || current.deliveryClaim || current.nextOccurrenceAt > now) return null;
      const claimed = {
        ...current,
        updatedAt: now,
        deliveryClaim: {
          token: asUuid(this._uuid(), 'Delivery claim token'),
          occurrenceAt: current.nextOccurrenceAt,
          startedAt: now,
        },
      };
      file.schedules[index] = claimed;
      this._write(file);
      this._ownedClaimTokens.add(claimed.deliveryClaim.token);
      return clone(claimed);
    });
  }

  async finalizeClaim(id, token, status) {
    const claimToken = asUuid(token, 'Delivery claim token');
    try {
      return await this._serialize(() => {
        const scheduleId = asUuid(id, 'Schedule id');
        if (!RESULT_VALUES.has(status)) fail('Delivery result is invalid');
        const file = this._read();
        const index = file.schedules.findIndex(schedule => schedule.id === scheduleId);
        const current = file.schedules[index];
        if (!current || current.deliveryClaim?.token !== claimToken) return false;
        file.schedules[index] = advanceOccurrence(current, status, this._now());
        this._write(file);
        return true;
      });
    } finally {
      this._ownedClaimTokens.delete(claimToken);
    }
  }
}

module.exports = {
  CLAIM_STALE_MS,
  MAX_FILE_BYTES,
  MAX_PROMPT_CHARS,
  MAX_REPEAT_MINUTES,
  MAX_SCHEDULES,
  LEGACY_SCHEMA_VERSION,
  SCHEMA_VERSION,
  SessionPromptScheduleError,
  SessionPromptScheduleStore,
  advanceOccurrence,
  bindingInspection,
  bindingMatches,
  migrateLegacyFile,
  normalizePrompt,
  serializedFileBytes,
  validateFile,
};
