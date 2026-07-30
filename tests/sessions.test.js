// Unit tests for the PTY session registry, driven by a fake node-pty.
const test = require('node:test');
const assert = require('node:assert/strict');

const { SessionRegistry, nextSessionId } = require('../src/main/sessions');

/** Minimal node-pty stand-in: records writes, lets a test drive exit. */
function fakePty() {
  const spawned = [];
  const api = {
    spawn(file, args, opts) {
      const proc = {
        pid: 1000 + spawned.length,
        file, args, opts,
        written: [],
        resized: null,
        killed: null,
        _onData: null,
        _onExit: null,
        onData(cb) { this._onData = cb; },
        onExit(cb) { this._onExit = cb; },
        write(text) { this.written.push(text); },
        resize(cols, rows) { this.resized = { cols, rows }; },
        kill(sig) { this.killed = sig; },
        /** test helper */
        emitData(d) { this._onData && this._onData(d); },
        exit(code) { this._onExit && this._onExit({ exitCode: code }); },
      };
      spawned.push(proc);
      return proc;
    },
    spawned,
  };
  return api;
}

function makeRegistry(overrides = {}) {
  const events = { output: [], exit: [], status: [], killedTrees: [] };
  const pty = fakePty();
  const reg = new SessionRegistry({
    pty,
    onOutput: (e) => events.output.push(e),
    onExit: (e) => events.exit.push(e),
    onStatus: (e) => events.status.push(e),
    killTree: (pid) => events.killedTrees.push(pid),
    ...overrides,
  });
  return { reg, pty, events };
}

const SPEC = {
  file: 'pwsh.exe',
  args: ['-NoLogo'],
  env: { PATH: '/usr/bin' },
  cwd: 'C:/tmp',
  profileId: 'claude-work',
  agent: 'claude',
  label: 'Claude · work',
  assurance: 'L2-env',
  resultInputCapable: true,
};

test('nextSessionId produces ids the IPC validator accepts', () => {
  const { ID_PATTERN } = require('../src/main/validate');
  for (let i = 0; i < 5; i++) {
    assert.match(nextSessionId(), ID_PATTERN);
  }
  assert.notEqual(nextSessionId(), nextSessionId());
});

test('create spawns with the spec and records metadata', () => {
  const { reg, pty } = makeRegistry();
  const { id, pid } = reg.create(SPEC, { cols: 100, rows: 30 });

  assert.equal(pty.spawned.length, 1);
  const proc = pty.spawned[0];
  assert.equal(proc.file, 'pwsh.exe');
  assert.deepEqual(proc.args, ['-NoLogo']);
  assert.equal(proc.opts.cwd, 'C:/tmp');
  assert.deepEqual(proc.opts.env, { PATH: '/usr/bin' });
  assert.equal(proc.opts.cols, 100);
  assert.equal(proc.opts.rows, 30);
  assert.equal(proc.opts.useConpty, true);

  const meta = reg.describe(id);
  assert.equal(meta.pid, pid);
  assert.equal(meta.agent, 'claude');
  assert.equal(meta.label, 'Claude · work');
  assert.equal(meta.assurance, 'L2-env');
  assert.equal(meta.resultInputCapable, true);
  assert.equal(meta.status, 'running');
});

test('describe never leaks env or the resolved executable path', () => {
  // A routed spec carries canonical account-home paths. Those are
  // secret-adjacent and must not reach the renderer or any log.
  const { reg } = makeRegistry();
  const { id } = reg.create({
    ...SPEC,
    env: { CODEX_HOME: 'C:/private/vault/codex-a', SECRETISH: 'x' },
  });
  const meta = reg.describe(id);
  const serialized = JSON.stringify(meta);
  assert.equal(meta.env, undefined);
  assert.equal(meta.file, undefined);
  assert.equal(meta.cwd, undefined);
  assert.ok(!serialized.includes('vault'), 'metadata must not contain home paths');
  assert.ok(!serialized.includes('CODEX_HOME'));
});

test('create rejects a spec with no executable', () => {
  const { reg } = makeRegistry();
  assert.throws(() => reg.create({ args: [] }), /missing an executable/);
  assert.throws(() => reg.create(null), /missing an executable/);
});

test('reusing a live id fails closed without disturbing the previous PTY', () => {
  const { reg, pty } = makeRegistry();
  reg.create(SPEC, { id: 'sess-fixed' });
  assert.throws(
    () => reg.create(SPEC, { id: 'sess-fixed' }),
    /already in use/
  );
  assert.equal(pty.spawned[0].killed, null);
  assert.equal(pty.spawned.length, 1);
  assert.equal(reg.size, 1);
});

