const test = require('node:test');
const assert = require('node:assert/strict');

const {
  RESUME_EVIDENCE_VERSION,
  RESUME_EVIDENCE_STATE,
  RESUME_EVIDENCE_REASON,
  assessResumeEvidence,
} = require('../src/main/resume-evidence');

function interruptedRun(overrides = {}) {
  return {
    schemaVersion: 1,
    status: 'interrupted',
    workflow: { formatVersion: 1 },
    snapshot: { storage: 'encrypted' },
    truncated: null,
    blocks: [{ blockIndex: 0, status: 'completed' }],
    results: [{ storage: 'encrypted', status: 'complete' }],
    ...overrides,
  };
}

test('non-interrupted runs are outside the resume evidence contract', () => {
  const result = assessResumeEvidence(interruptedRun({ status: 'completed' }));

  assert.deepEqual(result, {
    version: RESUME_EVIDENCE_VERSION,
    state: RESUME_EVIDENCE_STATE.NOT_APPLICABLE,
    executionAvailable: false,
    reasonCodes: [RESUME_EVIDENCE_REASON.RUN_NOT_INTERRUPTED],
    completedVisitCount: 1,
    uncertainVisitCount: 0,
    durableResultCount: 1,
    unavailableResultCount: 0,
  });
});

test('durable untruncated metadata records a boundary without enabling execution', () => {
  const result = assessResumeEvidence(interruptedRun({
    blocks: [
      { blockIndex: 0, status: 'completed' },
      { blockIndex: 1, status: 'completed' },
    ],
  }));

  assert.equal(result.state, RESUME_EVIDENCE_STATE.RECORDED_BOUNDARY);
  assert.equal(result.executionAvailable, false);
  assert.deepEqual(result.reasonCodes, []);
  assert.equal(result.completedVisitCount, 2);
  assert.equal(result.uncertainVisitCount, 0);
});

test('lossy or unsupported metadata fails the evidence gate closed', () => {
  const result = assessResumeEvidence(interruptedRun({
    schemaVersion: 2,
    workflow: { formatVersion: 2 },
    snapshot: { storage: 'memory' },
    truncated: { reason: 'event-capacity' },
    blocks: [{ blockIndex: null, status: 'completed' }],
    results: [{ storage: 'memory', status: 'complete' }],
  }));

  assert.equal(result.state, RESUME_EVIDENCE_STATE.BLOCKED);
  assert.deepEqual(result.reasonCodes, [
    RESUME_EVIDENCE_REASON.JOURNAL_SCHEMA_UNSUPPORTED,
    RESUME_EVIDENCE_REASON.WORKFLOW_FORMAT_UNSUPPORTED,
    RESUME_EVIDENCE_REASON.SNAPSHOT_NOT_DURABLE,
    RESUME_EVIDENCE_REASON.JOURNAL_TRUNCATED,
    RESUME_EVIDENCE_REASON.VISIT_ADDRESS_INCOMPLETE,
    RESUME_EVIDENCE_REASON.RESULT_NOT_DURABLE,
  ]);
  assert.equal(result.unavailableResultCount, 1);
});

test('uncertain visits and partial results require review and are deduplicated', () => {
  const result = assessResumeEvidence(interruptedRun({
    blocks: [
      { blockIndex: 0, status: 'completed' },
      { blockIndex: 1, status: 'interrupted' },
      { blockIndex: 2, status: 'interrupted' },
      { blockIndex: 3, status: 'cancelled' },
    ],
    results: [
      { storage: 'encrypted', status: 'partial' },
      { storage: 'encrypted', status: 'partial' },
    ],
  }));

  assert.equal(result.state, RESUME_EVIDENCE_STATE.REVIEW_REQUIRED);
  assert.deepEqual(result.reasonCodes, [
    RESUME_EVIDENCE_REASON.VISIT_OUTCOME_UNCERTAIN,
    RESUME_EVIDENCE_REASON.VISIT_TERMINAL_NONCOMPLETION,
    RESUME_EVIDENCE_REASON.RESULT_INCOMPLETE,
  ]);
  assert.equal(result.completedVisitCount, 1);
  assert.equal(result.uncertainVisitCount, 3);
  assert.equal(result.durableResultCount, 2);
});

test('malformed interrupted evidence never throws or becomes a recorded boundary', () => {
  const result = assessResumeEvidence({ status: 'interrupted' });

  assert.equal(result.state, RESUME_EVIDENCE_STATE.BLOCKED);
  assert.equal(result.executionAvailable, false);
  assert.ok(result.reasonCodes.includes(RESUME_EVIDENCE_REASON.EVIDENCE_INVALID));
});
