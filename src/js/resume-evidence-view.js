// Human-readable presentation for the main process's metadata-only resume
// assessment. This module never decides whether execution is safe.

const REASON_COPY = Object.freeze({
  'evidence-invalid': 'The stored evidence is incomplete or internally inconsistent.',
  'journal-schema-unsupported': 'This journal schema is not supported by the current resume design.',
  'workflow-format-unsupported': 'This workflow format is not supported by the current resume design.',
  'snapshot-not-durable': 'The immutable workflow snapshot was memory-only and cannot survive a restart.',
  'journal-truncated': 'The journal reached a capacity limit, so later visits or results may be unknown.',
  'visit-address-incomplete': 'At least one visit lacks the block address needed to reconstruct control flow.',
  'result-not-durable': 'At least one explicit result body was memory-only and may no longer exist.',
  'visit-outcome-uncertain': 'A block was active during recovery; its external effects may have happened even though completion was not recorded.',
  'visit-terminal-noncompletion': 'A prior visit failed or was cancelled before the interruption boundary.',
  'result-incomplete': 'At least one explicit result is partial and cannot be treated as a complete handoff.',
});

const STATE_COPY = Object.freeze({
  blocked: {
    label: 'Evidence blocked',
    tone: 'blocked',
    summary: 'This record is missing evidence required even to begin a future resume preflight.',
  },
  'review-required': {
    label: 'Decision required',
    tone: 'review',
    summary: 'The boundary contains an ambiguous outcome. It must never be retried automatically.',
  },
  'recorded-boundary': {
    label: 'Boundary recorded',
    tone: 'recorded',
    summary: 'Durable metadata contains an untruncated boundary. Snapshot decryption, control-state reconstruction, and profile resolution are still unchecked.',
  },
});

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export function describeResumeEvidence(evidence) {
  if (!evidence || evidence.state === 'not-applicable') return null;
  const display = STATE_COPY[evidence.state] || STATE_COPY.blocked;
  const codes = Array.isArray(evidence.reasonCodes)
    ? [...new Set(evidence.reasonCodes.filter(code => typeof code === 'string'))]
    : ['evidence-invalid'];
  const reasons = codes.map(code => (
    REASON_COPY[code] || `Unrecognized resume evidence condition: ${code}.`
  ));

  return {
    ...display,
    reasons,
    completedVisitCount: count(evidence.completedVisitCount),
    uncertainVisitCount: count(evidence.uncertainVisitCount),
    durableResultCount: count(evidence.durableResultCount),
    unavailableResultCount: count(evidence.unavailableResultCount),
    executionAvailable: false,
  };
}
