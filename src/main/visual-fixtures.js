// Disposable Run Journal scenarios for `npm run visual`. They exercise the
// real journal and public projection without spawning a PTY or touching the
// user's production data.

const VISUAL_WORKFLOW = Object.freeze({
  formatVersion: 1,
  id: 'visual-resume-evidence',
  name: 'Resume evidence · boundary recorded',
  defaultDirectory: '.',
  blocks: [{
    id: 'visual-command',
    type: 'command',
    params: { command: 'visual fixture — never executed' },
  }],
});

async function seedVisualRunJournal(journal) {
  if (
    !journal
    || typeof journal.startRun !== 'function'
    || typeof journal.startBlock !== 'function'
    || typeof journal.recoverInterrupted !== 'function'
  ) {
    throw new TypeError('Visual Run Journal fixture requires a journal');
  }

  const boundary = await journal.startRun({
    workflow: VISUAL_WORKFLOW,
    trigger: { kind: 'visual-test' },
    opId: 'visual-boundary-start',
  });
  const uncertain = await journal.startRun({
    workflow: {
      ...VISUAL_WORKFLOW,
      id: 'visual-resume-review',
      name: 'Resume evidence · decision required',
    },
    trigger: { kind: 'visual-test' },
    opId: 'visual-review-start',
  });
  await journal.startBlock({
    runId: uncertain.id,
    opId: 'visual-review-block-start',
    block: {
      id: 'visual-command',
      index: 0,
      type: 'command',
      iterationPath: [],
    },
  });
  const recovered = await journal.recoverInterrupted();
  return {
    boundaryRunId: boundary.id,
    uncertainRunId: uncertain.id,
    recoveredCount: recovered.length,
  };
}

module.exports = {
  VISUAL_WORKFLOW,
  seedVisualRunJournal,
};
