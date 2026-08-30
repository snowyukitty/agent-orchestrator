const assert = require('node:assert/strict');
const test = require('node:test');

const {
  expectResponseMarker,
  failOnProviderBlock,
  fragments,
  notifyContractSatisfied,
  observeExpectedResponse,
  observeProviderSignals,
  requestedAccountNumber,
} = require('../scripts/manual-verify-direct-delivery');

function signalState() {
  return {
    signalCarry: '',
    providerSignals: {
      usageLimited: false,
      authenticationRequired: false,
      trustRequired: false,
      approvalRequired: false,
      connectionFailure: false,
    },
  };
}

test('live delivery gate requires a valid explicit account ordinal', () => {
  assert.equal(requestedAccountNumber([]), 1);
  assert.equal(requestedAccountNumber(['--account-number=2']), 2);
  for (const argv of [
    ['--account-number=0'],
    ['--account-number=1.5'],
    ['--account-number=two'],
    ['--account-number=1', '--account-number=2'],
  ]) {
    assert.throws(
      () => requestedAccountNumber(argv),
      error => error?.code === 'invalid-account-number'
    );
  }
});

test('live delivery gate classifies chunked provider blockers without retaining output', () => {
  const state = signalState();
  observeProviderSignals(state, '\x1b[31mUsage limit re');
  observeProviderSignals(state, 'ached\x1b[0m');
  observeProviderSignals(state, 'Do you trust the contents of this direc');
  observeProviderSignals(state, 'tory?');

  assert.deepEqual(state.providerSignals, {
    usageLimited: true,
    authenticationRequired: false,
    trustRequired: true,
    approvalRequired: false,
    connectionFailure: false,
  });
  assert.ok(state.signalCarry.length <= 512);
});

test('live delivery gate fails closed on a recognized provider blocker', () => {
  const state = signalState();
  state.providerSignals.approvalRequired = true;
  assert.throws(
    () => failOnProviderBlock(state.providerSignals),
    error => error?.code === 'provider-approval-required'
  );
});

test('live delivery gate binds an ANSI-split response marker without echoing it in the prompt', () => {
  const state = signalState();
  const challenge = fragments('TEST');
  assert.equal(challenge.prompt.includes(challenge.responseMarker), false);

  expectResponseMarker(state, challenge.responseMarker);
  observeExpectedResponse(state, `\x1b[32m${challenge.responseMarker.slice(0, 10)}`);
  assert.equal(state.expectedResponseSeen, false);
  observeExpectedResponse(state, `${challenge.responseMarker.slice(10)}\x1b[0m`);
  assert.equal(state.expectedResponseSeen, true);
  assert.ok(state.responseCarry.length <= 512);
});

test('live delivery gate accepts only a complete notify-helper contract', () => {
  const complete = {
    notifyInvoked: true,
    notifyPipePresent: true,
    notifyTokenPresent: true,
    notifyIncarnationPresent: true,
    notifyTurnCompleteEvent: true,
  };
  assert.equal(notifyContractSatisfied(complete), true);
  assert.equal(notifyContractSatisfied({ ...complete, notifyTokenPresent: false }), false);
});
