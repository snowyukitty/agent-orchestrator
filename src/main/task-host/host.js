// Desktop task host: one typed launch request -> one fresh provider in its
// own window and worktree -> independent evidence for review.
//
// Admission is decided synchronously and the accepted record is written
// before any asynchronous work, so a repeated start cannot create a second
// task. Nothing is ever respawned, re-adopted, or replayed after a restart.

const fs = require('fs');
const path = require('path');
const { createHash, randomBytes, randomUUID } = require('crypto');

const { SessionRegistry } = require('../sessions');
const { readJson, readJsonStrict, writeJsonAtomic, ensureDir } = require('../store');
const { createResultFrame, parseResultFrame, readResultFile, renderPromptFile } = require('./adapters');
const { compareCheckClaims, runCheck } = require('./checks');
const {
  collectDiffEvidence, createWorktree, isWorkTreeRoot, repositoryRoot, resolveCommit,
} = require('./git');
const { DAY_MS, checkRemoteAuthorization, policyLimits, readPolicy } = require('./policy');

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
// Adapter refusals that name their own reason; anything else is route-unavailable.
const ADAPTER_REFUSALS = new Set([
  'route-unavailable', 'route-policy-conflict', 'provider-version-unknown', 'provider-version-changed',
  'provider-trust-unexpressible',
]);
const MAX_RECORD_BYTES = 256 * 1024;
const MAX_LISTED_LAUNCHES = 50;
const JOB_SWEEP_MS = 2_000;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

class TaskHost {
  /**
   * @param {object} deps
   * @param {string} deps.dataDir            private task-host directory
   * @param {object} deps.pty                node-pty (or a test double)
   * @param {object} deps.lifecycleBroker    started CodexLifecycleBroker
   * @param {object} deps.adapters           { [providerId]: adapter }
   * @param {object} deps.presentation       task-window opener (see main.js)
   * @param {function} [deps.observeSession] () => 'unlocked' | 'locked' | 'not-interactive' | 'unknown', read at admission
   * @param {function} [deps.observePower]   () => 'ac' | 'battery' | 'unknown', read at admission
   * @param {function} [deps.holdAwake]      () => release function; held while any task is active
   * @param {object}   [deps.jobs]           see process-jobs.js; without it no collection is stable
   * @param {function} [deps.account]        () => the SID of the account this host runs as, or null
   * @param {function} [deps.launcherContained] () => true when a provider's launcher keeps its
   *                                           children in the task's job (not an MSIX package)
   * @param {string[]} [deps.allowUnqualified] adapter ids allowed although unqualified
   */
  constructor({
    dataDir,
    pty,
    lifecycleBroker,
    adapters,
    presentation,
    observeSession = () => 'unlocked',
    observePower = () => 'ac',
    holdAwake = null,
    jobs = null,
    account = () => null,
    launcherContained = () => false,
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
    this._observeSession = observeSession;
    this._observePower = observePower;
    this._holdAwake = holdAwake;
    this._releaseAwake = null;
    this._jobs = jobs;
    this._account = account;
    this._launcherContained = launcherContained;
    this._suspending = false;
    this._allowUnqualified = new Set(allowUnqualified);
    this._log = log || (() => {});
    this._killTree = killTree;
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
  get policyFile() { return path.join(this._dataDir, 'policy.json'); }
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
    const policy = readPolicy(this.policyFile);
    const limits = policyLimits(policy, this._limits);
    return {
      ok: true,
      schema: 1,
      hostIncarnationId: this.hostIncarnationId,
      observedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this._limits.capabilityTtlMs).toISOString(),
      admission: this._closed ? 'closed' : 'open',
      session: this._session(),
      power: this._power(),
      policy: policy.status === 'valid'
        ? { status: 'valid', revision: policy.revision, hostId: policy.hostId, profile: policy.profile, remoteStarts: policy.remoteStarts }
        : { status: policy.status, remoteStarts: 'disabled' },
      presentation: ['task-window'],
      providers: Object.values(this._adapters).map(adapter => ({
        provider: adapter.id,
        qualification: adapter.qualification,
        qualifiedVersion: adapter.qualifiedVersion ?? null,
        admitted: adapter.qualification !== 'unqualified' || this._allowUnqualified.has(adapter.id),
        lockedSession: this._lockedSessionAdmitted(adapter),
        delivery: adapter.delivery,
        lifecycle: adapter.lifecycle,
        turnStarted: 'unavailable',
        waitingForInput: 'unavailable',
      })),
      workspaces: Object.keys(this._readWorkspaces()).sort(),
      gitEffects: ['edits-only'],
      limits: {
        maxActiveTasks: limits.maxActiveTasks,
        taskTimeoutMs: limits.taskTimeoutMs,
        maxStartsPerDay: limits.maxStartsPerDay,
        startsInLastDay: this._startsSince(now - DAY_MS),
      },
    };
  }

