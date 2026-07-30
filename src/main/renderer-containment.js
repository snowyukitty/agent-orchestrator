// ============================================================
// Renderer-loss containment
//
// A renderer owns workflow sequencing, while PTYs and the Run Journal live in
// the main process. If that renderer reloads or crashes, its in-flight IPC must
// not create a session or a running journal entry after cleanup has passed it.
// This coordinator supplies:
//   - a renderer generation fence for stale IPC;
//   - one coalesced containment promise per renderer-loss incident;
//   - a serialized journal lane shared by IPC and interrupted-run recovery.
// ============================================================
const crypto = require('node:crypto');

class StaleRendererError extends Error {
  constructor() {
    super('Request belongs to a renderer that is no longer active');
    this.name = 'StaleRendererError';
    this.code = 'stale-renderer';
  }
}

class RendererContainmentError extends Error {
  constructor(cause = null) {
    super('Renderer recovery did not complete; restart the app before continuing');
    this.name = 'RendererContainmentError';
    this.code = 'renderer-containment-failed';
    if (cause) this.cause = cause;
  }
}

class RendererNavigationError extends Error {
  constructor() {
    super('Renderer navigation is not committed yet');
    this.name = 'RendererNavigationError';
    this.code = 'renderer-navigation-pending';
  }
}

function isReloadAccelerator(input) {
  if (!input || (input.type !== 'keyDown' && input.type !== 'rawKeyDown')) {
    return false;
  }
  const key = typeof input.key === 'string' ? input.key.toLowerCase() : '';
  if (key === 'f5') return true;
  if (key !== 'r' || input.alt) return false;
  return input.control === true || input.meta === true;
}

/**
 * Track ownership of the current top-level renderer document.
 *
 * did-start-navigation closes privileged IPC admission. Only did-frame-navigate,
 * which means Chromium committed a new main-frame document, opens that
 * generation. Same-document navigation never rotates state.
 */
class RendererDocumentLifecycle {
  constructor() {
    this._state = 'none';
  }

  didStartLoading({ trusted = true } = {}) {
    if (!trusted) {
      return {
        block: false,
        contain: false,
        newIncident: false,
      };
    }
    const prior = this._state;
    this._state = 'loading';
    const replacingOwnedDocument = prior === 'committed' || prior === 'loading';
    return {
      block: true,
      contain: replacingOwnedDocument,
      newIncident: replacingOwnedDocument,
    };
  }

  didNavigateCommit() {
    if (this._state !== 'loading') return false;
    this._state = 'committed';
    return true;
  }

  didNavigateInPage() {
    return false;
  }

  renderProcessGone() {
    if (this._state === 'none') {
      return { block: false, contain: false, newIncident: false };
    }
    if (this._state === 'lost') {
      return { block: false, contain: true, newIncident: false };
    }
    this._state = 'lost';
    return { block: true, contain: true, newIncident: true };
  }
}

class RendererContainmentCoordinator {
  constructor({
    containSessions,
    recoverJournal,
    onStart = null,
    onComplete = null,
    onError = null,
    randomToken = () => crypto.randomBytes(32).toString('base64url'),
  } = {}) {
    if (typeof containSessions !== 'function') {
      throw new TypeError('containSessions must be a function');
    }
    if (typeof recoverJournal !== 'function') {
      throw new TypeError('recoverJournal must be a function');
    }
    for (const [name, callback] of Object.entries({ onStart, onComplete, onError })) {
      if (callback !== null && typeof callback !== 'function') {
        throw new TypeError(`${name} must be a function or null`);
      }
    }
    if (typeof randomToken !== 'function') {
      throw new TypeError('randomToken must be a function');
    }
    this._containSessions = containSessions;
    this._recoverJournal = recoverJournal;
    this._onStart = onStart;
    this._onComplete = onComplete;
    this._onError = onError;
    this._randomToken = randomToken;

    this._epoch = 0;
    this._admissionOpen = false;
    this._documentToken = null;
    this._issuedTokens = new Set();
    this._incident = null;
    this._failure = null;
    this._journalQueue = Promise.resolve();
  }

  captureEpoch() {
    return this.requireCommittedEpoch();
  }

  _advanceEpoch() {
    this._epoch += 1;
    return this._epoch;
  }

  blockPrivilegedIpc() {
    this._admissionOpen = false;
    this._documentToken = null;
    return this._advanceEpoch();
  }

  commitRenderer() {
    this._admissionOpen = true;
    this._documentToken = this._mintDocumentToken();
    this.markRendererLoaded();
    return this._epoch;
  }

  _mintDocumentToken() {
    for (let attempt = 0; attempt < 16; attempt++) {
      const token = this._randomToken();
      if (typeof token !== 'string' || token.length < 16 || token.length > 256) {
        throw new TypeError('Renderer document token source returned an invalid token');
      }
      if (this._issuedTokens.has(token)) continue;
      this._issuedTokens.add(token);
      return token;
    }
    throw new Error('Could not allocate a unique renderer document token');
  }

  getCommittedToken() {
    return this._admissionOpen ? this._documentToken : null;
  }

  validateDocumentToken(token) {
    if (
      typeof token !== 'string'
      || this._documentToken === null
      || token !== this._documentToken
    ) {
      throw new StaleRendererError();
    }
    return this.requireCommittedEpoch();
  }

  requireCommittedEpoch() {
    if (!this._admissionOpen) throw new RendererNavigationError();
    return this._epoch;
  }

  assertCurrent(epoch) {
    if (!Number.isSafeInteger(epoch) || epoch < 0 || epoch !== this._epoch) {
      throw new StaleRendererError();
    }
  }

  _assertHealthy() {
    if (this._failure) throw new RendererContainmentError(this._failure);
  }

