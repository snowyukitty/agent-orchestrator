const test = require('node:test');
const assert = require('node:assert/strict');

const {
  RESUME_PREFLIGHT_STATE,
  PREFLIGHT_STAGE_STATE,
  RESUME_PREFLIGHT_REASON,
  ResumePreflightError,
  validateCapturedWorkflow,
  controlVisitSequence,
  proveVisitTrace,
  inspectResumeRun,
} = require('../src/main/resume-preflight');

function document(blocks, overrides = {}) {
  return {
    formatVersion: 2,
    id: 'wf-resume',
    name: 'Resume contract',
    defaultDirectory: 'C:\\private\\resume-workspace',
    blocks,
    ...overrides,
  };
}

function block(id, type, params) {
  return { id, type, params };
}

function visit(address, status = 'completed') {
  return {
    visitId: `visit-${address.blockIndex}-${address.iterationPath.map(x => x.iteration).join('-') || 'root'}`,
    blockId: address.blockId,
    blockIndex: address.blockIndex,
    blockType: address.blockType,
    iterationPath: address.iterationPath,
    status,
  };
}

function interruptedRun(workflow, visits = [], results = []) {
  return {
    schemaVersion: 1,
    id: '00000000-0000-4000-8000-000000000010',
    revision: 7,
    status: 'interrupted',
    workflow: {
      id: workflow.id,
      name: workflow.name,
      formatVersion: workflow.formatVersion,
      blockCount: workflow.blocks.length,
    },
    snapshot: { storage: 'encrypted', byteLength: 100 },
    truncated: null,
    blocks: visits,
    results,
  };
}

function inspect(run, workflow, overrides = {}) {
  return inspectResumeRun({
    run,
    readWorkflow: async () => workflow,
    readResult: async () => 'verified body',
    resolveProfile: async () => ({ assurance: 'L1-routed' }),
    isDirectory: () => true,
    ...overrides,
  });
}

test('deep validation reuses the current workflow loader and migrates v1 identities', async () => {
  const current = document([
    block('blk-log', 'log', { message: 'hello' }),
  ]);
  const validated = await validateCapturedWorkflow(current);
  assert.equal(validated.sourceFormatVersion, 2);
  assert.equal(validated.currentFormatVersion, 2);
  assert.equal(validated.migrated, false);
  assert.deepEqual(validated.document, current);

  const legacy = { ...current, formatVersion: 1 };
  const migrated = await validateCapturedWorkflow(legacy);
  assert.equal(migrated.migrated, true);
  assert.equal(migrated.document.formatVersion, 2);
  assert.equal(migrated.document.blocks[0].id, 'blk-log');
});

test('future formats and identity repair fail closed', async () => {
  const future = document([], { formatVersion: 3 });
  await assert.rejects(
    validateCapturedWorkflow(future),
    error => (
      error instanceof ResumePreflightError
      && error.code === RESUME_PREFLIGHT_REASON.WORKFLOW_FORMAT_UNSUPPORTED
    )
  );

  const invalidIdentity = document([
    block('not:valid', 'log', { message: 'hello' }),
  ], { formatVersion: 1 });
  await assert.rejects(
    validateCapturedWorkflow(invalidIdentity),
    error => (
      error instanceof ResumePreflightError
      && error.code === RESUME_PREFLIGHT_REASON.WORKFLOW_IDENTITY_UNSTABLE
    )
  );
});

