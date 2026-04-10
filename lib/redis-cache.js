/**
 * Phase 35.1: Redis-backed distributed cache with in-memory fallback.
 *
 * When REDIS_URL is set (or passed via options.redisUrl), values are stored
 * in Redis with a key prefix and TTL. Otherwise the cache transparently
 * falls back to an in-memory LRU (lib/cache.js) so callers do not need to
 * branch on whether Redis is available.
 *
 * Connection failures degrade gracefully: a single connect attempt is made
 * lazily on first use. If it fails (or the optional `redis` package is not
 * installed) the cache silently uses memory and increments an error counter.
 */

import { createCache } from "./cache.js";

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_KEY_PREFIX = "siskelbot:cache:";

/**
 * Create a Redis-backed cache with in-memory fallback.
 *
 * @param {Object} [options]
 * @param {string} [options.redisUrl] - Redis URL. Defaults to process.env.REDIS_URL.
 * @param {number} [options.ttlMs] - Default TTL in milliseconds.
 * @param {string} [options.keyPrefix] - Prefix prepended to every key in Redis.
 * @param {boolean} [options.fallbackToMemory] - Use in-memory LRU when Redis unavailable. Default true.
 * @param {number} [options.memoryMaxSize] - Max entries for the fallback LRU.
 * @param {object} [options.redisClient] - Inject a pre-built client (for tests).
 */
