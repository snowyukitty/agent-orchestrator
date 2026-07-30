const test = require('node:test');
const assert = require('node:assert/strict');

const {
  RendererDocumentLifecycle,
  RendererContainmentCoordinator,
  RendererContainmentError,
  RendererNavigationError,
  StaleRendererError,
  isReloadAccelerator,
} = require('../src/main/renderer-containment');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function nextTurn() {
  return new Promise(resolve => setImmediate(resolve));
}

function committedCoordinator(options) {
  const coordinator = new RendererContainmentCoordinator(options);
  coordinator.commitRenderer();
  return coordinator;
}

test('reload accelerators are recognized without blocking unrelated input', () => {
  assert.equal(isReloadAccelerator({ type: 'keyDown', key: 'F5' }), true);
  assert.equal(isReloadAccelerator({ type: 'rawKeyDown', key: 'r', control: true }), true);
  assert.equal(isReloadAccelerator({ type: 'keyDown', key: 'R', meta: true }), true);
  assert.equal(
    isReloadAccelerator({ type: 'keyDown', key: 'r', control: true, shift: true }),
    true
  );

  assert.equal(isReloadAccelerator({ type: 'keyUp', key: 'F5' }), false);
  assert.equal(isReloadAccelerator({ type: 'keyDown', key: 'r' }), false);
  assert.equal(
    isReloadAccelerator({ type: 'keyDown', key: 'r', control: true, alt: true }),
    false
  );
  assert.equal(isReloadAccelerator({ type: 'keyDown', key: 'x', control: true }), false);
});

test('document lifecycle opens only committed cross-document navigations', () => {
  const lifecycle = new RendererDocumentLifecycle();

  assert.deepEqual(lifecycle.didStartLoading({ trusted: false }), {
    block: false,
    contain: false,
    newIncident: false,
  }, 'a navigation the guard will cancel does not revoke the current document');
  assert.deepEqual(lifecycle.renderProcessGone(), {
    block: false,
    contain: false,
    newIncident: false,
  });
  assert.deepEqual(lifecycle.didStartLoading(), {
    block: true,
    contain: false,
    newIncident: false,
  }, 'initial navigation closes admission without unnecessary cleanup');
  assert.equal(lifecycle.didNavigateCommit(), true);
  assert.equal(lifecycle.didNavigateInPage(), false);

  assert.deepEqual(lifecycle.didStartLoading(), {
    block: true,
    contain: true,
    newIncident: true,
  }, 'a reload invalidates the loaded document');
  assert.deepEqual(lifecycle.renderProcessGone(), {
    block: true,
    contain: true,
    newIncident: true,
  }, 'a loading replacement is still a distinct renderer loss');
  assert.deepEqual(lifecycle.renderProcessGone(), {
    block: false,
    contain: true,
    newIncident: false,
  }, 'duplicate loss signals share the incident');

  assert.deepEqual(lifecycle.didStartLoading(), {
    block: true,
    contain: false,
    newIncident: false,
  });
  assert.equal(lifecycle.didNavigateCommit(), true);
  assert.equal(lifecycle.didNavigateCommit(), false);
});

test('cross-document start blocks old IPC, commit admits new IPC, and in-page navigation does neither', async () => {
  const lifecycle = new RendererDocumentLifecycle();
  const tokens = ['document-token-0001', 'document-token-0002'];
  const coordinator = new RendererContainmentCoordinator({
    containSessions: async () => {},
    recoverJournal: async () => {},
    randomToken: () => tokens.shift(),
  });

  assert.throws(
    () => coordinator.captureEpoch(),
    error => error instanceof RendererNavigationError
  );

  const initial = lifecycle.didStartLoading();
  coordinator.blockPrivilegedIpc();
  assert.equal(initial.contain, false);
  assert.throws(() => coordinator.captureEpoch(), RendererNavigationError);
  assert.equal(lifecycle.didNavigateCommit(), true);
  const firstEpoch = coordinator.commitRenderer();
  const firstToken = coordinator.getCommittedToken();
  assert.equal(firstToken, 'document-token-0001');
  assert.equal(coordinator.captureEpoch(), firstEpoch);
  assert.equal(coordinator.validateDocumentToken(firstToken), firstEpoch);

  const cancelledNavigation = lifecycle.didStartLoading({ trusted: false });
  assert.equal(cancelledNavigation.block, false);
  assert.equal(coordinator.captureEpoch(), firstEpoch);
  assert.equal(
    coordinator.getCommittedToken(),
    firstToken,
    'a navigation guard rejection preserves the live document token'
  );

  lifecycle.didNavigateInPage();
  assert.equal(coordinator.captureEpoch(), firstEpoch, 'same-document navigation keeps admission open');
  assert.equal(
    coordinator.getCommittedToken(),
    firstToken,
    'same-document navigation preserves the document token'
  );
  assert.equal(coordinator.validateDocumentToken(firstToken), firstEpoch);

  const reload = lifecycle.didStartLoading();
  coordinator.blockPrivilegedIpc();
  const containment = coordinator.contain(
    'renderer reload',
    { advanceEpoch: false, newIncident: reload.newIncident }
  );
  assert.throws(
    () => coordinator.captureEpoch(),
    error => error instanceof RendererNavigationError
  );
  assert.throws(
    () => coordinator.validateDocumentToken(firstToken),
    error => error instanceof StaleRendererError
  );
  await assert.rejects(
    coordinator.waitUntilSafe(firstEpoch),
    error => error instanceof StaleRendererError
  );

  assert.equal(lifecycle.didNavigateCommit(), true);
  const replacementEpoch = coordinator.commitRenderer();
  const replacementToken = coordinator.getCommittedToken();
  assert.notEqual(replacementEpoch, firstEpoch);
  assert.equal(replacementToken, 'document-token-0002');
  assert.notEqual(replacementToken, firstToken);
  assert.throws(
    () => coordinator.validateDocumentToken(firstToken),
    error => error instanceof StaleRendererError
  );
  assert.equal(
    coordinator.validateDocumentToken(replacementToken),
    replacementEpoch,
    'only the committed replacement document is admitted'
  );
  await containment;
  assert.equal(coordinator.captureEpoch(), replacementEpoch);
  assert.deepEqual(
    await coordinator.runJournal(replacementEpoch, async () => ({ admitted: true })),
    { admitted: true }
  );
});