test('control trace reproduces nested loop visit addresses exactly', () => {
  const workflow = document([
    block('outer', 'loop', { count: 2 }),
    block('inner', 'loop', { count: 2 }),
    block('work', 'log', { message: 'inside' }),
    block('inner-end', 'loopEnd', {}),
    block('outer-end', 'loopEnd', {}),
    block('after', 'sleep', { delay: 5, unit: 'minutes' }),
  ]);
  const sequence = [...controlVisitSequence(workflow.blocks)];

  assert.deepEqual(sequence.map(item => [
    item.blockType,
    item.iterationPath.map(frame => frame.iteration),
  ]), [
    ['loop', []],
    ['loop', [1]],
    ['log', [1, 1]],
    ['loopEnd', [1, 1]],
    ['log', [1, 2]],
    ['loopEnd', [1, 2]],
    ['loopEnd', [1]],
    ['loop', [2]],
    ['log', [2, 1]],
    ['loopEnd', [2, 1]],
    ['log', [2, 2]],
    ['loopEnd', [2, 2]],
    ['loopEnd', [2]],
    ['sleep', []],
  ]);

  const proof = proveVisitTrace(workflow, sequence.slice(0, 10).map(item => visit(item)));
  assert.equal(proof.boundaryKind, 'between-visits');
  assert.equal(proof.next.blockId, 'work');
  assert.deepEqual(proof.next.iterationPath.map(frame => frame.iteration), [2, 2]);
  assert.equal(proof.remainingVisitCount, 4);
});

test('trace mismatch and visits after an uncertain outcome are rejected', () => {
  const workflow = document([
    block('one', 'log', { message: 'one' }),
    block('two', 'log', { message: 'two' }),
  ]);
  const sequence = [...controlVisitSequence(workflow.blocks)];
  const wrong = visit(sequence[0]);
  wrong.blockId = 'different';
  assert.throws(
    () => proveVisitTrace(workflow, [wrong]),
    error => error.code === RESUME_PREFLIGHT_REASON.VISIT_TRACE_MISMATCH
  );
  assert.throws(
    () => proveVisitTrace(workflow, [
      visit(sequence[0], 'interrupted'),
      visit(sequence[1]),
    ]),
    error => error.code === RESUME_PREFLIGHT_REASON.VISIT_TRACE_MISMATCH
  );
});

test('deep preflight returns a redacted verified boundary and never execution authority', async () => {
  const workflow = document([
    block('secret-first-id', 'log', { message: 'PRIVATE PROMPT BODY' }),
    block('secret-next-id', 'sleep', { delay: 5, unit: 'minutes' }),
  ]);
  const sequence = [...controlVisitSequence(workflow.blocks)];
  const run = interruptedRun(workflow, [visit(sequence[0])]);

  const report = await inspect(run, workflow);
  assert.equal(report.state, RESUME_PREFLIGHT_STATE.BOUNDARY_VERIFIED);
  assert.equal(report.executionAvailable, false);
  assert.equal(report.snapshot.state, PREFLIGHT_STAGE_STATE.VERIFIED);
  assert.equal(report.trace.state, PREFLIGHT_STAGE_STATE.VERIFIED);
  assert.equal(report.trace.next.blockIndex, 1);
  assert.equal(report.trace.next.blockType, 'sleep');
  assert.equal(report.trace.remainingVisitCount, 1);
  assert.equal(report.runtime.workingDirectoryReconstructed, true);

  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes('PRIVATE PROMPT BODY'), false);
  assert.equal(serialized.includes('private\\\\resume-workspace'), false);
  assert.equal(serialized.includes('secret-first-id'), false);
  assert.equal(serialized.includes('secret-next-id'), false);
});

test('an uncertain external-effect visit remains an explicit decision boundary', async () => {
  const workflow = document([
    block('command', 'command', { command: 'do-not-expose --secret' }),
    block('after', 'log', { message: 'after' }),
  ]);
  const sequence = [...controlVisitSequence(workflow.blocks)];
  const run = interruptedRun(workflow, [visit(sequence[0], 'interrupted')]);

  const report = await inspect(run, workflow);
  assert.equal(report.state, RESUME_PREFLIGHT_STATE.DECISION_REQUIRED);
  assert.equal(report.trace.state, PREFLIGHT_STAGE_STATE.REVIEW_REQUIRED);
  assert.equal(report.trace.boundary.blockType, 'command');
  assert.ok(report.reasonCodes.includes('visit-outcome-uncertain'));
  assert.equal(JSON.stringify(report).includes('do-not-expose'), false);
});

