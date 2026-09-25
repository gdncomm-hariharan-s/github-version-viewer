const { ROUTE_CACHE_TTL_MS } = require('./config');

const routeCache = new Map(); // key -> { expiresAt, promise }

function cachedRoute(key, ttlMs, buildFn, force) {
  const cached = routeCache.get(key);
  if (!force && cached && cached.expiresAt > Date.now()) return cached.promise;
  const promise = buildFn();
  routeCache.set(key, { expiresAt: Date.now() + ttlMs, promise });
  promise.catch(() => routeCache.delete(key));
  return promise;
}

function clearRouteCache() {
  routeCache.clear();
}

module.exports = { cachedRoute, clearRouteCache, ROUTE_CACHE_TTL_MS };
