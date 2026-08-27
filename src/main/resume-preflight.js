// ============================================================
// Interrupted-run deep preflight
//
// This module may inspect protected workflow/result bodies, but its return
// value is deliberately redacted metadata. It proves evidence; it never
// creates a session, emits a block effect, or authorizes resume execution.
// ============================================================
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { isDeepStrictEqual } = require('node:util');

const { assessResumeEvidence } = require('./resume-evidence');

const RESUME_PREFLIGHT_VERSION = 1;
const MAX_CONTROL_STEPS = 1_000_000;
const FIRST_RESUMABLE_WORKFLOW_FORMAT = 1;
const WORKFLOW_AGENT_TARGET = '@workflow-agents';

const RESUME_PREFLIGHT_STATE = Object.freeze({
  NOT_APPLICABLE: 'not-applicable',
  BLOCKED: 'blocked',
  DECISION_REQUIRED: 'decision-required',
  BOUNDARY_VERIFIED: 'boundary-verified',
  NO_REMAINING_WORK: 'no-remaining-work',
});

const PREFLIGHT_STAGE_STATE = Object.freeze({
  NOT_RUN: 'not-run',
  VERIFIED: 'verified',
  REVIEW_REQUIRED: 'review-required',
  BLOCKED: 'blocked',
});

const RESUME_PREFLIGHT_REASON = Object.freeze({
  SNAPSHOT_DECRYPTION_UNAVAILABLE: 'snapshot-decryption-unavailable',
  SNAPSHOT_INTEGRITY_FAILED: 'snapshot-integrity-failed',
  WORKFLOW_FORMAT_UNSUPPORTED: 'workflow-format-unsupported',
  WORKFLOW_INVALID: 'workflow-invalid',
  WORKFLOW_IDENTITY_UNSTABLE: 'workflow-identity-unstable',
  VISIT_TRACE_MISMATCH: 'visit-trace-mismatch',
  CONTROL_STEP_LIMIT: 'control-step-limit',
  RESULT_INTEGRITY_UNAVAILABLE: 'result-integrity-unavailable',
  REQUIRED_RESULT_MISSING: 'required-result-missing',
  REQUIRED_RESULT_INCOMPLETE: 'required-result-incomplete',
  WORKING_DIRECTORY_UNAVAILABLE: 'working-directory-unavailable',
  RUNTIME_CHECKPOINT_REQUIRED: 'runtime-checkpoint-required',
  PENDING_TEAM_STAGE: 'pending-team-stage',
  PROFILE_RESOLUTION_UNAVAILABLE: 'profile-resolution-unavailable',
  PROFILE_UNAVAILABLE: 'profile-unavailable',
  PROFILE_ASSURANCE_CHANGED: 'profile-assurance-changed',
});

class ResumePreflightError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ResumePreflightError';
    this.code = code;
  }
}

let workflowModulePromise = null;

function workflowModule() {
  if (!workflowModulePromise) {
    const file = path.join(__dirname, '..', 'js', 'workflow-document.mjs');
    workflowModulePromise = import(pathToFileURL(file).href);
  }
  return workflowModulePromise;
}

function unique(values) {
  return [...new Set(values.filter(value => typeof value === 'string' && value))];
}

function stage(state, detail = {}) {
  return { state, ...detail };
}

function redactedAddress(address) {
  if (!address) return null;
  return {
    blockIndex: address.blockIndex,
    blockType: address.blockType,
    iterationPath: address.iterationPath.map(frame => ({
      iteration: frame.iteration,
      total: frame.total,
    })),
  };
}

