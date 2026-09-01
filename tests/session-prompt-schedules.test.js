const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  CLAIM_STALE_MS,
  MAX_FILE_BYTES,
  MAX_PROMPT_CHARS,
  MAX_SCHEDULES,
  LEGACY_SCHEMA_VERSION,
  SCHEMA_VERSION,
  SessionPromptScheduleStore,
  migrateLegacyFile,
  serializedFileBytes,
} = require('../src/main/session-prompt-schedules');
const { SessionPromptScheduler } = require('../src/main/session-prompt-scheduler');

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-session-prompts-'));
  return path.join(dir, 'session-prompt-schedules.json');
}

function uuidSource() {
  let value = 0;
  return () => `00000000-0000-4000-8000-${String(++value).padStart(12, '0')}`;
}

function harness(start = 1_000) {
  let now = start;
  const filePath = tmpFile();
  const store = new SessionPromptScheduleStore({ filePath, now: () => now, uuid: uuidSource() });
  return {
    store,
    filePath,
    now: () => now,
    setNow: value => { now = value; },
  };
}

const IDENTITY = {
  backendId: 'orchestrator-pty',
  sessionId: 'sess-fixed',
  sessionIncarnationId: '10000000-0000-4000-8000-000000000001',
  expectedProfileId: 'codex:a',
  expectedAgent: 'codex',
};

function binding(schedule = IDENTITY) {
  return {
    backendId: schedule.backendId,
    sessionId: schedule.sessionId,
    incarnationId: schedule.sessionIncarnationId,
    profileId: schedule.expectedProfileId,
    agent: schedule.expectedAgent,
    sessionMode: 'direct-agent',
  };
}

function matched(schedule = IDENTITY) {
  return { status: 'matched', binding: binding(schedule) };
}

async function createDue(h, overrides = {}) {
  const schedule = await h.store.create({
    ...IDENTITY,
    prompt: 'Continue the exact task.',
    nextOccurrenceAt: 2_000,
    ...overrides,
  });
  h.setNow(2_000);
  return schedule;
}

test('create validates bounded records and writes an atomic schema-owned file', async () => {
  const h = harness();
  const schedule = await h.store.create({
    ...IDENTITY,
    prompt: 'Line one\r\nLine two',
    nextOccurrenceAt: 2_000,
    repeatIntervalMinutes: 300,
  });
  assert.equal(schedule.prompt, 'Line one\nLine two');
  assert.equal(schedule.enabled, true);
  assert.equal(schedule.repeatIntervalMinutes, 300);

  const stored = JSON.parse(fs.readFileSync(h.filePath, 'utf8'));
  assert.equal(stored.schemaVersion, SCHEMA_VERSION);
  assert.equal(stored.schedules[0].sessionIncarnationId, IDENTITY.sessionIncarnationId);
  assert.deepEqual(fs.readdirSync(path.dirname(h.filePath)), ['session-prompt-schedules.json']);

  await assert.rejects(h.store.create({ ...IDENTITY, prompt: '', nextOccurrenceAt: 3_000 }), /cannot be empty/);
  await assert.rejects(h.store.create({ ...IDENTITY, prompt: 'x'.repeat(MAX_PROMPT_CHARS + 1), nextOccurrenceAt: 3_000 }), /exceeds/);
  await assert.rejects(h.store.create({ ...IDENTITY, prompt: 'bad\x1b[31m', nextOccurrenceAt: 3_000 }), /control/);
  await assert.rejects(h.store.create({ ...IDENTITY, prompt: 'x', nextOccurrenceAt: 1_000 }), /future/);
  await assert.rejects(h.store.create({ ...IDENTITY, prompt: 'x', nextOccurrenceAt: 3_000, repeatIntervalMinutes: 0 }), /Repeat interval/);
});

