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
 * @param {object} [options.redisClient] - Inject a pre-built client (for tests). Must already be connected.
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

  const memoryCache = fallbackToMemory
    ? createCache({ ttlMs, maxSize: memoryMaxSize, name: `redis-fallback:${keyPrefix}` })
    : null;

  // Track keys we've written to memory so deletePattern/clear can iterate them.
  /** @type {Set<string>} */
  const memoryKeys = new Set();

  function memSet(k, v, t) {
    if (!memoryCache) return;
    memoryKeys.add(k);
    memoryCache.set(k, v, t);
  }
  function memGet(k) {
    if (!memoryCache) return undefined;
    const v = memoryCache.get(k);
    if (v === undefined) memoryKeys.delete(k);
    return v;
  }
  function memHas(k) {
    if (!memoryCache) return false;
    const ok = memoryCache.has(k);
    if (!ok) memoryKeys.delete(k);
    return ok;
  }
  function memDelete(k) {
    if (!memoryCache) return false;
    memoryKeys.delete(k);
    return memoryCache.delete(k);
  }
  function memClear() {
    if (!memoryCache) return;
    memoryKeys.clear();
    memoryCache.clear();
  }

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

  function logError(label, err) {
    errors++;
    if (process.env.REDIS_CACHE_LOG_ERRORS === "1") {
      console.warn(`[redis-cache] ${label}:`, err && err.message);
    }
  }

  async function ensureConnected() {
    if (connected && client) return client;
    if (!redisUrl) return null;
    if (connectionAttempted && !client && !connecting) return null;
    if (connecting) return connecting;

    connectionAttempted = true;
    connecting = (async () => {
      try {
        const redis = await import("redis");
        const c = redis.createClient({ url: redisUrl });
        c.on("error", (err) => logError("client error", err));
        await c.connect();
        client = c;
        connected = true;
        return client;
      } catch (err) {
        logError("connect failed, using memory fallback", err);
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
            return raw;
          }
        }
      } catch (err) {
        logError("get error", err);
      }
    }
    const v = memGet(fk);
    if (v !== undefined) {
      hits++;
      memoryHits++;
      return v;
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
        logError("set error", err);
      }
    }
    memSet(fk, value, ttl);
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
        logError("has error", err);
      }
    }
    return memHas(fk);
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
        logError("delete error", err);
      }
    }
    const m = memDelete(fk);
    return removed || m;
  }

  /**
   * Read the {cursor, keys} pair from a node-redis SCAN reply.
   * Supports both v4 object form and legacy array form.
   */
  function parseScanReply(reply) {
    if (reply && typeof reply === "object" && !Array.isArray(reply) && "cursor" in reply) {
      return { cursor: Number(reply.cursor), keys: Array.isArray(reply.keys) ? reply.keys : [] };
    }
    if (Array.isArray(reply)) {
      return { cursor: Number(reply[0]), keys: Array.isArray(reply[1]) ? reply[1] : [] };
    }
    return { cursor: 0, keys: [] };
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
        let cursor = 0;
        do {
          const reply = await c.scan(cursor, { MATCH: fp, COUNT: 100 });
          const parsed = parseScanReply(reply);
          cursor = parsed.cursor;
          if (parsed.keys.length > 0) {
            const n = await c.del(parsed.keys);
            count += typeof n === "number" ? n : parsed.keys.length;
          }
        } while (cursor !== 0);
      } catch (err) {
        logError("deletePattern error", err);
      }
    }
    if (memoryCache) {
      const re = globToRegExp(fp);
      for (const k of [...memoryKeys]) {
        if (re.test(k)) {
          if (memDelete(k)) count++;
        }
      }
    }
    return count;
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
          const parsed = parseScanReply(reply);
          cursor = parsed.cursor;
          if (parsed.keys.length > 0) {
            await c.del(parsed.keys);
          }
        } while (cursor !== 0);
      } catch (err) {
        logError("clear error", err);
      }
    }
    memClear();
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
      backend: connected ? "redis" : memoryCache ? "memory" : "none",
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
    memClear();
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
