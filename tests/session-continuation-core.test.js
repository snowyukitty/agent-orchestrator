const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CAPABILITY_KEYS,
  SessionContinuationCore,
} = require('../src/main/session-continuation-core');
const {
  ORCHESTRATOR_PTY_BACKEND_ID,
  createOrchestratorPtyContinuationBackend,
} = require('../src/main/orchestrator-pty-continuation-backend');

const BINDING = {
  sessionId: 'session-shared',
  incarnationId: '10000000-0000-4000-8000-000000000001',
  profileId: 'codex:a',
  agent: 'codex',
  sessionMode: 'direct-agent',
};

function capabilities(overrides = {}) {
  return {
    exactSessionIdentity: true,
    agentReadinessProof: true,
    protectedPromptDelivery: true,
    claimBoundDelivery: true,
    ...overrides,
  };
}

function backend(id, overrides = {}) {
  return {
    id,
    label: `Backend ${id}`,
    capabilities: capabilities(),
    getScheduleTarget: () => ({ ...BINDING, readiness: 'idle' }),
    inspectSchedule: () => ({ status: 'matched', binding: BINDING }),
    deliverClaimed: async () => 'sent',
    ...overrides,
  };
}

function schedule(backendId) {
  return {
    backendId,
    sessionId: BINDING.sessionId,
    sessionIncarnationId: BINDING.incarnationId,
    expectedProfileId: BINDING.profileId,
    expectedAgent: BINDING.agent,
    deliveryClaim: { token: '20000000-0000-4000-8000-000000000001' },
  };
}

test('the core publishes an explicit capability matrix and gates partial adapters', async () => {
  let touched = false;
  const core = new SessionContinuationCore({
    backends: [backend('wezterm-pane', {
      capabilities: capabilities({ agentReadinessProof: false }),
      getScheduleTarget: () => { touched = true; return BINDING; },
      inspectSchedule: () => { touched = true; return { status: 'matched', binding: BINDING }; },
      deliverClaimed: async () => { touched = true; return 'sent'; },
    })],
  });

  const [description] = core.describeBackends();
  assert.deepEqual(Object.keys(description.capabilities), [...CAPABILITY_KEYS]);
  assert.equal(description.schedulingEligible, false);
  assert.equal(await core.getScheduleTarget('wezterm-pane', BINDING.sessionId), null);
  assert.deepEqual(await core.inspectSchedule(schedule('wezterm-pane')), { status: 'unavailable' });
  assert.equal(await core.deliverClaimed(schedule('wezterm-pane')), 'unavailable');
  assert.equal(touched, false, 'an ineligible adapter is never asked to deliver');
});

test('backend ids are an authority namespace and never fall back by session id', async () => {
  let deliveries = 0;
  const core = new SessionContinuationCore({
    backends: [backend('backend-b', {
      deliverClaimed: async () => { deliveries += 1; return 'sent'; },
    })],
  });

  assert.deepEqual(await core.inspectSchedule(schedule('backend-a')), { status: 'unavailable' });
  assert.equal(await core.deliverClaimed(schedule('backend-a')), 'unavailable');
  assert.equal(deliveries, 0, 'a same-named session in another backend is not a fallback');
  assert.throws(() => core.register(backend('backend-b')), /already registered/);
  assert.throws(() => core.register(backend('../unsafe')), /id is invalid/);
});

test('only a backend authority can classify a target as session_changed', async () => {
  const unavailable = new SessionContinuationCore({
    backends: [backend('offline', {
      inspectSchedule: () => { throw new Error('transport down'); },
    })],
  });
  assert.deepEqual(await unavailable.inspectSchedule(schedule('offline')), { status: 'unavailable' });

  const replaced = new SessionContinuationCore({
    backends: [backend('authoritative', {
      inspectSchedule: () => ({ status: 'session_changed' }),
    })],
  });
  assert.deepEqual(await replaced.inspectSchedule(schedule('authoritative')), {
    status: 'session_changed',
  });
});

test('async read-side adapters are bounded and fail closed as unavailable', async () => {
  const never = () => new Promise(() => {});
  const core = new SessionContinuationCore({
    readTimeoutMs: 5,
    backends: [backend('slow-daemon', {
      getScheduleTarget: never,
      inspectSchedule: never,
    })],
  });
  assert.equal(await core.getScheduleTarget('slow-daemon', BINDING.sessionId), null);
  assert.deepEqual(await core.inspectSchedule(schedule('slow-daemon')), {
    status: 'unavailable',
  });
});

test('malformed post-claim backend results consume safely as error', async () => {
  const malformed = new SessionContinuationCore({
    backends: [backend('malformed', { deliverClaimed: async () => 'maybe' })],
  });
  const throwing = new SessionContinuationCore({
    backends: [backend('throwing', { deliverClaimed: async () => { throw new Error('after write'); } })],
  });
  assert.equal(await malformed.deliverClaimed(schedule('malformed')), 'error');
  assert.equal(await throwing.deliverClaimed(schedule('throwing')), 'error');
});

test('the native adapter preserves SessionRegistry authority and redacts private extras', async () => {
  const calls = [];
  const registry = {
    scheduleTarget: id => id === BINDING.sessionId
      ? { ...BINDING, readiness: 'idle', env: { SECRET: 'hidden' }, executable: 'private-path' }
      : null,
    scheduleBinding: id => id === BINDING.sessionId ? BINDING : null,
  };
  const native = createOrchestratorPtyContinuationBackend({
    registry,
    deliver: async (claimed, options) => {
      calls.push([claimed.backendId, options.registry]);
      return 'sent';
    },
  });
  const core = new SessionContinuationCore({ backends: [native] });

  const target = await core.getScheduleTarget(ORCHESTRATOR_PTY_BACKEND_ID, BINDING.sessionId);
  assert.deepEqual(target, {
    backendId: ORCHESTRATOR_PTY_BACKEND_ID,
    ...BINDING,
    readiness: 'idle',
  });
  assert.ok(!JSON.stringify(target).includes('private-path'));
  assert.deepEqual(await core.inspectSchedule(schedule(ORCHESTRATOR_PTY_BACKEND_ID)), {
    status: 'matched',
    binding: { backendId: ORCHESTRATOR_PTY_BACKEND_ID, ...BINDING },
  });
  assert.equal(await core.deliverClaimed(schedule(ORCHESTRATOR_PTY_BACKEND_ID)), 'sent');
  assert.deepEqual(calls, [[ORCHESTRATOR_PTY_BACKEND_ID, registry]]);
});