test('a removed live id stays reserved until its old PTY exits', () => {
  const { reg, pty } = makeRegistry();
  reg.create(SPEC, { id: 'sess-fixed' });
  reg.remove('sess-fixed');
  assert.throws(() => reg.create(SPEC, { id: 'sess-fixed' }), /already in use/);

  pty.spawned[0].exit(0);
  assert.doesNotThrow(() => reg.create(SPEC, { id: 'sess-fixed' }));
  assert.equal(pty.spawned.length, 2);
});

test('closing admission rejects every later create without spawning', () => {
  const { reg, pty } = makeRegistry();
  reg.closeAdmission('test shutdown');
  assert.equal(reg.admissionClosed, true);
  assert.throws(() => reg.create(SPEC), /test shutdown/);
  assert.equal(pty.spawned.length, 0);
});

test('write translates LF to CR and only reaches live sessions', () => {
  const { reg, pty } = makeRegistry();
  const { id } = reg.create(SPEC);
  assert.equal(reg.write(id, 'hello\nworld\n'), true);
  assert.deepEqual(pty.spawned[0].written, ['hello\rworld\r']);

  assert.equal(reg.write('nope', 'x'), false);
  pty.spawned[0].exit(0);
  assert.equal(reg.write(id, 'after exit'), false);
});

test('structured writes require the main-owned live-session capability', () => {
  const { reg, pty } = makeRegistry();
  const capable = reg.create(SPEC).id;
  const shell = reg.create({
    ...SPEC,
    profileId: 'shell',
    agent: 'shell',
    resultInputCapable: false,
  }).id;

  assert.equal(reg.writeStructured(capable, 'line one\nline two'), true);
  assert.deepEqual(pty.spawned[0].written, ['line one\rline two']);

  assert.throws(
    () => reg.writeStructured(shell, 'Remove-Item ./valuable.txt\r'),
    /not capable of structured result input/
  );
  assert.deepEqual(pty.spawned[1].written, [], 'rejected result text must never reach the shell');

  pty.spawned[0].exit(0);
  assert.throws(() => reg.writeStructured(capable, 'late'), /No live session/);
  assert.deepEqual(pty.spawned[0].written, ['line one\rline two']);
  assert.throws(() => reg.writeStructured('missing', 'late'), /No live session/);
});

test('resize clamps geometry and survives a throwing PTY', () => {
  const { reg, pty } = makeRegistry();
  const { id } = reg.create(SPEC);
  assert.equal(reg.resize(id, 999999, -5), true);
  assert.deepEqual(pty.spawned[0].resized, { cols: 1000, rows: 1 });

  pty.spawned[0].resize = () => { throw new Error('conpty busy'); };
  assert.equal(reg.resize(id, 80, 24), false);
  assert.equal(reg.resize('nope', 80, 24), false);
});

test('exit records the code, flips status, and notifies once', () => {
  const { reg, pty, events } = makeRegistry();
  const { id } = reg.create(SPEC);
  pty.spawned[0].exit(3);

  assert.deepEqual(events.exit, [{ id, code: 3 }]);
  const meta = reg.describe(id);
  assert.equal(meta.status, 'exited');
  assert.equal(meta.exitCode, 3);
  assert.equal(reg.isRunning(id), false);
});

test('output is tagged with its session id', () => {
  const { reg, pty, events } = makeRegistry();
  const a = reg.create(SPEC).id;
  const b = reg.create({ ...SPEC, label: 'Codex · a' }).id;
  pty.spawned[0].emitData('from-a');
  pty.spawned[1].emitData('from-b');

  assert.deepEqual(events.output.map(e => [e.id, e.data]), [[a, 'from-a'], [b, 'from-b']]);
  assert.notEqual(a, b);
});

test('output checkpoints are opaque counters and buffered text stays out of metadata', () => {
  const { reg, pty } = makeRegistry();
  const { id } = reg.create(SPEC);
  assert.deepEqual(reg.checkpoint(id), { outputSeq: 0 });

  pty.spawned[0].emitData('C:/private/path should stay main-only');
  assert.deepEqual(reg.checkpoint(id), { outputSeq: 1 });
  assert.ok(!JSON.stringify(reg.describe(id)).includes('private'));
  assert.equal(reg.checkpoint('missing'), null);
});