  _notify(callback, value) {
    if (!callback) return;
    try {
      callback(value);
    } catch (_error) {
      // Diagnostic hooks must never change the containment outcome.
    }
  }

  _enqueueJournal(task) {
    const queued = this._journalQueue.then(task, task);
    this._journalQueue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  /**
   * Begin one renderer-loss incident.
   *
   * containSessions is invoked before this method returns, so a sequential
   * termination is enqueued in the same event turn that advances the epoch.
   */
  contain(
    reason = 'renderer lost',
    { advanceEpoch = true, newIncident = advanceEpoch } = {}
  ) {
    if (this._incident) {
      if (newIncident && this._incident.settled && !this._failure) {
        // A replacement document may begin issuing IPC after the prior cleanup
        // settles but before its load finishes. Losing that document is a new
        // incident and needs a fresh kill/recovery sweep.
        this._incident = null;
        return this.contain(reason, { advanceEpoch, newIncident: true });
      }
      if (newIncident) this._incident.replacementLoaded = false;
      if (advanceEpoch) {
        this._admissionOpen = false;
        this._documentToken = null;
        this._advanceEpoch();
        // A replacement renderer was observed and then lost before the shared
        // cleanup settled. Its IPC belongs to the superseded epoch even though
        // another kill/recovery sweep is unnecessary.
      }
      return this._incident.promise;
    }
    if (this._failure) {
      return Promise.reject(new RendererContainmentError(this._failure));
    }

    if (advanceEpoch) {
      this._admissionOpen = false;
      this._documentToken = null;
    }
    const epoch = advanceEpoch ? this._advanceEpoch() : this._epoch;
    let resolveIncident;
    let rejectIncident;
    const promise = new Promise((resolve, reject) => {
      resolveIncident = resolve;
      rejectIncident = reject;
    });
    const incident = {
      epoch,
      reason,
      promise,
      replacementLoaded: false,
      settled: false,
    };
    this._incident = incident;
    this._notify(this._onStart, { epoch, reason });

    let sessionDrain;
    try {
      sessionDrain = this._containSessions(reason, epoch);
    } catch (error) {
      sessionDrain = Promise.reject(error);
    }

    Promise.resolve(sessionDrain)
      .then(
        sessionResult => ({ sessionResult, sessionError: null }),
        sessionError => ({ sessionResult: null, sessionError })
      )
      .then(async ({ sessionResult, sessionError }) => {
        let recoveryResult = null;
        let recoveryError = null;
        try {
          recoveryResult = await this._enqueueJournal(
            () => this._recoverJournal(reason, epoch)
          );
        } catch (error) {
          recoveryError = error;
        }
        if (sessionError && recoveryError) {
          const combined = new AggregateError(
            [sessionError, recoveryError],
            'Session cleanup and Run Journal recovery both failed'
          );
          combined.code = 'containment-failures';
          throw combined;
        }
        if (sessionError) throw sessionError;
        if (recoveryError) throw recoveryError;
        return { epoch, reason, sessionResult, recoveryResult };
      })
      .then(
        (result) => {
          incident.settled = true;
          this._notify(this._onComplete, result);
          resolveIncident(result);
          if (incident.replacementLoaded && this._incident === incident) {
            this._incident = null;
          }
        },
        (error) => {
          incident.settled = true;
          this._failure = error;
          this._notify(this._onError, { epoch, reason, error });
          rejectIncident(error);
        }
      );

    return promise;
  }

  /**
   * Mark the replacement renderer ready. The incident remains visible until
   * containment settles, so early IPC from that renderer still waits.
   */
  markRendererLoaded() {
    const incident = this._incident;
    if (!incident) return false;
    incident.replacementLoaded = true;
    if (incident.settled && !this._failure && this._incident === incident) {
      this._incident = null;
    }
    return true;
  }

  async waitUntilSafe(epoch) {
    this.assertCurrent(epoch);
    this._assertHealthy();
    const incident = this._incident;
    if (incident) {
      try {
        await incident.promise;
      } catch (_error) {
        throw new RendererContainmentError(this._failure);
      }
    }
    this._assertHealthy();
    this.assertCurrent(epoch);
  }

  /**
   * Admit a synchronous session creation only after both renderer containment
   * and every queued ConPTY termination have drained.
   */
  async admitSession(epoch, { waitForTerminations, create } = {}) {
    if (typeof waitForTerminations !== 'function' || typeof create !== 'function') {
      throw new TypeError('Session admission requires waitForTerminations and create functions');
    }
    await this.waitUntilSafe(epoch);
    await waitForTerminations();
    // No event can interleave between this fence and a synchronous create().
    this.assertCurrent(epoch);
    this._assertHealthy();
    return create();
  }

  /**
   * Serialize journal IPC with renderer-loss recovery. An old operation already
   * encrypting at loss time is allowed to finish its atomic write, then fails
   * its epoch fence; recovery is queued behind it and terminals the new record.
   */
  async runJournal(epoch, operation) {
    if (typeof operation !== 'function') {
      throw new TypeError('Journal operation must be a function');
    }
    await this.waitUntilSafe(epoch);
    return this._enqueueJournal(async () => {
      this.assertCurrent(epoch);
      this._assertHealthy();
      let value;
      try {
        value = await operation();
      } catch (error) {
        // Prefer the stale/fail-closed result if renderer loss raced the error.
        this.assertCurrent(epoch);
        this._assertHealthy();
        throw error;
      }
      this.assertCurrent(epoch);
      this._assertHealthy();
      return value;
    });
  }
}

module.exports = {
  RendererDocumentLifecycle,
  RendererContainmentCoordinator,
  RendererContainmentError,
  RendererNavigationError,
  StaleRendererError,
  isReloadAccelerator,
};