export function createRedisCache(options = {}) {
  const {
    redisUrl = process.env.REDIS_URL || "",
    ttlMs = DEFAULT_TTL_MS,
    keyPrefix = DEFAULT_KEY_PREFIX,
    fallbackToMemory = true,
    memoryMaxSize = 1000,
    redisClient: injectedClient = null,
  } = options;

  const memory = fallbackToMemory
    ? createCache({ ttlMs, maxSize: memoryMaxSize, name: `redis-fallback:${keyPrefix}` })
    : null;

  /** @type {any} */
  let client = injectedClient;
  let connecting = null;
  let connectionAttempted = injectedClient != null;
  let connected = injectedClient != null;

  let hits = 0;
  let misses = 0;
  let errors = 0;
  let redisHits = 0;
  let memoryHits = 0;

  function fullKey(key) {
    return `${keyPrefix}${key}`;
  }

  async function ensureConnected() {
    if (connected) return client;
    if (!redisUrl && !injectedClient) return null;
    if (connectionAttempted && !client) return null;
    if (connecting) return connecting;

    connectionAttempted = true;
    connecting = (async () => {
      try {
        const redis = await import("redis");
        const c = redis.createClient({ url: redisUrl });
        c.on("error", (err) => {
          errors++;
          // Avoid log spam: only log distinct errors at warn level.
          if (process.env.REDIS_CACHE_LOG_ERRORS === "1") {
            console.warn("[redis-cache] client error:", err && err.message);
          }
        });
        await c.connect();
        client = c;
        connected = true;
        return client;
      } catch (err) {
        errors++;
        if (process.env.REDIS_CACHE_LOG_ERRORS === "1") {
          console.warn("[redis-cache] connect failed, using memory fallback:", err && err.message);
        }
        client = null;
        connected = false;
        return null;
      } finally {
        connecting = null;
      }
    })();
    return connecting;
  }

  async function get(key) {
    const fk = fullKey(key);
    const c = await ensureConnected();
    if (c) {
      try {
        const raw = await c.get(fk);
        if (raw != null) {
          hits++;
          redisHits++;
          try {
            return JSON.parse(raw);
          } catch {
            // Stored without JSON encoding (legacy / external writer); return raw.
            return raw;
          }
        }
      } catch (err) {
        errors++;
        if (process.env.REDIS_CACHE_LOG_ERRORS === "1") {
          console.warn("[redis-cache] get error:", err && err.message);
        }
      }
    }
    if (memory) {
      const v = memory.get(fk);
      if (v !== undefined) {
        hits++;
        memoryHits++;
        return v;
      }
    }
    misses++;
    return undefined;
  }

  async function set(key, value, customTtlMs) {
    const fk = fullKey(key);
    const ttl = typeof customTtlMs === "number" && customTtlMs > 0 ? customTtlMs : ttlMs;
    const seconds = Math.max(1, Math.ceil(ttl / 1000));
    const serialized = JSON.stringify(value);
    const c = await ensureConnected();
    if (c) {
      try {
        await c.set(fk, serialized, { EX: seconds });
      } catch (err) {
        errors++;
        if (process.env.REDIS_CACHE_LOG_ERRORS === "1") {
          console.warn("[redis-cache] set error:", err && err.message);
        }
      }
    }
    if (memory) memory.set(fk, value, ttl);
    return true;
  }

  async function has(key) {
    const fk = fullKey(key);
    const c = await ensureConnected();
    if (c) {
      try {
        const exists = await c.exists(fk);
        if (exists) return true;
      } catch (err) {
        errors++;
      }
    }
    if (memory) return memory.has(fk);
    return false;
  }

  async function del(key) {
    const fk = fullKey(key);
    let removed = false;
    const c = await ensureConnected();
    if (c) {
      try {
        const n = await c.del(fk);
        if (n > 0) removed = true;
      } catch (err) {
        errors++;
      }
    }
    if (memory) {
      const m = memory.delete(fk);
      removed = removed || m;
    }
    return removed;
  }

  /**
   * Delete keys matching a glob pattern (e.g. "user:*").
   * Pattern is automatically prefixed with keyPrefix.
   */
  async function deletePattern(pattern) {
    const fp = `${keyPrefix}${pattern}`;
    let count = 0;
    const c = await ensureConnected();
    if (c) {
      try {
        // Use SCAN to avoid blocking on large keyspaces.
        let cursor = 0;
        do {
          const reply = await c.scan(cursor, { MATCH: fp, COUNT: 100 });
          // node-redis v4 returns { cursor, keys }
          cursor = typeof reply === "object" && reply !== null && "cursor" in reply ? Number(reply.cursor) : Number(reply[0]);
          const keys = typeof reply === "object" && reply !== null && "keys" in reply ? reply.keys : reply[1];
          if (Array.isArray(keys) && keys.length > 0) {
            const n = await c.del(keys);
            count += typeof n === "number" ? n : keys.length;
          }
        } while (cursor !== 0);
      } catch (err) {
        errors++;
      }
    }
    if (memory) {
      // Translate glob to RegExp on the fallback store.
      const re = globToRegExp(fp);
      // memory cache exposes only public ops; iterate via a probe set.
      // Track by deleting any keys we know via stats peek: we don't have key listing,
      // so brute-force a snapshot via stats() which doesn't expose keys either.
      // Instead, we maintain a parallel key set for pattern deletes.
      for (const k of memoryKeys) {
        if (re.test(k)) {
          if (memory.delete(k)) count++;
          memoryKeys.delete(k);
        }
      }
    }
    return count;
  }

  /**
   * Track keys we set in the memory fallback so deletePattern can iterate them.
   * (createCache does not expose a key list.)
   */
  const memoryKeys = new Set();
  if (memory) {
    const origSet = memory.set;
    memory.set = function patchedSet(k, v, t) {
      memoryKeys.add(k);
      return origSet.call(memory, k, v, t);
    };
    const origDelete = memory.delete;
    memory.delete = function patchedDelete(k) {
      memoryKeys.delete(k);
      return origDelete.call(memory, k);
    };
    const origClear = memory.clear;
    memory.clear = function patchedClear() {
      memoryKeys.clear();
      return origClear.call(memory);
    };
  }

  /**
   * Clear all keys with this cache's prefix.
   */
  async function clear() {
    const c = await ensureConnected();
    if (c) {
      try {
        let cursor = 0;
        const match = `${keyPrefix}*`;
        do {
          const reply = await c.scan(cursor, { MATCH: match, COUNT: 200 });
          cursor = typeof reply === "object" && reply !== null && "cursor" in reply ? Number(reply.cursor) : Number(reply[0]);
          const keys = typeof reply === "object" && reply !== null && "keys" in reply ? reply.keys : reply[1];
          if (Array.isArray(keys) && keys.length > 0) {
            await c.del(keys);
          }
        } while (cursor !== 0);
      } catch (err) {
        errors++;
      }
    }
    if (memory) memory.clear();
    hits = 0;
    misses = 0;
    redisHits = 0;
    memoryHits = 0;
    // do not reset errors -- they reflect long-term health
  }

  async function stats() {
    const total = hits + misses;
    return {
      keyPrefix,
      hits,
      misses,
      errors,
      redisHits,
      memoryHits,
      hitRate: total === 0 ? 0 : hits / total,
      connected,
      backend: connected ? "redis" : memory ? "memory" : "none",
    };
  }

  async function close() {
    if (client && typeof client.quit === "function") {
      try {
        await client.quit();
      } catch {
        // ignore
      }
    }
    client = null;
    connected = false;
    if (memory) memory.clear();
  }

  function isConnected() {
    return connected;
  }

  return {
    get,
    set,
    has,
    delete: del,
    deletePattern,
    clear,
    stats,
    close,
    isConnected,
  };
}

function globToRegExp(glob) {
  let re = "^";
  for (const ch of glob) {
    if (ch === "*") re += ".*";
    else if (ch === "?") re += ".";
    else if (/[.+^${}()|[\]\\]/.test(ch)) re += "\\" + ch;
    else re += ch;
  }
  re += "$";
  return new RegExp(re);
}

// Pre-configured caches with sensible TTLs for common use cases.
export const queryCache = createRedisCache({ ttlMs: 60_000, keyPrefix: "siskelbot:query:" });
export const responseCache = createRedisCache({ ttlMs: 300_000, keyPrefix: "siskelbot:resp:" });
export const configCache = createRedisCache({ ttlMs: 30_000, keyPrefix: "siskelbot:cfg:" });
