// The owner's per-host policy for the desktop task host
// (docs/w2b-unattended-policy.md).
//
// `policy.json` in the task-host directory is written by the owner on each
// machine. It names the machine, its profile, the enrolled Windows account,
// and whether starts requested from another machine are accepted at all. A
// request can never select or weaken a profile, and the hostname never
// implies one. Without the file the host keeps its local defaults and refuses
// every remote start.
//
// A remote start carries an authorization bound to this host and to the exact
// request digest, valid for at most a minute. Who may send it is decided by
// the transport (the owner's approved SSH route and the owner-only ingress
// token); this file decides whether this host accepts it.

const { readJsonStrict } = require('../store');

const POLICY_SCHEMA = 1;
const POLICY_KIND = 'agent-orchestrator.remote-task-policy';
const MAX_POLICY_BYTES = 16 * 1024;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Limits per machine profile; the policy file picks one, never a request. */
const PROFILES = Object.freeze({
  // Twin primary workstations: full development work.
  primary: Object.freeze({ maxActiveTasks: 2, taskTimeoutMs: 2 * HOUR_MS, maxStartsPerDay: 24 }),
  // A lower-privileged work machine.
  secondary: Object.freeze({ maxActiveTasks: 1, taskTimeoutMs: HOUR_MS, maxStartsPerDay: 12 }),
  // A weak laptop for simple work.
  light: Object.freeze({ maxActiveTasks: 1, taskTimeoutMs: 20 * 60 * 1000, maxStartsPerDay: 4 }),
});

const MAX_AUTHORIZATION_MS = 60_000;
// The controller's clock may run slightly ahead of this host's.
const MAX_CLOCK_SKEW_MS = 5_000;
const HOST_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ACCOUNT = /^[^\u0000-\u001f\\/"[\]:;|=,+*?<>@]{1,104}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const POLICY_KEYS = ['schema', 'kind', 'revision', 'hostId', 'profile', 'owner', 'remoteStarts'];
const AUTHORIZATION_KEYS = ['destination', 'requestDigest', 'issuedAt', 'expiresAt'];

const exactKeys = (value, keys) => !!value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && Object.keys(value).every(name => keys.includes(name));

/**
 * Read the policy. Returns { status: 'absent' } without a file,
 * { status: 'invalid' } for anything inexact (which also refuses remote
 * starts and applies the most conservative limits), or the policy.
 */
function readPolicy(file) {
  let raw;
  try {
    raw = readJsonStrict(file, { maxFileBytes: MAX_POLICY_BYTES });
  } catch (error) {
    return { status: error.code === 'ENOENT' ? 'absent' : 'invalid' };
  }
  if (
    !exactKeys(raw, POLICY_KEYS) || raw.schema !== POLICY_SCHEMA || raw.kind !== POLICY_KIND ||
    !Number.isSafeInteger(raw.revision) || raw.revision < 1 ||
    typeof raw.hostId !== 'string' || !HOST_ID.test(raw.hostId) ||
    !Object.hasOwn(PROFILES, raw.profile) ||
    typeof raw.owner !== 'string' || !ACCOUNT.test(raw.owner) ||
    !['enabled', 'disabled'].includes(raw.remoteStarts)
  ) {
    return { status: 'invalid' };
  }
  return {
    status: 'valid',
    revision: raw.revision,
    hostId: raw.hostId,
    profile: raw.profile,
    owner: raw.owner,
    remoteStarts: raw.remoteStarts,
    limits: PROFILES[raw.profile],
  };
}

/** The limits a policy read imposes on top of the host's defaults. */
function policyLimits(policy, defaults) {
  if (policy.status === 'valid') return { ...defaults, ...policy.limits };
  if (policy.status === 'invalid') return { ...defaults, ...PROFILES.light };
  return { ...defaults, maxStartsPerDay: PROFILES.primary.maxStartsPerDay };
}

/**
 * Check a remote start's authorization against this host's policy. Returns
 * null when admitted, or a fixed refusal code.
 */
function checkRemoteAuthorization(authorization, { policy, digest, account, now = Date.now() }) {
  if (policy.status !== 'valid' || policy.remoteStarts !== 'enabled') return 'remote-starts-disabled';
  if (
    !exactKeys(authorization, AUTHORIZATION_KEYS) ||
    typeof authorization.destination !== 'string' || !HOST_ID.test(authorization.destination) ||
    typeof authorization.requestDigest !== 'string' || !DIGEST.test(authorization.requestDigest) ||
    typeof authorization.issuedAt !== 'string' || !ISO_INSTANT.test(authorization.issuedAt) ||
    typeof authorization.expiresAt !== 'string' || !ISO_INSTANT.test(authorization.expiresAt)
  ) {
    return 'invalid-authorization';
  }
  if (authorization.destination !== policy.hostId) return 'wrong-destination';
  if (authorization.requestDigest !== digest) return 'digest-mismatch';
  const issued = Date.parse(authorization.issuedAt);
  const expires = Date.parse(authorization.expiresAt);
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued ||
    expires - issued > MAX_AUTHORIZATION_MS) {
    return 'invalid-authorization';
  }
  if (issued > now + MAX_CLOCK_SKEW_MS || now > expires) return 'authorization-expired';
  if (typeof account !== 'string' || account.toLowerCase() !== policy.owner.toLowerCase()) {
    return 'session-owner-mismatch';
  }
  return null;
}

module.exports = {
  AUTHORIZATION_KEYS,
  DAY_MS,
  MAX_AUTHORIZATION_MS,
  POLICY_KIND,
  POLICY_SCHEMA,
  PROFILES,
  checkRemoteAuthorization,
  policyLimits,
  readPolicy,
};
