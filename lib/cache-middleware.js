/**
 * Phase 23: Express middleware for response caching.
 */

/**
 * Cache response middleware. Serves cached responses on HIT,
 * intercepts res.json to store on MISS.
 *
 * @param {ReturnType<import('./cache.js').createCache>} cache
 * @param {(req: import('express').Request) => string} keyFn
 * @param {object} [options]
 * @param {number} [options.ttlMs] - Custom TTL for this middleware
 * @returns {import('express').RequestHandler}
 */
export function cacheResponse(cache, keyFn, options = {}) {
  return (req, res, next) => {
    const key = keyFn(req);
    const cached = cache.get(key);
    if (cached) {
      res.setHeader("X-Cache", "HIT");
      return res.status(cached.status).json(cached.body);
    }
    const origJson = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode < 400) {
        cache.set(key, { status: res.statusCode, body }, options.ttlMs);
      }
      res.setHeader("X-Cache", "MISS");
      return origJson(body);
    };
    next();
  };
}

/**
 * Invalidate cache entries matching a prefix.
 *
 * @param {ReturnType<import('./cache.js').createCache>} cache
 * @param {string} prefix
 */
export function invalidatePrefix(cache, _prefix) {
  // The cache doesn't expose iteration, so we track keys externally
  // For now, use clear as a simple invalidation strategy per-cache
  cache.clear();
}
