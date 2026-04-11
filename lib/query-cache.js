/**
 * Phase 35.1: Query cache helper.
 *
 * Wraps an arbitrary async function in a cache lookup keyed by a stable
 * hash of the supplied "key source" (any JSON-serializable value).
 * Backed by a Redis cache from `lib/redis-cache.js` (with in-memory fallback)
 * so the cache is shared across server instances when REDIS_URL is set.
 */

import { createHash } from "crypto";
import { queryCache as defaultQueryCache } from "./redis-cache.js";

/**
 * Hash a key source into a stable string suitable for use as a cache key.
 * Objects are key-sorted before hashing so {a:1,b:2} === {b:2,a:1}.
 */
export function hashKeySource(keySource) {
  const stable = stableStringify(keySource);
  return createHash("sha1").update(stable).digest("hex");
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v) => stableStringify(v)).join(",") + "]";
  }
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(value[k])).join(",") + "}";
}

/**
 * Create a query cache wrapper around an underlying redis-cache.
 *
 * @param {ReturnType<typeof import('./redis-cache.js').createRedisCache>} cache
 */
export function createQueryCache(cache) {
  let wrapHits = 0;
  let wrapMisses = 0;
  let wrapErrors = 0;

  /**
   * Cache the result of `fn()` keyed by `keySource`.
   * On hit, fn is NOT called. On miss, fn is awaited and its result stored.
   *
   * @template T
   * @param {any} keySource - Any JSON-serializable value used as the cache key.
   * @param {() => Promise<T> | T} fn - Function to execute on miss.
   * @param {number} [ttlMs] - Optional override TTL in milliseconds.
   * @returns {Promise<T>}
   */
  async function wrap(keySource, fn, ttlMs) {
    const key = hashKeySource(keySource);
    try {
      const cached = await cache.get(key);
      if (cached !== undefined) {
        wrapHits++;
        return cached;
      }
    } catch (err) {
      wrapErrors++;
    }
    wrapMisses++;
    const result = await fn();
    if (result !== undefined) {
      try {
        await cache.set(key, result, ttlMs);
      } catch (err) {
        wrapErrors++;
      }
    }
    return result;
  }

  /**
   * Invalidate cached entries by glob pattern (matched against the
   * underlying cache's key prefix). Pass "*" to clear everything.
   */
  async function invalidate(pattern) {
    if (pattern == null || pattern === "" || pattern === "*") {
      await cache.clear();
      return;
    }
    await cache.deletePattern(pattern);
  }

  /**
   * Invalidate a single key derived from the same keySource format used by `wrap`.
   */
  async function invalidateKey(keySource) {
    const key = hashKeySource(keySource);
    await cache.delete(key);
  }

  async function getStats() {
    const inner = await cache.stats();
    const total = wrapHits + wrapMisses;
    return {
      ...inner,
      wrapHits,
      wrapMisses,
      wrapErrors,
      wrapHitRate: total === 0 ? 0 : wrapHits / total,
    };
  }

  return {
    wrap,
    invalidate,
    invalidateKey,
    getStats,
  };
}

// Convenience: a shared query cache for knowledge search lookups.
export const cachedKnowledgeSearch = createQueryCache(defaultQueryCache);
