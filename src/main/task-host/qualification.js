// Provider qualification receipts for the desktop task host.
//
// A provider adapter is admitted only after one owner-authorized live turn has
// proven, end to end, what the fixture proves with a scripted agent. The
// receipt binds that proof to the adapter's contract version and to the exact
// provider version observed. Each launch re-probes the version right before
// spawn, so a provider upgraded since qualification is refused, not trusted.
//
// The receipt holds no route alias, path, prompt, or provider output.

const path = require('path');

const { readJsonStrict, writeJsonAtomic } = require('../store');

const QUALIFICATION_SCHEMA = 1;
const QUALIFICATION_KIND = 'agent-orchestrator.task-host-qualification';
const MAX_RECEIPT_BYTES = 16 * 1024;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
const SESSION_STATES = ['unlocked', 'locked'];

/** Every axis a qualifying live turn must show, and the value it must show. */
const REQUIRED_EVIDENCE = Object.freeze({
  windowCreated: true,
  providerRead: 'echoed',
  turnComplete: 'authenticated-receipt',
  frame: 'complete',
  hostCheck: 'passed',
  checkAgreement: 'agree',
  diffComplete: true,
  ownerCheckoutClean: true,
  collectionStable: true,
});

function qualificationFile(dataDir, provider) {
  return path.join(dataDir, 'qualifications', `${provider}.json`);
}

/** Reduce a launch result to the qualification axes. */
function qualificationEvidence(result, { ownerCheckoutClean }) {
  const observed = result?.evidence?.checks?.hostObserved || [];
  const comparison = result?.evidence?.checks?.comparison || [];
  return {
    windowCreated: result?.window?.created === true,
    providerRead: result?.delivery?.providerRead ?? 'not-observed',
    turnComplete: result?.lifecycle?.turnComplete?.source ?? 'not-observed',
    frame: result?.evidence?.result?.frame ?? 'missing',
    hostCheck: observed.length > 0 && observed.every(check => check.outcome === 'passed') ? 'passed' : 'not-passed',
    checkAgreement: comparison.length > 0 && comparison.every(entry => entry.agreement === 'agree') ? 'agree' : 'not-agreed',
    diffComplete: result?.evidence?.diff?.complete === true,
    ownerCheckoutClean: ownerCheckoutClean === true,
    collectionStable: result?.collection?.stable === true,
  };
}

/** The axes that fell short, by name; empty when the turn qualifies. */
function qualificationShortfall(evidence) {
  return Object.entries(REQUIRED_EVIDENCE)
    .filter(([key, value]) => evidence?.[key] !== value)
    .map(([key]) => key);
}

/**
 * Write a receipt for a qualifying turn observed in `session` (the state at
 * admission and at completion, or `unlocked` when they differed). A locked
 * qualification of the same contract and version is kept when an unlocked
 * turn is qualified later; any other change starts the record afresh.
 */
function writeQualification(file, {
  provider, adapterContract, providerVersion, evidence, session = 'unlocked', qualifiedAt = new Date(),
}) {
  if (qualificationShortfall(evidence).length) throw new Error('evidence does not qualify');
  if (typeof providerVersion !== 'string' || !VERSION_PATTERN.test(providerVersion)) {
    throw new Error('provider version was not observed');
  }
  if (!SESSION_STATES.includes(session)) throw new Error('session state was not observed');
  const prior = readQualification(file, { provider, adapterContract });
  const sessions = new Set([session]);
  if (prior.status === 'qualified' && prior.providerVersion === providerVersion) {
    for (const state of prior.sessions) sessions.add(state);
  }
  const receipt = {
    schema: QUALIFICATION_SCHEMA,
    kind: QUALIFICATION_KIND,
    provider,
    adapterContract,
    providerVersion,
    qualifiedAt: qualifiedAt.toISOString(),
    sessions: SESSION_STATES.filter(state => sessions.has(state)),
    evidence: { ...evidence },
  };
  writeJsonAtomic(file, receipt);
  return receipt;
}

/**
 * Read a receipt for this adapter. Anything but an exact, complete receipt for
 * the current adapter contract leaves the provider unqualified.
 */
function readQualification(file, { provider, adapterContract }) {
  let receipt;
  try {
    receipt = readJsonStrict(file, { maxFileBytes: MAX_RECEIPT_BYTES });
  } catch (error) {
    return { status: error.code === 'ENOENT' ? 'absent' : 'invalid' };
  }
  if (
    receipt?.schema !== QUALIFICATION_SCHEMA || receipt.kind !== QUALIFICATION_KIND ||
    receipt.provider !== provider || typeof receipt.providerVersion !== 'string' ||
    !VERSION_PATTERN.test(receipt.providerVersion) || qualificationShortfall(receipt.evidence).length
  ) {
    return { status: 'invalid' };
  }
  if (receipt.adapterContract !== adapterContract) return { status: 'stale-contract' };
  // Receipts written before session states were recorded were unlocked turns.
  const sessions = receipt.sessions === undefined ? ['unlocked'] : receipt.sessions;
  if (!Array.isArray(sessions) || !sessions.length || sessions.some(state => !SESSION_STATES.includes(state))) {
    return { status: 'invalid' };
  }
  return {
    status: 'qualified',
    providerVersion: receipt.providerVersion,
    qualifiedAt: receipt.qualifiedAt,
    sessions: [...sessions],
    lockedSession: sessions.includes('locked'),
  };
}

module.exports = {
  QUALIFICATION_KIND,
  QUALIFICATION_SCHEMA,
  REQUIRED_EVIDENCE,
  VERSION_PATTERN,
  qualificationEvidence,
  qualificationFile,
  qualificationShortfall,
  readQualification,
  writeQualification,
};
