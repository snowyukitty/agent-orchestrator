// Target-side adapter between a Matrix-carried remote command and the local
// loopback ingress (W2b).
//
// `scripts/task-host-client.mjs` runs on the target in the SSH logon of the
// enrolled account. It reads the owner's discovery file, connects to
// 127.0.0.1 with the locally read token, and sends one typed command. The
// desktop host, already running in the owner's interactive session, does the
// rest. Nothing here starts a provider, opens a window, or accepts a token,
// op, executable, environment, or data directory from the remote body.
//
// Every failure is a fixed code. Exception text, arguments, paths, and body
// fragments are never printed, because the controller retains this output.

const fs = require('fs');
const net = require('net');
const path = require('path');

const { parseStrictJson } = require('./strict-json');
const { taskRequestDigest, validateTaskRequest } = require('./request');
const { DISCOVERY_FILE, INGRESS_KIND, INGRESS_SCHEMA, MAX_MESSAGE_BYTES } = require('./ingress');

// The whole remote body, JSON overhead included. Matches Matrix's
// `--stdin-file` ceiling.
const MAX_REMOTE_BODY_BYTES = 128 * 1024;
const BODY_DEADLINE_MS = 5_000;
// Metadata answers (capabilities, status, list, start acknowledgements).
const MAX_ANSWER_BYTES = 64 * 1024;
const ANSWER_DEADLINE_MS = 10_000;
const MAX_LIST_LIMIT = 64;
const BODY_KEYS = ['authorization', 'digest', 'request'];
const DIGEST = /^[0-9a-f]{64}$/;
const TOKEN = /^[0-9a-f]{32,128}$/;
const INCARNATION = /^[A-Za-z0-9-]{8,64}$/;
const LAUNCH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REASON = /^[a-z0-9][a-z0-9-]{0,63}$/;

class AdapterError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

/**
 * Strict command-line grammar. Each operation has a fixed option set; a
 * repeated, unknown, or valueless option is an error before anything is read.
 */
const GRAMMAR = {
  capabilities: { values: [], flags: [] },
  list: { values: ['origin', 'limit'], flags: [] },
  'remote-start': { values: [], flags: ['stdin'], required: ['stdin'] },
  status: { values: ['launch'], flags: [], required: ['launch'] },
};

function parseRemoteArgs(argv) {
  const [op, ...rest] = argv;
  const grammar = Object.hasOwn(GRAMMAR, op || '') ? GRAMMAR[op] : null;
  if (!grammar) throw new AdapterError('unknown-op');
  const options = {};
  let dataDir = null;
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (typeof token !== 'string' || !token.startsWith('--')) throw new AdapterError('invalid-arguments');
    const name = token.slice(2);
    if (name === 'data-dir') {
      // A target-local directory pinned in the controller's private binding
      // (only when the SSH logon's APPDATA differs); never from the body.
      if (dataDir !== null || i + 1 >= rest.length) throw new AdapterError('invalid-arguments');
      dataDir = rest[i += 1];
      if (!path.isAbsolute(dataDir)) throw new AdapterError('invalid-arguments');
      continue;
    }
    if (Object.hasOwn(options, name)) throw new AdapterError('invalid-arguments');
    if (grammar.flags.includes(name)) {
      options[name] = true;
    } else if (grammar.values.includes(name)) {
      if (i + 1 >= rest.length || rest[i + 1].startsWith('--')) throw new AdapterError('invalid-arguments');
      options[name] = rest[i += 1];
    } else {
      throw new AdapterError('invalid-arguments');
    }
  }
  for (const name of grammar.required || []) {
    if (!Object.hasOwn(options, name)) throw new AdapterError('invalid-arguments');
  }
  if (op === 'status' && !LAUNCH_ID.test(options.launch)) throw new AdapterError('invalid-arguments');
  if (op === 'list') {
    if (options.origin !== undefined && !['remote', 'local'].includes(options.origin)) {
      throw new AdapterError('invalid-arguments');
    }
    if (options.limit !== undefined) {
      if (!/^[1-9][0-9]{0,2}$/.test(options.limit) || Number(options.limit) > MAX_LIST_LIMIT) {
        throw new AdapterError('invalid-arguments');
      }
      options.limit = Number(options.limit);
    }
  }
  return { op, options, dataDir };
}