test('an unresolved pending team stage is blocked after snapshot and trace proof', async () => {
  const workflow = document([
    block('start', 'agentStart', { profileId: 'codex:a', settleMs: 1500 }),
    block('send', 'agentSend', {
      profileId: 'codex:a',
      text: 'PRIVATE AGENT PROMPT',
      pressEnter: true,
      expectResult: true,
      handoffFrom: '',
    }),
    block('join', 'agentJoin', {
      idleMs: 2000,
      pattern: '',
      timeoutMs: 120000,
      onIncomplete: 'stop',
      resultName: 'research',
    }),
  ]);
  const sequence = [...controlVisitSequence(workflow.blocks)];
  const run = interruptedRun(workflow, [visit(sequence[0]), visit(sequence[1])]);

  const report = await inspect(run, workflow);
  assert.equal(report.state, RESUME_PREFLIGHT_STATE.BLOCKED);
  assert.equal(report.runtime.state, PREFLIGHT_STAGE_STATE.BLOCKED);
  assert.equal(report.runtime.pendingTeamStage, true);
  assert.equal(report.runtime.sessionRecipeCount, 1);
  assert.ok(report.reasonCodes.includes(RESUME_PREFLIGHT_REASON.PENDING_TEAM_STAGE));
  assert.ok(report.reasonCodes.includes(RESUME_PREFLIGHT_REASON.RUNTIME_CHECKPOINT_REQUIRED));
  assert.equal(report.profiles.resolvedCount, 1);
  assert.equal(report.profiles.baselineMissingCount, 1);
  assert.equal(JSON.stringify(report).includes('codex:a'), false);
});

test('future handoff requires the latest complete protected result', async () => {
  const workflow = document([
    block('producer', 'agentJoin', {
      idleMs: 2000,
      pattern: '',
      timeoutMs: 120000,
      onIncomplete: 'stop',
      resultName: 'research',
    }),
    block('consumer', 'agentSend', {
      profileId: '',
      text: '',
      pressEnter: true,
      expectResult: false,
      handoffFrom: 'producer',
    }),
  ]);
  const sequence = [...controlVisitSequence(workflow.blocks)];
  const run = interruptedRun(workflow, [visit(sequence[0])]);

  const report = await inspect(run, workflow);
  assert.equal(report.state, RESUME_PREFLIGHT_STATE.BLOCKED);
  assert.equal(report.results.requiredCount, 1);
  assert.equal(report.results.availableRequiredCount, 0);
  assert.ok(report.reasonCodes.includes(RESUME_PREFLIGHT_REASON.REQUIRED_RESULT_MISSING));
});

test('profile resolution and assurance changes are main-owned blockers', async () => {
  const workflow = document([
    block('start', 'agentStart', { profileId: 'codex:a', settleMs: 1500 }),
    block('after', 'log', { message: 'after' }),
  ]);
  const run = interruptedRun(workflow, [], [{
    id: 'result-1',
    producerBlockId: 'unused',
    status: 'complete',
    storage: 'encrypted',
    lanes: [{ profileId: 'codex:a', assurance: 'L1-routed' }],
  }]);

  const missing = await inspect(run, workflow, { resolveProfile: async () => null });
  assert.ok(missing.reasonCodes.includes(RESUME_PREFLIGHT_REASON.PROFILE_UNAVAILABLE));

  const changed = await inspect(run, workflow, {
    resolveProfile: async () => ({ assurance: 'L2-env' }),
  });
  assert.ok(changed.reasonCodes.includes(RESUME_PREFLIGHT_REASON.PROFILE_ASSURANCE_CHANGED));
  assert.equal(changed.profiles.assuranceChangedCount, 1);
});