test('renderer-loss events coalesce and replacement IPC waits for containment', async () => {
  const sessionDrain = deferred();
  const recovery = deferred();
  const calls = [];
  const coordinator = committedCoordinator({
    containSessions(reason, epoch) {
      calls.push(['sessions', reason, epoch]);
      return sessionDrain.promise;
    },
    recoverJournal(reason, epoch) {
      calls.push(['journal', reason, epoch]);
      return recovery.promise;
    },
    onStart: info => calls.push(['start', info.reason, info.epoch]),
    onComplete: info => calls.push(['complete', info.reason, info.epoch]),
  });

  const oldEpoch = coordinator.captureEpoch();
  assert.equal(oldEpoch, 0);
  assert.equal(coordinator.markRendererLoaded(), false, 'initial load has no incident');

  const first = coordinator.contain('renderer reload');
  const duplicate = coordinator.contain(
    'renderer process gone',
    { advanceEpoch: false }
  );
  assert.strictEqual(duplicate, first);
  assert.throws(() => coordinator.captureEpoch(), RendererNavigationError);
  assert.deepEqual(calls, [
    ['start', 'renderer reload', 1],
    ['sessions', 'renderer reload', 1],
  ], 'session containment is enqueued synchronously');

  await assert.rejects(
    coordinator.waitUntilSafe(oldEpoch),
    error => error instanceof StaleRendererError && error.code === 'stale-renderer'
  );

  let replacementReleased = false;
  const replacementEpoch = coordinator.commitRenderer();
  const replacementWait = coordinator.waitUntilSafe(replacementEpoch).then(() => {
    replacementReleased = true;
  });
  await nextTurn();
  assert.equal(replacementReleased, false);

  sessionDrain.resolve({ terminated: 2, pruned: 2 });
  await nextTurn();
  assert.deepEqual(calls.at(-1), ['journal', 'renderer reload', 1]);
  assert.equal(replacementReleased, false);

  recovery.resolve(['run-a']);
  const result = await first;
  await replacementWait;
  assert.deepEqual(result.sessionResult, { terminated: 2, pruned: 2 });
  assert.deepEqual(result.recoveryResult, ['run-a']);
  assert.equal(replacementReleased, true);
  assert.deepEqual(calls.at(-1), ['complete', 'renderer reload', 1]);
});