test('waitForOutput matches case-insensitive text across ANSI-decorated chunks', async () => {
  const { reg, pty } = makeRegistry();
  const { id } = reg.create(SPEC);
  const checkpoint = reg.checkpoint(id);
  const waiting = reg.waitForOutput(id, {
    afterSeq: checkpoint.outputSeq,
    idleMs: 0,
    pattern: 'rate limit',
    timeoutMs: 500,
  });

  pty.spawned[0].emitData('\x1b[31mRa');
  pty.spawned[0].emitData('te LIMIT\x1b[0m');
  const result = await waiting;
  assert.equal(result.reason, 'match');
  assert.equal(result.outputSeq, 2);
  assert.deepEqual(
    Object.keys(result),
    ['reason', 'elapsedMs', 'outputSeq'],
    'ordinary waits must not gain a capture field'
  );
});

test('waitForOutput sees output that raced between checkpoint and registration', async () => {
  const { reg, pty } = makeRegistry();
  const { id } = reg.create(SPEC);
  const checkpoint = reg.checkpoint(id);
  pty.spawned[0].emitData('fast reply: done');

  const result = await reg.waitForOutput(id, {
    afterSeq: checkpoint.outputSeq,
    idleMs: 1000,
    pattern: 'DONE',
    timeoutMs: 500,
  });
  assert.equal(result.reason, 'match');
});

test('framed capture excludes pre-checkpoint echo and handles split markers and controls', async () => {
  const { reg, pty } = makeRegistry();
  const { id } = reg.create(SPEC);
  const startMarker = '<<<RESULT:BEGIN>>>';
  const endMarker = '<<<RESULT:END>>>';

  pty.spawned[0].emitData(`PS> echoed ${startMarker}wrong${endMarker}`);
  const checkpoint = reg.checkpoint(id);
  const waiting = reg.waitForOutput(id, {
    afterSeq: checkpoint.outputSeq,
    idleMs: 0,
    timeoutMs: 500,
    capture: { startMarker, endMarker, maxBytes: 1024 },
  });

  pty.spawned[0].emitData(`fresh prompt\r${startMarker.slice(0, 8)}`);
  pty.spawned[0].emitData(`${startMarker.slice(8)}\x1b[3`);
  pty.spawned[0].emitData('1mHello\x1b[0m\r\n');
  pty.spawned[0].emitData(`world!${endMarker.slice(0, 7)}`);
  pty.spawned[0].emitData(`${endMarker.slice(7)}not part of the result`);

  const result = await waiting;
  assert.equal(result.reason, 'match');
  assert.equal(result.outputSeq, 6);
  assert.deepEqual(result.capture, {
    complete: true,
    missingStart: false,
    missingEnd: false,
    truncatedBefore: false,
    truncatedAfter: false,
    fromSeq: 2,
    throughSeq: 6,
    byteLength: 12,
    text: 'Hello\nworld!',
  });

  const metadata = JSON.stringify(reg.describe(id));
  assert.ok(!metadata.includes('Hello'));
  assert.ok(!metadata.includes(startMarker));
  assert.equal(reg.describe(id).capture, undefined);
});

test('terminal cleanup after an end marker cannot invalidate a completed frame', async () => {
  const { reg, pty } = makeRegistry();
  const { id } = reg.create(SPEC);
  const waiting = reg.waitForOutput(id, {
    idleMs: 0,
    timeoutMs: 500,
    capture: {
      startMarker: 'FRAME-START',
      endMarker: 'FRAME-END',
      maxBytes: 100,
    },
  });

  pty.spawned[0].emitData('FRAME-STARTbodyFRAME-END\x1b[2K');
  const result = await waiting;
  assert.equal(result.reason, 'match');
  assert.deepEqual(result.capture, {
    complete: true,
    missingStart: false,
    missingEnd: false,
    truncatedBefore: false,
    truncatedAfter: false,
    fromSeq: 1,
    throughSeq: 1,
    byteLength: 4,
    text: 'body',
  });
});

test('terminal redraw inside a result frame remains incomplete', async () => {
  const { reg, pty } = makeRegistry();
  const { id } = reg.create(SPEC);
  const waiting = reg.waitForOutput(id, {
    idleMs: 0,
    timeoutMs: 500,
    capture: {
      startMarker: 'FRAME-START',
      endMarker: 'FRAME-END',
      maxBytes: 100,
    },
  });

  pty.spawned[0].emitData('FRAME-STARTbo\x1b[2KdyFRAME-END');
  const result = await waiting;
  assert.equal(result.reason, 'match');
  assert.equal(result.capture.complete, false);
  assert.equal(result.capture.truncatedAfter, true);
  assert.equal(result.capture.text, 'body');
});

