const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  SCHEMA_VERSION,
  RUN_STATUS,
  BLOCK_STATUS,
  RESULT_STATUS,
  STORAGE,
  MAX_RESULT_BYTES_PER_LANE,
  MAX_HANDOFF_BYTES,
  MAX_RESULT_BYTES,
  MAX_RUN_RESULT_BYTES,
  MAX_WORKFLOW_BYTES,
  MAX_MEMORY_ENTRIES,
  MAX_RUN_RECORD_BYTES,
  MAX_RESULTS,
  MAX_OPERATIONS,
  ENCRYPTED_ENVELOPE_VERSION,
  RunJournal,
  RunJournalError,
  decodeEncryptedEnvelope,
  normalizeWorkflowSnapshot,
  normalizeLaneDescriptors,
  stableJson,
} = require('../src/main/run-journal');
const { writeJsonAtomic } = require('../src/main/store');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agents-orch-journal-'));
}

function deterministicUuid() {
  let value = 0;
  return () => {
    value += 1;
    return `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
  };
}

function deterministicClock() {
  let tick = 0;
  const base = Date.parse('2026-07-30T00:00:00.000Z');
  return () => new Date(base + tick++ * 1000);
}

function encryptionAdapter({ available = true } = {}) {
  const calls = [];
  return {
    calls,
    isAvailable() {
      calls.push({ method: 'available' });
      return available;
    },
    encrypt(plaintext, context) {
      const ciphertext = Buffer.from(`sealed\u0000${plaintext}`, 'utf8').toString('base64');
      calls.push({
        method: 'encrypt',
        plaintext,
        ciphertextBytes: Buffer.byteLength(ciphertext, 'utf8'),
        context: { ...context },
      });
      return ciphertext;
    },
    decrypt(ciphertext, context) {
      calls.push({ method: 'decrypt', ciphertext, context: { ...context } });
      const decoded = Buffer.from(ciphertext, 'base64').toString('utf8');
      if (!decoded.startsWith('sealed\u0000')) throw new Error('not sealed');
      return decoded.slice('sealed\u0000'.length);
    },
  };
}

function workflow(overrides = {}) {
  return {
    formatVersion: 1,
    id: 'wf-demo',
    name: 'Demo workflow',
    defaultDirectory: 'C:\\private\\workspace',
    blocks: [{
      id: 'blk-prompt',
      type: 'prompt',
      params: { text: 'PRIVATE WORKFLOW BODY' },
    }],
    ...overrides,
  };
}

function makeJournal(options = {}) {
  const dir = options.dir || tmpDir();
  const encryption = options.encryption === undefined
    ? encryptionAdapter()
    : options.encryption;
  return {
    dir,
    encryption,
    journal: new RunJournal({
      dir,
      encryption,
      randomUUID: options.randomUUID || deterministicUuid(),
      now: options.now || deterministicClock(),
      memoryMaxBytes: options.memoryMaxBytes,
      recordMaxBytes: options.recordMaxBytes,
      writeRecord: options.writeRecord,
      deleteRecord: options.deleteRecord,
      onError: options.onError,
    }),
  };
}

async function startRun(journal, overrides = {}) {
  return journal.startRun({
    workflow: workflow(),
    trigger: { kind: 'manual' },
    opId: 'op-run-start',
    ...overrides,
  });
}

async function startVisit(journal, runId, overrides = {}) {
  return journal.startBlock({
    runId,
    opId: 'op-block-start',
    block: {
      id: 'blk-prompt',
      index: 0,
      type: 'prompt',
      iterationPath: [],
    },
    ...overrides,
  });
}

async function listRuns(journal, options = undefined) {
  return (await journal.listRuns(options)).runs;
}

function onlyJournalFile(dir) {
  const files = fs.readdirSync(dir).filter(file => file.endsWith('.json'));
  assert.equal(files.length, 1);
  return path.join(dir, files[0]);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function formerOperationFingerprint(action, payload) {
  return sha256(stableJson({ action, payload }, `${action} operation`));
}

test('encrypted run persists one atomic file with public metadata and no plaintext snapshot', async () => {
  const { journal, dir, encryption } = makeJournal();
  const run = await startRun(journal, {
    trigger: {
      kind: 'scheduled',
      scheduledFor: '2026-08-01T12:30:00+09:00',
    },
  });

  assert.match(run.id, /^[0-9a-f-]{36}$/);
  assert.equal(run.schemaVersion, SCHEMA_VERSION);
  assert.equal(run.revision, 1);
  assert.equal(run.eventSeq, 1);
  assert.equal(run.status, RUN_STATUS.RUNNING);
  assert.deepEqual(run.workflow, {
    id: 'wf-demo',
    name: 'Demo workflow',
    formatVersion: 1,
    blockCount: 1,
  });
  assert.deepEqual(run.trigger, {
    kind: 'scheduled',
    scheduledFor: '2026-08-01T03:30:00.000Z',
  });
  assert.equal(run.snapshot.storage, STORAGE.ENCRYPTED);
  assert.equal(Object.hasOwn(run.snapshot, 'ciphertext'), false);
  assert.equal(Object.hasOwn(run.snapshot, 'hash'), false);
  assert.equal(Object.hasOwn(run, 'operations'), false);
  assert.equal(run.resumeEvidence.state, 'not-applicable');
  assert.equal(run.resumeEvidence.executionAvailable, false);

  const file = onlyJournalFile(dir);
  assert.equal(path.basename(file), `${run.id}.json`);
  const diskText = fs.readFileSync(file, 'utf8');
  const disk = JSON.parse(diskText);
  assert.equal(disk.schemaVersion, 1);
  assert.equal(disk.id, run.id);
  assert.equal(disk.snapshot.storage, STORAGE.ENCRYPTED);
  assert.equal(typeof disk.snapshot.ciphertext, 'string');
  assert.equal(Object.hasOwn(disk.snapshot, 'hash'), false);
  assert.equal(diskText.includes('PRIVATE WORKFLOW BODY'), false);
  assert.equal(diskText.includes('C:\\\\private\\\\workspace'), false);
  assert.equal(diskText.includes('"blocks"'), true, 'journal metadata has a blocks collection');
  assert.equal(disk.workflow.defaultDirectory, undefined);
  const encryptionCall = encryption.calls.find(call => call.method === 'encrypt');
  assert.deepEqual(encryptionCall.context, { kind: 'workflow', runId: run.id });
  const envelope = JSON.parse(encryptionCall.plaintext);
  assert.equal(envelope.version, ENCRYPTED_ENVELOPE_VERSION);
  assert.deepEqual(envelope.context, { kind: 'workflow', runId: run.id });
  assert.equal(typeof envelope.body, 'string');
  assert.match(envelope.body, /PRIVATE WORKFLOW BODY/);
  assert.equal(diskText.includes('"context"'), false);
});

test('maximum escape-heavy payloads remain encrypted beyond the former ciphertext caps', async () => {
  const encryption = encryptionAdapter();
  const { journal } = makeJournal({ encryption });
  const empty = workflow({
    blocks: [{
      id: 'blk-prompt',
      type: 'prompt',
      params: { text: '' },
    }],
  });
  const fixedWorkflowBytes = normalizeWorkflowSnapshot(empty).byteLength;
  const slashCount = Math.floor((MAX_WORKFLOW_BYTES - fixedWorkflowBytes) / 2);
  const largeWorkflow = workflow({
    blocks: [{
      id: 'blk-prompt',
      type: 'prompt',
      params: { text: '\\'.repeat(slashCount) },
    }],
  });
  const normalizedWorkflow = normalizeWorkflowSnapshot(largeWorkflow);
  assert.ok(normalizedWorkflow.byteLength <= MAX_WORKFLOW_BYTES);
  assert.ok(normalizedWorkflow.byteLength >= MAX_WORKFLOW_BYTES - 2);

  const run = await journal.startRun({
    workflow: largeWorkflow,
    trigger: { kind: 'manual' },
    opId: 'large-workflow-start',
  });
  assert.equal(run.snapshot.storage, STORAGE.ENCRYPTED);
  const workflowEncryption = encryption.calls.find(call => (
    call.method === 'encrypt' && call.context.kind === 'workflow'
  ));
  assert.ok(
    workflowEncryption.ciphertextBytes > 6 * 1024 * 1024,
    'the regression payload must exceed the former workflow ciphertext cap'
  );

  const visit = await startVisit(journal, run.id, { opId: 'large-result-visit' });
  const result = await journal.storeResult({
    runId: run.id,
    producerBlockId: 'blk-prompt',
    visitId: visit.visitId,
    name: 'escape-heavy',
    status: RESULT_STATUS.COMPLETE,
    lanes: [{ laneId: 'lane-a', displayName: 'Lane A' }],
    body: '\u0000'.repeat(MAX_RESULT_BYTES),
    opId: 'large-result-store',
  });
  assert.equal(result.storage, STORAGE.ENCRYPTED);
  const resultEncryption = encryption.calls.find(call => (
    call.method === 'encrypt' && call.context.kind === 'result'
  ));
  assert.ok(
    resultEncryption.ciphertextBytes > 512 * 1024,
    'the regression payload must exceed the former result ciphertext cap'
  );
});

test('storage scan failures expose a stable path-free journal error', async () => {
  const parent = tmpDir();
  const blockedPath = path.join(parent, 'private-user-run-journal');
  fs.writeFileSync(blockedPath, 'not a directory');
  const { journal } = makeJournal({ dir: blockedPath });

  await assert.rejects(
    startRun(journal),
    error => (
      error instanceof RunJournalError
      && error.code === 'storage-read-failed'
      && error.message === 'Run Journal records could not be listed'
      && !error.message.includes(blockedPath)
      && !error.message.includes(parent)
    )
  );
});

test('storage write and delete failures never expose their absolute target paths', async () => {
  const privatePath = 'C:\\Users\\private-name\\AppData\\run-journal';
  const writeFailure = makeJournal({
    writeRecord() {
      throw new Error(`EACCES: ${privatePath}\\record.tmp`);
    },
  });
  await assert.rejects(
    startRun(writeFailure.journal),
    error => (
      error instanceof RunJournalError
      && error.code === 'storage-write-failed'
      && error.message === 'Run Journal record could not be written'
      && !error.message.includes(privatePath)
    )
  );

  const durable = makeJournal();
  const run = await startRun(durable.journal);
  await durable.journal.finishRun({
    runId: run.id,
    status: RUN_STATUS.CANCELLED,
    opId: 'finish-before-delete-error',
  });
  const deleteFailure = makeJournal({
    dir: durable.dir,
    deleteRecord() {
      throw new Error(`EACCES: ${privatePath}\\record.json`);
    },
  });
  await assert.rejects(
    deleteFailure.journal.deleteRun({
      runId: run.id,
      opId: 'delete-error',
    }),
    error => (
      error instanceof RunJournalError
      && error.code === 'storage-delete-failed'
      && error.message === 'Run Journal record could not be deleted'
      && !error.message.includes(privatePath)
    )
  );
});

test('unavailable encryption keeps snapshot and result bodies in bounded memory only', async () => {
  const adapter = encryptionAdapter({ available: false });
  const { journal, dir } = makeJournal({ encryption: adapter });
  const run = await startRun(journal);
  const visit = await startVisit(journal, run.id);
  const result = await journal.storeResult({
    runId: run.id,
    producerBlockId: 'blk-prompt',
    visitId: visit.visitId,
    name: 'answer',
    status: RESULT_STATUS.COMPLETE,
    lanes: [{ laneId: 'lane-a', profileId: 'codex:work' }],
    body: 'MEMORY ONLY RESULT',
    opId: 'op-result',
  });

  assert.equal(run.snapshot.storage, STORAGE.MEMORY);
  assert.equal(result.storage, STORAGE.MEMORY);
  assert.equal(adapter.calls.some(call => call.method === 'encrypt'), false);
  const diskText = fs.readFileSync(onlyJournalFile(dir), 'utf8');
  assert.equal(diskText.includes('PRIVATE WORKFLOW BODY'), false);
  assert.equal(diskText.includes('MEMORY ONLY RESULT'), false);
  assert.equal(
    diskText.includes(
      crypto.createHash('sha256').update('MEMORY ONLY RESULT', 'utf8').digest('hex')
    ),
    false
  );
  assert.equal(diskText.includes('"fingerprint"'), false);
  const disk = JSON.parse(diskText);
  assert.equal(Object.hasOwn(disk.snapshot, 'ciphertext'), false);
  assert.equal(Object.hasOwn(disk.results[0], 'ciphertext'), false);
  assert.equal(Object.hasOwn(disk.results[0], 'body'), false);
  assert.ok(disk.operations.every(operation => (
    operation.proof.storage === STORAGE.MEMORY
    && !Object.hasOwn(operation.proof, 'ciphertext')
  )));

  const available = await journal.getResult({ runId: run.id, resultId: result.id });
  assert.equal(available.body, 'MEMORY ONLY RESULT');

  const restarted = new RunJournal({
    dir,
    encryption: adapter,
    randomUUID: deterministicUuid(),
    now: deterministicClock(),
  });
  await assert.rejects(
    restarted.getResult({ runId: run.id, resultId: result.id }),
    error => error instanceof RunJournalError && error.code === 'body-unavailable'
  );
  await assert.rejects(
    startRun(restarted),
    error => error instanceof RunJournalError && error.code === 'op-proof-unavailable'
  );
});

test('memory-only mode fails closed at its configured bound and leaves no run file', async () => {
  const dir = tmpDir();
  const journal = new RunJournal({
    dir,
    encryption: encryptionAdapter({ available: false }),
    randomUUID: deterministicUuid(),
    now: deterministicClock(),
    memoryMaxBytes: 32,
  });
  await assert.rejects(
    startRun(journal),
    error => error instanceof RunJournalError && error.code === 'memory-capacity'
  );
  assert.deepEqual(fs.existsSync(dir) ? fs.readdirSync(dir) : [], []);
});

test('default memory entry capacity covers every logically allowed proof and result', () => {
  assert.ok(
    MAX_MEMORY_ENTRIES >= 1 + MAX_OPERATIONS + MAX_RESULTS,
    'snapshot + operation proofs + result bodies must fit the default entry cap'
  );
});

test('memory pressure evicts oldest terminal runs but never an active run', async () => {
  const snapshotBytes = normalizeWorkflowSnapshot(workflow()).byteLength;
  const resultBytes = 300;
  // Each run below records four 64-byte protected operation proofs.
  const capacity = snapshotBytes + resultBytes + 4 * 64;
  const { journal } = makeJournal({
    encryption: encryptionAdapter({ available: false }),
    memoryMaxBytes: capacity,
  });

  const first = await startRun(journal);
  const firstVisit = await startVisit(journal, first.id);
  const firstResult = await journal.storeResult({
    runId: first.id,
    producerBlockId: 'blk-prompt',
    visitId: firstVisit.visitId,
    name: 'first',
    status: 'complete',
    lanes: [{ laneId: 'lane-a' }],
    body: 'a'.repeat(resultBytes),
    opId: 'first-result',
  });
  await journal.finishRun({
    runId: first.id,
    status: 'cancelled',
    opId: 'first-finish',
  });
  await assert.rejects(
    journal.startRun({
      workflow: workflow({
        id: 'wf-huge',
        padding: 'x'.repeat(capacity),
      }),
      trigger: { kind: 'manual' },
      opId: 'oversized-start',
    }),
    error => error instanceof RunJournalError && error.code === 'memory-capacity'
  );
  assert.equal(
    (await journal.getResult({ runId: first.id, resultId: firstResult.id })).body,
    'a'.repeat(resultBytes),
    'an impossible allocation must not evict terminal-run payloads'
  );

  const second = await journal.startRun({
    workflow: workflow({ id: 'wf-next' }),
    trigger: { kind: 'manual' },
    opId: 'second-start',
  });
  await assert.rejects(
    journal.getResult({ runId: first.id, resultId: firstResult.id }),
    error => (
      error instanceof RunJournalError
      && error.code === 'body-unavailable'
      && error.message === 'Result body is unavailable'
    )
  );

  const secondVisit = await journal.startBlock({
    runId: second.id,
    blockId: 'blk-prompt',
    blockIndex: 0,
    opId: 'second-block',
  });
  const secondResult = await journal.storeResult({
    runId: second.id,
    producerBlockId: 'blk-prompt',
    visitId: secondVisit.visitId,
    name: 'second',
    status: 'complete',
    lanes: [{ laneId: 'lane-b' }],
    body: 'b'.repeat(resultBytes),
    opId: 'second-result',
  });

  const thirdPayload = {
    workflow: workflow({ id: 'wf-last' }),
    trigger: { kind: 'manual' },
    opId: 'third-start',
  };
  await assert.rejects(
    journal.startRun(thirdPayload),
    error => error instanceof RunJournalError && error.code === 'memory-capacity'
  );
  assert.equal(
    (await journal.getResult({ runId: second.id, resultId: secondResult.id })).body,
    'b'.repeat(resultBytes),
    'failed allocation must not evict the active run'
  );

  await journal.finishRun({
    runId: second.id,
    status: 'cancelled',
    opId: 'second-finish',
  });
  const third = await journal.startRun(thirdPayload);
  assert.equal(third.status, RUN_STATUS.RUNNING);
  await assert.rejects(
    journal.getResult({ runId: second.id, resultId: secondResult.id }),
    error => error instanceof RunJournalError && error.code === 'body-unavailable'
  );
});

test('failed startRun restores terminal payloads evicted by its snapshot allocation', async () => {
  const capacity = 1000;
  const { journal } = makeJournal({
    encryption: encryptionAdapter({ available: false }),
    memoryMaxBytes: capacity,
  });
  const first = await startRun(journal);
  const firstVisit = await startVisit(journal, first.id);
  const firstResult = await journal.storeResult({
    runId: first.id,
    producerBlockId: 'blk-prompt',
    visitId: firstVisit.visitId,
    name: 'keeper',
    status: 'complete',
    lanes: [{ laneId: 'lane-a' }],
    body: 'terminal body must survive',
    opId: 'keeper-result',
  });
  await journal.finishRun({
    runId: first.id,
    status: 'cancelled',
    opId: 'keeper-finish',
  });

  const targetSnapshotBytes = 950;
  const largeBase = workflow({ id: 'wf-large', padding: '' });
  const baseBytes = normalizeWorkflowSnapshot(largeBase).byteLength;
  assert.ok(baseBytes < targetSnapshotBytes);
  const largeWorkflow = workflow({
    id: 'wf-large',
    padding: 'x'.repeat(targetSnapshotBytes - baseBytes),
  });
  assert.equal(
    normalizeWorkflowSnapshot(largeWorkflow).byteLength,
    targetSnapshotBytes
  );

  await assert.rejects(
    journal.startRun({
      workflow: largeWorkflow,
      trigger: { kind: 'manual' },
      opId: 'large-start',
    }),
    error => error instanceof RunJournalError && error.code === 'memory-capacity'
  );
  assert.equal(
    (await journal.getResult({ runId: first.id, resultId: firstResult.id })).body,
    'terminal body must survive'
  );
  assert.equal((await startRun(journal)).id, first.id, 'operation proofs are restored too');
  assert.deepEqual((await listRuns(journal)).map(run => run.id), [first.id]);
});

test('failed storeResult restores terminal payloads evicted by its body allocation', async () => {
  const capacity = 1000;
  const { journal } = makeJournal({
    encryption: encryptionAdapter({ available: false }),
    memoryMaxBytes: capacity,
  });
  const keeper = await startRun(journal);
  const keeperVisit = await startVisit(journal, keeper.id);
  const keeperResult = await journal.storeResult({
    runId: keeper.id,
    producerBlockId: 'blk-prompt',
    visitId: keeperVisit.visitId,
    name: 'keeper',
    status: 'complete',
    lanes: [{ laneId: 'lane-a' }],
    body: 'keep this result',
    opId: 'keeper-result',
  });
  await journal.finishRun({
    runId: keeper.id,
    status: 'cancelled',
    opId: 'keeper-finish',
  });

  const active = await journal.startRun({
    workflow: workflow({ id: 'wf-next' }),
    trigger: { kind: 'manual' },
    opId: 'active-start',
  });
  const activeVisit = await journal.startBlock({
    runId: active.id,
    blockId: 'blk-prompt',
    blockIndex: 0,
    opId: 'active-block',
  });
  const activeSnapshotBytes = normalizeWorkflowSnapshot(
    workflow({ id: 'wf-next' })
  ).byteLength;
  const activeBytesBeforeResult = activeSnapshotBytes + 2 * 64;
  const bodyBytes = capacity - activeBytesBeforeResult - 32;
  assert.ok(bodyBytes > 0 && bodyBytes <= MAX_RESULT_BYTES);

  await assert.rejects(
    journal.storeResult({
      runId: active.id,
      producerBlockId: 'blk-prompt',
      visitId: activeVisit.visitId,
      name: 'too-tight-with-proof',
      status: 'complete',
      lanes: [{ laneId: 'lane-b' }],
      body: 'z'.repeat(bodyBytes),
      opId: 'active-result',
    }),
    error => error instanceof RunJournalError && error.code === 'memory-capacity'
  );
  assert.equal(
    (await journal.getResult({ runId: keeper.id, resultId: keeperResult.id })).body,
    'keep this result'
  );
  const replayedKeeper = await journal.storeResult({
    runId: keeper.id,
    producerBlockId: 'blk-prompt',
    visitId: keeperVisit.visitId,
    name: 'keeper',
    status: 'complete',
    lanes: [{ laneId: 'lane-a' }],
    body: 'keep this result',
    opId: 'keeper-result',
  });
  assert.equal(replayedKeeper.id, keeperResult.id, 'evicted operation proof is restored');
  const activeAfter = await journal.getRun(active.id);
  assert.equal(activeAfter.results.length, 0);
  assert.equal(activeAfter.revision, 2);
});

test('block visits carry main-owned ids, loop context, and only public lane identity', async () => {
  const { journal } = makeJournal();
  const run = await startRun(journal);
  const visit = await journal.startBlock({
    runId: run.id,
    opId: 'op-block-start',
    block: {
      id: 'blk-prompt',
      index: 0,
      type: 'prompt',
      iterationPath: [{
        loopBlockId: 'blk-loop',
        iteration: 2,
        total: 3,
      }],
    },
    lanes: [{
      laneId: 'lane-a',
      profileId: 'codex:work',
      agent: 'codex',
      label: 'Work account',
      assurance: 'L1-routed',
      cwd: 'C:\\must-not-persist',
      command: 'secret-command',
      env: { TOKEN: 'never' },
      sessionId: 'session-private',
    }],
  });

  assert.match(visit.visitId, /^[0-9a-f-]{36}$/);
  assert.equal(visit.blockId, 'blk-prompt');
  assert.equal(visit.blockIndex, 0);
  assert.equal(visit.blockType, 'prompt');
  assert.deepEqual(visit.iterationPath, [{
    loopBlockId: 'blk-loop',
    iteration: 2,
    total: 3,
  }]);
  assert.deepEqual(visit.lanes, [{
    laneId: 'lane-a',
    profileId: 'codex:work',
    agent: 'codex',
    displayName: 'Work account',
    assurance: 'L1-routed',
  }]);
  assert.equal(visit.status, BLOCK_STATUS.RUNNING);
});

test('result body is encrypted separately and metadata is immutable/public', async () => {
  const { journal, dir, encryption } = makeJournal();
  const run = await startRun(journal);
  const visit = await startVisit(journal, run.id);
  const result = await journal.storeResult({
    runId: run.id,
    producerBlockId: 'blk-prompt',
    visitId: visit.visitId,
    name: 'stage-output',
    status: 'partial',
    lanes: [{
      laneId: 'lane-a',
      profileId: 'codex:work',
      agent: 'codex',
      displayName: 'Work',
      assurance: 'L1-routed',
      cwd: 'C:\\private',
    }],
    body: 'PRIVATE RESULT BODY',
    opId: 'op-result',
  });

  assert.match(result.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(result.lanes, [{
    laneId: 'lane-a',
    profileId: 'codex:work',
    agent: 'codex',
    displayName: 'Work',
    assurance: 'L1-routed',
  }]);
  assert.equal(result.byteLength, Buffer.byteLength('PRIVATE RESULT BODY'));
  assert.equal(Object.hasOwn(result, 'hash'), false);
  assert.equal(result.storage, STORAGE.ENCRYPTED);
  assert.equal(Object.hasOwn(result, 'ciphertext'), false);
  assert.equal(Object.hasOwn(result, 'body'), false);

  const encryptCalls = encryption.calls.filter(call => call.method === 'encrypt');
  const resultEncryptCall = encryptCalls.find(call => call.context.kind === 'result');
  assert.ok(resultEncryptCall);
  assert.deepEqual(resultEncryptCall.context, {
    kind: 'result',
    runId: run.id,
    resultId: result.id,
  });
  const resultEnvelope = JSON.parse(resultEncryptCall.plaintext);
  assert.deepEqual(resultEnvelope, {
    body: 'PRIVATE RESULT BODY',
    context: {
      kind: 'result',
      runId: run.id,
      resultId: result.id,
    },
    version: ENCRYPTED_ENVELOPE_VERSION,
  });
  assert.ok(encryptCalls.some(call => call.context.kind === 'operation'));

  const diskText = fs.readFileSync(onlyJournalFile(dir), 'utf8');
  assert.equal(diskText.includes('PRIVATE RESULT BODY'), false);
  assert.equal(diskText.includes('C:\\\\private'), false);
  const normalizedWorkflow = normalizeWorkflowSnapshot(workflow());
  const workflowDigest = sha256(normalizedWorkflow.plaintext);
  const resultDigest = sha256('PRIVATE RESULT BODY');
  const startFingerprint = formerOperationFingerprint('start-run', {
    workflowSnapshot: normalizedWorkflow.plaintext,
    workflow: normalizedWorkflow.metadata,
    trigger: { kind: 'manual' },
  });
  const resultFingerprint = formerOperationFingerprint('store-result', {
    producerBlockId: 'blk-prompt',
    visitId: visit.visitId,
    name: 'stage-output',
    status: 'partial',
    lanes: [{
      laneId: 'lane-a',
      profileId: 'codex:work',
      agent: 'codex',
      displayName: 'Work',
      assurance: 'L1-routed',
    }],
    byteLength: Buffer.byteLength('PRIVATE RESULT BODY'),
    body: 'PRIVATE RESULT BODY',
  });
  assert.equal(diskText.includes(workflowDigest), false);
  assert.equal(diskText.includes(resultDigest), false);
  assert.equal(diskText.includes(startFingerprint), false);
  assert.equal(diskText.includes(resultFingerprint), false);
  assert.equal(diskText.includes('"fingerprint"'), false);
  const disk = JSON.parse(diskText);
  assert.equal(typeof disk.results[0].ciphertext, 'string');
  assert.equal(Object.hasOwn(disk.results[0], 'hash'), false);
  assert.equal(disk.results[0].body, undefined);
  assert.ok(disk.operations.every(operation => (
    operation.proof.storage === STORAGE.ENCRYPTED
    && typeof operation.proof.ciphertext === 'string'
  )));

  const revealed = await journal.getResult({ runId: run.id, resultId: result.id });
  assert.deepEqual(revealed, { ...result, body: 'PRIVATE RESULT BODY' });
});

test('encrypted envelopes reject result-id, run-id, and kind context swaps', async () => {
  const { journal, dir, encryption } = makeJournal();
  const run = await startRun(journal);
  const visit = await startVisit(journal, run.id);
  const common = {
    runId: run.id,
    producerBlockId: 'blk-prompt',
    visitId: visit.visitId,
    status: 'complete',
    lanes: [{ laneId: 'lane-a' }],
  };
  const first = await journal.storeResult({
    ...common,
    name: 'first',
    body: 'AAAA',
    opId: 'result-first',
  });
  const second = await journal.storeResult({
    ...common,
    name: 'second',
    body: 'BBBB',
    opId: 'result-second',
  });

  const resultEncrypt = encryption.calls
    .filter(call => call.method === 'encrypt')
    .find(call => call.context.resultId === first.id);
  assert.throws(
    () => decodeEncryptedEnvelope(resultEncrypt.plaintext, {
      kind: 'result',
      runId: run.id,
      resultId: second.id,
    }),
    error => error instanceof RunJournalError && error.code === 'context-mismatch'
  );
  assert.throws(
    () => decodeEncryptedEnvelope(resultEncrypt.plaintext, {
      kind: 'result',
      runId: '00000000-0000-4000-8000-0000000000ff',
      resultId: first.id,
    }),
    error => error instanceof RunJournalError && error.code === 'context-mismatch'
  );
  assert.throws(
    () => decodeEncryptedEnvelope(resultEncrypt.plaintext, {
      kind: 'workflow',
      runId: run.id,
    }),
    error => error instanceof RunJournalError && error.code === 'context-mismatch'
  );

  const file = onlyJournalFile(dir);
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  const firstStored = disk.results.find(result => result.id === first.id);
  const secondStored = disk.results.find(result => result.id === second.id);
  const firstOperation = disk.operations.find(operation => operation.opId === 'result-first');
  const secondOperation = disk.operations.find(operation => operation.opId === 'result-second');
  [firstOperation.proof.ciphertext, secondOperation.proof.ciphertext] = [
    secondOperation.proof.ciphertext,
    firstOperation.proof.ciphertext,
  ];
  writeJsonAtomic(file, disk);
  await assert.rejects(
    journal.storeResult({
      ...common,
      name: 'first',
      body: 'AAAA',
      opId: 'result-first',
    }),
    error => error instanceof RunJournalError && error.code === 'op-proof-unavailable'
  );
  [firstOperation.proof.ciphertext, secondOperation.proof.ciphertext] = [
    secondOperation.proof.ciphertext,
    firstOperation.proof.ciphertext,
  ];
  [firstStored.ciphertext, secondStored.ciphertext] = [
    secondStored.ciphertext,
    firstStored.ciphertext,
  ];
  writeJsonAtomic(file, disk);

  await assert.rejects(
    journal.getResult({ runId: run.id, resultId: first.id }),
    error => error instanceof RunJournalError && error.code === 'decrypt-failed'
  );
  await assert.rejects(
    journal.getResult({ runId: run.id, resultId: second.id }),
    error => error instanceof RunJournalError && error.code === 'decrypt-failed'
  );
});

test('same opId and canonical payload replay without revision or identity changes', async () => {
  const { journal, dir, encryption } = makeJournal();
  const first = await startRun(journal);
  const replayedStart = await startRun(journal, { workflow: { ...workflow() } });
  assert.equal(replayedStart.id, first.id);
  assert.equal(replayedStart.revision, 1);

  const blockPayload = {
    runId: first.id,
    opId: 'op-block-start',
    blockId: 'blk-prompt',
    blockIndex: 0,
    blockType: 'prompt',
    iterationPath: [],
  };
  const [visitA, visitB] = await Promise.all([
    journal.startBlock(blockPayload),
    journal.startBlock({ ...blockPayload }),
  ]);
  assert.equal(visitA.visitId, visitB.visitId);
  const afterBlock = await journal.getRun(first.id);
  assert.equal(afterBlock.revision, 2);
  assert.equal(afterBlock.blocks.length, 1);

  const resultPayload = {
    runId: first.id,
    producerBlockId: 'blk-prompt',
    visitId: visitA.visitId,
    name: 'answer',
    status: 'complete',
    lanes: [{ laneId: 'lane-a' }],
    body: 'same body',
    opId: 'op-result',
  };
  const resultA = await journal.storeResult(resultPayload);
  const resultB = await journal.storeResult({ ...resultPayload });
  assert.equal(resultA.id, resultB.id);
  assert.equal((await journal.getRun(first.id)).revision, 3);

  const restarted = new RunJournal({
    dir,
    encryption,
    randomUUID: deterministicUuid(),
    now: deterministicClock(),
  });
  const durableReplay = await startRun(restarted);
  assert.equal(durableReplay.id, first.id);
  assert.equal(durableReplay.revision, 3);
  await assert.rejects(
    startRun(restarted, {
      workflow: workflow({ name: 'Conflicting after restart' }),
    }),
    error => error instanceof RunJournalError && error.code === 'op-conflict'
  );
});

test('conflicting opId reuse rejects instead of performing a second mutation', async () => {
  const { journal } = makeJournal();
  const run = await startRun(journal);

  await assert.rejects(
    startRun(journal, {
      workflow: workflow({ name: 'Different workflow' }),
    }),
    error => error instanceof RunJournalError && error.code === 'op-conflict'
  );

  await startVisit(journal, run.id);
  await assert.rejects(
    journal.startBlock({
      runId: run.id,
      blockId: 'blk-other',
      blockIndex: 0,
      opId: 'op-block-start',
    }),
    error => error instanceof RunJournalError && error.code === 'op-conflict'
  );
  assert.equal((await journal.getRun(run.id)).blocks.length, 1);
});

test('renderer cannot supply journal ids, timestamps, revisions, storage, or paths', async () => {
  const { journal } = makeJournal();
  for (const extra of [
    { runId: '00000000-0000-4000-8000-000000000099' },
    { id: 'renderer-run' },
    { startedAt: '2000-01-01T00:00:00.000Z' },
    { revision: 99 },
    { path: 'C:\\elsewhere\\run.json' },
  ]) {
    await assert.rejects(
      journal.startRun({
        workflow: workflow(),
        trigger: { kind: 'manual' },
        opId: `reject-${Object.keys(extra)[0]}`,
        ...extra,
      }),
      error => error instanceof RunJournalError && error.code === 'invalid-input'
    );
  }

  const run = await startRun(journal);
  await assert.rejects(
    journal.startBlock({
      runId: run.id,
      visitId: '00000000-0000-4000-8000-000000000099',
      blockId: 'blk-prompt',
      opId: 'reject-visit',
    }),
    error => error instanceof RunJournalError && error.code === 'invalid-input'
  );
  const visit = await startVisit(journal, run.id);
  await assert.rejects(
    journal.storeResult({
      runId: run.id,
      resultId: '00000000-0000-4000-8000-000000000099',
      producerBlockId: 'blk-prompt',
      visitId: visit.visitId,
      name: 'answer',
      status: 'complete',
      body: 'body',
      opId: 'reject-result-id',
    }),
    error => error instanceof RunJournalError && error.code === 'invalid-input'
  );
});

test('UTF-8 result caps reject oversize bodies and aggregate bytes without truncation', async () => {
  assert.equal(MAX_RESULT_BYTES_PER_LANE, 32 * 1024);
  assert.equal(MAX_HANDOFF_BYTES, 128 * 1024);
  assert.equal(MAX_RESULT_BYTES, 256 * 1024);
  assert.equal(MAX_RUN_RESULT_BYTES, 1024 * 1024);

  const { journal } = makeJournal({
    encryption: encryptionAdapter({ available: false }),
  });
  const run = await startRun(journal);
  const visit = await startVisit(journal, run.id);
  const base = {
    runId: run.id,
    producerBlockId: 'blk-prompt',
    visitId: visit.visitId,
    name: 'chunk',
    status: 'complete',
    lanes: [{ laneId: 'lane-a' }],
  };

  await assert.rejects(
    journal.storeResult({
      ...base,
      body: '雪'.repeat(Math.floor(MAX_RESULT_BYTES / 3) + 1),
      opId: 'oversize-one',
    }),
    error => error instanceof RunJournalError && error.code === 'size-limit'
  );
  assert.equal((await journal.getRun(run.id)).results.length, 0);

  const exact = 'x'.repeat(MAX_RESULT_BYTES);
  for (let index = 0; index < 4; index++) {
    await journal.storeResult({
      ...base,
      name: `chunk-${index}`,
      body: exact,
      opId: `chunk-${index}`,
    });
  }
  assert.equal(
    (await journal.getRun(run.id)).results.reduce(
      (sum, result) => sum + result.byteLength,
      0
    ),
    MAX_RUN_RESULT_BYTES
  );
  await assert.rejects(
    journal.storeResult({
      ...base,
      name: 'one-more',
      body: 'x',
      opId: 'one-more',
    }),
    error => error instanceof RunJournalError && error.code === 'size-limit'
  );
});

test('terminal state rules close failed/cancelled visits and reject illegal transitions', async () => {
  const { journal } = makeJournal();
  const run = await startRun(journal);
  const visit = await startVisit(journal, run.id);

  await assert.rejects(
    journal.finishRun({
      runId: run.id,
      status: 'completed',
      opId: 'finish-too-early',
    }),
    error => error instanceof RunJournalError && error.code === 'invalid-state'
  );
  await assert.rejects(
    journal.finishRun({
      runId: run.id,
      status: 'interrupted',
      opId: 'renderer-interrupted',
    }),
    error => error instanceof RunJournalError && error.code === 'invalid-state'
  );
  await assert.rejects(
    journal.deleteRun({ runId: run.id, opId: 'delete-active' }),
    error => error instanceof RunJournalError && error.code === 'active-run'
  );

  const cancelled = await journal.finishRun({
    runId: run.id,
    status: 'cancelled',
    opId: 'finish-cancelled',
  });
  assert.equal(cancelled.status, RUN_STATUS.CANCELLED);
  assert.equal(cancelled.blocks[0].visitId, visit.visitId);
  assert.equal(cancelled.blocks[0].status, BLOCK_STATUS.CANCELLED);
  assert.equal(cancelled.blocks[0].reasonCode, 'run-finished');

  const replay = await journal.finishRun({
    runId: run.id,
    status: 'cancelled',
    opId: 'finish-cancelled',
  });
  assert.equal(replay.revision, cancelled.revision);
  await assert.rejects(
    journal.startBlock({
      runId: run.id,
      blockId: 'blk-prompt',
      opId: 'after-terminal',
    }),
    error => error instanceof RunJournalError && error.code === 'invalid-state'
  );
});

test('completed run requires terminal block visits and active runs alone are undeletable', async () => {
  const { journal, dir } = makeJournal();
  const run = await startRun(journal);
  const visit = await startVisit(journal, run.id);
  await journal.finishBlock({
    runId: run.id,
    visitId: visit.visitId,
    status: 'completed',
    opId: 'op-block-finish',
  });
  const completed = await journal.finishRun({
    runId: run.id,
    status: 'completed',
    opId: 'op-run-finish',
  });
  assert.equal(completed.status, RUN_STATUS.COMPLETED);
  assert.ok(completed.finishedAt);
  assert.equal(await journal.deleteRun({ runId: run.id, opId: 'op-delete' }), true);
  assert.equal(await journal.deleteRun({ runId: run.id, opId: 'op-delete' }), false);
  assert.deepEqual(fs.readdirSync(dir).filter(file => file.endsWith('.json')), []);
  assert.deepEqual(await journal.listRuns(), { runs: [], nextCursor: null, total: 0 });
});

test('recoverInterrupted atomically terminals active runs and is idempotent', async () => {
  const { journal } = makeJournal();
  const active = await startRun(journal);
  await startVisit(journal, active.id);
  const finished = await journal.startRun({
    workflow: workflow({ id: 'wf-finished', name: 'Finished' }),
    trigger: { kind: 'manual' },
    opId: 'start-finished',
  });
  await journal.finishRun({
    runId: finished.id,
    status: 'completed',
    opId: 'finish-finished',
  });

  const recovered = await journal.recoverInterrupted();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].id, active.id);
  assert.equal(recovered[0].status, RUN_STATUS.INTERRUPTED);
  assert.equal(recovered[0].blocks[0].status, BLOCK_STATUS.INTERRUPTED);
  assert.equal(recovered[0].blocks[0].reasonCode, 'process-recovery');
  assert.equal(recovered[0].events.at(-1).type, 'run.interrupted');
  assert.equal(recovered[0].resumeEvidence.state, 'review-required');
  assert.deepEqual(recovered[0].resumeEvidence.reasonCodes, ['visit-outcome-uncertain']);
  assert.equal(recovered[0].resumeEvidence.executionAvailable, false);
  assert.deepEqual(await journal.recoverInterrupted(), []);
  assert.equal((await journal.getRun(finished.id)).status, RUN_STATUS.COMPLETED);
});

test('recoverInterrupted sweeps every active run then fails closed on a durable write error', async () => {
  const durable = makeJournal();
  const first = await startRun(durable.journal, {
    workflow: workflow({ id: 'wf-first', name: 'First' }),
    opId: 'start-first',
  });
  const second = await startRun(durable.journal, {
    workflow: workflow({ id: 'wf-second', name: 'Second' }),
    opId: 'start-second',
  });
  const attempted = new Set();
  const reports = [];
  const privatePath = 'C:\\Users\\private-name\\AppData\\run-journal';
  const recovery = makeJournal({
    dir: durable.dir,
    writeRecord(file, data) {
      attempted.add(data.id);
      if (data.id === first.id) {
        throw new Error(`EACCES: ${privatePath}\\${data.id}.json`);
      }
      writeJsonAtomic(file, data);
    },
    onError(file, error) {
      reports.push({ file, code: error.code, message: error.message });
    },
  });

  await assert.rejects(
    recovery.journal.recoverInterrupted(),
    error => (
      error instanceof RunJournalError
      && error.code === 'recovery-failed'
      && error.message === 'One or more active runs could not be recovered'
      && !error.message.includes(privatePath)
      && !error.message.includes(first.id)
    )
  );

  assert.deepEqual(attempted, new Set([first.id, second.id]));
  assert.deepEqual(reports, [{
    file: `${first.id}.json`,
    code: 'storage-write-failed',
    message: 'Run Journal record could not be written',
  }]);
  assert.equal((await durable.journal.getRun(first.id)).status, RUN_STATUS.RUNNING);
  assert.equal((await durable.journal.getRun(second.id)).status, RUN_STATUS.INTERRUPTED);
});

test('recoverInterrupted treats a corrupt active re-read as a recovery failure', async () => {
  const reports = [];
  const { journal, dir } = makeJournal({
    onError: (file, error) => reports.push([file, error.code || error.name]),
  });
  const active = await startRun(journal);
  const file = path.join(dir, `${active.id}.json`);

  const recovering = journal.recoverInterrupted();
  fs.writeFileSync(file, '{broken', 'utf8');

  await assert.rejects(
    recovering,
    error => (
      error instanceof RunJournalError
      && error.code === 'recovery-failed'
      && !error.message.includes(dir)
      && !error.message.includes(active.id)
    )
  );
  assert.deepEqual(reports, [[`${active.id}.json`, 'SyntaxError']]);
});

test('recoverInterrupted sweeps valid active runs then rejects an unreadable scan record', async () => {
  const reports = [];
  const { journal, dir } = makeJournal({
    onError: (file, error) => reports.push([file, error.code || error.name]),
  });
  const active = await startRun(journal);
  fs.writeFileSync(path.join(dir, 'unknown.json'), '{broken', 'utf8');

  await assert.rejects(
    journal.recoverInterrupted(),
    error => (
      error instanceof RunJournalError
      && error.code === 'recovery-failed'
      && !error.message.includes(dir)
      && !error.message.includes('unknown.json')
    )
  );
  assert.equal((await journal.getRun(active.id)).status, RUN_STATUS.INTERRUPTED);
  assert.deepEqual(reports, [['unknown.json', 'SyntaxError']]);
});

test('recoverInterrupted tolerates an active record removed after its scan', async () => {
  const { journal, dir } = makeJournal();
  const active = await startRun(journal);
  const recovering = journal.recoverInterrupted();
  fs.unlinkSync(path.join(dir, `${active.id}.json`));

  assert.deepEqual(await recovering, []);
});

test('list/get skip corrupt and future files while omitting ciphertext and bodies', async () => {
  const errors = [];
  const dir = tmpDir();
  const { journal } = makeJournal({
    dir,
    onError: (file, error) => errors.push([file, error.code || error.name]),
  });
  const run = await startRun(journal);
  const visit = await startVisit(journal, run.id);
  const result = await journal.storeResult({
    runId: run.id,
    producerBlockId: 'blk-prompt',
    visitId: visit.visitId,
    name: 'answer',
    status: 'complete',
    lanes: [{ laneId: 'lane-a' }],
    body: 'hidden body',
    opId: 'result',
  });

  fs.writeFileSync(path.join(dir, 'corrupt.json'), '{broken', 'utf8');
  const futureId = '00000000-0000-4000-8000-0000000000f0';
  writeJsonAtomic(path.join(dir, `${futureId}.json`), {
    schemaVersion: 2,
    id: futureId,
    ciphertext: 'should-not-matter',
  });

  const listed = await listRuns(journal);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, run.id);
  assert.equal(Object.hasOwn(listed[0].snapshot, 'ciphertext'), false);
  assert.equal(Object.hasOwn(listed[0].snapshot, 'hash'), false);
  assert.equal(Object.hasOwn(listed[0], 'operations'), false);

  const detail = await journal.getRun(run.id);
  assert.equal(detail.results[0].id, result.id);
  assert.equal(Object.hasOwn(detail.results[0], 'ciphertext'), false);
  assert.equal(Object.hasOwn(detail.results[0], 'body'), false);
  assert.equal(Object.hasOwn(detail.results[0], 'hash'), false);
  assert.equal(Object.hasOwn(detail, 'operations'), false);
  assert.equal(await journal.getRun(futureId), null);
  assert.ok(errors.some(([file]) => file === 'corrupt.json'));
  assert.ok(errors.some(([file]) => file === `${futureId}.json`));
});

test('metadata index serves stable cursor pages and contains public summaries only', async () => {
  const { journal, dir } = makeJournal();
  const created = [];
  for (let index = 0; index < 5; index += 1) {
    const run = await journal.startRun({
      workflow: workflow({ id: `wf-page-${index}`, name: `Page ${index}` }),
      trigger: { kind: 'manual' },
      opId: `page-start-${index}`,
    });
    await journal.finishRun({
      runId: run.id,
      status: RUN_STATUS.COMPLETED,
      opId: `page-finish-${index}`,
    });
    created.push(run);
  }

  const first = await journal.listRuns({ limit: 2 });
  assert.deepEqual(first.runs.map(run => run.id), [created[4].id, created[3].id]);
  assert.equal(first.total, 5);
  assert.match(first.nextCursor, /^[A-Za-z0-9_-]+$/);

  const newest = await journal.startRun({
    workflow: workflow({ id: 'wf-page-new', name: 'Newest' }),
    trigger: { kind: 'manual' },
    opId: 'page-start-new',
  });
  await journal.finishRun({
    runId: newest.id,
    status: RUN_STATUS.COMPLETED,
    opId: 'page-finish-new',
  });

  const second = await journal.listRuns({ limit: 2, cursor: first.nextCursor });
  assert.deepEqual(second.runs.map(run => run.id), [created[2].id, created[1].id]);
  assert.equal(second.total, 6, 'newer inserts do not shift an issued cursor');
  assert.ok(second.nextCursor);
  const third = await journal.listRuns({ limit: 2, cursor: second.nextCursor });
  assert.deepEqual(third.runs.map(run => run.id), [created[0].id]);
  assert.equal(third.nextCursor, null);

  const indexFile = path.join(dir, '.index', 'runs-v1.json');
  const indexText = fs.readFileSync(indexFile, 'utf8');
  assert.equal(indexText.includes('PRIVATE WORKFLOW BODY'), false);
  assert.equal(indexText.includes('ciphertext'), false);
  assert.equal(indexText.includes('operations'), false);
  assert.equal(indexText.includes(dir), false);
  assert.equal(JSON.parse(indexText).runs.length, 6);

  const reopened = makeJournal({ dir }).journal;
  const durablePage = await reopened.listRuns({ limit: 1 });
  assert.equal(durablePage.runs[0].id, newest.id);
  assert.equal(durablePage.total, 6);
  await assert.rejects(
    reopened.listRuns({ cursor: 'not-a-real-cursor' }),
    error => error instanceof RunJournalError && error.code === 'invalid-input'
  );
});

test('a corrupt metadata index is reported and rebuilt from source records', async () => {
  const reports = [];
  const { journal, dir } = makeJournal();
  const run = await startRun(journal);
  await journal.listRuns({ limit: 1 });
  const indexFile = path.join(dir, '.index', 'runs-v1.json');
  fs.writeFileSync(indexFile, '{broken', 'utf8');

  const reopened = makeJournal({
    dir,
    onError: (file, error) => reports.push([path.basename(file), error.name]),
  }).journal;
  const page = await reopened.listRuns({ limit: 1 });
  assert.equal(page.runs[0].id, run.id);
  assert.equal(page.total, 1);
  assert.deepEqual(reports, [['runs-v1.json', 'SyntaxError']]);
  assert.equal(JSON.parse(fs.readFileSync(indexFile, 'utf8')).runs.length, 1);
});

test('active run events stay in the in-memory index until one terminal commit', async () => {
  const { journal, dir } = makeJournal();
  const baseline = await startRun(journal);
  await journal.finishRun({
    runId: baseline.id,
    status: RUN_STATUS.COMPLETED,
    opId: 'index-baseline-finish',
  });
  await journal.listRuns({ limit: 10 });
  const indexFile = path.join(dir, '.index', 'runs-v1.json');
  const dirtyFile = path.join(dir, '.index', 'dirty-v1.json');
  const baselineIndex = fs.readFileSync(indexFile, 'utf8');

  const active = await journal.startRun({
    workflow: workflow({ id: 'wf-index-active', name: 'Index active' }),
    trigger: { kind: 'manual' },
    opId: 'index-active-start',
  });
  await startVisit(journal, active.id, { opId: 'index-active-visit' });
  assert.equal(fs.existsSync(dirtyFile), true);
  assert.equal(fs.readFileSync(indexFile, 'utf8'), baselineIndex);
  const livePage = await journal.listRuns({ limit: 10 });
  assert.equal(livePage.runs[0].id, active.id);
  assert.equal(livePage.runs[0].status, RUN_STATUS.RUNNING);
  assert.equal(fs.existsSync(dirtyFile), true, 'listing does not clean an active projection');

  await journal.finishRun({
    runId: active.id,
    status: RUN_STATUS.CANCELLED,
    opId: 'index-active-finish',
  });
  assert.equal(fs.existsSync(dirtyFile), false);
  const durableIndex = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  assert.equal(durableIndex.runs[0].id, active.id);
  assert.equal(durableIndex.runs[0].status, RUN_STATUS.CANCELLED);
});

test('retention previews exact terminal candidates, rejects stale plans, and never prunes active runs', async () => {
  let current = Date.parse('2026-01-01T00:00:00.000Z');
  const now = () => new Date(current);
  const { journal } = makeJournal({ now });
  const terminal = [];
  for (let index = 0; index < 3; index += 1) {
    const run = await journal.startRun({
      workflow: workflow({ id: `wf-retain-${index}`, name: `Retain ${index}` }),
      trigger: { kind: 'manual' },
      opId: `retain-start-${index}`,
    });
    await journal.finishRun({
      runId: run.id,
      status: RUN_STATUS.COMPLETED,
      opId: `retain-finish-${index}`,
    });
    terminal.push(run);
    current += 24 * 60 * 60 * 1000;
  }

  const stalePreview = await journal.pruneRuns({ maxRuns: 2, preview: true });
  assert.equal(stalePreview.candidateCount, 1);
  const inserted = await journal.startRun({
    workflow: workflow({ id: 'wf-retain-new', name: 'Retain new' }),
    trigger: { kind: 'manual' },
    opId: 'retain-start-new',
  });
  await journal.finishRun({
    runId: inserted.id,
    status: RUN_STATUS.COMPLETED,
    opId: 'retain-finish-new',
  });
  await assert.rejects(
    journal.pruneRuns({
      maxRuns: 2,
      preview: false,
      previewToken: stalePreview.previewToken,
      opId: 'prune-stale',
    }),
    error => error instanceof RunJournalError && error.code === 'prune-preview-stale'
  );
  assert.equal((await journal.listRuns()).total, 4);

  const countPreview = await journal.pruneRuns({ maxRuns: 2, preview: true });
  assert.equal(countPreview.candidateCount, 2);
  const applied = await journal.pruneRuns({
    maxRuns: 2,
    preview: false,
    previewToken: countPreview.previewToken,
    opId: 'prune-count',
  });
  assert.equal(applied.deletedCount, 2);
  assert.deepEqual(
    await journal.pruneRuns({
      maxRuns: 2,
      preview: false,
      previewToken: countPreview.previewToken,
      opId: 'prune-count',
    }),
    applied,
    'same-process retry returns the committed result'
  );

  const active = await journal.startRun({
    workflow: workflow({ id: 'wf-retain-active', name: 'Active' }),
    trigger: { kind: 'manual' },
    opId: 'retain-start-active',
  });
  current += 100 * 24 * 60 * 60 * 1000;
  const agePreview = await journal.pruneRuns({ maxAgeDays: 30, preview: true });
  assert.equal(agePreview.candidateCount, 2);
  assert.equal(agePreview.activeCount, 1);
  const ageApplied = await journal.pruneRuns({
    maxAgeDays: 30,
    preview: false,
    cutoff: agePreview.cutoff,
    previewToken: agePreview.previewToken,
    opId: 'prune-age',
  });
  assert.equal(ageApplied.deletedCount, 2);
  assert.equal((await journal.getRun(active.id)).status, RUN_STATUS.RUNNING);
  const remaining = await journal.listRuns();
  assert.deepEqual(remaining.runs.map(run => run.id), [active.id]);
});

test('oversized journal files are skipped before parsing and reports stay path-free', async () => {
  const errors = [];
  const dir = tmpDir();
  const privateMarker = path.basename(dir);
  fs.writeFileSync(path.join(dir, 'oversized.json'), ' '.repeat(257));
  const { journal } = makeJournal({
    dir,
    recordMaxBytes: 256,
    onError: (file, error) => errors.push({
      file,
      code: error.code,
      message: error.message,
    }),
  });

  assert.deepEqual(await listRuns(journal), []);
  assert.deepEqual(errors.map(error => [error.file, error.code]), [
    ['oversized.json', 'json-file-too-large'],
  ]);
  assert.equal(errors[0].message.includes(privateMarker), false);
});

test('record size invariant rejects a write before the storage adapter is called', async () => {
  let writes = 0;
  const { journal } = makeJournal({
    recordMaxBytes: 2000,
    writeRecord: (file, data) => {
      writes += 1;
      writeJsonAtomic(file, data);
    },
  });
  await assert.rejects(
    startRun(journal),
    error => error instanceof RunJournalError && error.code === 'size-limit'
  );
  assert.equal(writes, 0);
});

test('an active record reserves enough bytes for terminal recovery', async () => {
  let stored;
  const probe = makeJournal({
    writeRecord(file, data) {
      stored = structuredClone(data);
      writeJsonAtomic(file, data);
    },
  });
  await startRun(probe.journal);
  const activeBytes = Buffer.byteLength(JSON.stringify(stored, null, 2), 'utf8');
  let writes = 0;
  const constrained = makeJournal({
    recordMaxBytes: activeBytes,
    writeRecord: () => {
      writes += 1;
    },
  });

  await assert.rejects(
    startRun(constrained.journal),
    error => error instanceof RunJournalError && error.code === 'size-limit'
  );
  assert.equal(writes, 0, 'a write-once/read-never active record must not reach storage');

  const sizing = makeJournal({ writeRecord: () => {} });
  let low = activeBytes;
  let high = MAX_RUN_RECORD_BYTES;
  while (low < high) {
    const candidate = low + Math.floor((high - low) / 2);
    sizing.journal.recordMaxBytes = candidate;
    try {
      sizing.journal._writeRun(structuredClone(stored));
      high = candidate;
    } catch (error) {
      assert.equal(error.code, 'size-limit');
      low = candidate + 1;
    }
  }

  const boundary = makeJournal({ recordMaxBytes: low });
  const active = await startRun(boundary.journal);
  const recovered = await boundary.journal.recoverInterrupted();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].id, active.id);
  assert.equal(recovered[0].status, RUN_STATUS.INTERRUPTED);
});

test('result ids are immutable and malformed decrypted envelopes are rejected', async () => {
  const adapter = encryptionAdapter();
  const { journal } = makeJournal({ encryption: adapter });
  const run = await startRun(journal);
  const visit = await startVisit(journal, run.id);
  const result = await journal.storeResult({
    runId: run.id,
    producerBlockId: 'blk-prompt',
    visitId: visit.visitId,
    name: 'answer',
    status: 'complete',
    lanes: [{ laneId: 'lane-a' }],
    body: 'original body',
    opId: 'result',
  });

  adapter.decrypt = () => 'tampered body';
  await assert.rejects(
    journal.getResult({ runId: run.id, resultId: result.id }),
    error => error instanceof RunJournalError && error.code === 'decrypt-failed'
  );
  assert.equal(
    await journal.getResult({
      runId: run.id,
      resultId: '00000000-0000-4000-8000-0000000000ff',
    }),
    null
  );
});

test('lane normalization drops all path, process, and credential-adjacent fields', () => {
  assert.deepEqual(normalizeLaneDescriptors([{
    laneId: 'lane-1',
    profileId: 'codex:primary',
    agent: 'codex',
    displayName: 'Primary',
    assurance: 'L1-routed',
    cwd: 'C:\\private',
    executable: 'pwsh.exe',
    env: { CODEX_HOME: 'C:\\private\\home' },
    token: 'secret',
    output: 'private terminal output',
  }]), [{
    laneId: 'lane-1',
    profileId: 'codex:primary',
    agent: 'codex',
    displayName: 'Primary',
    assurance: 'L1-routed',
  }]);
});

test('public workflow, result, and lane names use a 512 UTF-8 byte cap', async () => {
  const accepted = '雪'.repeat(170); // 510 UTF-8 bytes
  const rejected = '雪'.repeat(171); // 513 UTF-8 bytes
  const { journal } = makeJournal();
  const run = await startRun(journal, {
    workflow: workflow({ name: accepted }),
  });
  const visit = await startVisit(journal, run.id);
  const result = await journal.storeResult({
    runId: run.id,
    producerBlockId: 'blk-prompt',
    visitId: visit.visitId,
    name: accepted,
    status: 'complete',
    lanes: [{ laneId: 'lane-a', displayName: accepted }],
    body: 'body',
    opId: 'long-public-metadata',
  });
  assert.equal(result.name, accepted);
  assert.equal(result.lanes[0].displayName, accepted);
  await assert.rejects(
    journal.storeResult({
      runId: run.id,
      producerBlockId: 'blk-prompt',
      visitId: visit.visitId,
      name: rejected,
      status: 'complete',
      lanes: [{ laneId: 'lane-a' }],
      body: 'body',
      opId: 'rejected-result-name',
    }),
    error => error instanceof RunJournalError && error.code === 'size-limit'
  );

  assert.throws(
    () => normalizeLaneDescriptors([{ laneId: 'lane-a', displayName: rejected }]),
    error => error instanceof RunJournalError && error.code === 'size-limit'
  );
  const other = makeJournal();
  await assert.rejects(
    startRun(other.journal, {
      workflow: workflow({ name: rejected }),
    }),
    error => error instanceof RunJournalError && error.code === 'size-limit'
  );
});

async function journalTruncatedByRecordCapacity() {
  let stored;
  const probe = makeJournal({
    writeRecord(file, data) {
      stored = structuredClone(data);
      writeJsonAtomic(file, data);
    },
  });
  const probeRun = await startRun(probe.journal);
  await startVisit(probe.journal, probeRun.id);

  // Minimal recordMaxBytes that accepts the record holding one open visit.
  const sizing = makeJournal({ writeRecord: () => {} });
  let low = 1;
  let high = MAX_RUN_RECORD_BYTES;
  while (low < high) {
    const candidate = low + Math.floor((high - low) / 2);
    sizing.journal.recordMaxBytes = candidate;
    try {
      sizing.journal._writeRun(structuredClone(stored));
      high = candidate;
    } catch (error) {
      assert.equal(error.code, 'size-limit');
      low = candidate + 1;
    }
  }

  const constrained = makeJournal({ recordMaxBytes: low });
  const run = await startRun(constrained.journal);
  const visit = await startVisit(constrained.journal, run.id);
  const second = await constrained.journal.startBlock({
    runId: run.id,
    opId: 'op-block-two',
    block: { id: 'blk-prompt', index: 0, type: 'prompt', iterationPath: [] },
  });
  return { ...constrained, run, visit, second };
}

test('exceeding operation capacity mid-run degrades to a truncated no-op journal', async () => {
  const dir = tmpDir();
  const runId = '11111111-1111-4111-8111-111111111111';
  const at = '2026-07-30T00:00:00.000Z';
  const operations = [];
  for (let index = 0; index < MAX_OPERATIONS - 1; index++) {
    operations.push({
      opId: `pad-${index}`,
      action: 'start-run',
      proof: { storage: STORAGE.MEMORY },
      at,
      refId: null,
    });
  }
  writeJsonAtomic(path.join(dir, `${runId}.json`), {
    schemaVersion: SCHEMA_VERSION,
    id: runId,
    revision: 1,
    eventSeq: 1,
    status: RUN_STATUS.RUNNING,
    startedAt: at,
    updatedAt: at,
    finishedAt: null,
    workflow: { id: 'wf-demo', name: 'Demo workflow', formatVersion: 1, blockCount: 1 },
    trigger: { kind: 'manual' },
    snapshot: { storage: STORAGE.MEMORY, byteLength: 16 },
    blocks: [],
    results: [],
    operations,
    events: [{ seq: 1, type: 'run.started', at }],
  });

  const { journal } = makeJournal({ dir });
  const degradedVisit = await journal.startBlock({
    runId,
    opId: 'op-over-capacity',
    block: { id: 'blk-prompt', index: 0, type: 'prompt', iterationPath: [] },
  });
  assert.equal(degradedVisit.truncated, true);
  assert.equal(degradedVisit.status, BLOCK_STATUS.RUNNING);
  assert.equal(degradedVisit.blockId, 'blk-prompt');

  const afterTruncation = await journal.getRun(runId);
  assert.equal(afterTruncation.status, RUN_STATUS.RUNNING);
  assert.equal(afterTruncation.truncated.reason, 'operation-capacity');
  assert.equal(afterTruncation.blocks.length, 0, 'the over-capacity visit is not recorded');

  const laterVisit = await journal.startBlock({
    runId,
    opId: 'op-still-degraded',
    block: { id: 'blk-prompt', index: 0, type: 'prompt', iterationPath: [] },
  });
  assert.equal(laterVisit.truncated, true);
  const laterResult = await journal.storeResult({
    runId,
    producerBlockId: 'blk-prompt',
    visitId: degradedVisit.visitId,
    name: 'late',
    status: 'complete',
    lanes: [{ laneId: 'lane-a' }],
    body: 'dropped body',
    opId: 'op-late-result',
  });
  assert.equal(laterResult.truncated, true);
  const unchanged = await journal.getRun(runId);
  assert.equal(unchanged.blocks.length, 0);
  assert.equal(unchanged.results.length, 0);
  assert.equal(unchanged.status, RUN_STATUS.RUNNING);

  const finished = await journal.finishRun({
    runId,
    status: RUN_STATUS.COMPLETED,
    opId: 'op-run-finish',
  });
  assert.equal(finished.status, RUN_STATUS.COMPLETED);
  assert.equal(finished.truncated.reason, 'operation-capacity');
  assert.equal(finished.events.at(-1).type, 'run.finished');

  const summaries = await listRuns(journal);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].truncated.reason, 'operation-capacity');
  assert.equal(summaries[0].status, RUN_STATUS.COMPLETED);
});

test('record capacity truncates mid-run and finishRun still records terminal state', async () => {
  const { journal, run, visit, second } = await journalTruncatedByRecordCapacity();
  assert.equal(second.truncated, true);
  assert.equal(second.status, BLOCK_STATUS.RUNNING);

  const truncatedRun = await journal.getRun(run.id);
  assert.equal(truncatedRun.status, RUN_STATUS.RUNNING);
  assert.equal(truncatedRun.truncated.reason, 'record-capacity');
  assert.equal(truncatedRun.blocks.length, 1, 'the pre-truncation visit is retained');

  const closed = await journal.finishBlock({
    runId: run.id,
    visitId: visit.visitId,
    status: BLOCK_STATUS.COMPLETED,
    opId: 'op-block-finish',
  });
  assert.equal(closed.truncated, true);
  assert.equal(closed.status, BLOCK_STATUS.COMPLETED);

  const finished = await journal.finishRun({
    runId: run.id,
    status: RUN_STATUS.COMPLETED,
    opId: 'op-run-finish',
  });
  assert.equal(finished.status, RUN_STATUS.COMPLETED);
  assert.equal(finished.truncated.reason, 'record-capacity');
  assert.equal(finished.blocks[0].status, BLOCK_STATUS.INTERRUPTED);
  assert.equal(finished.blocks[0].reasonCode, 'journal-truncated');
  assert.equal(finished.events.at(-1).type, 'run.finished');
});

test('a truncated run round-trips through listing, read, and crash recovery', async () => {
  const { dir, run } = await journalTruncatedByRecordCapacity();

  const reopened = makeJournal({ dir }).journal;
  const summaries = await listRuns(reopened);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].id, run.id);
  assert.equal(summaries[0].truncated.reason, 'record-capacity');
  const read = await reopened.getRun(run.id);
  assert.deepEqual(Object.keys(read.truncated).sort(), ['at', 'reason']);
  assert.equal(read.truncated.reason, 'record-capacity');

  const recovered = await reopened.recoverInterrupted();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].status, RUN_STATUS.INTERRUPTED);
  assert.equal(recovered[0].truncated.reason, 'record-capacity');
  assert.equal(recovered[0].blocks[0].status, BLOCK_STATUS.INTERRUPTED);
  assert.equal(recovered[0].blocks[0].reasonCode, 'process-recovery');

  const listed = await listRuns(reopened);
  assert.equal(listed[0].status, RUN_STATUS.INTERRUPTED);
  assert.equal(listed[0].truncated.reason, 'record-capacity');
});
