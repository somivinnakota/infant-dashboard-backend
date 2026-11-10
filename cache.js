// Remembers the answer from a slow outside service for a while, so pages don't ask it again and again.
// Failed calls are not remembered, so they are tried again next time.
//
//   const cache = createCache(15 * MINUTE);
//   const stats = await cache.get('facebook', () => fetchFacebookStats());
//   cache.get(key, loader, { refresh: true })   ignore the saved answer and ask again
//   cache.clear('facebook')                     forget one answer; cache.clear() forgets them all

function createCache(ttlMs) {
  const saved = new Map();
  return {
    async get(key, loader, { refresh = false } = {}) {
      const hit = saved.get(key);
      if (hit && !refresh && Date.now() - hit.time < ttlMs) return hit.value;
      const value = await loader();
      saved.set(key, { value, time: Date.now() });
      return value;
    },
    clear(key) {
      if (key === undefined) saved.clear();
      else saved.delete(key);
    },
  };
}

module.exports = { createCache };