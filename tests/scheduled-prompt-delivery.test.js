const test = require('node:test');
const assert = require('node:assert/strict');

const { SessionRegistry } = require('../src/main/sessions');
const {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  deliverScheduledPrompt,
} = require('../src/main/scheduled-prompt-delivery');

function uuidSource() {
  let value = 100;
  return () => `10000000-0000-4000-8000-${String(++value).padStart(12, '0')}`;
}

function fakePty() {
  const spawned = [];
  return {
    spawned,
    spawn(file, args, opts) {
      const proc = {
        // Reusing a PID is deliberate: neither PTY PIDs nor renderer session
        // ids are identity. The registry's random incarnation must be.
        pid: 2000,
        file, args, opts, written: [],
        _onData: null, _onExit: null,
        onData(callback) { this._onData = callback; },
        onExit(callback) { this._onExit = callback; },
        write(text) { this.written.push(text); },
        resize() {},
        kill() {},
        exit(code = 0) { this._onExit?.({ exitCode: code }); },
      };
      spawned.push(proc);
      return proc;
    },
  };
}

function fakeLifecycleBroker() {
  const registrations = [];
  return {
    registrations,
    register(args) {
      const record = { ...args, active: true };
      registrations.push(record);
      return {
        env: {
          AGENT_ORCHESTRATOR_NOTIFY_SECRET_PIPE: 'synthetic-pipe',
          AGENT_ORCHESTRATOR_NOTIFY_SECRET_TOKEN: `secret-${registrations.length}`,
        },
        release: () => { record.active = false; return true; },
      };
    },
    complete(index = registrations.length - 1) {
      return registrations[index].onEvent({ type: 'agent-turn-complete' });
    },
  };
}

const DIRECT_SPEC = {
  file: 'pwsh.exe',
  args: ['-File', 'agent-entrypoint.ps1', 'target', 'run', 'codex:a', '--'],
  env: { PATH: 'C:/tools' },
  profileId: 'codex:a',
  agent: 'codex',
  label: 'Codex A · direct',
  assurance: 'L1-routed',
  sessionMode: 'direct-agent',
};

function harness() {
  let now = 100_000;
  const pty = fakePty();
  const broker = fakeLifecycleBroker();
  const statuses = [];
  const registry = new SessionRegistry({
    pty,
    lifecycleBroker: broker,
    now: () => now,
    uuid: uuidSource(),
    onStatus: meta => statuses.push(meta),
  });
  const ready = (index = pty.spawned.length - 1) => {
    pty.spawned[index]._onData('\x1b[?2004h');
    return broker.complete(index);
  };
  return { registry, pty, broker, ready, statuses, setNow: value => { now = value; }, now: () => now };
}

function scheduleFor(registry, id, prompt = 'Continue safely.') {
  const meta = registry.describe(id);
  return {
    id: '20000000-0000-4000-8000-000000000001',
    sessionId: id,
    sessionIncarnationId: meta.incarnationId,
    expectedProfileId: meta.profileId,
    expectedAgent: meta.agent,
    prompt,
    deliveryClaim: {
      token: '30000000-0000-4000-8000-000000000001',
      occurrenceAt: 100_000,
      startedAt: 100_000,
    },
  };
}

test('incarnations are random per PTY creation and safely exposed without private launch data', () => {
  const h = harness();
  const first = h.registry.create(DIRECT_SPEC, { id: 'sess-reused' });
  const firstMeta = h.registry.describe(first.id);
  assert.match(firstMeta.incarnationId, /^[0-9a-f-]{36}$/);
  assert.equal(firstMeta.sessionMode, 'direct-agent');
  assert.equal(firstMeta.scheduledPrompt.supported, true);
  const serialized = JSON.stringify(firstMeta);
  assert.ok(!serialized.includes('synthetic-pipe'));
  assert.ok(!serialized.includes('secret-'));
  assert.ok(!serialized.includes('agent-entrypoint.ps1'));
  assert.ok(!serialized.includes('C:/tools'));

  h.registry.remove(first.id);
  h.pty.spawned[0].exit(0);
  const second = h.registry.create(DIRECT_SPEC, { id: 'sess-reused' });
  assert.equal(h.registry.describe(second.id).pid, firstMeta.pid, 'the fixture reuses the PID');
  assert.notEqual(h.registry.describe(second.id).incarnationId, firstMeta.incarnationId,
    'session id and PID reuse cannot reuse an incarnation');
});