test('an initial renderer crash after commit fences preload IPC and recovers its start', async () => {
  const lifecycle = new RendererDocumentLifecycle();
  const allowSessionAdmission = deferred();
  const allowJournalWrite = deferred();
  let runStatus = null;
  let spawned = 0;
  let cleanupCount = 0;
  let recoveryCount = 0;
  const coordinator = new RendererContainmentCoordinator({
    containSessions() {
      cleanupCount += 1;
      return Promise.resolve();
    },
    recoverJournal() {
      recoveryCount += 1;
      if (runStatus === 'running') runStatus = 'interrupted';
      return Promise.resolve();
    },
  });

  const initialLoad = lifecycle.didStartLoading();
  assert.equal(initialLoad.contain, false);
  coordinator.blockPrivilegedIpc();
  assert.equal(lifecycle.didNavigateCommit(), true);
  coordinator.commitRenderer();
  const preloadEpoch = coordinator.captureEpoch();
  const delayedSession = coordinator.admitSession(preloadEpoch, {
    waitForTerminations: () => allowSessionAdmission.promise,
    create: () => {
      spawned += 1;
      return 'hidden-session';
    },
  });
  const delayedStart = coordinator.runJournal(preloadEpoch, async () => {
    await allowJournalWrite.promise;
    runStatus = 'running';
    return { id: 'hidden-run' };
  });
  await nextTurn();

  const crash = lifecycle.renderProcessGone();
  assert.deepEqual(crash, { block: true, contain: true, newIncident: true });
  coordinator.blockPrivilegedIpc();
  const containment = coordinator.contain(
    'initial renderer lost',
    { advanceEpoch: false, newIncident: crash.newIncident }
  );
  assert.throws(() => coordinator.captureEpoch(), RendererNavigationError);

  allowSessionAdmission.resolve();
  allowJournalWrite.resolve();
  await assert.rejects(delayedSession, StaleRendererError);
  await assert.rejects(delayedStart, StaleRendererError);
  await containment;

  assert.equal(spawned, 0);
  assert.equal(cleanupCount, 1);
  assert.equal(recoveryCount, 1);
  assert.equal(runStatus, 'interrupted');
});

test('a loading replacement lost after prior recovery gets a fresh cleanup sweep', async () => {
  const lifecycle = new RendererDocumentLifecycle();
  let liveSessions = 0;
  let runStatus = null;
  const sweeps = [];
  const recoveries = [];
  const coordinator = new RendererContainmentCoordinator({
    containSessions() {
      sweeps.push(liveSessions);
      liveSessions = 0;
      return Promise.resolve();
    },
    recoverJournal() {
      recoveries.push(runStatus);
      if (runStatus === 'running') runStatus = 'interrupted';
      return Promise.resolve();
    },
  });

  lifecycle.didStartLoading();
  coordinator.blockPrivilegedIpc();
  lifecycle.didNavigateCommit();
  coordinator.commitRenderer();
  const firstCrash = lifecycle.renderProcessGone();
  coordinator.blockPrivilegedIpc();
  await coordinator.contain(
    'initial renderer lost',
    { advanceEpoch: false, newIncident: firstCrash.newIncident }
  );
  assert.deepEqual(sweeps, [0]);

  lifecycle.didStartLoading();
  coordinator.blockPrivilegedIpc();
  lifecycle.didNavigateCommit();
  coordinator.commitRenderer();
  const replacementEpoch = coordinator.captureEpoch();
  await coordinator.admitSession(replacementEpoch, {
    waitForTerminations: async () => {},
    create: () => {
      liveSessions += 1;
      return 'replacement-session';
    },
  });
  await coordinator.runJournal(replacementEpoch, async () => {
    runStatus = 'running';
  });

  const replacementCrash = lifecycle.renderProcessGone();
  coordinator.blockPrivilegedIpc();
  await coordinator.contain(
    'loading replacement lost',
    { advanceEpoch: false, newIncident: replacementCrash.newIncident }
  );
  assert.throws(() => coordinator.captureEpoch(), RendererNavigationError);
  coordinator.assertCurrent(replacementEpoch + 1);
  assert.deepEqual(sweeps, [0, 1], 'the settled first incident is not reused');
  assert.deepEqual(recoveries, [null, 'running']);
  assert.equal(liveSessions, 0);
  assert.equal(runStatus, 'interrupted');
});

test('losing a loaded replacement advances its epoch while cleanup stays coalesced', async () => {
  const recovery = deferred();
  let cleanupCount = 0;
  let spawned = 0;
  let journalStarted = 0;
  const coordinator = committedCoordinator({
    containSessions() {
      cleanupCount += 1;
      return Promise.resolve();
    },
    recoverJournal() {
      return recovery.promise;
    },
  });

  const containment = coordinator.contain('first renderer lost');
  await nextTurn();
  coordinator.commitRenderer();
  const replacementEpoch = coordinator.captureEpoch();

  const delayedSpawn = coordinator.admitSession(replacementEpoch, {
    waitForTerminations: async () => {},
    create: () => {
      spawned += 1;
      return 'hidden-session';
    },
  });
  const delayedStart = coordinator.runJournal(replacementEpoch, async () => {
    journalStarted += 1;
    return { id: 'hidden-run' };
  });

  coordinator.blockPrivilegedIpc();
  const secondLoss = coordinator.contain(
    'replacement renderer lost',
    { advanceEpoch: false, newIncident: true }
  );
  assert.strictEqual(secondLoss, containment, 'cleanup work is shared');
  assert.throws(() => coordinator.captureEpoch(), RendererNavigationError);
  coordinator.assertCurrent(replacementEpoch + 1);
  assert.equal(cleanupCount, 1);

  const duplicate = coordinator.contain(
    'duplicate loss signal',
    { advanceEpoch: false, newIncident: false }
  );
  assert.strictEqual(duplicate, containment);
  coordinator.assertCurrent(replacementEpoch + 1);

  recovery.resolve([]);
  await containment;
  await assert.rejects(delayedSpawn, StaleRendererError);
  await assert.rejects(delayedStart, StaleRendererError);
  assert.equal(spawned, 0);
  assert.equal(journalStarted, 0);
});