test('control strings cannot forge markers and ANSI may decorate visible markers', async () => {
  const { reg, pty } = makeRegistry();
  const { id } = reg.create(SPEC);
  // These token shapes deliberately also fit inside real CSI parameter bytes.
  const startMarker = '31;42m';
  const endMarker = '0;99m';
  const waiting = reg.waitForOutput(id, {
    idleMs: 0,
    timeoutMs: 500,
    capture: { startMarker, endMarker, maxBytes: 100 },
  });
  let settled = false;
  waiting.then(() => { settled = true; });

  pty.spawned[0].emitData(`\x1b]0;${startMarker}OSC forgery`);
  pty.spawned[0].emitData(`${endMarker}\x1b\\`);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'OSC payload is not visible framing text');

  pty.spawned[0].emitData(`\x1bPDCS bell is data\x07${startMarker}DCS forgery`);
  pty.spawned[0].emitData(`${endMarker}\x1b\\`);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'DCS payload is not visible framing text');

  pty.spawned[0].emitData(`\x1b[${startMarker}\x1b[${endMarker}`);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'CSI parameter bytes are not visible framing text');

  pty.spawned[0].emitData(`31;\x1b[35m`);
  pty.spawned[0].emitData(`42mtrusted body0;\x1b[0m`);
  pty.spawned[0].emitData('99m');
  const result = await waiting;

  assert.equal(result.reason, 'match');
  assert.deepEqual(result.capture, {
    complete: true,
    missingStart: false,
    missingEnd: false,
    truncatedBefore: false,
    truncatedAfter: false,
    fromSeq: 6,
    throughSeq: 8,
    byteLength: 12,
    text: 'trusted body',
  });
});

test('SGR-concealed text cannot forge a visible result frame', async () => {
  const { reg, pty } = makeRegistry();
  const { id } = reg.create(SPEC);
  const startMarker = '<<<VISIBLE:BEGIN>>>';
  const endMarker = '<<<VISIBLE:END>>>';
  const waiting = reg.waitForOutput(id, {
    idleMs: 0,
    timeoutMs: 500,
    capture: { startMarker, endMarker, maxBytes: 100 },
  });

  pty.spawned[0].emitData(
    `\x1b[8m${startMarker}hidden result${endMarker}\x1b[28m`
  );
  let settled = false;
  waiting.then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'concealed framing is not renderable text');

  pty.spawned[0].emitData(`${startMarker}visible result${endMarker}`);
  const result = await waiting;
  assert.equal(result.reason, 'match');
  assert.equal(result.capture.complete, true);
  assert.equal(result.capture.text, 'visible result');
});

test('redraw and hidden controls cannot join visible marker fragments', async () => {
  const { reg, pty } = makeRegistry();
  const { id } = reg.create(SPEC);
  const startMarker = 'ABC';
  const endMarker = 'XYZ';
  const waiting = reg.waitForOutput(id, {
    idleMs: 0,
    timeoutMs: 500,
    capture: { startMarker, endMarker, maxBytes: 100 },
  });
  let settled = false;
  waiting.then(() => { settled = true; });

  pty.spawned[0].emitData('A\bBCbackspace');
  pty.spawned[0].emitData('A\rBCcarriage');
  pty.spawned[0].emitData('A\x1b]0;hidden title\x07BControl-string');
  pty.spawned[0].emitData('A\x1b[2KBCerase');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);

  pty.spawned[0].emitData(`${startMarker}trusted${endMarker}`);
  const result = await waiting;
  assert.equal(result.capture.complete, true);
  assert.equal(result.capture.text, 'trusted');
});

test('capture carries hidden terminal state across its checkpoint', async () => {
  const { reg, pty } = makeRegistry();
  const startMarker = '31;42';
  const endMarker = ';99';
  const cases = [
    {
      name: 'OSC',
      open: '\x1b]0;',
      hidden: `${startMarker}hidden${endMarker}\x07`,
      raceBeforeWait: true,
    },
    {
      name: 'DCS',
      open: '\x1bP',
      hidden: `${startMarker}hidden${endMarker}\x1b\\`,
    },
    {
      name: 'CSI',
      open: '\x1b[',
      hidden: `${startMarker}7${endMarker}m`,
    },
  ];

  for (const scenario of cases) {
    const { id } = reg.create(SPEC);
    const proc = pty.spawned.at(-1);
    proc.emitData(scenario.open);
    const checkpoint = reg.checkpoint(id);
    if (scenario.raceBeforeWait) proc.emitData(scenario.hidden);

    const waiting = reg.waitForOutput(id, {
      afterSeq: checkpoint.outputSeq,
      idleMs: 0,
      timeoutMs: 1000,
      capture: { startMarker, endMarker, maxBytes: 100 },
    });
    let settled = false;
    waiting.then(() => { settled = true; });
    if (!scenario.raceBeforeWait) proc.emitData(scenario.hidden);

    await new Promise(resolve => setImmediate(resolve));
    assert.equal(
      settled,
      false,
      `${scenario.name} payload crossing the checkpoint must stay hidden`
    );

    proc.emitData(`${startMarker}${scenario.name} trusted${endMarker}`);
    const result = await waiting;
    assert.equal(result.capture.complete, true);
    assert.equal(result.capture.text, `${scenario.name} trusted`);
    assert.equal(result.capture.fromSeq, 3);
    assert.equal(result.capture.throughSeq, 3);
  }
});