/** Read the whole body to EOF within a deadline, or refuse before any ingress contact. */
function readRemoteBody(stream, { limit = MAX_REMOTE_BODY_BYTES, deadlineMs = BODY_DEADLINE_MS } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.removeAllListeners?.('data');
      stream.pause?.();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new AdapterError('body-incomplete')), deadlineMs);
    stream.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { finish(new AdapterError('body-too-large')); return; }
      chunks.push(chunk);
    });
    stream.on('end', () => finish(null, Buffer.concat(chunks, size)));
    stream.on('error', () => finish(new AdapterError('body-unreadable')));
  });
}

/**
 * Parse and check one remote-start body. Both supplied digests must equal the
 * digest of the validated request; a wrong one is refused, never replaced.
 * The authorization is passed through unchanged for the host to judge.
 */
function parseRemoteBody(bytes) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (_error) {
    throw new AdapterError('invalid-utf8');
  }
  let body;
  try {
    body = parseStrictJson(text);
  } catch (error) {
    throw new AdapterError(error.code === 'duplicate-key' ? 'duplicate-key' : 'invalid-json');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AdapterError('invalid-body');
  const keys = Object.keys(body).sort();
  if (keys.length !== BODY_KEYS.length || keys.some((key, i) => key !== BODY_KEYS[i])) {
    throw new AdapterError('invalid-body');
  }
  let request;
  try {
    request = validateTaskRequest(body.request);
  } catch (error) {
    throw new AdapterError(typeof error.code === 'string' ? error.code : 'invalid-request');
  }
  if (typeof body.digest !== 'string' || !DIGEST.test(body.digest)) throw new AdapterError('invalid-digest');
  const digest = taskRequestDigest(request);
  if (body.digest !== digest) throw new AdapterError('digest-mismatch');
  const authorization = body.authorization;
  if (!authorization || typeof authorization !== 'object' || Array.isArray(authorization)) {
    throw new AdapterError('invalid-authorization');
  }
  if (authorization.requestDigest !== digest) throw new AdapterError('digest-mismatch');
  // A fresh object with only the operation's fields; nothing from the body
  // can add a token or another key to the ingress message.
  return { op: 'remote-start', authorization, request, digest };
}

function defaultDataDir(env = process.env) {
  if (!env.APPDATA) throw new AdapterError('host-unavailable');
  return path.join(env.APPDATA, 'agent-orchestrator', 'task-host');
}

/** Read and validate the discovery file; anything unexpected is host-unavailable. */
function readDiscoveryStrict(dir, { readFile = fs.readFileSync } = {}) {
  let raw;
  try {
    raw = parseStrictJson(readFile(path.join(dir, DISCOVERY_FILE), 'utf8'));
  } catch (_error) {
    throw new AdapterError('host-unavailable');
  }
  if (
    !raw || raw.schema !== INGRESS_SCHEMA || raw.kind !== INGRESS_KIND || raw.host !== '127.0.0.1' ||
    !Number.isInteger(raw.port) || raw.port < 1 || raw.port > 65535 ||
    typeof raw.token !== 'string' || !TOKEN.test(raw.token) ||
    typeof raw.hostIncarnationId !== 'string' || !INCARNATION.test(raw.hostIncarnationId)
  ) {
    throw new AdapterError('host-unavailable');
  }
  return { port: raw.port, token: raw.token, hostIncarnationId: raw.hostIncarnationId };
}

/**
 * Send one command and read one bounded answer under an absolute deadline.
 * A failure before the command was written is `host-unavailable` (nothing was
 * asked); after it, `ingress-answer-unavailable` (the host may have acted).
 */
function sendBounded(discovery, command, {
  netModule = net, maxBytes = MAX_ANSWER_BYTES, deadlineMs = ANSWER_DEADLINE_MS,
} = {}) {
  const message = Buffer.from(`${JSON.stringify({ token: discovery.token, ...command })}\n`, 'utf8');
  if (message.length > MAX_MESSAGE_BYTES) return Promise.reject(new AdapterError('request-too-large'));
  return new Promise((resolve, reject) => {
    let written = false;
    let settled = false;
    const chunks = [];
    let size = 0;
    const socket = netModule.connect({ host: '127.0.0.1', port: discovery.port });
    const fail = () => new AdapterError(written ? 'ingress-answer-unavailable' : 'host-unavailable');
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(fail()), deadlineMs);
    socket.on('connect', () => {
      written = true;
      socket.write(message);
    });
    socket.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) { finish(new AdapterError('ingress-answer-unavailable')); return; }
      chunks.push(chunk);
    });
    socket.on('error', () => finish(fail()));
    socket.on('close', () => {
      if (settled) return;
      let answer;
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)).trim();
        answer = parseStrictJson(text);
      } catch (_error) {
        finish(fail());
        return;
      }
      if (!answer || typeof answer !== 'object' || Array.isArray(answer) || typeof answer.ok !== 'boolean') {
        finish(fail());
        return;
      }
      finish(null, answer);
    });
  });
}