function emptyReport(run, evidence) {
  return {
    version: RESUME_PREFLIGHT_VERSION,
    state: RESUME_PREFLIGHT_STATE.BLOCKED,
    executionAvailable: false,
    source: {
      runId: run?.id || null,
      revision: Number.isSafeInteger(run?.revision) ? run.revision : null,
    },
    reasonCodes: [],
    snapshot: stage(PREFLIGHT_STAGE_STATE.NOT_RUN),
    trace: stage(PREFLIGHT_STAGE_STATE.NOT_RUN, {
      completedVisitCount: evidence?.completedVisitCount || 0,
      uncertainVisitCount: evidence?.uncertainVisitCount || 0,
      remainingVisitCount: null,
      boundary: null,
      next: null,
    }),
    results: stage(PREFLIGHT_STAGE_STATE.NOT_RUN, {
      verifiedCount: 0,
      requiredCount: 0,
      availableRequiredCount: 0,
    }),
    runtime: stage(PREFLIGHT_STAGE_STATE.NOT_RUN, {
      workingDirectoryReconstructed: false,
      sessionRecipeCount: 0,
      pendingTeamStage: false,
      opaqueInteractionCount: 0,
    }),
    profiles: stage(PREFLIGHT_STAGE_STATE.NOT_RUN, {
      referencedCount: 0,
      resolvedCount: 0,
      missingCount: 0,
      assuranceChangedCount: 0,
      baselineMissingCount: 0,
    }),
  };
}

function failReport(report, reasonCodes) {
  report.state = RESUME_PREFLIGHT_STATE.BLOCKED;
  report.reasonCodes = unique([...report.reasonCodes, ...reasonCodes]);
  return report;
}

function workflowErrorCode(error) {
  if (error?.code === 'future-version' || error?.code === 'invalid-version') {
    return RESUME_PREFLIGHT_REASON.WORKFLOW_FORMAT_UNSUPPORTED;
  }
  return RESUME_PREFLIGHT_REASON.WORKFLOW_INVALID;
}

/** Reuse the renderer's exact versioned loader from a Node-compatible ESM file. */
async function validateCapturedWorkflow(workflow) {
  let loadedModule;
  try {
    loadedModule = await workflowModule();
  } catch (_error) {
    throw new ResumePreflightError(
      'The workflow validator is unavailable',
      RESUME_PREFLIGHT_REASON.WORKFLOW_INVALID
    );
  }

  if (
    !Number.isSafeInteger(workflow?.formatVersion)
    || workflow.formatVersion < FIRST_RESUMABLE_WORKFLOW_FORMAT
    || workflow.formatVersion > loadedModule.WORKFLOW_FORMAT_VERSION
  ) {
    throw new ResumePreflightError(
      'The workflow format is unsupported',
      RESUME_PREFLIGHT_REASON.WORKFLOW_FORMAT_UNSUPPORTED
    );
  }

  let loaded;
  try {
    loaded = loadedModule.loadWorkflowDocument(workflow, {
      defaultDirectory: typeof workflow.defaultDirectory === 'string'
        ? workflow.defaultDirectory
        : '.',
    });
  } catch (error) {
    throw new ResumePreflightError('The workflow is invalid', workflowErrorCode(error));
  }

  if (loaded.diagnostics.some(item => item?.severity === 'error')) {
    throw new ResumePreflightError(
      'The workflow contains an invalid reference',
      RESUME_PREFLIGHT_REASON.WORKFLOW_INVALID
    );
  }
  if (loaded.diagnostics.some(item => (
    item?.code === 'invalid-id-repaired' || item?.code === 'duplicate-id-repaired'
  ))) {
    throw new ResumePreflightError(
      'Workflow identities would change during normalization',
      RESUME_PREFLIGHT_REASON.WORKFLOW_IDENTITY_UNSTABLE
    );
  }
  if (
    workflow.blocks.length !== loaded.document.blocks.length
    || workflow.blocks.some((block, index) => (
      block?.id !== loaded.document.blocks[index]?.id
      || block?.type !== loaded.document.blocks[index]?.type
    ))
  ) {
    throw new ResumePreflightError(
      'Workflow identities do not survive validation',
      RESUME_PREFLIGHT_REASON.WORKFLOW_IDENTITY_UNSTABLE
    );
  }
  if (
    workflow.formatVersion === loadedModule.WORKFLOW_FORMAT_VERSION
    && !isDeepStrictEqual(workflow, loaded.document)
  ) {
    throw new ResumePreflightError(
      'The current-format workflow is not canonical',
      RESUME_PREFLIGHT_REASON.WORKFLOW_INVALID
    );
  }

  return {
    document: loaded.document,
    sourceFormatVersion: workflow.formatVersion,
    currentFormatVersion: loadedModule.WORKFLOW_FORMAT_VERSION,
    migrated: loaded.migrated,
  };
}

