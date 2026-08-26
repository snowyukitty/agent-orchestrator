// ============================================================
// Graceful application shutdown coordinator
//
// Electron's before-quit event is synchronous, while ConPTY termination is
// not. This coordinator prevents the first quit, closes session admission,
// drains every queued termination, then requests one final allowed quit.
// ============================================================

const MAX_DRAIN_ATTEMPTS = 3;
const DRAIN_RETRY_DELAY_MS = 2000;

class ShutdownCoordinator {
  constructor({ getRegistry, cleanup, requestQuit, onError, schedule } = {}) {
    this._getRegistry = getRegistry || (() => null);
    this._cleanup = cleanup || (() => {});
    this._requestQuit = requestQuit || (() => {});
    this._onError = onError || (() => {});
    this._schedule = schedule || ((fn, ms) => setTimeout(fn, ms));
    this._started = false;
    this._ready = false;
    this._attempts = 0;
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
    this._drainPromise = this._drain(registry);
    return false;
  }

  _drain(registry) {
    this._attempts += 1;
    return (async () => {
      if (registry) {
        await registry.killAllSequential('shutdown', { failOnTimeout: true });
        await registry.whenTerminationsComplete();
      }
      this._ready = true;
      this._requestQuit();
    })().catch((err) => {
      this._onError(err);
      if (this._attempts < MAX_DRAIN_ATTEMPTS) {
        // Retry on our own schedule: by now cleanup() has destroyed the tray
        // and closed the window, so no UI affordance remains to request
        // another quit. Session admission stays closed either way.
        return new Promise((resolve) => {
          this._schedule(() => {
            this._drainPromise = this._drain(registry);
            resolve(this._drainPromise);
          }, DRAIN_RETRY_DELAY_MS);
        });
      }
      // A ConPTY that survived every sequential kill plus the taskkill /T /F
      // backstop is wedged beyond what staying alive can fix. Exiting risks a
      // native assert in node-pty; a permanent headless zombie process is
      // strictly worse, so allow the quit.
      this._ready = true;
      this._requestQuit();
      return undefined;
    });
  }

  whenDrained() {
    return this._drainPromise;
  }

  get ready() {
    return this._ready;
  }
}

module.exports = { ShutdownCoordinator, MAX_DRAIN_ATTEMPTS, DRAIN_RETRY_DELAY_MS };