test('an old deferred session admission cannot spawn after the kill sweep', async () => {
  const terminationWait = deferred();
  const calls = [];
  let spawned = 0;
  const coordinator = committedCoordinator({
    containSessions() {
      calls.push('kill');
      return Promise.resolve();
    },
    recoverJournal() {
      calls.push('recover');
      return Promise.resolve();
    },
  });

  const oldEpoch = coordinator.captureEpoch();
  const oldAdmission = coordinator.admitSession(oldEpoch, {
    waitForTerminations: () => {
      calls.push('wait');
      return terminationWait.promise;
    },
    create: () => {
      spawned += 1;
      return 'old-session';
    },
  });
  await nextTurn();
  assert.deepEqual(calls, ['wait']);

  const containment = coordinator.contain('renderer lost');
  await containment;
  assert.deepEqual(calls, ['wait', 'kill', 'recover']);

  terminationWait.resolve();
  await assert.rejects(
    oldAdmission,
    error => error instanceof StaleRendererError && error.code === 'stale-renderer'
  );
  assert.equal(spawned, 0);

  coordinator.commitRenderer();
  const newEpoch = coordinator.captureEpoch();
  assert.equal(await coordinator.admitSession(newEpoch, {
    waitForTerminations: async () => {},
    create: () => {
      spawned += 1;
      return 'new-session';
    },
  }), 'new-session');
  assert.equal(spawned, 1);
});

test('a stale deferred journal start is recovered before new journal IPC runs', async () => {
  const allowWrite = deferred();
  const calls = [];
  let runStatus = null;
  const coordinator = committedCoordinator({
    containSessions() {
      calls.push('kill');
      return Promise.resolve();
    },
    async recoverJournal() {
      calls.push(['recover', runStatus]);
      if (runStatus === 'running') runStatus = 'interrupted';
      return runStatus;
    },
  });

  const oldEpoch = coordinator.captureEpoch();
  const oldStart = coordinator.runJournal(oldEpoch, async () => {
    calls.push('start-entered');
    await allowWrite.promise;
    runStatus = 'running';
    calls.push('start-written');
    return { id: 'stale-run' };
  });
  await nextTurn();
  assert.deepEqual(calls, ['start-entered']);

  const containment = coordinator.contain('renderer reload');
  coordinator.commitRenderer();
  const newEpoch = coordinator.captureEpoch();
  let newStarted = false;
  const newStart = coordinator.runJournal(newEpoch, async () => {
    newStarted = true;
    runStatus = 'running';
    return { id: 'new-run' };
  });
  await nextTurn();
  assert.equal(newStarted, false, 'replacement journal IPC waits for recovery');

  allowWrite.resolve();
  await assert.rejects(
    oldStart,
    error => error instanceof StaleRendererError && error.code === 'stale-renderer'
  );
  await containment;
  assert.equal(runStatus, 'interrupted');
  assert.deepEqual(calls, [
    'start-entered',
    'kill',
    'start-written',
    ['recover', 'running'],
  ]);

  assert.deepEqual(await newStart, { id: 'new-run' });
  assert.equal(newStarted, true);
  assert.equal(runStatus, 'running');
});

for (const failingStage of ['sessions', 'journal']) {
  test(`${failingStage} containment failure permanently fails journal IPC closed`, async () => {
    const expected = new Error(`${failingStage} failed`);
    let recoveryCalls = 0;
    const coordinator = committedCoordinator({
      containSessions() {
        if (failingStage === 'sessions') return Promise.reject(expected);
        return Promise.resolve();
      },
      recoverJournal() {
        recoveryCalls += 1;
        if (failingStage === 'journal') return Promise.reject(expected);
        return Promise.resolve();
      },
    });

    const containment = coordinator.contain('renderer lost');
    await assert.rejects(containment, expected);
    coordinator.commitRenderer();
    const epoch = coordinator.captureEpoch();
    let called = false;
    await assert.rejects(
      coordinator.runJournal(epoch, async () => {
        called = true;
      }),
      error => (
        error instanceof RendererContainmentError
        && error.code === 'renderer-containment-failed'
        && error.cause === expected
      )
    );
    assert.equal(called, false);
    assert.equal(recoveryCalls, 1, 'journal recovery is attempted after session failure too');
    coordinator.markRendererLoaded();
    await assert.rejects(
      coordinator.waitUntilSafe(epoch),
      error => error instanceof RendererContainmentError
    );
  });
}
