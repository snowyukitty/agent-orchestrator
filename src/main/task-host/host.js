// Desktop task host: one typed launch request -> one fresh provider in its
// own window and worktree -> independent evidence for review.
//
// Admission is decided synchronously and the accepted record is written
// before any asynchronous work, so a repeated start cannot create a second
// task. Nothing is ever respawned, re-adopted, or replayed after a restart.

const fs = require('fs');
const path = require('path');
const { createHash, randomUUID } = require('crypto');

const { SessionRegistry } = require('../sessions');
const { readJson, readJsonStrict, writeJsonAtomic, ensureDir } = require('../store');
const { createResultFrame, parseResultFrame, renderPromptFile } = require('./adapters');
const { compareCheckClaims, runCheck } = require('./checks');
const { collectDiffEvidence, createWorktree, isWorkTreeRoot, resolveCommit } = require('./git');

const RECORD_SCHEMA = 1;
const WORKSPACES_SCHEMA = 1;
const DEFAULT_LIMITS = Object.freeze({
  maxActiveTasks: 2,
  taskTimeoutMs: 2 * 60 * 60 * 1000,
  resultGraceMs: 3_000,
  maxResultBytes: 16 * 1024,
  maxReplayChars: 256 * 1024,
  maxDiffResponseBytes: 1024 * 1024,
  capabilityTtlMs: 30_000,
});
const ACTIVE_STATES = new Set(['accepted', 'preparing', 'window-open', 'spawning', 'running', 'collecting']);
const MAX_RECORD_BYTES = 256 * 1024;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

class TaskHost {
  /**
   * @param {object} deps
   * @param {string} deps.dataDir            private task-host directory
   * @param {object} deps.pty                node-pty (or a test double)
   * @param {object} deps.lifecycleBroker    started CodexLifecycleBroker
   * @param {object} deps.adapters           { [providerId]: adapter }
   * @param {object} deps.presentation       task-window opener (see main.js)
   * @param {function} [deps.isSessionLocked] () => boolean
   * @param {string[]} [deps.allowUnqualified] adapter ids allowed although unqualified
   */
  constructor({
    dataDir,
    pty,
    lifecycleBroker,
    adapters,
    presentation,
    isSessionLocked = () => false,
    allowUnqualified = [],
    terminateTree = null,
    killTree = null,
    log = null,
    limits = {},
    uuid = randomUUID,
  } = {}) {
    if (!dataDir) throw new TypeError('Task host needs a data directory');
    if (!presentation || typeof presentation.openTaskWindow !== 'function') {
      throw new TypeError('Task host needs a task-window presentation');
    }
    this._dataDir = dataDir;
    this._adapters = adapters || {};
    this._presentation = presentation;
    this._isSessionLocked = isSessionLocked;
    this._allowUnqualified = new Set(allowUnqualified);
    this._log = log || (() => {});
    this._limits = { ...DEFAULT_LIMITS, ...limits };
    this._uuid = uuid;
    this._closed = false;
    /** launchId -> in-memory launch (active and historical) */
    this._launches = new Map();
    /** sessionId -> launchId */
    this._bySession = new Map();
    this.hostIncarnationId = uuid();
    this._registry = new SessionRegistry({
      pty,
      lifecycleBroker,
      terminateTree,
      killTree: killTree || (() => {}),
      log: message => this._log(message),
      continuationBackendId: 'task-host',
      conptyInheritCursor: false,
      onOutput: ({ id, data }) => this._onOutput(id, data),
      onExit: ({ id, code }) => this._onExit(id, code),
      onLifecycle: ({ id, type }) => this._onLifecycle(id, type),
    });
    ensureDir(this._launchesDir());
    ensureDir(this._worktreesDir());
  }

  _launchesDir() { return path.join(this._dataDir, 'launches'); }
  _worktreesDir() { return path.join(this._dataDir, 'worktrees'); }
  _launchDir(launchId) { return path.join(this._launchesDir(), launchId); }
  get workspacesFile() { return path.join(this._dataDir, 'workspaces.json'); }
  get registry() { return this._registry; }