function matchingLoopEnd(blocks, startIndex) {
  let depth = 0;
  for (let index = startIndex + 1; index < blocks.length; index++) {
    if (blocks[index]?.type === 'loop') depth += 1;
    else if (blocks[index]?.type === 'loopEnd') {
      if (depth === 0) return index;
      depth -= 1;
    }
  }
  return -1;
}

/** Yield exactly the visit addresses emitted by WorkflowEngine._drive. */
function* controlVisitSequence(blocks) {
  const loopStack = [];
  let blockIndex = 0;
  let steps = 0;

  while (blockIndex < blocks.length) {
    if (++steps > MAX_CONTROL_STEPS) {
      throw new ResumePreflightError(
        'The workflow exceeds the engine control-step limit',
        RESUME_PREFLIGHT_REASON.CONTROL_STEP_LIMIT
      );
    }
    const block = blocks[blockIndex];
    const address = {
      blockId: block.id,
      blockIndex,
      blockType: block.type,
      iterationPath: loopStack.map(frame => ({
        loopBlockId: frame.blockId,
        iteration: frame.iteration,
        total: frame.total,
      })),
    };

    yield address;

    if (block.type === 'loop') {
      const end = matchingLoopEnd(blocks, blockIndex);
      const count = Math.max(0, Math.floor(Number(block.params?.count) || 0));
      if (end === -1) {
        blockIndex += 1;
      } else if (count <= 0) {
        blockIndex = end + 1;
      } else {
        loopStack.push({
          start: blockIndex,
          end,
          total: count,
          iteration: 1,
          blockId: block.id,
        });
        blockIndex += 1;
      }
      continue;
    }

    if (block.type === 'loopEnd') {
      const frame = loopStack[loopStack.length - 1];
      if (!frame) {
        blockIndex += 1;
      } else if (frame.iteration < frame.total) {
        frame.iteration += 1;
        blockIndex = frame.start + 1;
      } else {
        loopStack.pop();
        blockIndex += 1;
      }
      continue;
    }

    blockIndex += 1;
  }
}

function sameAddress(visit, expected) {
  return visit?.blockId === expected.blockId
    && visit?.blockIndex === expected.blockIndex
    && visit?.blockType === expected.blockType
    && isDeepStrictEqual(visit?.iterationPath, expected.iterationPath);
}

function collectRemaining(iterator, first) {
  const blockIndexes = new Set();
  let count = 0;
  let current = first;
  while (current) {
    count += 1;
    blockIndexes.add(current.blockIndex);
    const item = iterator.next();
    current = item.done ? null : item.value;
  }
  return { blockIndexes, count };
}

function proveVisitTrace(workflow, visits) {
  const iterator = controlVisitSequence(workflow.blocks);
  let uncertain = null;

  for (let index = 0; index < visits.length; index++) {
    const expectedItem = iterator.next();
    if (expectedItem.done || !sameAddress(visits[index], expectedItem.value)) {
      throw new ResumePreflightError(
        'The journal visits are not a legal workflow prefix',
        RESUME_PREFLIGHT_REASON.VISIT_TRACE_MISMATCH
      );
    }
    if (visits[index].status !== 'completed') {
      if (index !== visits.length - 1) {
        throw new ResumePreflightError(
          'A non-complete visit is followed by later visits',
          RESUME_PREFLIGHT_REASON.VISIT_TRACE_MISMATCH
        );
      }
      uncertain = expectedItem.value;
    }
  }

  const nextItem = iterator.next();
  const next = nextItem.done ? null : nextItem.value;
  const remaining = collectRemaining(iterator, next);
  if (uncertain) {
    remaining.blockIndexes.add(uncertain.blockIndex);
    remaining.count += 1;
  }

  return {
    boundaryKind: uncertain
      ? 'uncertain-visit'
      : next
        ? 'between-visits'
        : 'workflow-end',
    boundary: uncertain,
    next,
    remainingBlockIndexes: remaining.blockIndexes,
    remainingVisitCount: remaining.count,
  };
}

