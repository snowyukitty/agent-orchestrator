const test = require('node:test');
const assert = require('node:assert/strict');

const { ShutdownCoordinator } = require('../src/main/shutdown');

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

for (const liveCount of [0, 1, 2]) {
  test(`quit waits for the sequential drain with ${liveCount} live session(s)`, async () => {
    const killed = deferred();
    const queueDrained = deferred();
    const calls = [];
    const registry = {
      closeAdmission(reason) { calls.push(['close', reason]); },
      async killAllSequential(reason, options) {
        calls.push(['kill', reason, options]);
        await killed.promise;
        return liveCount;
      },
      async whenTerminationsComplete() {
        calls.push(['wait']);
        await queueDrained.promise;
      },
    };
    let quitRequests = 0;
    let prevented = 0;
    const coordinator = new ShutdownCoordinator({
      getRegistry: () => registry,
      cleanup: () => calls.push(['cleanup']),
      requestQuit: () => { quitRequests += 1; },
    });

    assert.equal(coordinator.handleBeforeQuit({ preventDefault: () => { prevented += 1; } }), false);
    assert.equal(prevented, 1);
    assert.equal(quitRequests, 0);
    assert.deepEqual(calls.slice(0, 3), [
      ['close', 'application shutdown'],
      ['cleanup'],
      ['kill', 'shutdown', { failOnTimeout: true }],
    ]);

    killed.resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(quitRequests, 0, 'pending termination queue must also drain');

    queueDrained.resolve();
    await coordinator.whenDrained();
    assert.equal(quitRequests, 1);
    assert.equal(coordinator.ready, true);

    // Electron's second before-quit event is the one allowed to exit.
    assert.equal(coordinator.handleBeforeQuit({ preventDefault: () => { prevented += 1; } }), true);
    assert.equal(prevented, 1);
  });
}

test('quit without a session registry still uses the two-phase gate', async () => {
  let quitRequests = 0;
  let prevented = 0;
  const coordinator = new ShutdownCoordinator({
    getRegistry: () => null,
    requestQuit: () => { quitRequests += 1; },
  });
  coordinator.handleBeforeQuit({ preventDefault: () => { prevented += 1; } });
  assert.equal(prevented, 1);
  await coordinator.whenDrained();
  assert.equal(quitRequests, 1);
});

test('a failed termination drain never allows process exit', async () => {
  const errors = [];
  let quitRequests = 0;
  const registry = {
    closeAdmission() {},
    async killAllSequential() { throw new Error('termination failed'); },
    async whenTerminationsComplete() {},
  };
  const coordinator = new ShutdownCoordinator({
    getRegistry: () => registry,
    requestQuit: () => { quitRequests += 1; },
    onError: err => errors.push(err.message),
  });

  coordinator.handleBeforeQuit({ preventDefault() {} });
  await coordinator.whenDrained();
  assert.equal(quitRequests, 0);
  assert.deepEqual(errors, ['termination failed']);
  assert.equal(coordinator.ready, false);
});