  /** Load prior records. Unfinished ones become interrupted or uncertain. */
  recover() {
    let recovered = 0;
    for (const name of fs.existsSync(this._launchesDir()) ? fs.readdirSync(this._launchesDir()) : []) {
      const file = path.join(this._launchDir(name), 'record.json');
      let record;
      try { record = readJsonStrict(file, { maxFileBytes: MAX_RECORD_BYTES }); } catch (_error) { continue; }
      if (record?.schema !== RECORD_SCHEMA || record.launchId !== name) continue;
      if (ACTIVE_STATES.has(record.state)) {
        const spawnUncertain = record.state === 'spawning';
        const spawned = ['running', 'collecting'].includes(record.state);
        record.state = spawnUncertain ? 'uncertain' : 'interrupted';
        record.reason = spawnUncertain ? 'host-restart-during-spawn' : 'host-restart';
        if (spawnUncertain || spawned) record.process = { ...(record.process || {}), observation: 'unknown-after-restart' };
        record.updatedAt = new Date().toISOString();
        writeJsonAtomic(file, record);
        recovered += 1;
      }
      this._launches.set(name, { launchId: name, record, historical: true });
    }
    return recovered;
  }

  capabilities() {
    const now = Date.now();
    return {
      ok: true,
      schema: 1,
      hostIncarnationId: this.hostIncarnationId,
      observedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this._limits.capabilityTtlMs).toISOString(),
      admission: this._closed ? 'closed' : 'open',
      session: this._isSessionLocked() ? 'locked' : 'unlocked',
      presentation: ['task-window'],
      providers: Object.values(this._adapters).map(adapter => ({
        provider: adapter.id,
        qualification: adapter.qualification,
        admitted: adapter.qualification !== 'unqualified' || this._allowUnqualified.has(adapter.id),
        delivery: adapter.delivery,
        lifecycle: adapter.lifecycle,
        turnStarted: 'unavailable',
        waitingForInput: 'unavailable',
      })),
      workspaces: Object.keys(this._readWorkspaces()).sort(),
      gitEffects: ['edits-only'],
      limits: { maxActiveTasks: this._limits.maxActiveTasks, taskTimeoutMs: this._limits.taskTimeoutMs },
    };
  }

  _readWorkspaces() {
    const raw = readJson(this.workspacesFile, null);
    if (raw?.schema !== WORKSPACES_SCHEMA || !raw.workspaces || typeof raw.workspaces !== 'object') return {};
    const out = {};
    for (const [label, dir] of Object.entries(raw.workspaces)) {
      if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(label) && typeof dir === 'string' && path.isAbsolute(dir)) {
        out[label] = dir;
      }
    }
    return out;
  }

  /** Dispatch one validated ingress command. */
  async handle(command) {
    switch (command.op) {
      case 'capabilities': return this.capabilities();
      case 'start': return this.start(command.request, command.digest);
      case 'status': return this.status(command.launchId);
      case 'result': return this.result(command.launchId);
      case 'diff': return this.diff(command.launchId);
      case 'stop': return this.stop(command.launchId);
      case 'show': return this.show(command.launchId);
      default: return { ok: false, error: 'unknown-op' };
    }
  }

  /**
   * Admit or refuse synchronously. Returns an acknowledgement only; the task
   * proceeds in the background and is observed through status.
   */
  start(request, digest) {
    const existing = this._launches.get(request.launchId);
    if (existing) {
      if (existing.record.requestDigest !== digest) return { ok: false, error: 'launch-id-conflict' };
      return { ok: true, duplicate: true, ...this._publicStatus(existing) };
    }
    const refuse = error => ({ ok: false, error });
    if (this._closed) return refuse('host-closing');
    if (this._isSessionLocked()) return refuse('session-locked');
    const adapter = Object.hasOwn(this._adapters, request.provider) ? this._adapters[request.provider] : null;
    if (!adapter) return refuse('provider-unavailable');
    if (adapter.qualification === 'unqualified' && !this._allowUnqualified.has(adapter.id)) {
      return refuse('provider-unqualified');
    }
    const workspaces = this._readWorkspaces();
    if (!Object.hasOwn(workspaces, request.workspace)) return refuse('unknown-workspace');
    const active = [...this._launches.values()].filter(launch => ACTIVE_STATES.has(launch.record.state));
    if (active.some(launch => launch.record.workspace === request.workspace)) return refuse('workspace-busy');
    if (active.length >= this._limits.maxActiveTasks) return refuse('host-busy');

    const now = new Date().toISOString();
    const launch = {
      launchId: request.launchId,
      request,
      adapter,
      repo: workspaces[request.workspace],
      frame: createResultFrame(),
      sessionId: null,
      replay: '',
      stopRequested: false,
      settle: null,
      record: {
        schema: RECORD_SCHEMA,
        launchId: request.launchId,
        taskId: request.taskId,
        requestDigest: digest,
        hostIncarnationId: this.hostIncarnationId,
        provider: request.provider,
        route: request.route,
        workspace: request.workspace,
        baseRevision: request.baseRevision,
        checks: request.checks,
        gitEffects: request.gitEffects,
        state: 'accepted',
        reason: null,
        ending: null,
        acceptedAt: now,
        updatedAt: now,
        delivery: null,
        window: null,
        process: null,
        lifecycle: { turnComplete: null, turnStarted: 'unavailable', waitingForInput: 'unavailable' },
        stop: null,
        evidence: null,
      },
    };
    // Durable before acknowledged: a crash after this line leaves a record
    // that recovery reports as interrupted, never a silent second start.
    fs.mkdirSync(this._launchDir(request.launchId), { recursive: true });
    this._persist(launch);
    this._launches.set(request.launchId, launch);
    const ack = { ok: true, duplicate: false, ...this._publicStatus(launch) };
    launch.done = this._run(launch).catch((error) => {
      this._log(`[TaskHost] launch failed unexpectedly (${error?.code || 'error'})`);
      if (ACTIVE_STATES.has(launch.record.state)) this._setState(launch, 'interrupted', 'host-error');
    });
    return ack;
  }

  _persist(launch) {
    launch.record.updatedAt = new Date().toISOString();
    writeJsonAtomic(path.join(this._launchDir(launch.launchId), 'record.json'), launch.record);
  }

  _setState(launch, state, reason = null, patch = {}) {
    Object.assign(launch.record, patch, { state, reason });
    this._persist(launch);
    this._presentation.sendState?.(launch.launchId, this._windowState(launch));
  }

  async _run(launch) {
    const { request } = launch;
    const fail = reason => this._setState(launch, 'failed-to-start', reason);
    this._setState(launch, 'preparing');

    if (!await isWorkTreeRoot(launch.repo)) return fail('workspace-invalid');
    if (await resolveCommit(launch.repo, request.baseRevision) !== request.baseRevision) {
      return fail('base-revision-unknown');
    }
    const worktree = path.join(this._worktreesDir(), launch.launchId);
    const branch = `task/${launch.launchId.replace(/-/g, '').slice(0, 12)}`;
    try {
      await createWorktree(launch.repo, worktree, branch, request.baseRevision);
    } catch (_error) {
      return fail('worktree-failed');
    }
    launch.worktree = worktree;
    launch.record.worktreeBranch = branch;

    const promptFile = path.join(this._launchDir(launch.launchId), 'prompt.md');
    const prompt = renderPromptFile(request, launch.frame);
    fs.writeFileSync(promptFile, prompt, 'utf8');
    launch.record.delivery = {
      mechanism: launch.adapter.delivery,
      promptSha256: createHash('sha256').update(prompt, 'utf8').digest('hex'),
      promptBytes: Buffer.byteLength(prompt, 'utf8'),
      handedAt: null,
      providerRead: 'not-observed',
    };

    let spec;
    try {
      spec = await launch.adapter.buildSpec({ route: request.route, worktree, promptFile });
    } catch (_error) {
      return fail('route-unavailable');
    }
    if (launch.stopRequested) return fail('stopped-before-start');
    if (this._closed) return fail('host-closing');

    // The window exists before the provider does: a task never runs headless.
    this._setState(launch, 'window-open');
    try {
      const opened = await this._presentation.openTaskWindow({
        launchId: launch.launchId,
        title: `Task ${request.taskId} · ${request.provider}:${request.route}`,
      });
      launch.record.window = {
        created: true,
        createdAt: new Date().toISOString(),
        windowId: opened?.windowId ?? null,
        shown: opened?.shown === true,
        nativeHandle: opened?.nativeHandle === true,
        detachedCount: 0,
        reopenedCount: 0,
      };
    } catch (_error) {
      launch.record.window = { created: false };
      return fail('window-unavailable');
    }
    if (launch.stopRequested) return fail('stopped-before-start');
    if (this._closed) return fail('host-closing');

    // From here a process may exist. Record the intent first so a crash
    // between spawn and the next write is reported as uncertain.
    this._setState(launch, 'spawning', null, { spawnIntentAt: new Date().toISOString() });
    const sessionId = `task-${launch.launchId.slice(0, 8)}`;
    let created;
    try {
      created = this._registry.create(spec, { id: sessionId, cols: 120, rows: 32 });
    } catch (_error) {
      return fail('spawn-failed');
    }
    launch.sessionId = sessionId;
    this._bySession.set(sessionId, launch.launchId);
    const spawnedAt = new Date().toISOString();
    launch.record.delivery.handedAt = spawnedAt;
    launch.record.process = { rootPid: created.pid, spawnedAt, exitCode: null, exitedAt: null };
    launch.exited = new Promise((resolve) => { launch.resolveExit = resolve; });
    launch.turnComplete = new Promise((resolve) => { launch.resolveTurn = resolve; });
    launch.stopped = new Promise((resolve) => { launch.resolveStop = resolve; });
    this._setState(launch, 'running');

    const capture = this._registry.waitForOutput(sessionId, {
      afterSeq: 0,
      capture: {
        startMarker: launch.frame.startMarker,
        endMarker: launch.frame.endMarker,
        maxBytes: this._limits.maxResultBytes,
      },
      timeoutMs: this._limits.taskTimeoutMs,
      waitId: `task-result-${launch.launchId}`,
    });
    let deadlineTimer;
    const deadline = new Promise((resolve) => {
      deadlineTimer = setTimeout(() => resolve('deadline'), this._limits.taskTimeoutMs);
    });
    const ending = await Promise.race([
      launch.turnComplete.then(() => 'turn-complete'),
      launch.exited.then(() => 'process-exited'),
      launch.stopped.then(() => 'stopped'),
      deadline,
    ]);
    clearTimeout(deadlineTimer);
    if (ending === 'deadline') this._requestKill(launch, 'deadline');
    if (ending === 'stopped' || ending === 'deadline') await Promise.race([launch.exited, delay(10_000)]);

    // A result frame normally precedes the receipt; allow a short grace, then
    // stop waiting so a missing frame is reported rather than awaited.
    let captureResult = await Promise.race([capture, delay(this._limits.resultGraceMs).then(() => null)]);
    if (!captureResult) {
      this._registry.cancelWait(sessionId, `task-result-${launch.launchId}`);
      captureResult = await capture;
    }
    if (this._closed) return undefined;
    this._setState(launch, 'collecting', null, { ending });
    const evidence = await this._collect(launch, captureResult?.capture || null);
    if (this._closed) return undefined;
    this._setState(launch, 'needs-review', null, { evidence });
    return undefined;
  }

  async _collect(launch, capture) {
    const dir = this._launchDir(launch.launchId);
    const parsed = parseResultFrame(capture, launch.frame);
    if (capture?.complete) fs.writeFileSync(path.join(dir, 'result.txt'), capture.text, 'utf8');
    launch.record.delivery.providerRead = parsed.nonce;

    let tree = null;
    let diff;
    try {
      diff = await collectDiffEvidence(launch.worktree, launch.request.baseRevision, {
        patchFile: path.join(dir, 'diff.patch'),
      });
      tree = diff.tree;
    } catch (error) {
      diff = { complete: false, error: error.code || 'git-failed' };
    }

    const checksDir = ensureDir(path.join(dir, 'checks'));
    const observed = [];
    for (const [index, check] of launch.request.checks.entries()) {
      if (this._closed) break;
      observed.push(await runCheck({
        worktree: launch.worktree,
        base: launch.request.baseRevision,
        check,
        tree,
        logFile: path.join(checksDir, `${index}.log`),
      }));
    }

    return {
      collectedAt: new Date().toISOString(),
      verdict: 'needs-review',
      result: {
        frame: parsed.frame,
        nonce: parsed.nonce,
        source: 'ai-reported',
        aiReported: parsed.aiReported,
      },
      checks: {
        hostObserved: observed,
        aiClaimed: parsed.aiReported?.checks || [],
        comparison: compareCheckClaims(observed, parsed.aiReported?.checks || []),
      },
      diff,
    };
  }

  _onOutput(sessionId, data) {
    const launchId = this._bySession.get(sessionId);
    const launch = launchId && this._launches.get(launchId);
    if (!launch) return;
    launch.replay += data;
    if (launch.replay.length > this._limits.maxReplayChars) {
      launch.replay = launch.replay.slice(-this._limits.maxReplayChars);
    }
    this._presentation.sendOutput?.(launchId, data);
  }

  _onExit(sessionId, code) {
    const launchId = this._bySession.get(sessionId);
    const launch = launchId && this._launches.get(launchId);
    if (!launch) return;
    launch.record.process = { ...launch.record.process, exitCode: code ?? null, exitedAt: new Date().toISOString() };
    if (launch.record.stop) launch.record.stop.rootExitObservedAt = launch.record.process.exitedAt;
    this._persist(launch);
    this._presentation.sendState?.(launchId, this._windowState(launch));
    launch.resolveExit?.();
  }

  _onLifecycle(sessionId, type) {
    const launchId = this._bySession.get(sessionId);
    const launch = launchId && this._launches.get(launchId);
    if (!launch || type !== 'agent-turn-complete' || launch.record.lifecycle.turnComplete) return;
    launch.record.lifecycle.turnComplete = {
      observedAt: new Date().toISOString(),
      source: 'authenticated-receipt',
    };
    this._persist(launch);
    launch.resolveTurn?.();
  }

  _requestKill(launch, reason) {
    if (launch.sessionId && this._registry.isRunning(launch.sessionId)) {
      this._registry.kill(launch.sessionId, reason);
      return true;
    }
    return false;
  }

  stop(launchId) {
    const launch = this._launches.get(launchId);
    if (!launch || launch.historical) return launch ? { ok: true, status: 'not-running' } : { ok: false, error: 'unknown-launch' };
    const running = !!launch.sessionId && this._registry.isRunning(launch.sessionId);
    if (!running && !ACTIVE_STATES.has(launch.record.state)) return { ok: true, status: 'not-running' };
    launch.stopRequested = true;
    launch.record.stop = {
      requestedAt: new Date().toISOString(),
      rootExitObservedAt: null,
      effectReconciliation: 'not-performed',
    };
    this._persist(launch);
    if (running) this._requestKill(launch, 'task-stop');
    launch.resolveStop?.();
    return { ok: true, status: 'stop-requested' };
  }

  async show(launchId) {
    const launch = this._launches.get(launchId);
    if (!launch) return { ok: false, error: 'unknown-launch' };
    if (launch.historical || !launch.record.window?.created) return { ok: false, error: 'no-task-view' };
    if (this._presentation.isOpen?.(launchId)) {
      this._presentation.focus?.(launchId);
      return { ok: true, status: 'shown' };
    }
    try {
      await this._presentation.openTaskWindow({ launchId, title: `Task ${launch.record.taskId}` });
    } catch (_error) {
      return { ok: false, error: 'window-unavailable' };
    }
    launch.record.window.reopenedCount += 1;
    this._persist(launch);
    return { ok: true, status: 'reopened' };
  }

  /** The task window closed: the view detaches, the task continues. */
  windowClosed(launchId) {
    const launch = this._launches.get(launchId);
    if (!launch?.record.window?.created) return;
    launch.record.window.detachedCount += 1;
    this._persist(launch);
  }

  /** Replay and state for a (re)attached task window. No paths, no prompt. */
  windowAttach(launchId) {
    const launch = this._launches.get(launchId);
    if (!launch) return null;
    return { state: this._windowState(launch), replay: launch.replay };
  }

  /** Keystrokes typed by the person at this desktop into the task window. */
  windowInput(launchId, text) {
    const launch = this._launches.get(launchId);
    if (!launch?.sessionId || typeof text !== 'string' || text.length > 4096) return false;
    if (!this._registry.isRunning(launch.sessionId)) return false;
    return this._registry.write(launch.sessionId, text);
  }

  windowResize(launchId, cols, rows) {
    const launch = this._launches.get(launchId);
    if (!launch?.sessionId) return false;
    return this._registry.resize(launch.sessionId, cols, rows);
  }

  _windowState(launch) {
    const r = launch.record;
    return {
      launchId: launch.launchId,
      taskId: r.taskId,
      provider: r.provider,
      route: r.route,
      state: r.state,
      reason: r.reason,
      ending: r.ending,
      turnComplete: !!r.lifecycle.turnComplete,
      processRunning: !!launch.sessionId && this._registry.isRunning(launch.sessionId),
      exitCode: r.process?.exitCode ?? null,
      stopRequested: !!r.stop,
    };
  }

  _publicStatus(launch) {
    const r = launch.record;
    return {
      launchId: launch.launchId,
      taskId: r.taskId,
      hostIncarnationId: this.hostIncarnationId,
      recordIncarnationId: r.hostIncarnationId,
      state: r.state,
      reason: r.reason,
      ending: r.ending,
      acceptedAt: r.acceptedAt,
      updatedAt: r.updatedAt,
      observedAt: new Date().toISOString(),
      window: r.window ? { created: !!r.window.created, open: !!this._presentation.isOpen?.(launch.launchId) } : null,
      process: r.process
        ? {
          running: !launch.historical && !!launch.sessionId && this._registry.isRunning(launch.sessionId),
          exited: r.process.exitedAt !== null && r.process.exitedAt !== undefined,
          observation: r.process.observation || 'live',
        }
        : null,
      turnComplete: !!r.lifecycle?.turnComplete,
    };
  }

  status(launchId) {
    const launch = this._launches.get(launchId);
    return launch ? { ok: true, ...this._publicStatus(launch) } : { ok: false, error: 'unknown-launch' };
  }

  result(launchId) {
    const launch = this._launches.get(launchId);
    if (!launch) return { ok: false, error: 'unknown-launch' };
    const r = launch.record;
    return {
      ok: true,
      ...this._publicStatus(launch),
      delivery: r.delivery,
      lifecycle: r.lifecycle,
      process: r.process ? { exitCode: r.process.exitCode, spawnedAt: r.process.spawnedAt, exitedAt: r.process.exitedAt, observation: r.process.observation || 'live' } : null,
      window: r.window,
      stop: r.stop,
      evidence: r.evidence,
    };
  }

  diff(launchId) {
    const launch = this._launches.get(launchId);
    if (!launch) return { ok: false, error: 'unknown-launch' };
    const diff = launch.record.evidence?.diff;
    if (!diff?.patchSha256) return { ok: false, error: 'diff-unavailable' };
    if (diff.patchBytes > this._limits.maxDiffResponseBytes) return { ok: false, error: 'diff-too-large' };
    const patch = fs.readFileSync(path.join(this._launchDir(launchId), 'diff.patch'));
    if (createHash('sha256').update(patch).digest('hex') !== diff.patchSha256) return { ok: false, error: 'diff-changed' };
    return { ok: true, launchId, patchSha256: diff.patchSha256, patchBase64: patch.toString('base64') };
  }

  /**
   * Close admission, mark every active task interrupted, then drain PTYs.
   * Tasks do not survive the host.
   */
  async shutdown() {
    this._closed = true;
    this._registry.closeAdmission('task host shutdown');
    for (const launch of this._launches.values()) {
      if (!launch.historical && ACTIVE_STATES.has(launch.record.state)) {
        this._setState(launch, 'interrupted', 'host-quit');
      }
      launch.resolveStop?.();
    }
    await this._registry.killAllSequential('task host shutdown');
    await this._registry.whenTerminationsComplete();
  }

  /** Test helper: settle every background launch. */
  async whenIdle() {
    await Promise.all([...this._launches.values()].map(launch => launch.done).filter(Boolean));
  }
}

module.exports = { ACTIVE_STATES, DEFAULT_LIMITS, TaskHost };
