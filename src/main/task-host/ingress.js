// Loopback-only typed ingress for the desktop task host.
//
// One JSON line in, one JSON line out, per connection. The server binds
// 127.0.0.1 on an ephemeral port and publishes the port with a random
// capability token in a user-private discovery file. It never listens on
// another interface and never returns exception text, paths, or provider
// output in an error.

const fs = require('fs');
const net = require('net');
const path = require('path');
const { randomBytes, timingSafeEqual } = require('crypto');

const { writeJsonAtomic } = require('../store');
const { parseStrictJson } = require('./strict-json');
const { MAX_REQUEST_BYTES, TaskRequestError, validateEnvelope } = require('./request');

const INGRESS_SCHEMA = 1;
const INGRESS_KIND = 'agent-orchestrator.task-ingress';
const DISCOVERY_FILE = 'ingress.json';
const MAX_MESSAGE_BYTES = MAX_REQUEST_BYTES + 32 * 1024;
const MAX_CONNECTIONS = 8;
const SOCKET_TIMEOUT_MS = 5_000;
const LOOPBACK = new Set(['127.0.0.1', '::ffff:127.0.0.1']);

function tokenMatches(expected, actual) {
  if (typeof actual !== 'string') return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(actual, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

class TaskIngress {
  constructor({ host, dir, netModule = net, log = null, token = null } = {}) {
    if (!host || typeof host.handle !== 'function') throw new TypeError('Task ingress needs a host');
    if (!dir) throw new TypeError('Task ingress needs a discovery directory');
    this._host = host;
    this._dir = dir;
    this._net = netModule;
    this._log = log || (() => {});
    this._token = token || randomBytes(32).toString('hex');
    this._server = null;
    this._sockets = new Set();
    this._port = null;
  }

  get discoveryPath() {
    return path.join(this._dir, DISCOVERY_FILE);
  }

  get port() {
    return this._port;
  }

  async start() {
    if (this._server) throw new Error('Task ingress already started');
    const server = this._net.createServer(socket => this._accept(socket));
    server.maxConnections = MAX_CONNECTIONS;
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address !== 'object' || address.address !== '127.0.0.1') {
      // Refuse to run on anything but the IPv4 loopback address.
      server.close();
      throw new Error('Task ingress did not bind to loopback');
    }
    server.on('error', error => this._log(`task ingress error (${error.code || 'error'})`));
    this._server = server;
    this._port = address.port;
    writeJsonAtomic(this.discoveryPath, {
      schema: INGRESS_SCHEMA,
      kind: INGRESS_KIND,
      host: '127.0.0.1',
      port: this._port,
      token: this._token,
      hostIncarnationId: this._host.hostIncarnationId,
      pid: process.pid,
    });
    return { port: this._port };
  }

  stop() {
    for (const socket of this._sockets) socket.destroy();
    this._sockets.clear();
    if (this._server) {
      try { this._server.close(); } catch (_error) { /* already closed */ }
      this._server = null;
    }
    // Remove the discovery file only when it still names this incarnation; a
    // newer host instance may already have replaced it.
    try {
      const current = JSON.parse(fs.readFileSync(this.discoveryPath, 'utf8'));
      if (current?.hostIncarnationId === this._host.hostIncarnationId) fs.rmSync(this.discoveryPath, { force: true });
    } catch (_error) { /* absent or unreadable: leave it */ }
  }

  _accept(socket) {
    if (!LOOPBACK.has(socket.remoteAddress) || this._sockets.size >= MAX_CONNECTIONS) {
      socket.destroy();
      return;
    }
    this._sockets.add(socket);
    socket.once('close', () => this._sockets.delete(socket));
    socket.setTimeout(SOCKET_TIMEOUT_MS, () => socket.destroy());
    const chunks = [];
    let size = 0;
    let received = false;
    let answered = false;
    const respond = (payload) => {
      if (answered) return;
      answered = true;
      received = true;
      try { socket.end(`${JSON.stringify(payload)}\n`); } catch (_error) { socket.destroy(); }
    };
    socket.on('data', (chunk) => {
      if (received) return;
      const newline = chunk.indexOf(0x0a);
      const take = newline < 0 ? chunk : chunk.subarray(0, newline);
      size += take.length;
      if (size > MAX_MESSAGE_BYTES) {
        respond({ ok: false, error: 'request-too-large' });
        return;
      }
      chunks.push(take);
      if (newline < 0) return;
      received = true;
      this._dispatch(Buffer.concat(chunks, size)).then(
        respond,
        () => respond({ ok: false, error: 'internal-error' }),
      );
    });
    socket.on('end', () => { if (!received) respond({ ok: false, error: 'incomplete-request' }); });
    socket.on('error', () => socket.destroy());
  }

  async _dispatch(bytes) {
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (_error) {
      return { ok: false, error: 'invalid-utf8' };
    }
    let envelope;
    try {
      envelope = parseStrictJson(text);
    } catch (error) {
      return { ok: false, error: error.code === 'duplicate-key' ? 'duplicate-key' : 'invalid-json' };
    }
    // Authenticate before validating anything else, so an unauthenticated
    // caller learns nothing about the request schema.
    if (!envelope || typeof envelope !== 'object' || !tokenMatches(this._token, envelope.token)) {
      return { ok: false, error: 'unauthorized' };
    }
    let command;
    try {
      command = validateEnvelope(envelope);
    } catch (error) {
      return { ok: false, error: error instanceof TaskRequestError ? error.code : 'invalid-envelope' };
    }
    return this._host.handle(command);
  }
}

/** Client side: read the discovery file and send one typed command. */
function readDiscovery(dir) {
  const raw = JSON.parse(fs.readFileSync(path.join(dir, DISCOVERY_FILE), 'utf8'));
  if (
    raw?.schema !== INGRESS_SCHEMA || raw.kind !== INGRESS_KIND || raw.host !== '127.0.0.1' ||
    !Number.isInteger(raw.port) || typeof raw.token !== 'string'
  ) {
    throw new Error('Task ingress discovery file is not valid');
  }
  return raw;
}

function sendIngressCommand(discovery, command, { netModule = net, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = netModule.connect({ host: '127.0.0.1', port: discovery.port });
    const chunks = [];
    socket.setTimeout(timeoutMs, () => { socket.destroy(); reject(new Error('Task ingress timed out')); });
    socket.on('connect', () => socket.write(`${JSON.stringify({ token: discovery.token, ...command })}\n`));
    socket.on('data', chunk => chunks.push(chunk));
    socket.on('error', reject);
    socket.on('close', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      try { resolve(JSON.parse(text)); } catch (_error) { reject(new Error('Task ingress returned no answer')); }
    });
  });
}

module.exports = {
  DISCOVERY_FILE,
  INGRESS_KIND,
  INGRESS_SCHEMA,
  MAX_CONNECTIONS,
  MAX_MESSAGE_BYTES,
  TaskIngress,
  readDiscovery,
  sendIngressCommand,
};