test('capture maxBytes is a UTF-8 prefix cap and reports truncation', async () => {
  const { reg, pty } = makeRegistry();
  const { id } = reg.create(SPEC);
  const startMarker = '<RESULT>';
  const endMarker = '</RESULT>';
  const waiting = reg.waitForOutput(id, {
    idleMs: 0,
    timeoutMs: 500,
    capture: { startMarker, endMarker, maxBytes: 5 },
  });

  pty.spawned[0].emitData(`${startMarker}éééZ${endMarker}`);
  const result = await waiting;
  assert.equal(result.reason, 'match');
  assert.deepEqual(result.capture, {
    complete: false,
    missingStart: false,
    missingEnd: false,
    truncatedBefore: false,
    truncatedAfter: true,
    fromSeq: 1,
    throughSeq: 1,
    byteLength: 4,
    text: 'éé',
  });
});

test('capture replays a raced frame only through its end-marker chunk', async () => {
  const { reg, pty } = makeRegistry();
  const { id } = reg.create(SPEC);
  const checkpoint = reg.checkpoint(id);
  const capture = {
    startMarker: 'FRAME-START',
    endMarker: 'FRAME-END',
    maxBytes: 100,
  };

  pty.spawned[0].emitData('FRAME-STARTatomic resultFRAME-ENDsame chunk tail');
  pty.spawned[0].emitData('later terminal output');
  const result = await reg.waitForOutput(id, {
    afterSeq: checkpoint.outputSeq,
    idleMs: 0,
    timeoutMs: 500,
    capture,
  });

  assert.equal(result.outputSeq, 2, 'legacy position still reports the latest output');
  assert.equal(result.capture.fromSeq, 1);
  assert.equal(result.capture.throughSeq, 1);
  assert.equal(result.capture.text, 'atomic result');
  assert.equal(result.capture.complete, true);
});

test('an unframed end marker completes with no captured body', async () => {
  const { reg, pty } = makeRegistry();
  const { id } = reg.create(SPEC);
  const waiting = reg.waitForOutput(id, {
    idleMs: 0,
    timeoutMs: 500,
    capture: {
      startMarker: 'FRAME-START',
      endMarker: 'FRAME-END',
      maxBytes: 100,
    },
  });

  pty.spawned[0].emitData('untrusted output FRAME-END trailing output');
  const result = await waiting;
  assert.equal(result.reason, 'match');
  assert.deepEqual(result.capture, {
    complete: false,
    missingStart: true,
    missingEnd: false,
    truncatedBefore: false,
    truncatedAfter: false,
    fromSeq: null,
    throughSeq: 1,
    byteLength: 0,
    text: '',
  });
});

test('capture marks a start evicted from bounded history as partial', async () => {
  const { reg, pty } = makeRegistry();
  const { id } = reg.create(SPEC);
  const startMarker = 'FRAME-START';
  const endMarker = 'FRAME-END';
  const checkpoint = reg.checkpoint(id);

  // One oversized PTY chunk is retained as a suffix. Its start marker is gone
  // before the waiter registers, but the end boundary and surviving body stay.
  pty.spawned[0].emitData(
    `${startMarker}${'x'.repeat(64 * 1024 + 128)}${endMarker}`
  );
  const result = await reg.waitForOutput(id, {
    afterSeq: checkpoint.outputSeq,
    idleMs: 0,
    timeoutMs: 500,
    capture: { startMarker, endMarker, maxBytes: 64 * 1024 },
  });

  assert.equal(result.reason, 'match');
  assert.equal(result.capture.complete, false);
  assert.equal(result.capture.missingStart, true);
  assert.equal(result.capture.missingEnd, false);
  assert.equal(result.capture.truncatedBefore, true);
  assert.equal(result.capture.truncatedAfter, false);
  assert.equal(result.capture.fromSeq, 1);
  assert.equal(result.capture.throughSeq, 1);
  assert.equal(result.capture.byteLength, 64 * 1024 - endMarker.length);
  assert.equal(result.capture.text, 'x'.repeat(64 * 1024 - endMarker.length));
});

