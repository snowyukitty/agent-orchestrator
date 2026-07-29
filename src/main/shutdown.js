// ============================================================
// Graceful application shutdown coordinator
//
// Electron's before-quit event is synchronous, while ConPTY termination is
// not. This coordinator prevents the first quit, closes session admission,
// drains every queued termination, then requests one final allowed quit.
// ============================================================
class ShutdownCoordinator {
  constructor({ getRegistry, cleanup, requestQuit, onError } = {}) {
    this._getRegistry = getRegistry || (() => null);
    this._cleanup = cleanup || (() => {});
    this._requestQuit = requestQuit || (() => {});
    this._onError = onError || (() => {});
    this._started = false;
    this._ready = false;
    this._drainPromise = Promise.resolve();
  }

  handleBeforeQuit(event) {
    if (this._ready) {
      this._cleanup();
      return true;
    }

    event?.preventDefault?.();
    if (this._started) return false;
    this._started = true;

    const registry = this._getRegistry();
    registry?.closeAdmission?.('application shutdown');
    this._cleanup();

    this._drainPromise = (async () => {
      if (registry) {
        await registry.killAllSequential('shutdown', { failOnTimeout: true });
        await registry.whenTerminationsComplete();
      }
      this._ready = true;
      this._requestQuit();
    })().catch((err) => {
      // Fail closed: do not allow Electron to exit when termination failed.
      // A later quit request may retry the drain, but session admission stays
      // closed for the lifetime of this process.
      this._started = false;
      this._onError(err);
    });

    return false;
  }

  whenDrained() {
    return this._drainPromise;
  }

  get ready() {
    return this._ready;
  }
}

module.exports = { ShutdownCoordinator };
