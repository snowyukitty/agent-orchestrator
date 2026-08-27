// ============================================================
// Resume evidence assessment
//
// This is deliberately a metadata-only, side-effect-free first gate. It does
// not decrypt a workflow, reconstruct engine state, or authorize execution.
// A future resume preflight must do all three in the main process before it
// may offer an action to the renderer.
// ============================================================

const RESUME_EVIDENCE_VERSION = 1;
const SUPPORTED_JOURNAL_SCHEMA_VERSION = 1;
const SUPPORTED_WORKFLOW_FORMAT_VERSIONS = new Set([1]);

const RESUME_EVIDENCE_STATE = Object.freeze({
  NOT_APPLICABLE: 'not-applicable',
  BLOCKED: 'blocked',
  REVIEW_REQUIRED: 'review-required',
  RECORDED_BOUNDARY: 'recorded-boundary',
});

const RESUME_EVIDENCE_REASON = Object.freeze({
  RUN_NOT_INTERRUPTED: 'run-not-interrupted',
  EVIDENCE_INVALID: 'evidence-invalid',
  JOURNAL_SCHEMA_UNSUPPORTED: 'journal-schema-unsupported',
  WORKFLOW_FORMAT_UNSUPPORTED: 'workflow-format-unsupported',
  SNAPSHOT_NOT_DURABLE: 'snapshot-not-durable',
  JOURNAL_TRUNCATED: 'journal-truncated',
  VISIT_ADDRESS_INCOMPLETE: 'visit-address-incomplete',
  RESULT_NOT_DURABLE: 'result-not-durable',
  VISIT_OUTCOME_UNCERTAIN: 'visit-outcome-uncertain',
  VISIT_TERMINAL_NONCOMPLETION: 'visit-terminal-noncompletion',
  RESULT_INCOMPLETE: 'result-incomplete',
});

function addReason(reasons, code) {
  if (!reasons.includes(code)) reasons.push(code);
}

function assessment({
  state,
  reasonCodes,
  completedVisitCount,
  uncertainVisitCount,
  durableResultCount,
  unavailableResultCount,
}) {
  return {
    version: RESUME_EVIDENCE_VERSION,
    state,
    // This field is intentionally false in every state. A recorded boundary
    // is evidence for a future preflight, never permission to execute today.
    executionAvailable: false,
    reasonCodes,
    completedVisitCount,
    uncertainVisitCount,
    durableResultCount,
    unavailableResultCount,
  };
}

/**
 * Classify only the public metadata already present in one journal record.
 *
 * `recorded-boundary` means the cheap gate found no known evidence loss. It
 * does not mean the encrypted snapshot is decryptable, the control cursor is
 * reconstructable, profiles still resolve, or replay is safe.
 */
function assessResumeEvidence(run) {
  const blocks = Array.isArray(run?.blocks) ? run.blocks : [];
  const results = Array.isArray(run?.results) ? run.results : [];
  const completedVisitCount = blocks.reduce(
    (count, visit) => count + (visit?.status === 'completed' ? 1 : 0),
    0
  );
  const uncertainVisitCount = blocks.reduce(
    (count, visit) => count + (
      visit?.status !== 'completed' ? 1 : 0
    ),
    0
  );
  const durableResultCount = results.reduce(
    (count, result) => count + (result?.storage === 'encrypted' ? 1 : 0),
    0
  );
  const unavailableResultCount = results.length - durableResultCount;

  if (!run || typeof run !== 'object' || run.status !== 'interrupted') {
    return assessment({
      state: RESUME_EVIDENCE_STATE.NOT_APPLICABLE,
      reasonCodes: [RESUME_EVIDENCE_REASON.RUN_NOT_INTERRUPTED],
      completedVisitCount,
      uncertainVisitCount,
      durableResultCount,
      unavailableResultCount,
    });
  }

  const blockers = [];
  const review = [];

  if (!Array.isArray(run.blocks) || !Array.isArray(run.results)) {
    addReason(blockers, RESUME_EVIDENCE_REASON.EVIDENCE_INVALID);
  }
  if (run.schemaVersion !== SUPPORTED_JOURNAL_SCHEMA_VERSION) {
    addReason(blockers, RESUME_EVIDENCE_REASON.JOURNAL_SCHEMA_UNSUPPORTED);
  }
  if (!SUPPORTED_WORKFLOW_FORMAT_VERSIONS.has(run.workflow?.formatVersion)) {
    addReason(blockers, RESUME_EVIDENCE_REASON.WORKFLOW_FORMAT_UNSUPPORTED);
  }
  if (run.snapshot?.storage !== 'encrypted') {
    addReason(blockers, RESUME_EVIDENCE_REASON.SNAPSHOT_NOT_DURABLE);
  }
  if (run.truncated) {
    addReason(blockers, RESUME_EVIDENCE_REASON.JOURNAL_TRUNCATED);
  }

  for (const visit of blocks) {
    if (!Number.isSafeInteger(visit?.blockIndex) || visit.blockIndex < 0) {
      addReason(blockers, RESUME_EVIDENCE_REASON.VISIT_ADDRESS_INCOMPLETE);
    }
    if (visit?.status === 'interrupted') {
      addReason(review, RESUME_EVIDENCE_REASON.VISIT_OUTCOME_UNCERTAIN);
    } else if (visit?.status === 'failed' || visit?.status === 'cancelled') {
      addReason(review, RESUME_EVIDENCE_REASON.VISIT_TERMINAL_NONCOMPLETION);
    } else if (visit?.status !== 'completed') {
      addReason(blockers, RESUME_EVIDENCE_REASON.EVIDENCE_INVALID);
    }
  }

  for (const result of results) {
    if (result?.storage !== 'encrypted') {
      addReason(blockers, RESUME_EVIDENCE_REASON.RESULT_NOT_DURABLE);
    }
    if (result?.status === 'partial') {
      addReason(review, RESUME_EVIDENCE_REASON.RESULT_INCOMPLETE);
    } else if (result?.status !== 'complete') {
      addReason(blockers, RESUME_EVIDENCE_REASON.EVIDENCE_INVALID);
    }
  }

  const state = blockers.length > 0
    ? RESUME_EVIDENCE_STATE.BLOCKED
    : review.length > 0
      ? RESUME_EVIDENCE_STATE.REVIEW_REQUIRED
      : RESUME_EVIDENCE_STATE.RECORDED_BOUNDARY;

  return assessment({
    state,
    reasonCodes: [...blockers, ...review],
    completedVisitCount,
    uncertainVisitCount,
    durableResultCount,
    unavailableResultCount,
  });
}

module.exports = {
  RESUME_EVIDENCE_VERSION,
  RESUME_EVIDENCE_STATE,
  RESUME_EVIDENCE_REASON,
  assessResumeEvidence,
};