test('v1 schedules migrate explicitly and idempotently to a backend-bound schema', async () => {
  const h = harness(5_000);
  const legacy = {
    schemaVersion: LEGACY_SCHEMA_VERSION,
    schedules: [{
      id: '00000000-0000-4000-8000-000000000090',
      sessionId: IDENTITY.sessionId,
      sessionIncarnationId: IDENTITY.sessionIncarnationId,
      expectedProfileId: IDENTITY.expectedProfileId,
      expectedAgent: IDENTITY.expectedAgent,
      prompt: 'Preserve this exact prompt.',
      nextOccurrenceAt: 10_000,
      repeatIntervalMinutes: null,
      enabled: true,
      createdAt: 1_000,
      updatedAt: 2_000,
    }],
  };
  fs.writeFileSync(h.filePath, JSON.stringify(legacy));

  assert.deepEqual(await h.store.migrateV1(IDENTITY.backendId), {
    migrated: true,
    migratedCount: 1,
  });
  const disk = JSON.parse(fs.readFileSync(h.filePath, 'utf8'));
  assert.equal(disk.schemaVersion, SCHEMA_VERSION);
  assert.equal(disk.schedules[0].backendId, IDENTITY.backendId);
  assert.equal(disk.schedules[0].prompt, legacy.schedules[0].prompt);
  assert.equal(disk.schedules[0].sessionIncarnationId, IDENTITY.sessionIncarnationId);
  assert.deepEqual(await h.store.migrateV1(IDENTITY.backendId), {
    migrated: false,
    migratedCount: 0,
  });
});

function storedRecord(index, prompt, { legacy = false } = {}) {
  return {
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    ...(legacy ? {} : { backendId: IDENTITY.backendId }),
    sessionId: `session-${index}`,
    sessionIncarnationId: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    expectedProfileId: IDENTITY.expectedProfileId,
    expectedAgent: IDENTITY.expectedAgent,
    prompt,
    nextOccurrenceAt: 10_000,
    repeatIntervalMinutes: null,
    enabled: true,
    createdAt: 500,
    updatedAt: 500,
  };
}

