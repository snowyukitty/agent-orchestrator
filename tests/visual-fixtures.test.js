const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PROMO_CAPTURE_TIME,
  VISUAL_WORKFLOW,
  createVisualUuidSource,
  seedVisualRunJournal,
} = require('../src/main/visual-fixtures');

test('visual capture clock and UUID source are deterministic and valid', () => {
  assert.equal(PROMO_CAPTURE_TIME, '2026-08-01T12:00:00.000Z');
  const nextUuid = createVisualUuidSource();
  assert.equal(nextUuid(), '00000000-0000-4000-8000-000000000001');
  assert.equal(nextUuid(), '00000000-0000-4000-8000-000000000002');
});

test('visual journal fixture creates two inert recovery boundaries', async () => {
  const calls = [];
  const journal = {
    async startRun(input) {
      calls.push(['start-run', input]);
      return { id: `run-${calls.length}` };
    },
    async startBlock(input) {
      calls.push(['start-block', input]);
    },
    async recoverInterrupted() {
      calls.push(['recover']);
      return [{}, {}];
    },
  };

  const result = await seedVisualRunJournal(journal);

  assert.deepEqual(calls.map(call => call[0]), [
    'start-run',
    'start-run',
    'start-block',
    'recover',
  ]);
  assert.equal(calls[0][1].workflow, VISUAL_WORKFLOW);
  assert.equal(calls[1][1].workflow.name, 'Resume evidence · decision required');
  assert.deepEqual(calls[2][1].block, {
    id: 'visual-command',
    index: 0,
    type: 'command',
    iterationPath: [],
  });
  assert.deepEqual(result, {
    boundaryRunId: 'run-1',
    uncertainRunId: 'run-2',
    recoveredCount: 2,
  });
});

test('visual journal fixture rejects an incomplete adapter before mutation', async () => {
  await assert.rejects(
    seedVisualRunJournal({ startRun() {} }),
    /requires a journal/
  );
});