function collectProfileIds(workflow) {
  const ids = new Set();
  for (const block of workflow.blocks) {
    if (!['agentStart', 'agentSend', 'agentWait'].includes(block.type)) continue;
    const profileId = String(block.params?.profileId || '').trim();
    if (profileId && profileId !== WORKFLOW_AGENT_TARGET) ids.add(profileId);
  }
  return ids;
}

function requiredResultProducers(workflow, remainingBlockIndexes) {
  const ids = new Set();
  for (const index of remainingBlockIndexes) {
    const block = workflow.blocks[index];
    if (block?.type !== 'agentSend') continue;
    const producer = String(block.params?.handoffFrom || '').trim();
    if (producer) ids.add(producer);
  }
  return ids;
}

function classifyRuntime(workflow, run, proof, isDirectory) {
  const completed = run.blocks.filter(visit => visit.status === 'completed');
  const completedTypes = completed.map(visit => visit.blockType);
  const remainingTypes = new Set(
    [...proof.remainingBlockIndexes].map(index => workflow.blocks[index]?.type)
  );
  const reasons = [];

  let workingDirectory = workflow.defaultDirectory;
  for (const visit of completed) {
    if (visit.blockType === 'directory') {
      workingDirectory = workflow.blocks[visit.blockIndex]?.params?.path;
    }
  }
  const directoryOkay = typeof isDirectory === 'function'
    && typeof workingDirectory === 'string'
    && isDirectory(workingDirectory) === true;
  if (!directoryOkay) {
    reasons.push(RESUME_PREFLIGHT_REASON.WORKING_DIRECTORY_UNAVAILABLE);
  }

  const sessionRecipeCount = completedTypes.filter(type => type === 'agentStart').length;
  const opaqueAgent = completedTypes.filter(type => (
    type === 'agentSend' || type === 'agentWait' || type === 'agentJoin'
  )).length;
  const opaqueShell = completedTypes.filter(type => (
    type === 'command' || type === 'input' || type === 'keypress'
  )).length;
  const futureAgentUse = ['agentSend', 'agentWait', 'agentJoin']
    .some(type => remainingTypes.has(type));
  const futureShellUse = ['input', 'keypress'].some(type => remainingTypes.has(type));
  if ((opaqueAgent > 0 && futureAgentUse) || (opaqueShell > 0 && futureShellUse)) {
    reasons.push(RESUME_PREFLIGHT_REASON.RUNTIME_CHECKPOINT_REQUIRED);
  }

  let lastSend = -1;
  let lastJoin = -1;
  completed.forEach((visit, index) => {
    if (visit.blockType === 'agentSend') lastSend = index;
    if (visit.blockType === 'agentJoin') lastJoin = index;
  });
  const pendingTeamStage = lastSend > lastJoin && remainingTypes.has('agentJoin');
  if (pendingTeamStage) reasons.push(RESUME_PREFLIGHT_REASON.PENDING_TEAM_STAGE);

  return {
    reasons: unique(reasons),
    workingDirectoryReconstructed: directoryOkay,
    sessionRecipeCount,
    pendingTeamStage,
    opaqueInteractionCount: opaqueAgent + opaqueShell,
  };
}

function baselineAssurances(run) {
  const baselines = new Map();
  for (const result of run.results) {
    for (const lane of result.lanes || []) {
      if (!lane.profileId || !lane.assurance) continue;
      if (!baselines.has(lane.profileId)) baselines.set(lane.profileId, new Set());
      baselines.get(lane.profileId).add(lane.assurance);
    }
  }
  return baselines;
}