function largestFittingPrompt(buildFile, serialize) {
  let low = 1;
  let high = MAX_PROMPT_CHARS;
  let best = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const file = buildFile('雪'.repeat(middle));
    if (Buffer.byteLength(serialize(file), 'utf8') <= MAX_FILE_BYTES) {
      best = file;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

test('mutations cannot write a valid store that its own reader rejects as oversized', async () => {
  const filePath = tmpFile();
  const current = largestFittingPrompt(
    prompt => ({
      schemaVersion: SCHEMA_VERSION,
      schedules: Array.from({ length: MAX_SCHEDULES - 1 }, (_, index) => storedRecord(index, prompt)),
    }),
    file => JSON.stringify(file, null, 2)
  );
  const original = JSON.stringify(current, null, 2);
  assert.ok(Buffer.byteLength(original, 'utf8') <= MAX_FILE_BYTES);
  fs.writeFileSync(filePath, original);
  const store = new SessionPromptScheduleStore({
    filePath,
    now: () => 1_000,
    uuid: () => '00000000-0000-4000-8000-000000000100',
  });

  await assert.rejects(store.create({
    ...IDENTITY,
    prompt: '雪'.repeat(MAX_PROMPT_CHARS),
    nextOccurrenceAt: 2_000,
  }), error => error.code === 'store-limit');
  assert.equal(fs.readFileSync(filePath, 'utf8'), original, 'the readable original remains byte-identical');
  assert.equal((await store.list()).diagnostic, null);
});

test('an oversized v1-to-v2 serialization fails closed without replacing legacy evidence', async () => {
  const h = harness(5_000);
  const legacy = largestFittingPrompt(
    prompt => ({
      schemaVersion: LEGACY_SCHEMA_VERSION,
      schedules: Array.from({ length: MAX_SCHEDULES }, (_, index) => storedRecord(index, prompt, { legacy: true })),
    }),
    file => JSON.stringify(file)
  );
  const original = JSON.stringify(legacy);
  assert.ok(Buffer.byteLength(original, 'utf8') <= MAX_FILE_BYTES);
  assert.ok(serializedFileBytes(migrateLegacyFile(legacy, 5_000, IDENTITY.backendId)) > MAX_FILE_BYTES);
  fs.writeFileSync(h.filePath, original);

  await assert.rejects(
    h.store.migrateV1(IDENTITY.backendId),
    error => error.code === 'store_limit'
  );
  assert.equal(fs.readFileSync(h.filePath, 'utf8'), original);
  const listed = await h.store.list();
  assert.equal(listed.diagnostic.code, 'store_limit');
});

test('a temporarily unavailable backend stays due and cannot be resumed without proof', async () => {
  const h = harness();
  const schedule = await createDue(h);
  const due = await h.store.prepareTick(() => ({ status: 'unavailable' }));
  assert.deepEqual(due.map(record => record.id), [schedule.id]);
  assert.equal((await h.store.get(schedule.id)).enabled, true);

  await h.store.setEnabled(schedule.id, false);
  await assert.rejects(
    h.store.setEnabled(schedule.id, true, () => ({ status: 'unavailable' })),
    error => error.code === 'backend-unavailable'
  );
  assert.equal((await h.store.get(schedule.id)).lastResult?.status, undefined);
});

test('a same-named session from another backend is terminal, never a fallback', async () => {
  const h = harness();
  const schedule = await createDue(h);
  const wrongBackend = matched({ ...IDENTITY, backendId: 'wmux-daemon' });
  assert.deepEqual(await h.store.prepareTick(() => wrongBackend), []);
  const current = await h.store.get(schedule.id);
  assert.equal(current.enabled, false);
  assert.equal(current.lastResult.status, 'session_changed');
});

test('tick inspections start concurrently while the durable mutation stays serialized', async () => {
  const h = harness();
  for (let index = 0; index < 3; index += 1) {
    await h.store.create({
      ...IDENTITY,
      sessionId: `session-${index}`,
      sessionIncarnationId: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      prompt: `Future ${index}`,
      nextOccurrenceAt: 10_000 + index,
    });
  }
  let inspected = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const pending = h.store.prepareTick(async (schedule) => {
    inspected += 1;
    await gate;
    return matched(schedule);
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(inspected, 3, 'one slow backend read cannot multiply the tick timeout by row count');
  release();
  await pending;
});

test('the store enforces its record limit without replacing existing evidence', async () => {
  const h = harness();
  const schedules = Array.from({ length: MAX_SCHEDULES }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    backendId: IDENTITY.backendId,
    sessionId: `session-${index}`,
    sessionIncarnationId: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    expectedProfileId: 'codex:a',
    expectedAgent: 'codex',
    prompt: 'Existing evidence',
    nextOccurrenceAt: 10_000,
    repeatIntervalMinutes: null,
    enabled: false,
    createdAt: 500,
    updatedAt: 500,
  }));
  fs.writeFileSync(h.filePath, JSON.stringify({ schemaVersion: SCHEMA_VERSION, schedules }));
  await assert.rejects(h.store.create({
    ...IDENTITY,
    prompt: 'One too many',
    nextOccurrenceAt: 2_000,
  }), error => error.code === 'limit');
  assert.equal(JSON.parse(fs.readFileSync(h.filePath, 'utf8')).schedules.length, MAX_SCHEDULES);
});

test('legacy rows without an incarnation stay visible but become terminal', async () => {
  const h = harness(5_000);
  fs.writeFileSync(h.filePath, JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    schedules: [{
      id: '00000000-0000-4000-8000-000000000099',
      backendId: IDENTITY.backendId,
      sessionId: 'legacy-session',
      expectedProfileId: 'codex:a',
      expectedAgent: 'codex',
      prompt: 'Legacy prompt',
      nextOccurrenceAt: 10_000,
      repeatIntervalMinutes: null,
      enabled: true,
      createdAt: 1_000,
      updatedAt: 1_000,
    }],
  }));

  const result = await h.store.list();
  assert.equal(result.diagnostic, null);
  assert.equal(result.schedules[0].sessionIncarnationId, null);
  assert.equal(result.schedules[0].enabled, false);
  assert.equal(result.schedules[0].lastResult.status, 'session_changed');
  assert.equal(JSON.parse(fs.readFileSync(h.filePath, 'utf8')).schedules[0].enabled, true,
    'derived migration state must not silently rewrite evidence');
  await assert.rejects(
    h.store.setEnabled(result.schedules[0].id, true, null),
    error => error.code === 'session_changed'
  );
});