/** The public phase of a host state. An unrecognized state is never guessed. */
function phaseOf(state) {
  if (state === 'accepted') return 'accepted';
  if (['preparing', 'window-open', 'spawning', 'running', 'collecting'].includes(state)) return 'running';
  if (state === 'needs-review') return 'needs-review';
  if (state === 'failed-to-start' || state === 'interrupted') return 'failed';
  return 'unknown';
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/**
 * Project the host's list into the bounded public task-list document a
 * controller view may display: no task ID, provider, route, workspace,
 * instruction, path, digest or output. Nonterminal launches come first.
 */
function projectList(answer, { origin = null, limit = MAX_LIST_LIMIT, maxBytes = MAX_ANSWER_BYTES } = {}) {
  if (!answer?.ok || !Array.isArray(answer.launches)) throw new AdapterError('ingress-answer-unavailable');
  const rows = [];
  for (const launch of answer.launches) {
    if (!launch || !LAUNCH_ID.test(launch.launchId || '')) continue;
    const launchOrigin = launch.origin === 'remote' ? 'remote' : 'local';
    if (origin && launchOrigin !== origin) continue;
    rows.push({
      launchId: launch.launchId,
      origin: launchOrigin,
      acceptedHostIncarnationId: INCARNATION.test(launch.recordIncarnationId || '') ? launch.recordIncarnationId : null,
      phase: phaseOf(launch.state),
      reasonCode: REASON.test(launch.reason || '') ? launch.reason : null,
      acceptedAt: ISO.test(launch.acceptedAt || '') ? launch.acceptedAt : null,
      updatedAt: ISO.test(launch.updatedAt || '') ? launch.updatedAt : null,
    });
  }
  const active = row => row.phase === 'accepted' || row.phase === 'running';
  const newest = (a, b) => (Date.parse(b.acceptedAt) || 0) - (Date.parse(a.acceptedAt) || 0) ||
    (a.launchId < b.launchId ? -1 : 1);
  const ordered = [...rows.filter(active).sort(newest), ...rows.filter(row => !active(row)).sort(newest)];
  const document = {
    ok: true,
    schema: 1,
    kind: 'agent-orchestrator.task-list',
    hostId: typeof answer.hostId === 'string' ? answer.hostId : null,
    hostIncarnationId: answer.hostIncarnationId,
    observedAt: answer.observedAt,
    launches: ordered.slice(0, limit),
    more: ordered.length > limit,
  };
  // Always fit the wire ceiling: drop the oldest rows and say so.
  while (Buffer.byteLength(`${JSON.stringify(document)}\n`, 'utf8') > maxBytes && document.launches.length) {
    document.launches.pop();
    document.more = true;
  }
  return document;
}

/** Run one remote-facing operation and return the document to print. */
async function runRemoteOperation(argv, {
  stdin = process.stdin, env = process.env, readFile, netModule,
} = {}) {
  const { op, options, dataDir } = parseRemoteArgs(argv);
  // The body is read and checked completely before the ingress is touched.
  const command = op === 'remote-start'
    ? parseRemoteBody(await readRemoteBody(stdin))
    : op === 'status'
      ? { op: 'status', launchId: options.launch }
      : { op };
  const discovery = readDiscoveryStrict(dataDir || defaultDataDir(env), { readFile });
  const answer = await sendBounded(discovery, command, { netModule });
  if (op === 'list') return projectList(answer, { origin: options.origin || null, limit: options.limit || MAX_LIST_LIMIT });
  return answer;
}

module.exports = {
  AdapterError,
  MAX_ANSWER_BYTES,
  MAX_LIST_LIMIT,
  MAX_REMOTE_BODY_BYTES,
  parseRemoteArgs,
  parseRemoteBody,
  phaseOf,
  projectList,
  readDiscoveryStrict,
  readRemoteBody,
  runRemoteOperation,
  sendBounded,
};
