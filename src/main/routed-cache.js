// ============================================================
// Source-keyed routed-account discovery cache
//
// A profile discovered from one ai-agent-entrypoint checkout must never be
// launched through another. Invalidation generations also stop a slow, stale
// discovery from repopulating the cache after the configured source changes.
// ============================================================
class RoutedDiscoveryCache {
  constructor({ ttlMs = 60_000, now = Date.now } = {}) {
    this._ttlMs = ttlMs;
    this._now = now;
    this._entry = null;
    this._inflight = null;
    this._generation = 0;
    this._requestSeq = 0;
  }

  invalidate() {
    this._generation += 1;
    this._entry = null;
    this._inflight = null;
  }

  async get(source, { force = false, discover } = {}) {
    if (typeof discover !== 'function') throw new Error('Routed discovery needs a discover function');
    const sourceKey = source || null;
    const now = this._now();

    if (!force
        && this._entry
        && this._entry.source === sourceKey
        && now - this._entry.at < this._ttlMs) {
      return this._entry.value;
    }
    if (!force
        && this._inflight
        && this._inflight.source === sourceKey
        && this._inflight.generation === this._generation) {
      return this._inflight.promise;
    }

    const generation = this._generation;
    const requestId = ++this._requestSeq;
    const promise = Promise.resolve()
      .then(() => discover(sourceKey))
      .then((value) => {
        if (generation === this._generation && requestId === this._requestSeq) {
          this._entry = { source: sourceKey, value, at: this._now() };
        }
        return value;
      })
      .finally(() => {
        if (this._inflight?.promise === promise) this._inflight = null;
      });

    this._inflight = { source: sourceKey, generation, promise };
    return promise;
  }
}

module.exports = { RoutedDiscoveryCache };