test('pause and delete serialize against a due claim', async () => {
  const h = harness();
  const schedule = await createDue(h);

  const paused = h.store.setEnabled(schedule.id, false);
  const lostClaim = h.store.claimDue(schedule.id);
  assert.equal((await paused).enabled, false);
  assert.equal(await lostClaim, null, 'pause that enters the queue first prevents delivery');

  await h.store.setEnabled(schedule.id, true, matched());
  const wonClaim = h.store.claimDue(schedule.id);
  const blockedDelete = h.store.delete(schedule.id);
  const claimed = await wonClaim;
  assert.ok(claimed.deliveryClaim);
  await assert.rejects(blockedDelete, error => error.code === 'delivery-in-flight');
  await h.store.finalizeClaim(schedule.id, claimed.deliveryClaim.token, 'busy');
  assert.equal(await h.store.delete(schedule.id), true);
});

test('busy and unavailable remain due while sent and error consume one-shots', async () => {
  for (const status of ['busy', 'unavailable']) {
    const h = harness();
    const schedule = await createDue(h);
    const claimed = await h.store.claimDue(schedule.id);
    await h.store.finalizeClaim(schedule.id, claimed.deliveryClaim.token, status);
    const current = await h.store.get(schedule.id);
    assert.equal(current.enabled, true);
    assert.equal(current.nextOccurrenceAt, 2_000);
    assert.equal(current.deliveryClaim, undefined);
    assert.equal(current.lastResult.status, status);
  }

  for (const status of ['sent', 'error']) {
    const h = harness();
    const schedule = await createDue(h);
    const claimed = await h.store.claimDue(schedule.id);
    await h.store.finalizeClaim(schedule.id, claimed.deliveryClaim.token, status);
    const current = await h.store.get(schedule.id);
    assert.equal(current.enabled, false);
    assert.equal(current.lastResult.status, status);
    await assert.rejects(
      h.store.setEnabled(schedule.id, true, () => matched()),
      error => error.code === 'occurrence-consumed'
    );
    assert.equal((await h.store.get(schedule.id)).enabled, false,
      'a consumed one-shot cannot be replayed through Resume');
  }
});

test('resuming a paused repeat skips missed slots and inspects binding inside the mutation', async () => {
  const h = harness();
  const schedule = await h.store.create({
    ...IDENTITY,
    prompt: 'Continue on the next future interval.',
    nextOccurrenceAt: 2_000,
    repeatIntervalMinutes: 10,
  });
  await h.store.setEnabled(schedule.id, false);
  h.setNow(2_000 + 35 * 60_000);
  let inspectedSessionId = null;
  const resumed = await h.store.setEnabled(schedule.id, true, inspected => {
    inspectedSessionId = inspected.sessionId;
    return matched();
  });
  assert.equal(inspectedSessionId, IDENTITY.sessionId);
  assert.equal(resumed.enabled, true);
  assert.equal(resumed.nextOccurrenceAt, 2_000 + 40 * 60_000);
  assert.equal((await h.store.prepareTick(() => matched())).length, 0,
    'resume never creates a missed-interval catch-up delivery');
});

