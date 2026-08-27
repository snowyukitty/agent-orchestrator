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
  'snapshot-decryption-unavailable': 'The protected workflow snapshot could not be decrypted on this system.',
  'snapshot-integrity-failed': 'The protected snapshot no longer matches its journal metadata.',
  'workflow-invalid': 'The captured workflow does not pass the current versioned validator.',
  'workflow-identity-unstable': 'Validation would repair a block identity, so the recorded trace cannot be trusted.',
  'visit-trace-mismatch': 'The ordered visits are not a legal prefix of the captured workflow.',
  'control-step-limit': 'The captured control flow exceeds the engine safety limit.',
  'result-integrity-unavailable': 'At least one protected result could not be verified.',
  'required-result-missing': 'A future handoff has no verified protected result.',
  'required-result-incomplete': 'A future handoff points to a partial result.',
  'working-directory-unavailable': 'The reconstructed working directory is no longer available.',
  'runtime-checkpoint-required': 'Prior session interaction cannot be rebuilt without a protected runtime checkpoint.',
  'pending-team-stage': 'The run stopped between an agent send and its team barrier; old PTY signals are not durable.',
  'profile-resolution-unavailable': 'Current account authority could not be queried.',
  'profile-unavailable': 'At least one referenced account no longer resolves.',
  'profile-assurance-changed': 'At least one account now resolves at a different assurance level.',
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

const PREFLIGHT_STATE_COPY = Object.freeze({
  blocked: {
    label: 'Preflight blocked',
    tone: 'blocked',
    summary: 'Protected inspection found evidence that cannot support a safe continuation.',
  },
  'decision-required': {
    label: 'Decision required',
    tone: 'review',
    summary: 'The captured boundary is valid, but an ambiguous outcome must never be retried automatically.',
  },
  'boundary-verified': {
    label: 'Boundary verified',
    tone: 'verified',
    summary: 'Snapshot, control trace, protected results, runtime recipe, and current account resolution passed inspection.',
  },
  'no-remaining-work': {
    label: 'Nothing left to resume',
    tone: 'recorded',
    summary: 'The trace reaches the end of the captured workflow; there is no remaining visit to execute.',
  },
});

const STAGE_LABEL = Object.freeze({
  snapshot: 'Snapshot',
  trace: 'Control trace',
  results: 'Result bindings',
  runtime: 'Runtime recipe',
  profiles: 'Account authority',
});

const STAGE_STATE_LABEL = Object.freeze({
  verified: 'Verified',
  'review-required': 'Review',
  blocked: 'Blocked',
  'not-run': 'Not run',
});

function addressLabel(address) {
  if (!address || !Number.isSafeInteger(address.blockIndex)) return null;
  const path = Array.isArray(address.iterationPath) && address.iterationPath.length
    ? ` · loop ${address.iterationPath.map(frame => (
      `${count(frame.iteration)}/${count(frame.total)}`
    )).join(' › ')}`
    : '';
  return `Step ${address.blockIndex + 1} · ${address.blockType || 'block'}${path}`;
}

function stageDetail(key, value) {
  if (!value || value.state === 'not-run') return 'Not inspected';
  if (value.state === 'blocked' && !Number.isSafeInteger(value.blockCount)
    && !Number.isSafeInteger(value.verifiedCount)
    && !Number.isSafeInteger(value.referencedCount)
    && value.remainingVisitCount === undefined
    && value.workingDirectoryReconstructed === undefined) {
    return 'Inspection stopped at this stage';
  }
  if (key === 'snapshot') {
    const migration = value.migrated
      ? ` · migrated v${count(value.sourceFormatVersion)} → v${count(value.currentFormatVersion)}`
      : ` · format v${count(value.currentFormatVersion)}`;
    return `${count(value.blockCount)} block(s)${migration}`;
  }
  if (key === 'trace') {
    const remaining = value.remainingVisitCount === null
      ? 'remaining visits unknown'
      : `${count(value.remainingVisitCount)} remaining`;
    return `${count(value.completedVisitCount)} completed · ${count(value.uncertainVisitCount)} uncertain · ${remaining}`;
  }
  if (key === 'results') {
    return `${count(value.verifiedCount)} protected result(s) verified · ${count(value.availableRequiredCount)}/${count(value.requiredCount)} required handoff(s) available`;
  }
  if (key === 'runtime') {
    const directory = value.workingDirectoryReconstructed
      ? 'directory restored'
      : 'directory unavailable';
    const pending = value.pendingTeamStage ? ' · pending team stage' : '';
    return `${directory} · ${count(value.sessionRecipeCount)} session recipe(s) · ${count(value.opaqueInteractionCount)} opaque interaction(s)${pending}`;
  }
  return `${count(value.resolvedCount)}/${count(value.referencedCount)} account(s) resolve · ${count(value.assuranceChangedCount)} assurance change(s) · ${count(value.baselineMissingCount)} without a historical baseline`;
}

/** Human copy for a redacted, main-owned protected inspection report. */
export function describeResumePreflight(report) {
  if (!report || report.state === 'not-applicable') return null;
  const display = PREFLIGHT_STATE_COPY[report.state] || PREFLIGHT_STATE_COPY.blocked;
  const codes = Array.isArray(report.reasonCodes)
    ? [...new Set(report.reasonCodes.filter(code => typeof code === 'string'))]
    : ['evidence-invalid'];
  const stages = Object.keys(STAGE_LABEL).map(key => {
    const value = report[key] || { state: 'not-run' };
    return {
      key,
      label: STAGE_LABEL[key],
      state: value.state || 'not-run',
      stateLabel: STAGE_STATE_LABEL[value.state] || 'Unknown',
      detail: stageDetail(key, value),
    };
  });
  return {
    ...display,
    reasons: codes.map(code => (
      REASON_COPY[code] || `Unrecognized resume preflight condition: ${code}.`
    )),
    stages,
    boundary: addressLabel(report.trace?.boundary),
    next: addressLabel(report.trace?.next),
    sourceRevision: count(report.source?.revision),
    executionAvailable: false,
  };
}
