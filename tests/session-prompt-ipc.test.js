const test = require('node:test');
const assert = require('node:assert/strict');

const { createSessionPromptHandlers } = require('../src/main/session-prompt-ipc');

const SCHEDULE_ID = '50000000-0000-4000-8000-000000000001';
const BACKEND_ID = 'orchestrator-pty';
const TARGET = {
  backendId: BACKEND_ID,
  sessionId: 'sess-1',
  incarnationId: '60000000-0000-4000-8000-000000000001',
  profileId: 'codex:a',
  agent: 'codex',
  sessionMode: 'direct-agent',
};

function harness({ available = true } = {}) {
  const calls = [];
  const record = {
    id: SCHEDULE_ID,
    backendId: BACKEND_ID,
    sessionId: TARGET.sessionId,
    sessionIncarnationId: TARGET.incarnationId,
    expectedProfileId: TARGET.profileId,
    expectedAgent: TARGET.agent,
    deliveryClaim: {
      token: '70000000-0000-4000-8000-000000000001',
      occurrenceAt: 8_000,
      startedAt: 8_000,
    },
  };
  const store = {
    list: async () => ({ schedules: [record], diagnostic: null }),
    create: async input => { calls.push(['create', input]); return { ...record, ...input }; },
    get: async id => id === SCHEDULE_ID ? record : null,
    setEnabled: async (id, enabled, inspectBinding) => {
      const inspection = typeof inspectBinding === 'function'
        ? await inspectBinding(record)
        : inspectBinding;
      calls.push(['enabled', id, enabled, inspection]);
      return { ...record, enabled };
    },
    delete: async id => { calls.push(['delete', id]); return true; },
  };
  const continuation = {
    getScheduleTarget: async (backendId, id) => (
      available && backendId === BACKEND_ID && id === TARGET.sessionId ? TARGET : null
    ),
    inspectSchedule: async schedule => ({ status: 'matched', binding: {
      backendId: schedule.backendId,
      sessionId: TARGET.sessionId,
      incarnationId: TARGET.incarnationId,
      profileId: TARGET.profileId,
      agent: TARGET.agent,
      sessionMode: TARGET.sessionMode,
    } }),
  };
  return {
    handlers: createSessionPromptHandlers({
      store,
      continuation,
      defaultBackendId: BACKEND_ID,
    }),
    calls,
  };
}

test('create binds identity from main-owned session state and rejects extra IPC fields', async () => {
  const { handlers, calls } = harness();
  const created = await handlers.create({
    sessionId: 'sess-1',
    sessionIncarnationId: TARGET.incarnationId,
    prompt: 'Continue.',
    nextOccurrenceAt: 9_000,
    repeatIntervalMinutes: 60,
  });
  assert.equal(created.sessionIncarnationId, TARGET.incarnationId);
  assert.deepEqual(calls[0], ['create', {
    backendId: BACKEND_ID,
    sessionId: TARGET.sessionId,
    sessionIncarnationId: TARGET.incarnationId,
    expectedProfileId: TARGET.profileId,
    expectedAgent: TARGET.agent,
    prompt: 'Continue.',
    nextOccurrenceAt: 9_000,
    repeatIntervalMinutes: 60,
  }]);
  await assert.rejects(handlers.create({
    sessionId: 'sess-1', prompt: 'x', nextOccurrenceAt: 9_000,
    sessionIncarnationId: 'renderer-spoof',
  }), error => error.code === 'session-unavailable');
  await assert.rejects(handlers.create({
    sessionId: 'sess-1', prompt: 'x', nextOccurrenceAt: 9_000,
    expectedProfileId: 'codex:b',
  }), /unknown field/);
  await assert.rejects(handlers.create({
    backendId: 'unknown-backend',
    sessionId: 'sess-1', prompt: 'x', nextOccurrenceAt: 9_000,
    sessionIncarnationId: TARGET.incarnationId,
  }), error => error.code === 'session-unavailable');
});

test('create fails closed when lifecycle-confirmed direct-agent proof is absent', async () => {
  const { handlers, calls } = harness({ available: false });
  await assert.rejects(
    handlers.create({
      sessionId: 'sess-1',
      sessionIncarnationId: TARGET.incarnationId,
      prompt: 'x',
      nextOccurrenceAt: 9_000,
    }),
    error => error.code === 'session-unavailable'
  );
  assert.deepEqual(calls, []);
});

test('pause, resume, delete, and list validate exact payloads', async () => {
  const { handlers, calls } = harness();
  const listed = await handlers.list({});
  assert.equal(listed.schedules.length, 1);
  assert.equal(listed.schedules[0].deliveryInFlight, true);
  assert.equal(listed.schedules[0].deliveryClaim, undefined,
    'the renderer receives an in-flight fact, never the claim capability');
  assert.ok(!JSON.stringify(listed).includes('70000000-0000-4000-8000-000000000001'));
  await assert.rejects(handlers.list({ includePrivate: true }), /unknown field/);

  const paused = await handlers.setEnabled({ scheduleId: SCHEDULE_ID, enabled: false });
  assert.equal(paused.enabled, false);
  const resumed = await handlers.setEnabled({ scheduleId: SCHEDULE_ID, enabled: true });
  assert.equal(resumed.enabled, true);
  assert.equal(await handlers.delete({ scheduleId: SCHEDULE_ID }), true);
  assert.deepEqual(calls, [
    ['enabled', SCHEDULE_ID, false, null],
    ['enabled', SCHEDULE_ID, true, {
      status: 'matched',
      binding: {
        backendId: BACKEND_ID,
        sessionId: TARGET.sessionId,
        incarnationId: TARGET.incarnationId,
        profileId: TARGET.profileId,
        agent: TARGET.agent,
        sessionMode: TARGET.sessionMode,
      },
    }],
    ['delete', SCHEDULE_ID],
  ]);

  await assert.rejects(handlers.setEnabled({ scheduleId: SCHEDULE_ID, enabled: 'yes' }), /boolean/);
  await assert.rejects(handlers.delete({ scheduleId: SCHEDULE_ID, force: true }), /unknown field/);
  await assert.rejects(handlers.delete({ scheduleId: '../store' }), /Invalid schedule id/);
});
