// Provider-owned Codex turn-complete receipts over a process-local named pipe.
//
// The renderer never receives the pipe name or random capability token, and
// direct mode enables Codex's secret-name filter so ordinary shell tools do
// not inherit the pipe, token, or incarnation variables. The helper sends no
// prompt, output, path, or account metadata back to the app.

const net = require('net');
const { randomUUID } = require('crypto');

const MAX_MESSAGE_CHARS = 4096;
const MAX_CONNECTIONS = 16;
const MAX_TURN_RECEIPTS = 4096;
const SOCKET_TIMEOUT_MS = 2_000;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const MAX_INPUT_DIGESTS = 16;
const ENV_PIPE = 'AGENT_ORCHESTRATOR_NOTIFY_SECRET_PIPE';
const ENV_TOKEN = 'AGENT_ORCHESTRATOR_NOTIFY_SECRET_TOKEN';
const ENV_INCARNATION = 'AGENT_ORCHESTRATOR_NOTIFY_SECRET_INCARNATION';

class CodexLifecycleBroker {
  constructor({ netModule = net, uuid = randomUUID, processId = process.pid, log = null } = {}) {
    this._net = netModule;
    this._uuid = uuid;
    this._processId = processId;
    this._log = log || (() => {});
    this._pipeName = `agent-orchestrator-${processId}-${uuid()}`;
    this._pipePath = `\\\\.\\pipe\\${this._pipeName}`;
    this._server = null;
    this._started = false;
    this._registrations = new Map();
    this._sockets = new Set();
  }

  start() {
    if (this._started) return Promise.resolve(false);
    if (this._server) return this._startPromise;
    this._server = this._net.createServer(socket => this._accept(socket));
    this._startPromise = new Promise((resolve, reject) => {
      const onError = (error) => {
        this._server = null;
        reject(error);
      };
      this._server.once('error', onError);
      this._server.listen(this._pipePath, () => {
        this._server.removeListener('error', onError);
        this._server.on('error', error => this._log(`Codex lifecycle pipe failed (${error.code || 'error'})`));
        this._started = true;
        resolve(true);
      });
    });
    return this._startPromise;
  }

  stop() {
    this._registrations.clear();
    this._started = false;
    for (const socket of this._sockets) socket.destroy();
    this._sockets.clear();
    if (!this._server) return false;
    const server = this._server;
    this._server = null;
    try { server.close(); } catch (_error) { /* already closed */ }
    return true;
  }

  /**
   * @param {string} [expectedInputDigest] when set, only a receipt whose turn
   *   input includes a message with this SHA-256 counts, and only that receipt
   *   binds the thread. Others (a background or side turn in the same
   *   process) are reported to `onUncorrelated` and change nothing.
   */
  register({ sessionId, incarnationId, onEvent, expectedInputDigest = null, onUncorrelated = null }) {
    if (!this._started || !this._server) throw new Error('Codex lifecycle service is not listening');
    if (typeof onEvent !== 'function') throw new TypeError('Lifecycle registration needs an event handler');
    if (expectedInputDigest !== null && !DIGEST_PATTERN.test(expectedInputDigest)) {
      throw new TypeError('Expected input digest must be a SHA-256 hex digest');
    }
    const token = this._uuid();
    const registration = {
      sessionId,
      incarnationId,
      onEvent,
      expectedInputDigest,
      onUncorrelated: typeof onUncorrelated === 'function' ? onUncorrelated : null,
      threadDigest: null,
      turnDigests: new Set(),
      exhausted: false,
    };
    this._registrations.set(token, registration);
    let active = true;
    return {
      env: {
        [ENV_PIPE]: this._pipeName,
        [ENV_TOKEN]: token,
        [ENV_INCARNATION]: incarnationId,
      },
      release: () => {
        if (!active) return false;
        active = false;
        return this._registrations.delete(token);
      },
    };
  }

  _accept(socket) {
    if (this._sockets.size >= MAX_CONNECTIONS) {
      socket.destroy();
      return;
    }
    this._sockets.add(socket);
    socket.once('close', () => this._sockets.delete(socket));
    socket.setTimeout(SOCKET_TIMEOUT_MS, () => socket.destroy());
    socket.setEncoding('utf8');
    let buffer = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try { socket.end(); } catch (_error) { /* peer already closed */ }
    };
    socket.on('data', (chunk) => {
      if (settled) return;
      buffer += chunk;
      if (buffer.length > MAX_MESSAGE_CHARS) {
        finish();
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      this.acceptPayload(buffer.slice(0, newline));
      finish();
    });
    socket.on('error', finish);
  }

  acceptPayload(line) {
    if (typeof line !== 'string' || line.length > MAX_MESSAGE_CHARS) return false;
    let payload;
    try { payload = JSON.parse(line); } catch (_error) { return false; }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
    if (Object.keys(payload).some(key => ![
      'token',
      'incarnationId',
      'type',
      'threadDigest',
      'turnDigest',
      'inputDigests',
    ].includes(key))) return false;
    if (payload.type !== 'agent-turn-complete') return false;
    if (!DIGEST_PATTERN.test(payload.threadDigest) || !DIGEST_PATTERN.test(payload.turnDigest)) return false;
    const inputDigests = payload.inputDigests ?? [];
    if (
      !Array.isArray(inputDigests) || inputDigests.length > MAX_INPUT_DIGESTS ||
      !inputDigests.every(digest => typeof digest === 'string' && DIGEST_PATTERN.test(digest))
    ) return false;
    const registration = this._registrations.get(payload.token);
    if (!registration || registration.incarnationId !== payload.incarnationId) return false;
    if (registration.exhausted) return false;
    if (registration.expectedInputDigest && !inputDigests.includes(registration.expectedInputDigest)) {
      registration.onUncorrelated?.();
      return false;
    }
    if (registration.threadDigest && registration.threadDigest !== payload.threadDigest) return false;
    if (registration.turnDigests.has(payload.turnDigest)) return false;
    if (registration.turnDigests.size >= MAX_TURN_RECEIPTS) {
      // Never evict an old digest: accepting it again could make a delayed
      // duplicate receipt authorize a newer turn. Exhaustion stays fail-closed.
      registration.exhausted = true;
      return false;
    }
    registration.threadDigest ||= payload.threadDigest;
    registration.turnDigests.add(payload.turnDigest);
    return registration.onEvent({ type: payload.type }) === true;
  }

  get pipeName() {
    return this._pipeName;
  }
}

module.exports = {
  ENV_INCARNATION,
  ENV_PIPE,
  ENV_TOKEN,
  MAX_CONNECTIONS,
  MAX_INPUT_DIGESTS,
  MAX_MESSAGE_CHARS,
  MAX_TURN_RECEIPTS,
  SOCKET_TIMEOUT_MS,
  CodexLifecycleBroker,
};