test('cancelled and exited captures never return an unfinished body', async () => {
  const { reg, pty } = makeRegistry();
  const capture = {
    startMarker: 'FRAME-START',
    endMarker: 'FRAME-END',
    maxBytes: 100,
  };

  const cancelledId = reg.create(SPEC).id;
  const cancelledWait = reg.waitForOutput(cancelledId, {
    waitId: 'capture-cancel',
    idleMs: 0,
    timeoutMs: 5000,
    capture,
  });
  pty.spawned[0].emitData('FRAME-STARTcancelled secret');
  assert.equal(reg.cancelWait(cancelledId, 'capture-cancel'), true);
  const cancelled = await cancelledWait;
  assert.equal(cancelled.reason, 'cancelled');
  assert.equal(cancelled.capture.missingStart, false);
  assert.equal(cancelled.capture.missingEnd, true);
  assert.equal(cancelled.capture.byteLength, 0);
  assert.equal(cancelled.capture.text, '');
  assert.ok(!JSON.stringify(cancelled).includes('cancelled secret'));

  const exitedId = reg.create(SPEC).id;
  const exitedWait = reg.waitForOutput(exitedId, {
    idleMs: 0,
    timeoutMs: 5000,
    capture,
  });
  pty.spawned[1].emitData('FRAME-STARTexited secret');
  pty.spawned[1].exit(9);
  const exited = await exitedWait;
  assert.equal(exited.reason, 'exit');
  assert.equal(exited.capture.missingStart, false);
  assert.equal(exited.capture.missingEnd, true);
  assert.equal(exited.capture.byteLength, 0);
  assert.equal(exited.capture.text, '');
  assert.ok(!JSON.stringify(exited).includes('exited secret'));
});

test('idle waiting starts only after new output and resets on every chunk', async () => {
  const { reg, pty } = makeRegistry();
  const { id } = reg.create(SPEC);
  const checkpoint = reg.checkpoint(id);
  const waiting = reg.waitForOutput(id, {
    afterSeq: checkpoint.outputSeq,
    idleMs: 50,
    timeoutMs: 500,
  });

  pty.spawned[0].emitData('first');
  await new Promise(resolve => setTimeout(resolve, 30));
  pty.spawned[0].emitData('second');
  const result = await waiting;
  assert.equal(result.reason, 'idle');
  assert.equal(result.outputSeq, 2);
});

test('an already-idle terminal reaches the timeout backstop without new output', async () => {
  const { reg, pty } = makeRegistry();
  const { id } = reg.create(SPEC);
  pty.spawned[0].emitData('old prompt');
  const checkpoint = reg.checkpoint(id);

  const result = await reg.waitForOutput(id, {
    afterSeq: checkpoint.outputSeq,
    idleMs: 10,
    timeoutMs: 30,
  });
  assert.equal(result.reason, 'timeout');
});

test('pending output waits resolve on cancellation, exit, and removal', async () => {
  const { reg, pty } = makeRegistry();
  const first = reg.create(SPEC).id;
  const cancelled = reg.waitForOutput(first, {
    waitId: 'wait-cancel',
    idleMs: 1000,
    timeoutMs: 5000,
  });
  assert.equal(reg.cancelWait(first, 'wait-cancel'), true);
  assert.equal((await cancelled).reason, 'cancelled');
  assert.equal(reg.cancelWait(first, 'wait-cancel'), false);

  const second = reg.create(SPEC).id;
  const exited = reg.waitForOutput(second, { idleMs: 1000, timeoutMs: 5000 });
  pty.spawned[1].exit(0);
  assert.equal((await exited).reason, 'exit');

  const third = reg.create(SPEC).id;
  const removed = reg.waitForOutput(third, { idleMs: 1000, timeoutMs: 5000 });
  reg.remove(third);
  assert.equal((await removed).reason, 'removed');
});

test('waitForOutput validates its completion conditions', () => {
  const { reg } = makeRegistry();
  const { id } = reg.create(SPEC);
  assert.throws(
    () => reg.waitForOutput(id, { idleMs: 0, pattern: '', timeoutMs: 100 }),
    /needs idleMs or an output pattern/
  );
  assert.throws(
    () => reg.waitForOutput(id, { idleMs: 1.5, timeoutMs: 100 }),
    /idleMs must be an integer/
  );
  assert.throws(
    () => reg.waitForOutput(id, { idleMs: 10, timeoutMs: 0 }),
    /timeoutMs must be an integer/
  );
});