  /**
   * Owner-registered workspaces. An entry is a checkout path, or
   * `{ path, codexProjectTrust: "allow" }` when the owner also lets a provider
   * that needs project trust (Codex) run there; that opt-in is default-deny.
   */
  _readWorkspaces() {
    const raw = readJson(this.workspacesFile, null);
    if (raw?.schema !== WORKSPACES_SCHEMA || !raw.workspaces || typeof raw.workspaces !== 'object') return {};
    const out = {};
    for (const [label, entry] of Object.entries(raw.workspaces)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(label)) continue;
      const dir = typeof entry === 'string' ? entry : entry?.path;
      if (typeof dir !== 'string' || !path.isAbsolute(dir)) continue;
      out[label] = { path: dir, projectTrust: entry?.codexProjectTrust === 'allow' };
    }
    return out;
  }

  /** Dispatch one validated ingress command. */
  async handle(command) {
    switch (command.op) {
      case 'capabilities': return this.capabilities();
      case 'start': return this.start(command.request, command.digest);
      case 'remote-start': return this.remoteStart(command.authorization, command.request, command.digest);
      case 'list': return this.list();
      case 'status': return this.status(command.launchId);
      case 'result': return this.result(command.launchId);
      case 'diff': return this.diff(command.launchId);
      case 'stop': return this.stop(command.launchId);
      case 'show': return this.show(command.launchId);
      default: return { ok: false, error: 'unknown-op' };
    }
  }

  /** The session state, read now; anything unexpected is unknown. */
  _session() {
    try {
      const state = this._observeSession();
      return ['unlocked', 'locked', 'not-interactive'].includes(state) ? state : 'unknown';
    } catch (_error) {
      return 'unknown';
    }
  }

  _power() {
    try {
      const state = this._observePower();
      return ['ac', 'battery'].includes(state) ? state : 'unknown';
    } catch (_error) {
      return 'unknown';
    }
  }

  /** A locked session admits only an adapter qualified while locked. */
  _lockedSessionAdmitted(adapter) {
    return adapter.lockedSession === true || this._allowUnqualified.has(adapter.id);
  }

  _startsSince(since) {
    let count = 0;
    for (const launch of this._launches.values()) {
      if (Date.parse(launch.record.acceptedAt) >= since) count += 1;
    }
    return count;
  }

  /**
   * A start requested from another machine. The authorization must name this
   * host and the exact request, and be fresh; a retry of an accepted launch
   * returns its observation even after expiry and never starts another task.
   */
  remoteStart(authorization, request, digest) {
    const existing = this._launches.get(request.launchId);
    if (existing) return this._duplicate(existing, digest);
    // Nobody is there to notice a provider left running: without process
    // ownership, a remote start is refused outright.
    // A launcher whose children break away from every job (Store PowerShell
    // is an MSIX package) would start the provider outside the task's job.
    let contained = false;
    try { contained = this._launcherContained() === true; } catch { contained = false; }
    if (!this._jobs || !contained) {
      return { ok: false, error: 'process-ownership-unavailable' };
    }
    const refusal = checkRemoteAuthorization(authorization, {
      policy: readPolicy(this.policyFile),
      digest,
      account: this._safeAccount(),
    });
    if (refusal) return { ok: false, error: refusal };
    return this.start(request, digest, { origin: 'remote' });
  }

  _safeAccount() {
    try { return this._account(); } catch (_error) { return null; }
  }

  _duplicate(existing, digest) {
    if (existing.record.requestDigest !== digest) return { ok: false, error: 'launch-id-conflict' };
    return { ok: true, duplicate: true, ...this._publicStatus(existing) };
  }

  /**
   * Admit or refuse synchronously. Returns an acknowledgement only; the task
   * proceeds in the background and is observed through status.
   */
  start(request, digest, { origin = 'local' } = {}) {
    const existing = this._launches.get(request.launchId);
    if (existing) return this._duplicate(existing, digest);
    const refuse = error => ({ ok: false, error });
    if (this._closed) return refuse('host-closing');
    if (this._suspending) return refuse('host-suspending');
    const power = this._power();
    if (power === 'battery') return refuse('battery-disallowed');
    if (power === 'unknown') return refuse('power-state-unknown');
    // Read from the system now, never assumed unlocked from missed events.
    const session = this._session();
    if (session === 'unknown') return refuse('session-state-unknown');
    if (session === 'not-interactive') return refuse('session-not-interactive');
    const adapter = Object.hasOwn(this._adapters, request.provider) ? this._adapters[request.provider] : null;
    if (!adapter) return refuse('provider-unavailable');
    if (adapter.qualification === 'unqualified' && !this._allowUnqualified.has(adapter.id)) {
      return refuse('provider-unqualified');
    }
    if (session === 'locked' && !this._lockedSessionAdmitted(adapter)) return refuse('provider-session-unqualified');
    const workspaces = this._readWorkspaces();
    if (!Object.hasOwn(workspaces, request.workspace)) return refuse('unknown-workspace');
    if (adapter.requiresProjectTrust && !workspaces[request.workspace].projectTrust) {
      return refuse('workspace-trust-not-granted');
    }
    const policy = readPolicy(this.policyFile);
    const limits = policyLimits(policy, this._limits);
    const active = [...this._launches.values()].filter(launch => ACTIVE_STATES.has(launch.record.state));
    if (active.some(launch => launch.record.workspace === request.workspace)) return refuse('workspace-busy');
    if (active.length >= limits.maxActiveTasks) return refuse('host-busy');
    // A runaway brake, counted from durable records: every accepted launch
    // has its record on disk before it is acknowledged.
    if (this._startsSince(Date.now() - DAY_MS) >= limits.maxStartsPerDay) return refuse('daily-limit-reached');

    const now = new Date().toISOString();
    const launch = {
      launchId: request.launchId,
      request,
      adapter,
      repo: workspaces[request.workspace].path,
      frame: createResultFrame(),
      sessionId: null,
      replay: '',
      stopRequested: false,
      settle: null,
      taskTimeoutMs: limits.taskTimeoutMs,
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
        origin,
        admission: {
          session,
          power,
          policy: policy.status === 'valid' ? { revision: policy.revision, profile: policy.profile } : { status: policy.status },
        },
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
    this._reconcileAwake();
  }

  /**
   * Keep the machine from suspending on its own while any task prepares,
   * runs, or is checked; release as soon as none is. The display may sleep,
   * and a deliberate sleep still happens.
   */
  _reconcileAwake() {
    if (!this._holdAwake) return;
    const busy = [...this._launches.values()].some(launch => ACTIVE_STATES.has(launch.record.state));
    if (busy && !this._releaseAwake) {
      try { this._releaseAwake = this._holdAwake() || (() => {}); } catch (_error) { this._releaseAwake = null; }
    } else if (!busy && this._releaseAwake) {
      const release = this._releaseAwake;
      this._releaseAwake = null;
      try { release(); } catch (_error) { /* already released */ }
    }
  }

  get awakeHeld() { return !!this._releaseAwake; }

  /** The system is about to suspend, or has resumed. */
  setSuspending(suspending) {
    this._suspending = !!suspending;
  }

  /**
   * The power source changed. Off AC, every active task is stopped and its
   * evidence collected without host checks.
   */
  powerChanged() {
    const power = this._power();
    if (power === 'ac') return 0;
    let stopped = 0;
    for (const launch of this._launches.values()) {
      if (launch.historical || !ACTIVE_STATES.has(launch.record.state)) continue;
      launch.skipChecks = power === 'battery' ? 'on-battery' : 'power-state-unknown';
      // A host check already running is ended too, not left to finish.
      launch.checkAbort?.abort();
      if (this.stop(launch.launchId, launch.skipChecks).status === 'stop-requested') stopped += 1;
    }
    return stopped;
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

    // A file-channel adapter reports into a private outbox beside the prompt.
    // The outbox is the only directory outside the worktree it may write.
    const launchDir = this._launchDir(launch.launchId);
    const fileChannel = launch.adapter.resultChannel === 'file';
    const resultDir = fileChannel ? ensureDir(path.join(launchDir, `outbox-${randomBytes(8).toString('hex')}`)) : null;
    launch.resultFile = fileChannel ? path.join(resultDir, 'result.json') : null;
    const promptFile = path.join(launchDir, 'prompt.md');
    const prompt = renderPromptFile(request, launch.frame, { resultFile: launch.resultFile });
    fs.writeFileSync(promptFile, prompt, 'utf8');
    launch.record.delivery = {
      mechanism: launch.adapter.delivery,
      resultChannel: fileChannel ? 'file' : 'pty-frame',
      promptSha256: createHash('sha256').update(prompt, 'utf8').digest('hex'),
      promptBytes: Buffer.byteLength(prompt, 'utf8'),
      handedAt: null,
      providerRead: 'not-observed',
    };

    let spec;
    try {
      const built = await launch.adapter.buildSpec({
        route: request.route,
        worktree,
        promptFile,
        resultDir,
        repositoryRoot: await repositoryRoot(launch.repo),
      });
      spec = built.spec;
      launch.record.delivery.providerVersion = built.providerVersion ?? null;
    } catch (error) {
      return fail(ADAPTER_REFUSALS.has(error?.code) ? error.code : 'route-unavailable');
    }
    if (launch.stopRequested) return fail('stopped-before-start');
    if (this._closed) return fail('host-closing');

    // The window exists before the provider does: a task never runs headless.
    this._setState(launch, 'window-open');
    try {
      const opened = await this._presentation.openTaskWindow({
        launchId: launch.launchId,
        // Neutral: no route alias and no instruction text on the desktop.
        title: `Task ${request.taskId} · ${request.provider}`,
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
    const spawnStartedAt = Date.now();
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
    // Put the provider in its own job right away: everything it starts from
    // here on is a member, however it was started.
    launch.adoption = this._jobs
      ? this._jobs.adopt(launch.launchId, created.pid, spawnStartedAt).catch(() => ({ adopted: false, reason: 'helper-error' }))
      : Promise.resolve({ adopted: false, reason: 'unavailable' });
    // A process can be created outside its parent's job (PowerShell 7 starts
    // native commands that way); bring such children in while their parents
    // are still alive to name them, not only at the boundary.
    launch.adoption.then((adoption) => {
      if (!adoption.adopted || launch.sweepDone) return;
      launch.sweep = setInterval(() => { this._jobs.escapes(launch.launchId).catch(() => {}); }, JOB_SWEEP_MS);
      launch.sweep.unref?.();
    });
    launch.exited = new Promise((resolve) => { launch.resolveExit = resolve; });
    launch.turnComplete = new Promise((resolve) => { launch.resolveTurn = resolve; });
    launch.stopped = new Promise((resolve) => { launch.resolveStop = resolve; });
    this._setState(launch, 'running');

    const capture = fileChannel ? null : this._registry.waitForOutput(sessionId, {
      afterSeq: 0,
      capture: {
        startMarker: launch.frame.startMarker,
        endMarker: launch.frame.endMarker,
        maxBytes: this._limits.maxResultBytes,
      },
      timeoutMs: launch.taskTimeoutMs,
      waitId: `task-result-${launch.launchId}`,
    });
    let deadlineTimer;
    const deadline = new Promise((resolve) => {
      deadlineTimer = setTimeout(() => resolve('deadline'), launch.taskTimeoutMs);
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

    // A printed frame normally precedes the receipt; allow a short grace,
    // then stop waiting so a missing frame is reported rather than awaited.
    let report = null;
    if (!fileChannel) {
      let captureResult = await Promise.race([capture, delay(this._limits.resultGraceMs).then(() => null)]);
      if (!captureResult) {
        this._registry.cancelWait(sessionId, `task-result-${launch.launchId}`);
        captureResult = await capture;
      }
      report = captureResult?.capture || null;
    }
    if (this._closed) return undefined;
    this._setState(launch, 'collecting', null, { ending });

    // Collection boundary: end the provider's process tree before reading
    // the report, running checks, and taking the diff, so nothing the task
    // started is still writing while the evidence is frozen. Input closes
    // with the `collecting` state.
    const adoption = await launch.adoption;
    launch.sweepDone = true;
    clearInterval(launch.sweep);
    // Bring in any member's child still outside the job, while the members
    // are alive to name it; what cannot be adopted is counted, never ended
    // by pid.
    const escapes = adoption.adopted ? await this._jobs.escapes(launch.launchId) : null;
    const atBoundary = adoption.adopted ? await this._jobs.active(launch.launchId) : null;
    const escaped = escapes ? escapes.count : null;
    const endedByHost = this._requestKill(launch, 'collect');
    const rootExited = await Promise.race([launch.exited.then(() => true), delay(10_000).then(() => false)]);
    // End every member of the provider's job, however it was started and
    // whether or not its parent is still alive, and read back what is left.
    const left = adoption.adopted ? await this._jobs.end(launch.launchId, 10_000) : null;
    // Without a job, a still-running root's tree can only be asked to end by
    // pid, which proves nothing about what it left behind.
    let treeTermination = adoption.adopted ? 'job' : 'unavailable';
    if (!adoption.adopted && !rootExited && this._killTree && launch.record.process?.rootPid) {
      try {
        this._killTree(launch.record.process.rootPid);
        treeTermination = 'requested';
      } catch (_error) {
        treeTermination = 'failed';
      }
    }
    if (adoption.adopted) await this._jobs.release(launch.launchId);
    launch.record.collection = {
      providerEndedByHost: endedByHost,
      rootExitObserved: rootExited,
      treeTermination,
      ownership: {
        job: adoption.adopted,
        ...(adoption.adopted ? { childrenAdopted: adoption.childrenAdopted } : { reason: adoption.reason }),
        aliveAtBoundary: atBoundary,
        escapedAtBoundary: escaped,
        ...(escapes?.names.length ? { escapedNames: escapes.names } : {}),
        survivors: left,
      },
      // Stable only when the root exited, nothing had left the job, and the
      // job is empty: anything else may still be writing. Qualification never
      // accepts that.
      stable: rootExited && adoption.adopted && escaped === 0 && left === 0,
      boundaryAt: new Date().toISOString(),
    };
    if (this._closed) return undefined;
    if (fileChannel) report = readResultFile(launch.resultFile, this._limits.maxResultBytes);
    const evidence = await this._collect(launch, report);
    if (this._closed) return undefined;
    this._setState(launch, 'needs-review', null, { evidence });
    return undefined;
  }

  async _collect(launch, capture) {
    const dir = this._launchDir(launch.launchId);
    const parsed = parseResultFrame(capture, launch.frame);
    // Snapshot the report once, into host-owned storage; later writes to the
    // outbox cannot change what was collected.
    const reportSha256 = capture?.complete ? createHash('sha256').update(capture.text, 'utf8').digest('hex') : null;
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

    // What the window showed, kept privately (bounded, the tail) so a review
    // after the window closes, or of a turn that went wrong, can still read it.
    fs.writeFileSync(path.join(dir, 'terminal.log'), launch.replay, 'utf8');

    const checksDir = ensureDir(path.join(dir, 'checks'));
    const observed = [];
    launch.checkAbort = new AbortController();
    for (const [index, check] of launch.request.checks.entries()) {
      if (this._closed || launch.skipChecks) break;
      observed.push(await runCheck({
        worktree: launch.worktree,
        base: launch.request.baseRevision,
        check,
        tree,
        logFile: path.join(checksDir, `${index}.log`),
        signal: launch.checkAbort.signal,
        jobs: this._jobs,
        jobKey: `${launch.launchId}.check${index}`,
      }));
    }

    return {
      collectedAt: new Date().toISOString(),
      verdict: 'needs-review',
      result: {
        frame: parsed.frame,
        nonce: parsed.nonce,
        source: 'ai-reported',
        channel: launch.resultFile ? 'file' : 'pty-frame',
        reportSha256,
        aiReported: parsed.aiReported,
      },
      checks: {
        skipped: launch.skipChecks || null,
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
    if (!launch) return;
    if (type === 'uncorrelated-turn-complete') {
      // A turn completed in the provider process, but not the task's turn.
      launch.record.lifecycle.uncorrelatedReceipts = (launch.record.lifecycle.uncorrelatedReceipts || 0) + 1;
      this._persist(launch);
      return;
    }
    if (type !== 'agent-turn-complete' || launch.record.lifecycle.turnComplete) return;
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

  stop(launchId, reason = 'requested') {
    const launch = this._launches.get(launchId);
    if (!launch || launch.historical) return launch ? { ok: true, status: 'not-running' } : { ok: false, error: 'unknown-launch' };
    const running = !!launch.sessionId && this._registry.isRunning(launch.sessionId);
    if (!running && !ACTIVE_STATES.has(launch.record.state)) return { ok: true, status: 'not-running' };
    launch.stopRequested = true;
    launch.record.stop = {
      requestedAt: new Date().toISOString(),
      reason,
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
    // Input closes when collection starts: the evidence is being frozen.
    if (launch.record.state !== 'running' || !this._registry.isRunning(launch.sessionId)) return false;
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

  /**
   * The most recent launches, newest first, as public status only: no
   * instruction, terminal content, path, or route alias.
   */
  list() {
    const launches = [...this._launches.values()]
      .sort((a, b) => Date.parse(b.record.acceptedAt) - Date.parse(a.record.acceptedAt))
      .slice(0, MAX_LISTED_LAUNCHES)
      .map(launch => ({
        ...this._publicStatus(launch),
        provider: launch.record.provider,
        workspace: launch.record.workspace,
        origin: launch.record.origin || 'local',
      }));
    return { ok: true, hostIncarnationId: this.hostIncarnationId, observedAt: new Date().toISOString(), launches };
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
      origin: r.origin || 'local',
      admission: r.admission ?? null,
      delivery: r.delivery,
      lifecycle: r.lifecycle,
      process: r.process ? { exitCode: r.process.exitCode, spawnedAt: r.process.spawnedAt, exitedAt: r.process.exitedAt, observation: r.process.observation || 'live' } : null,
      window: r.window,
      stop: r.stop,
      collection: r.collection ?? null,
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
      // A running host check is ended too; it does not outlive the host.
      launch.checkAbort?.abort();
      launch.resolveStop?.();
      launch.sweepDone = true;
      clearInterval(launch.sweep);
    }
    await this._registry.killAllSequential('task host shutdown');
    await this._registry.whenTerminationsComplete();
    this._reconcileAwake();
  }

  /** Test helper: settle every background launch. */
  async whenIdle() {
    await Promise.all([...this._launches.values()].map(launch => launch.done).filter(Boolean));
  }
}

module.exports = { ACTIVE_STATES, DEFAULT_LIMITS, TaskHost };
