// Electron-free request validation for scheduled-prompt IPC handlers.

const { asPlainObject, asId, asText } = require('./validate');
const { MAX_PROMPT_CHARS } = require('./session-prompt-schedules');

function assertOnlyKeys(value, allowed, what) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${what} contains an unknown field`);
  }
}

function asOptionalRepeat(value) {
  if (value === undefined || value === null || value === '') return null;
  if (!Number.isInteger(value)) throw new Error('repeatIntervalMinutes must be an integer');
  return value;
}

function publicSchedule(schedule) {
  const { deliveryClaim, ...publicRecord } = schedule;
  return { ...publicRecord, deliveryInFlight: !!deliveryClaim };
}

function createSessionPromptHandlers({ store, continuation, defaultBackendId }) {
  if (!store || !continuation || typeof continuation.getScheduleTarget !== 'function') {
    throw new TypeError('Scheduled-prompt handlers need store and continuation core');
  }
  const fallbackBackendId = asId(defaultBackendId, 'default continuation backend id');
  return {
    async list(raw = {}) {
      const payload = asPlainObject(raw, 'session prompt list payload');
      assertOnlyKeys(payload, new Set(), 'session prompt list payload');
      const result = await store.list();
      return {
        ...result,
        schedules: result.schedules.map(publicSchedule),
      };
    },

    async create(raw) {
      const payload = asPlainObject(raw, 'session prompt create payload');
      assertOnlyKeys(payload, new Set([
        'backendId', 'sessionId', 'sessionIncarnationId', 'prompt', 'nextOccurrenceAt',
        'repeatIntervalMinutes',
      ]), 'session prompt create payload');
      const backendId = payload.backendId === undefined
        ? fallbackBackendId
        : asId(payload.backendId, 'continuation backend id');
      const sessionId = asId(payload.sessionId, 'session id');
      const target = await continuation.getScheduleTarget(backendId, sessionId);
      if (!target || target.incarnationId !== payload.sessionIncarnationId) {
        const error = new Error(
          'The selected exact session changed or its backend cannot prove readiness'
        );
        error.code = 'session-unavailable';
        throw error;
      }
      return publicSchedule(await store.create({
        backendId: target.backendId,
        sessionId,
        sessionIncarnationId: target.incarnationId,
        expectedProfileId: target.profileId,
        expectedAgent: target.agent,
        prompt: asText(payload.prompt, { max: MAX_PROMPT_CHARS, what: 'scheduled prompt' }),
        nextOccurrenceAt: payload.nextOccurrenceAt,
        repeatIntervalMinutes: asOptionalRepeat(payload.repeatIntervalMinutes),
      }));
    },

    async setEnabled(raw) {
      const payload = asPlainObject(raw, 'session prompt state payload');
      assertOnlyKeys(payload, new Set(['scheduleId', 'enabled']), 'session prompt state payload');
      const scheduleId = asId(payload.scheduleId, 'schedule id');
      if (typeof payload.enabled !== 'boolean') throw new Error('enabled must be a boolean');
      const inspectBinding = payload.enabled
        ? schedule => continuation.inspectSchedule(schedule)
        : null;
      return publicSchedule(await store.setEnabled(scheduleId, payload.enabled, inspectBinding));
    },

    async delete(raw) {
      const payload = asPlainObject(raw, 'session prompt delete payload');
      assertOnlyKeys(payload, new Set(['scheduleId']), 'session prompt delete payload');
      return store.delete(asId(payload.scheduleId, 'schedule id'));
    },
  };
}

module.exports = { createSessionPromptHandlers, publicSchedule };
