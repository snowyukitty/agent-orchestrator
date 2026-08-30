// Provider-neutral routing for exact-session continuation.
//
// A backend is eligible for unattended prompt delivery only when it owns all
// four proofs below. The core never upgrades a partial adapter, guesses a
// target, or falls back to a different backend with a matching session id.

const BACKEND_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const CAPABILITY_KEYS = Object.freeze([
  'exactSessionIdentity',
  'agentReadinessProof',
  'protectedPromptDelivery',
  'claimBoundDelivery',
]);
const DELIVERY_RESULTS = new Set([
  'sent',
  'busy',
  'unavailable',
  'session_changed',
  'error',
]);
const INSPECTION_RESULTS = new Set(['matched', 'unavailable', 'session_changed']);
const READ_TIMEOUT_MS = 2_000;
const READ_TIMED_OUT = Symbol('continuation-read-timed-out');

function isBackendId(value) {
  return typeof value === 'string' && BACKEND_ID_PATTERN.test(value);
}

function normalizeCapabilities(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return Object.freeze(Object.fromEntries(
    CAPABILITY_KEYS.map(key => [key, source[key] === true])
  ));
}

function isSchedulingEligible(backend) {
  return CAPABILITY_KEYS.every(key => backend.capabilities[key] === true) &&
    typeof backend.getScheduleTarget === 'function' &&
    typeof backend.inspectSchedule === 'function' &&
    typeof backend.deliverClaimed === 'function';
}

function publicBackend(backend) {
  return {
    id: backend.id,
    label: backend.label,
    capabilities: { ...backend.capabilities },
    schedulingEligible: isSchedulingEligible(backend),
  };
}

function sanitizeBinding(backendId, raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const binding = {
    backendId,
    sessionId: raw.sessionId,
    incarnationId: raw.incarnationId,
    profileId: raw.profileId,
    agent: raw.agent,
    sessionMode: raw.sessionMode,
  };
  if (
    !binding.sessionId || !binding.incarnationId || !binding.profileId ||
    !binding.agent || !binding.sessionMode
  ) return null;
  return binding;
}

class SessionContinuationCore {
  constructor({ backends = [], readTimeoutMs = READ_TIMEOUT_MS } = {}) {
    if (!Number.isSafeInteger(readTimeoutMs) || readTimeoutMs < 1) {
      throw new TypeError('Continuation read timeout is invalid');
    }
    this._backends = new Map();
    this._readTimeoutMs = readTimeoutMs;
    for (const backend of backends) this.register(backend);
  }

  async _read(operation) {
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(operation),
        new Promise(resolve => {
          timer = setTimeout(() => resolve(READ_TIMED_OUT), this._readTimeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  register(raw) {
    if (!raw || typeof raw !== 'object' || !isBackendId(raw.id)) {
      throw new TypeError('Continuation backend id is invalid');
    }
    if (this._backends.has(raw.id)) {
      throw new Error(`Continuation backend "${raw.id}" is already registered`);
    }
    const backend = Object.freeze({
      id: raw.id,
      label: typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : raw.id,
      capabilities: normalizeCapabilities(raw.capabilities),
      getScheduleTarget: raw.getScheduleTarget,
      inspectSchedule: raw.inspectSchedule,
      deliverClaimed: raw.deliverClaimed,
    });
    this._backends.set(backend.id, backend);
    return publicBackend(backend);
  }

  describeBackends() {
    return [...this._backends.values()].map(publicBackend);
  }

  async getScheduleTarget(backendId, sessionId) {
    const backend = this._backends.get(backendId);
    if (!backend || !isSchedulingEligible(backend)) return null;
    try {
      const target = await this._read(() => backend.getScheduleTarget(sessionId));
      if (target === READ_TIMED_OUT) return null;
      const binding = sanitizeBinding(backend.id, target);
      if (!binding || binding.sessionId !== sessionId) return null;
      return {
        ...binding,
        readiness: typeof target.readiness === 'string' ? target.readiness : undefined,
      };
    } catch (_error) {
      return null;
    }
  }

  async inspectSchedule(schedule) {
    const backend = this._backends.get(schedule?.backendId);
    if (!backend || !isSchedulingEligible(backend)) return { status: 'unavailable' };
    try {
      const inspection = await this._read(() => backend.inspectSchedule(schedule));
      if (inspection === READ_TIMED_OUT) return { status: 'unavailable' };
      if (!inspection || !INSPECTION_RESULTS.has(inspection.status)) {
        return { status: 'unavailable' };
      }
      if (inspection.status !== 'matched') return { status: inspection.status };
      const binding = sanitizeBinding(backend.id, inspection.binding);
      return binding ? { status: 'matched', binding } : { status: 'unavailable' };
    } catch (_error) {
      return { status: 'unavailable' };
    }
  }

  async deliverClaimed(schedule) {
    const backend = this._backends.get(schedule?.backendId);
    if (!backend || !isSchedulingEligible(backend)) return 'unavailable';
    try {
      const result = await backend.deliverClaimed(schedule);
      // A malformed result arrives after the durable claim and after a backend
      // may have crossed its write boundary. Consume rather than replay.
      return DELIVERY_RESULTS.has(result) ? result : 'error';
    } catch (_error) {
      return 'error';
    }
  }
}

module.exports = {
  CAPABILITY_KEYS,
  READ_TIMEOUT_MS,
  SessionContinuationCore,
  isSchedulingEligible,
};
