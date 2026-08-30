// Non-overlapping main-process loop for durable per-session prompt schedules.

const TICK_MS = 15_000;

class SessionPromptScheduler {
  constructor({ store, inspectBinding, deliver, now = Date.now, setIntervalFn = setInterval, clearIntervalFn = clearInterval, log = null } = {}) {
    if (!store || typeof store.prepareTick !== 'function') throw new TypeError('Scheduler needs a schedule store');
    if (typeof inspectBinding !== 'function') throw new TypeError('Scheduler needs a binding inspector');
    if (typeof deliver !== 'function') throw new TypeError('Scheduler needs a delivery function');
    this._store = store;
    this._inspectBinding = inspectBinding;
    this._deliver = deliver;
    this._now = now;
    this._setInterval = setIntervalFn;
    this._clearInterval = clearIntervalFn;
    this._log = log || (() => {});
    this._timer = null;
    this._ticking = false;
    this._idleWaiters = [];
  }

  start() {
    if (this._timer) return false;
    const run = () => this.tick().catch(error => this._log(`Scheduled prompt tick failed (${error.code || 'error'})`));
    this._timer = this._setInterval(run, TICK_MS);
    this._timer?.unref?.();
    run();
    return true;
  }

  stop() {
    if (!this._timer) return false;
    this._clearInterval(this._timer);
    this._timer = null;
    return true;
  }

  async tick() {
    if (this._ticking) return false;
    this._ticking = true;
    try {
      const due = await this._store.prepareTick(this._inspectBinding);
      for (const candidate of due) {
        const claimed = await this._store.claimDue(candidate.id);
        if (!claimed?.deliveryClaim) continue;
        let status = 'error';
        try {
          status = await this._deliver(claimed);
        } catch (_error) {
          status = 'error';
        }
        await this._store.finalizeClaim(claimed.id, claimed.deliveryClaim.token, status);
      }
      return true;
    } finally {
      this._ticking = false;
      for (const resolve of this._idleWaiters.splice(0)) resolve();
    }
  }

  /** Resolve after any tick that was already running has fully finalized. */
  whenIdle() {
    if (!this._ticking) return Promise.resolve();
    return new Promise(resolve => this._idleWaiters.push(resolve));
  }

  get running() {
    return !!this._timer;
  }
}

module.exports = { SessionPromptScheduler, TICK_MS };
