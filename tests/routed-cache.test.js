const test = require('node:test');
const assert = require('node:assert/strict');

const { RoutedDiscoveryCache } = require('../src/main/routed-cache');

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

test('routed discovery cache is keyed by resolved entrypoint source', async () => {
  let calls = 0;
  const cache = new RoutedDiscoveryCache({ ttlMs: 60_000, now: () => 100 });
  const discover = async source => ({ source, call: ++calls });

  const a1 = await cache.get('C:/entrypoint-a', { discover });
  const a2 = await cache.get('C:/entrypoint-a', { discover });
  const b = await cache.get('C:/entrypoint-b', { discover });

  assert.deepEqual(a2, a1);
  assert.equal(b.source, 'C:/entrypoint-b');
  assert.equal(calls, 2);
});

test('cache invalidation forces rediscovery for the same source', async () => {
  let calls = 0;
  const cache = new RoutedDiscoveryCache({ now: () => 100 });
  const discover = async () => ({ call: ++calls });
  assert.equal((await cache.get('C:/entrypoint', { discover })).call, 1);
  cache.invalidate();
  assert.equal((await cache.get('C:/entrypoint', { discover })).call, 2);
});

test('an invalidated slow discovery cannot repopulate the current cache', async () => {
  const oldRun = deferred();
  let newCalls = 0;
  const cache = new RoutedDiscoveryCache({ now: () => 100 });

  const oldResult = cache.get('C:/old', { discover: () => oldRun.promise });
  cache.invalidate();
  const current = await cache.get('C:/new', {
    discover: async source => ({ source, call: ++newCalls }),
  });
  oldRun.resolve({ source: 'C:/old', stale: true });
  await oldResult;

  const cachedCurrent = await cache.get('C:/new', {
    discover: async () => ({ source: 'unexpected', call: ++newCalls }),
  });
  assert.deepEqual(cachedCurrent, current);
  assert.equal(newCalls, 1);
});

test('concurrent callers share one in-flight discovery per source', async () => {
  const pending = deferred();
  let calls = 0;
  const cache = new RoutedDiscoveryCache();
  const discover = () => {
    calls += 1;
    return pending.promise;
  };
  const first = cache.get('C:/entrypoint', { discover });
  const second = cache.get('C:/entrypoint', { discover });
  pending.resolve({ profiles: [] });
  assert.deepEqual(await first, await second);
  assert.equal(calls, 1);
});