test('repeating jobs advance directly beyond missed intervals without catch-up floods', async () => {
  const h = harness();
  const schedule = await createDue(h, { repeatIntervalMinutes: 10 });
  const claimed = await h.store.claimDue(schedule.id);
  h.setNow(2_000 + 35 * 60_000);
  await h.store.finalizeClaim(schedule.id, claimed.deliveryClaim.token, 'sent');
  const current = await h.store.get(schedule.id);
  assert.equal(current.enabled, true);
  assert.equal(current.nextOccurrenceAt, 2_000 + 40 * 60_000);
  assert.equal((await h.store.prepareTick(() => matched())).length, 0);
});

test('a stale durable claim is consumed as error and never replayed', async () => {
  const h = harness();
  const schedule = await createDue(h);
  const claimed = await h.store.claimDue(schedule.id);
  assert.equal(JSON.parse(fs.readFileSync(h.filePath, 'utf8')).schedules[0].deliveryClaim.token,
    claimed.deliveryClaim.token);

  h.setNow(2_000 + CLAIM_STALE_MS);
  const restartedStore = new SessionPromptScheduleStore({
    filePath: h.filePath,
    now: h.now,
    uuid: uuidSource(),
  });
  const due = await restartedStore.prepareTick(() => matched());
  assert.deepEqual(due, []);
  const recovered = await restartedStore.get(schedule.id);
  assert.equal(recovered.enabled, false);
  assert.equal(recovered.lastResult.status, 'error');
  assert.equal(recovered.deliveryClaim, undefined);
});

test('stale recovery never consumes a claim still owned by this process', async () => {
  const h = harness();
  const schedule = await createDue(h);
  const claimed = await h.store.claimDue(schedule.id);
  h.setNow(2_000 + CLAIM_STALE_MS + 1);

  assert.deepEqual(await h.store.prepareTick(() => matched()), []);
  assert.equal((await h.store.get(schedule.id)).deliveryClaim.token, claimed.deliveryClaim.token);
  assert.equal(await h.store.finalizeClaim(
    schedule.id,
    claimed.deliveryClaim.token,
    'sent'
  ), true);
  assert.equal((await h.store.get(schedule.id)).lastResult.status, 'sent');
});

test('app restart reconciliation disables an orphaned exact-session row', async () => {
  const h = harness();
  const schedule = await h.store.create({
    ...IDENTITY,
    prompt: 'Later',
    nextOccurrenceAt: 100_000,
  });
  assert.deepEqual(await h.store.prepareTick(() => ({ status: 'session_changed' })), []);
  const orphan = await h.store.get(schedule.id);
  assert.equal(orphan.enabled, false);
  assert.equal(orphan.lastResult.status, 'session_changed');
  await assert.rejects(h.store.setEnabled(schedule.id, true, matched()), error => error.code === 'session_changed');
});

test('corrupt storage is preserved and every delivery mutation fails closed', async () => {
  const h = harness();
  const corrupt = '{ this is not valid JSON';
  fs.writeFileSync(h.filePath, corrupt);
  await assert.rejects(
    h.store.migrateV1(IDENTITY.backendId),
    error => error.code === 'store_corrupt'
  );
  const listed = await h.store.list();
  assert.equal(listed.schedules.length, 0);
  assert.equal(listed.diagnostic.code, 'store_corrupt');
  await assert.rejects(h.store.prepareTick(() => matched()), error => error.code === 'store_corrupt');
  await assert.rejects(h.store.create({ ...IDENTITY, prompt: 'x', nextOccurrenceAt: 2_000 }),
    error => error.code === 'store_corrupt');
  assert.equal(fs.readFileSync(h.filePath, 'utf8'), corrupt);
});