test('provider receipt makes only the exact direct session lifecycle-confirmed', () => {
  const h = harness();
  const id = h.registry.create(DIRECT_SPEC).id;
  assert.equal(h.registry.scheduleTarget(id), null);
  assert.equal(h.registry.describe(id).scheduledPrompt.confirmed, false);
  assert.equal(h.broker.complete(), true);
  assert.equal(h.registry.describe(id).scheduledPrompt.confirmed, true);
  assert.equal(h.registry.describe(id).scheduledPrompt.ready, false,
    'turn completion alone cannot prove protected multiline paste');
  h.pty.spawned[0]._onData('\x1b[?20');
  h.pty.spawned[0]._onData('04h');
  assert.equal(h.registry.describe(id).scheduledPrompt.ready, true);
  assert.equal(h.registry.describe(id).scheduledPrompt.bracketedPaste, true);
  assert.equal(h.registry.scheduleTarget(id).incarnationId, h.registry.describe(id).incarnationId);
});

test('delivery remains unavailable when the provider disables bracketed paste mode', async () => {
  const h = harness();
  const id = h.registry.create(DIRECT_SPEC).id;
  h.ready();
  h.pty.spawned[0]._onData('\x1b[?2004l');
  assert.equal(h.registry.describe(id).scheduledPrompt.bracketedPaste, false);
  assert.equal(h.registry.scheduleTarget(id), null);
  assert.equal(await deliverScheduledPrompt(scheduleFor(h.registry, id, 'line one\nline two'), {
    registry: h.registry,
    delay: async () => {},
  }), 'unavailable');
  assert.deepEqual(h.pty.spawned[0].written, []);
});

test('guarded delivery writes one protected paste then exactly one Enter', async () => {
  const h = harness();
  const id = h.registry.create(DIRECT_SPEC).id;
  h.ready();
  const schedule = scheduleFor(h.registry, id, 'line one\nline two');
  const result = await deliverScheduledPrompt(schedule, {
    registry: h.registry,
    delay: async () => {},
  });
  assert.equal(result, 'sent');
  assert.deepEqual(h.pty.spawned[0].written, [
    `${BRACKETED_PASTE_START}line one\nline two${BRACKETED_PASTE_END}`,
    '\r',
  ]);
  assert.equal(h.registry.describe(id).scheduledPrompt.readiness, 'running');
  h.broker.complete();
  assert.ok(h.registry.scheduleTarget(id),
    'a successful submit becomes eligible again after the next provider completion');
});

test('account shells, exited agents, and unconfirmed direct sessions fail closed', async () => {
  const h = harness();
  const unconfirmed = h.registry.create(DIRECT_SPEC).id;
  assert.equal(await deliverScheduledPrompt(scheduleFor(h.registry, unconfirmed), {
    registry: h.registry,
    delay: async () => {},
  }), 'unavailable');

  h.ready(0);
  h.pty.spawned[0].exit(0);
  assert.equal(await deliverScheduledPrompt(scheduleFor(h.registry, unconfirmed), {
    registry: h.registry,
    delay: async () => {},
  }), 'session_changed');

  const shell = h.registry.create({ ...DIRECT_SPEC, sessionMode: 'account-shell' }).id;
  assert.equal(await deliverScheduledPrompt(scheduleFor(h.registry, shell), {
    registry: h.registry,
    delay: async () => {},
  }), 'session_changed', 'a provider label on a shell is not agent-active proof');
});

test('running turns, approval waits, recent input, and old drafts remain busy', async () => {
  const h = harness();
  const id = h.registry.create(DIRECT_SPEC).id;
  h.ready();
  const schedule = scheduleFor(h.registry, id);

  h.registry.write(id, '\r');
  assert.equal(h.registry.scheduleTarget(id), null,
    'a running or approval-waiting session cannot accept a new schedule binding');
  assert.equal(await deliverScheduledPrompt(schedule, { registry: h.registry, delay: async () => {} }), 'busy');
  // An approval dialog is deliberately represented by the same provider-owned
  // non-complete state: no turn-complete receipt means no delivery.
  assert.equal(h.registry.describe(id).scheduledPrompt.readiness, 'running');

  h.ready();
  assert.equal(await deliverScheduledPrompt(schedule, { registry: h.registry, delay: async () => {} }), 'busy',
    'a just-completed human submission remains inside the quiet period');
  h.setNow(h.now() + 30_001);
  h.registry.write(id, 'unsent draft');
  assert.equal(h.registry.scheduleTarget(id), null,
    'a session with an unsent draft cannot accept a new schedule binding');
  h.broker.complete();
  assert.equal(h.registry.scheduleTarget(id), null,
    'a later provider receipt cannot clear an app-observed draft');
  h.setNow(h.now() + 60_000);
  assert.equal(await deliverScheduledPrompt(schedule, { registry: h.registry, delay: async () => {} }), 'busy',
    'an old draft is still unsafe even after the quiet period');
});

