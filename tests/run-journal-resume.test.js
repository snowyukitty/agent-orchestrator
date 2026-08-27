const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  RunJournal,
  RunJournalError,
} = require('../src/main/run-journal');
const { writeJsonAtomic } = require('../src/main/store');

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agents-orch-resume-'));
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
  const base = Date.parse('2026-08-27T00:00:00.000Z');
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
      calls.push({ method: 'encrypt', context: { ...context } });
      return Buffer.from(`sealed\u0000${plaintext}`, 'utf8').toString('base64');
    },
    decrypt(ciphertext, context) {
      calls.push({ method: 'decrypt', context: { ...context } });
      const decoded = Buffer.from(ciphertext, 'base64').toString('utf8');
      if (!decoded.startsWith('sealed\u0000')) throw new Error('not sealed');
      return decoded.slice('sealed\u0000'.length);
    },
  };
}

function workflow() {
  return {
    formatVersion: 2,
    id: 'wf-preflight',
    name: 'Protected preflight',
    defaultDirectory: 'C:\\private\\preflight-workspace',
    blocks: [
      { id: 'first', type: 'log', params: { message: 'PRIVATE BODY' } },
      { id: 'next', type: 'sleep', params: { delay: 5, unit: 'minutes' } },
    ],
  };
}

function makeJournal({ encryption = encryptionAdapter() } = {}) {
  const dir = temporaryDirectory();
  return {
    dir,
    encryption,
    journal: new RunJournal({
      dir,
      encryption,
      randomUUID: deterministicUuid(),
      now: deterministicClock(),
    }),
  };
}

async function interruptedAfterFirst(journal) {
  const run = await journal.startRun({
    workflow: workflow(),
    trigger: { kind: 'manual' },
    opId: 'resume-start-run',
  });
  const visit = await journal.startBlock({
    runId: run.id,
    block: {
      id: 'first',
      index: 0,
      type: 'log',
      iterationPath: [],
    },
    opId: 'resume-start-block',
  });
  await journal.finishBlock({
    runId: run.id,
    visitId: visit.visitId,
    status: 'completed',
    opId: 'resume-finish-block',
  });
  const recovered = await journal.recoverInterrupted();
  assert.equal(recovered.length, 1);
  return recovered[0];
}

test('journal preflight decrypts in main and returns only a revision-bound redacted report', async () => {
  const { journal, encryption } = makeJournal();
  const source = await interruptedAfterFirst(journal);

  const report = await journal.preflightResume({
    runId: source.id,
    sourceRevision: source.revision,
  }, {
    resolveProfile: async () => null,
    isDirectory: () => true,
  });

  assert.equal(report.state, 'boundary-verified');
  assert.equal(report.executionAvailable, false);
  assert.equal(report.source.revision, source.revision);
  assert.equal(report.trace.next.blockIndex, 1);
  assert.equal(report.trace.next.blockType, 'sleep');
  assert.ok(encryption.calls.some(call => (
    call.method === 'decrypt' && call.context.kind === 'workflow'
  )));
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes('PRIVATE BODY'), false);
  assert.equal(serialized.includes('preflight-workspace'), false);
  assert.equal(serialized.includes('first'), false);
  assert.equal(serialized.includes('next'), true, 'the public field name "next" remains');
});

test('journal preflight rejects a stale source revision before decryption', async () => {
  const { journal, encryption } = makeJournal();
  const source = await interruptedAfterFirst(journal);
  const decryptsBefore = encryption.calls.filter(call => call.method === 'decrypt').length;

  await assert.rejects(
    journal.preflightResume({
      runId: source.id,
      sourceRevision: source.revision - 1,
    }, { isDirectory: () => true }),
    error => error instanceof RunJournalError && error.code === 'stale-source'
  );
  assert.equal(
    encryption.calls.filter(call => call.method === 'decrypt').length,
    decryptsBefore
  );

  await assert.rejects(
    journal.preflightResume({
      runId: source.id,
      sourceRevision: source.revision,
      disposition: 'retry',
    }, { isDirectory: () => true }),
    error => error instanceof RunJournalError && error.code === 'invalid-input'
  );
});

test('snapshot metadata tampering blocks integrity without returning protected bytes', async () => {
  const { journal, dir } = makeJournal();
  const source = await interruptedAfterFirst(journal);
  const file = path.join(dir, `${source.id}.json`);
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  stored.snapshot.byteLength += 1;
  writeJsonAtomic(file, stored);

  const report = await journal.preflightResume({
    runId: source.id,
    sourceRevision: source.revision,
  }, { isDirectory: () => true });

  assert.equal(report.state, 'blocked');
  assert.equal(report.snapshot.state, 'blocked');
  assert.deepEqual(report.reasonCodes, ['snapshot-integrity-failed']);
  assert.equal(JSON.stringify(report).includes('PRIVATE BODY'), false);
});

test('memory-only evidence is rejected by the cheap gate without decrypting', async () => {
  const encryption = encryptionAdapter({ available: false });
  const { journal } = makeJournal({ encryption });
  const source = await interruptedAfterFirst(journal);

  const report = await journal.preflightResume({
    runId: source.id,
    sourceRevision: source.revision,
  }, { isDirectory: () => true });

  assert.equal(report.state, 'blocked');
  assert.equal(report.snapshot.state, 'not-run');
  assert.ok(report.reasonCodes.includes('snapshot-not-durable'));
  assert.equal(encryption.calls.some(call => call.method === 'decrypt'), false);
});