test('waitForOutput validates bounded capture framing', async () => {
  const { reg } = makeRegistry();
  const { id } = reg.create(SPEC);
  const valid = {
    startMarker: 'FRAME-START',
    endMarker: 'FRAME-END',
    maxBytes: 64 * 1024,
  };

  assert.throws(
    () => reg.waitForOutput(id, { idleMs: 0, capture: 'frame' }),
    /capture must be an object/
  );
  for (const startMarker of ['', 'two words', 'line\nbreak', '結果']) {
    assert.throws(
      () => reg.waitForOutput(id, {
        idleMs: 0,
        capture: { ...valid, startMarker },
      }),
      /startMarker must be a non-empty tight printable ASCII token/
    );
  }
  assert.throws(
    () => reg.waitForOutput(id, {
      idleMs: 0,
      capture: { ...valid, startMarker: 'x'.repeat(201) },
    }),
    /startMarker exceeds 200 characters/
  );
  assert.throws(
    () => reg.waitForOutput(id, {
      idleMs: 0,
      capture: { ...valid, endMarker: valid.startMarker },
    }),
    /capture markers must be distinct/
  );
  for (const maxBytes of [undefined, 0, 1.5, '5', true, 64 * 1024 + 1]) {
    assert.throws(
      () => reg.waitForOutput(id, {
        idleMs: 0,
        capture: { ...valid, maxBytes },
      }),
      /capture\.maxBytes must be an integer from 1 to 65536/
    );
  }

  const accepted = reg.waitForOutput(id, {
    waitId: 'valid-capture',
    idleMs: 0,
    pattern: '',
    timeoutMs: 500,
    capture: { ...valid, maxBytes: 1 },
  });
  assert.equal(reg.cancelWait(id, 'valid-capture'), true);
  assert.equal((await accepted).reason, 'cancelled');
});

test('a session that ignores SIGTERM gets its process tree force-killed', async () => {
  const { reg, pty, events } = makeRegistry();
  const { id, pid } = reg.create(SPEC);
  reg.kill(id);
  assert.equal(pty.spawned[0].killed, 'SIGTERM');
  assert.deepEqual(events.killedTrees, [], 'no force-kill before the grace window');

  await new Promise(r => setTimeout(r, 1700));
  assert.deepEqual(events.killedTrees, [pid], 'force-kill after the grace window');
});

test('a session that exits promptly is never force-killed', async () => {
  const { reg, pty, events } = makeRegistry();
  const { id } = reg.create(SPEC);
  reg.kill(id);
  pty.spawned[0].exit(0);

  await new Promise(r => setTimeout(r, 1700));
  assert.deepEqual(events.killedTrees, [], 'graceful exit cancels the force-kill');
});

test('tree-first termination is requested before the parent can orphan children', async () => {
  const order = [];
  const { reg, pty, events } = makeRegistry({
    terminateTree: (pid) => order.push(['tree', pid]),
  });
  const { id, pid } = reg.create(SPEC);
  pty.spawned[0].kill = (signal) => {
    order.push(['parent', signal]);
    pty.spawned[0].killed = signal;
  };

  reg.kill(id);
  assert.deepEqual(order, [['tree', pid]]);
  assert.equal(pty.spawned[0].killed, null);

  pty.spawned[0].exit(0);
  await new Promise(r => setTimeout(r, 1700));
  assert.deepEqual(events.killedTrees, [], 'a completed tree request needs no retry');
});

test('a rejected tree-first request falls back to the parent signal', () => {
  const { reg, pty } = makeRegistry({
    terminateTree: () => { throw new Error('taskkill unavailable'); },
  });
  const { id } = reg.create(SPEC);
  reg.kill(id);
  assert.equal(pty.spawned[0].killed, 'SIGTERM');
});

test('killAll counts only live sessions', () => {
  const { reg, pty } = makeRegistry();
  reg.create(SPEC);
  const b = reg.create(SPEC).id;
  pty.spawned[1].exit(0);

  assert.equal(reg.killAll(), 1);
  assert.equal(reg.describe(b).status, 'exited');
});

test('killAllSequential waits for each exit before killing the next PTY', async () => {
  const { reg, pty } = makeRegistry();
  reg.create(SPEC);
  reg.create(SPEC);

  const stopping = reg.killAllSequential('test shutdown');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pty.spawned[0].killed, 'SIGTERM');
  assert.equal(pty.spawned[1].killed, null);

  pty.spawned[0].exit(0);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pty.spawned[1].killed, 'SIGTERM');
  pty.spawned[1].exit(0);
  assert.equal(await stopping, 2);
});