test('input typed during a running or approval-waiting turn stays locked after completion', async () => {
  const h = harness();
  const id = h.registry.create(DIRECT_SPEC).id;
  h.ready();
  const schedule = scheduleFor(h.registry, id);

  h.registry.write(id, '\r');
  h.registry.write(id, 'foreign composer text');
  h.broker.complete();
  h.setNow(h.now() + 60_000);

  assert.equal(h.registry.scheduleTarget(id), null);
  assert.equal(await deliverScheduledPrompt(schedule, {
    registry: h.registry,
    delay: async () => {},
  }), 'busy');
});

test('a second scheduled delivery cannot enter the same session', async () => {
  const h = harness();
  const id = h.registry.create(DIRECT_SPEC).id;
  h.ready();
  const first = scheduleFor(h.registry, id);
  const second = {
    ...scheduleFor(h.registry, id),
    deliveryClaim: {
      ...scheduleFor(h.registry, id).deliveryClaim,
      token: '30000000-0000-4000-8000-000000000002',
    },
  };
  let release;
  const paused = new Promise(resolve => { release = resolve; });
  const firstDelivery = deliverScheduledPrompt(first, {
    registry: h.registry,
    delay: async () => paused,
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await deliverScheduledPrompt(second, {
    registry: h.registry,
    delay: async () => {},
  }), 'busy');
  release();
  assert.equal(await firstDelivery, 'sent');
});

test('profile or agent replacement is terminal even when the session id survives', async () => {
  const h = harness();
  const id = h.registry.create(DIRECT_SPEC).id;
  h.ready();
  const schedule = scheduleFor(h.registry, id);
  assert.equal(await deliverScheduledPrompt({ ...schedule, expectedProfileId: 'codex:b' }, {
    registry: h.registry,
    delay: async () => {},
  }), 'session_changed');
  assert.equal(await deliverScheduledPrompt({ ...schedule, expectedAgent: 'grok' }, {
    registry: h.registry,
    delay: async () => {},
  }), 'session_changed');
  assert.deepEqual(h.pty.spawned[0].written, []);
});

test('concurrent human input after paste prevents unattended Enter and consumes as error', async () => {
  const h = harness();
  const id = h.registry.create(DIRECT_SPEC).id;
  h.ready();
  const schedule = scheduleFor(h.registry, id);
  const result = await deliverScheduledPrompt(schedule, {
    registry: h.registry,
    delay: async () => { h.registry.write(id, 'human'); },
  });
  assert.equal(result, 'error');
  assert.deepEqual(h.pty.spawned[0].written, [
    `${BRACKETED_PASTE_START}${schedule.prompt}${BRACKETED_PASTE_END}`,
    'human',
  ]);
});

test('a terminal cursor-position reply after paste does not impersonate human input', async () => {
  const h = harness();
  const id = h.registry.create(DIRECT_SPEC).id;
  h.ready();
  const schedule = scheduleFor(h.registry, id);
  const result = await deliverScheduledPrompt(schedule, {
    registry: h.registry,
    delay: async () => { h.registry.write(id, '\x1b[12;40R'); },
  });
  assert.equal(result, 'sent');
  assert.deepEqual(h.pty.spawned[0].written, [
    `${BRACKETED_PASTE_START}${schedule.prompt}${BRACKETED_PASTE_END}`,
    '\x1b[12;40R',
    '\r',
  ]);
});

for (const [name, reply] of [
  ['device attributes', '\x1b[?1;2c'],
  ['device status', '\x1b[0n'],
  ['mode report', '\x1b[?2004;1$y'],
  ['window size', '\x1b[8;40;120t'],
  ['colour report', '\x1b]10;rgb:ffff/eeee/dddd\x1b\\'],
  ['status string', '\x1bP1$r0m\x1b\\'],
  ['focus report', '\x1b[I'],
]) {
  test(`an xterm ${name} reply does not impersonate composer input`, async () => {
    const h = harness();
    const id = h.registry.create(DIRECT_SPEC).id;
    h.ready();
    const schedule = scheduleFor(h.registry, id);
    const result = await deliverScheduledPrompt(schedule, {
      registry: h.registry,
      delay: async () => { h.registry.write(id, reply); },
    });
    assert.equal(result, 'sent');
    assert.deepEqual(h.pty.spawned[0].written, [
      `${BRACKETED_PASTE_START}${schedule.prompt}${BRACKETED_PASTE_END}`,
      reply,
      '\r',
    ]);
  });
}

test('an arbitrary terminal control payload still blocks unattended Enter', async () => {
  const h = harness();
  const id = h.registry.create(DIRECT_SPEC).id;
  h.ready();
  const schedule = scheduleFor(h.registry, id);
  const arbitrary = '\x1b]52;c;foreign-data\x1b\\';
  assert.equal(await deliverScheduledPrompt(schedule, {
    registry: h.registry,
    delay: async () => { h.registry.write(id, arbitrary); },
  }), 'error');
  assert.deepEqual(h.pty.spawned[0].written, [
    `${BRACKETED_PASTE_START}${schedule.prompt}${BRACKETED_PASTE_END}`,
    arbitrary,
  ]);
});

test('session replacement after paste cannot receive submit', async () => {
  const h = harness();
  const id = h.registry.create(DIRECT_SPEC, { id: 'sess-aba' }).id;
  h.ready();
  const schedule = scheduleFor(h.registry, id);
  let replacement;
  const result = await deliverScheduledPrompt(schedule, {
    registry: h.registry,
    delay: async () => {
      h.pty.spawned[0].exit(0);
      h.registry.prune();
      replacement = h.registry.create(DIRECT_SPEC, { id: 'sess-aba' });
      h.ready();
    },
  });
  assert.equal(result, 'error');
  assert.notEqual(h.registry.describe(replacement.id).incarnationId, schedule.sessionIncarnationId);
  assert.equal(h.pty.spawned[0].written.length, 1);
  assert.deepEqual(h.pty.spawned[1].written, []);
});

test('a possible partial paste is an error and is never followed by Enter', async () => {
  const h = harness();
  const id = h.registry.create(DIRECT_SPEC).id;
  h.ready();
  h.pty.spawned[0].write = function write(text) {
    this.written.push(text.slice(0, 12));
    throw new Error('native write failed after a possible prefix');
  };
  const result = await deliverScheduledPrompt(scheduleFor(h.registry, id), {
    registry: h.registry,
    delay: async () => {},
  });
  assert.equal(result, 'error');
  assert.equal(h.pty.spawned[0].written.length, 1);
  assert.notEqual(h.pty.spawned[0].written[0], '\r');

  h.pty.spawned[0].write = function write(text) { this.written.push(text); };
  h.broker.complete();
  h.setNow(h.now() + 60_000);
  assert.equal(await deliverScheduledPrompt(scheduleFor(h.registry, id), {
    registry: h.registry,
    delay: async () => {},
  }), 'busy', 'a later repeat cannot paste over an uncertain partial write');
  assert.equal(h.pty.spawned[0].written.length, 1);
});

test('post-paste mode loss leaves a sticky draft lock across later receipts', async () => {
  const h = harness();
  const id = h.registry.create(DIRECT_SPEC).id;
  h.ready();
  const schedule = scheduleFor(h.registry, id);

  assert.equal(await deliverScheduledPrompt(schedule, {
    registry: h.registry,
    delay: async () => { h.pty.spawned[0]._onData('\x1b[?2004l'); },
  }), 'error');
  assert.deepEqual(h.pty.spawned[0].written, [
    `${BRACKETED_PASTE_START}${schedule.prompt}${BRACKETED_PASTE_END}`,
  ]);

  h.pty.spawned[0]._onData('\x1b[?2004h');
  h.broker.complete();
  h.setNow(h.now() + 60_000);
  assert.equal(h.registry.scheduleTarget(id), null);
  assert.equal(await deliverScheduledPrompt(schedule, {
    registry: h.registry,
    delay: async () => {},
  }), 'busy');
  assert.equal(h.pty.spawned[0].written.length, 1);
});

test('a possibly partial submit leaves a sticky draft lock', async () => {
  const h = harness();
  const id = h.registry.create(DIRECT_SPEC).id;
  h.ready();
  const schedule = scheduleFor(h.registry, id);
  const originalWrite = h.pty.spawned[0].write;
  h.pty.spawned[0].write = function write(text) {
    if (text === '\r') throw new Error('submit may have reached ConPTY');
    return originalWrite.call(this, text);
  };

  assert.equal(await deliverScheduledPrompt(schedule, {
    registry: h.registry,
    delay: async () => {},
  }), 'error');
  h.broker.complete();
  h.setNow(h.now() + 60_000);
  assert.equal(await deliverScheduledPrompt(schedule, {
    registry: h.registry,
    delay: async () => {},
  }), 'busy');
  assert.equal(h.pty.spawned[0].written.length, 1);
});

test('hostile terminal controls are rejected before any PTY write', async () => {
  const h = harness();
  const id = h.registry.create(DIRECT_SPEC).id;
  h.ready();
  for (const prompt of ['escape\x1b[201~forgery', 'nul\x00byte', 'control\x7fbyte']) {
    await assert.rejects(
      deliverScheduledPrompt(scheduleFor(h.registry, id, prompt), { registry: h.registry, delay: async () => {} }),
      /control/
    );
  }
  assert.deepEqual(h.pty.spawned[0].written, []);
});