test('a future schema is preserved and reported instead of downgraded', async () => {
  const h = harness();
  const future = JSON.stringify({ schemaVersion: SCHEMA_VERSION + 1, schedules: [] });
  fs.writeFileSync(h.filePath, future);
  await assert.rejects(
    h.store.migrateV1(IDENTITY.backendId),
    error => error.code === 'store_unsupported'
  );
  const listed = await h.store.list();
  assert.equal(listed.diagnostic.code, 'store_unsupported');
  await assert.rejects(h.store.prepareTick(() => matched()), error => error.code === 'store_unsupported');
  assert.equal(fs.readFileSync(h.filePath, 'utf8'), future);
});

test('scheduler persists a unique claim before delivery and never overlaps ticks', async () => {
  const h = harness();
  await createDue(h);
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  let deliveries = 0;
  let durableClaimSeen = false;
  const scheduler = new SessionPromptScheduler({
    store: h.store,
    inspectBinding: () => matched(),
    deliver: async (schedule) => {
      deliveries += 1;
      const disk = JSON.parse(fs.readFileSync(h.filePath, 'utf8'));
      durableClaimSeen = disk.schedules[0].deliveryClaim.token === schedule.deliveryClaim.token;
      await blocked;
      return 'sent';
    },
  });

  const first = scheduler.tick();
  while (deliveries === 0) await new Promise(resolve => setImmediate(resolve));
  assert.equal(await scheduler.tick(), false);
  assert.equal(deliveries, 1);
  assert.equal(durableClaimSeen, true);
  release();
  assert.equal(await first, true);
});

test('scheduler start and stop are idempotent', () => {
  const timers = [];
  const cleared = [];
  const store = { prepareTick: async () => [], claimDue: async () => null, finalizeClaim: async () => false };
  const scheduler = new SessionPromptScheduler({
    store,
    inspectBinding: () => null,
    deliver: async () => 'unavailable',
    setIntervalFn: callback => {
      const timer = { callback, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearIntervalFn: timer => cleared.push(timer),
  });
  assert.equal(scheduler.start(), true);
  assert.equal(scheduler.start(), false);
  assert.equal(timers.length, 1);
  assert.equal(scheduler.stop(), true);
  assert.equal(scheduler.stop(), false);
  assert.deepEqual(cleared, timers);
});

test('scheduler shutdown waits for an in-flight claimed occurrence to finalize', async () => {
  const h = harness();
  await createDue(h);
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  let deliveryStarted = false;
  const scheduler = new SessionPromptScheduler({
    store: h.store,
    inspectBinding: () => matched(),
    deliver: async () => {
      deliveryStarted = true;
      await blocked;
      return 'sent';
    },
  });

  const tick = scheduler.tick();
  while (!deliveryStarted) await new Promise(resolve => setImmediate(resolve));
  scheduler.stop();
  let idle = false;
  const joined = scheduler.whenIdle().then(() => { idle = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(idle, false, 'shutdown must not tear down PTYs during a delivery');
  release();
  await Promise.all([tick, joined]);
  assert.equal(idle, true);
  assert.equal((await h.store.list()).schedules[0].lastResult.status, 'sent');
});

test('ordinary shutdown preserves rows and the next launch disables the vanished incarnation', async () => {
  const h = harness();
  const schedule = await h.store.create({
    ...IDENTITY,
    prompt: 'Continue after the quota window.',
    nextOccurrenceAt: 100_000,
  });
  let live = true;
  const scheduler = new SessionPromptScheduler({
    store: h.store,
    inspectBinding: () => live ? matched() : { status: 'session_changed' },
    deliver: async () => 'unavailable',
    setIntervalFn: callback => ({ callback, unref() {} }),
    clearIntervalFn: () => {},
  });
  scheduler.start();
  await new Promise(resolve => setImmediate(resolve));
  scheduler.stop();
  live = false;

  assert.equal((await h.store.get(schedule.id)).enabled, true,
    'stopping before PTY teardown must not rewrite durable rows');
  await h.store.prepareTick(() => ({ status: 'session_changed' }));
  const restarted = await h.store.get(schedule.id);
  assert.equal(restarted.enabled, false);
  assert.equal(restarted.lastResult.status, 'session_changed');
});