test('strict sequential shutdown rejects a PTY that never reports exit', async () => {
  const { reg, events } = makeRegistry({ terminationTimeoutMs: 5 });
  reg.create(SPEC, { id: 'stubborn' });

  await assert.rejects(
    reg.killAllSequential('shutdown', { failOnTimeout: true }),
    /Timed out waiting for session stubborn/
  );
  assert.deepEqual(events.killedTrees, [1000]);
});

test('strict sequential shutdown sweeps later PTYs after an early timeout', async () => {
  const { reg, pty, events } = makeRegistry();
  const first = reg.create(SPEC, { id: 'first' }).id;
  const second = reg.create(SPEC, { id: 'second' }).id;
  const third = reg.create(SPEC, { id: 'third' }).id;
  const drainAttempts = [];

  reg._waitForExit = async (session) => {
    drainAttempts.push(session.id);
    if (session.id === first) return false;
    session.proc.exit(0);
    return true;
  };

  await assert.rejects(
    reg.killAllSequential('renderer lost', { failOnTimeout: true }),
    error => (
      error.code === 'session-termination-timeout'
      && /session first/.test(error.message)
    )
  );

  assert.deepEqual(drainAttempts, [first, second, third]);
  assert.deepEqual(
    pty.spawned.map(proc => proc.killed),
    ['SIGTERM', 'SIGTERM', 'SIGTERM']
  );
  assert.deepEqual(events.killedTrees, [pty.spawned[0].pid]);
});

test('removeAndWait serializes rapid tab closes', async () => {
  const { reg, pty } = makeRegistry();
  const first = reg.create(SPEC).id;
  const second = reg.create(SPEC).id;

  const firstRemoval = reg.removeAndWait(first);
  const secondRemoval = reg.removeAndWait(second);
  let queueDrained = false;
  const drained = reg.whenTerminationsComplete().then(() => { queueDrained = true; });
  assert.equal(reg.hasPendingTermination, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(queueDrained, false);
  assert.equal(pty.spawned[0].killed, 'SIGTERM');
  assert.equal(pty.spawned[1].killed, null);
  assert.equal(reg.has(first), false);
  assert.equal(reg.has(second), true);

  pty.spawned[0].exit(0);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pty.spawned[1].killed, 'SIGTERM');
  assert.equal(reg.has(second), false);
  pty.spawned[1].exit(0);
  assert.deepEqual(await Promise.all([firstRemoval, secondRemoval]), [true, true]);
  await drained;
  assert.equal(queueDrained, true);
  assert.equal(reg.hasPendingTermination, false);
});

test('prune drops exited sessions and keeps live ones', () => {
  const { reg, pty } = makeRegistry();
  const a = reg.create(SPEC).id;
  const b = reg.create(SPEC).id;
  pty.spawned[0].exit(0);

  assert.equal(reg.prune(), 1);
  assert.equal(reg.has(a), false);
  assert.equal(reg.has(b), true);
});

test('remove kills a live session and forgets it', () => {
  const { reg, pty } = makeRegistry();
  const { id } = reg.create(SPEC);
  assert.equal(reg.remove(id), true);
  assert.equal(pty.spawned[0].killed, 'SIGTERM');
  assert.equal(reg.has(id), false);
  assert.equal(reg.remove('nope'), false);
});

test('closing a tab still force-kills a tree that ignores SIGTERM', async () => {
  // remove() drops the registry entry immediately; the escalation must not
  // depend on the entry still being there, or a stuck child survives.
  const { reg, events } = makeRegistry();
  const { id, pid } = reg.create(SPEC);
  reg.remove(id);

  await new Promise(r => setTimeout(r, 1700));
  assert.deepEqual(events.killedTrees, [pid]);
});

test('closing a tab whose process exits cleanly skips the force-kill', async () => {
  const { reg, pty, events } = makeRegistry();
  const { id } = reg.create(SPEC);
  reg.remove(id);
  pty.spawned[0].exit(0);

  await new Promise(r => setTimeout(r, 1700));
  assert.deepEqual(events.killedTrees, []);
});

test('list returns every session in creation order', () => {
  const { reg } = makeRegistry();
  const a = reg.create({ ...SPEC, label: 'first' }).id;
  const b = reg.create({ ...SPEC, label: 'second' }).id;
  assert.deepEqual(reg.list().map(s => s.id), [a, b]);
  assert.deepEqual(reg.list().map(s => s.label), ['first', 'second']);
});