async function inspectResumeRun({
  run,
  readWorkflow,
  readResult,
  resolveProfile,
  isDirectory,
}) {
  const evidence = assessResumeEvidence(run);
  const report = emptyReport(run, evidence);

  if (evidence.state === 'not-applicable') {
    report.state = RESUME_PREFLIGHT_STATE.NOT_APPLICABLE;
    report.reasonCodes = [...evidence.reasonCodes];
    return report;
  }
  if (evidence.state === 'blocked') {
    return failReport(report, evidence.reasonCodes);
  }

  let workflow;
  try {
    workflow = await readWorkflow();
  } catch (error) {
    report.snapshot = stage(PREFLIGHT_STAGE_STATE.BLOCKED);
    const reason = error?.code === 'integrity-failed'
      ? RESUME_PREFLIGHT_REASON.SNAPSHOT_INTEGRITY_FAILED
      : RESUME_PREFLIGHT_REASON.SNAPSHOT_DECRYPTION_UNAVAILABLE;
    return failReport(report, [reason]);
  }

  let validation;
  try {
    validation = await validateCapturedWorkflow(workflow);
    report.snapshot = stage(PREFLIGHT_STAGE_STATE.VERIFIED, {
      sourceFormatVersion: validation.sourceFormatVersion,
      currentFormatVersion: validation.currentFormatVersion,
      migrated: validation.migrated,
      blockCount: validation.document.blocks.length,
    });
  } catch (error) {
    report.snapshot = stage(PREFLIGHT_STAGE_STATE.BLOCKED);
    return failReport(report, [
      error?.code || RESUME_PREFLIGHT_REASON.WORKFLOW_INVALID,
    ]);
  }

  const normalizedWorkflow = validation.document;
  let proof;
  try {
    proof = proveVisitTrace(normalizedWorkflow, run.blocks);
    report.trace = stage(
      proof.boundaryKind === 'uncertain-visit'
        ? PREFLIGHT_STAGE_STATE.REVIEW_REQUIRED
        : PREFLIGHT_STAGE_STATE.VERIFIED,
      {
        completedVisitCount: evidence.completedVisitCount,
        uncertainVisitCount: evidence.uncertainVisitCount,
        remainingVisitCount: proof.remainingVisitCount,
        boundary: redactedAddress(proof.boundary),
        next: redactedAddress(proof.next),
      }
    );
  } catch (error) {
    report.trace = stage(PREFLIGHT_STAGE_STATE.BLOCKED, {
      completedVisitCount: evidence.completedVisitCount,
      uncertainVisitCount: evidence.uncertainVisitCount,
      remainingVisitCount: null,
      boundary: null,
      next: null,
    });
    return failReport(report, [
      error?.code || RESUME_PREFLIGHT_REASON.VISIT_TRACE_MISMATCH,
    ]);
  }

  const verifiedResults = new Map();
  let resultFailureCount = 0;
  for (const result of run.results) {
    try {
      await readResult(result);
      verifiedResults.set(result.id, result);
    } catch (_error) {
      resultFailureCount += 1;
    }
  }
  const requiredProducers = requiredResultProducers(
    normalizedWorkflow,
    proof.remainingBlockIndexes
  );
  const latestByProducer = new Map();
  for (const result of run.results) latestByProducer.set(result.producerBlockId, result);
  let availableRequiredCount = 0;
  let missingRequiredCount = 0;
  let incompleteRequiredCount = 0;
  for (const producer of requiredProducers) {
    const result = latestByProducer.get(producer);
    if (!result || !verifiedResults.has(result.id)) missingRequiredCount += 1;
    else if (result.status !== 'complete') incompleteRequiredCount += 1;
    else availableRequiredCount += 1;
  }
  const resultReasons = [];
  if (resultFailureCount > 0) {
    resultReasons.push(RESUME_PREFLIGHT_REASON.RESULT_INTEGRITY_UNAVAILABLE);
  }
  if (missingRequiredCount > 0) {
    resultReasons.push(RESUME_PREFLIGHT_REASON.REQUIRED_RESULT_MISSING);
  }
  if (incompleteRequiredCount > 0) {
    resultReasons.push(RESUME_PREFLIGHT_REASON.REQUIRED_RESULT_INCOMPLETE);
  }
  report.results = stage(
    resultReasons.length
      ? PREFLIGHT_STAGE_STATE.BLOCKED
      : run.results.some(result => result.status !== 'complete')
        ? PREFLIGHT_STAGE_STATE.REVIEW_REQUIRED
        : PREFLIGHT_STAGE_STATE.VERIFIED,
    {
      verifiedCount: verifiedResults.size,
      requiredCount: requiredProducers.size,
      availableRequiredCount,
    }
  );
  if (resultReasons.length) return failReport(report, resultReasons);

  const runtime = classifyRuntime(
    normalizedWorkflow,
    run,
    proof,
    isDirectory
  );
  report.runtime = stage(
    runtime.reasons.length
      ? PREFLIGHT_STAGE_STATE.BLOCKED
      : PREFLIGHT_STAGE_STATE.VERIFIED,
    {
      workingDirectoryReconstructed: runtime.workingDirectoryReconstructed,
      sessionRecipeCount: runtime.sessionRecipeCount,
      pendingTeamStage: runtime.pendingTeamStage,
      opaqueInteractionCount: runtime.opaqueInteractionCount,
    }
  );

  const profileIds = collectProfileIds(normalizedWorkflow);
  const baselines = baselineAssurances(run);
  let resolvedCount = 0;
  let missingCount = 0;
  let assuranceChangedCount = 0;
  let baselineMissingCount = 0;
  let resolutionUnavailable = false;
  if (profileIds.size > 0 && typeof resolveProfile !== 'function') {
    resolutionUnavailable = true;
  } else {
    for (const profileId of profileIds) {
      let profile;
      try {
        profile = await resolveProfile(profileId);
      } catch (_error) {
        resolutionUnavailable = true;
        continue;
      }
      if (!profile) {
        missingCount += 1;
        continue;
      }
      resolvedCount += 1;
      const prior = baselines.get(profileId);
      if (!prior || prior.size === 0) baselineMissingCount += 1;
      else if (!prior.has(profile.assurance)) assuranceChangedCount += 1;
    }
  }
  const profileReasons = [];
  if (resolutionUnavailable) {
    profileReasons.push(RESUME_PREFLIGHT_REASON.PROFILE_RESOLUTION_UNAVAILABLE);
  }
  if (missingCount > 0) profileReasons.push(RESUME_PREFLIGHT_REASON.PROFILE_UNAVAILABLE);
  if (assuranceChangedCount > 0) {
    profileReasons.push(RESUME_PREFLIGHT_REASON.PROFILE_ASSURANCE_CHANGED);
  }
  report.profiles = stage(
    profileReasons.length
      ? PREFLIGHT_STAGE_STATE.BLOCKED
      : PREFLIGHT_STAGE_STATE.VERIFIED,
    {
      referencedCount: profileIds.size,
      resolvedCount,
      missingCount,
      assuranceChangedCount,
      baselineMissingCount,
    }
  );

  const blockers = unique([
    ...runtime.reasons,
    ...profileReasons,
  ]);
  if (blockers.length) return failReport(report, blockers);

  report.reasonCodes = unique(evidence.reasonCodes);
  if (proof.boundaryKind === 'uncertain-visit' || evidence.state === 'review-required') {
    report.state = RESUME_PREFLIGHT_STATE.DECISION_REQUIRED;
  } else if (proof.remainingVisitCount === 0) {
    report.state = RESUME_PREFLIGHT_STATE.NO_REMAINING_WORK;
  } else {
    report.state = RESUME_PREFLIGHT_STATE.BOUNDARY_VERIFIED;
  }
  return report;
}

module.exports = {
  RESUME_PREFLIGHT_VERSION,
  RESUME_PREFLIGHT_STATE,
  PREFLIGHT_STAGE_STATE,
  RESUME_PREFLIGHT_REASON,
  ResumePreflightError,
  validateCapturedWorkflow,
  controlVisitSequence,
  proveVisitTrace,
  inspectResumeRun,
};
