/**
 * Phase 23: In-memory cache with TTL and LRU eviction.
 */

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_MAX_SIZE = 1000;

export function createCache(options = {}) {
  const { ttlMs = DEFAULT_TTL_MS, maxSize = DEFAULT_MAX_SIZE, name = "default" } = options;

  /** @type {Map<string, { value: any, expiresAt: number }>} */
  const store = new Map();
  let hits = 0;
  let misses = 0;
  let evictions = 0;

  function isExpired(entry) {
    return Date.now() >= entry.expiresAt;
  }

  function evictExpired() {
    for (const [key, entry] of store) {
      if (isExpired(entry)) {
        store.delete(key);
      }
    }
  }

  function evictLRU() {
    // Map iteration order is insertion order; the first key is the least recently used
    // because we re-insert on access (get/set)
    const oldest = store.keys().next().value;
    if (oldest !== undefined) {
      store.delete(oldest);
      evictions++;
    }
  }

  function get(key) {
    const entry = store.get(key);
    if (!entry) {
      misses++;
      return undefined;
    }
    if (isExpired(entry)) {
      store.delete(key);
      misses++;
      return undefined;
    }
    // Move to end (most recently used) by re-inserting
    store.delete(key);
    store.set(key, entry);
    hits++;
    return entry.value;
  }

  function set(key, value, customTtl) {
    const ttl = typeof customTtl === "number" && customTtl > 0 ? customTtl : ttlMs;
    // If key exists, delete first so re-insert moves it to end
    if (store.has(key)) {
      store.delete(key);
    }
    // Evict if at capacity
    if (store.size >= maxSize) {
      evictLRU();
    }
    store.set(key, { value, expiresAt: Date.now() + ttl });
  }

  function has(key) {
    const entry = store.get(key);
    if (!entry) return false;
    if (isExpired(entry)) {
      store.delete(key);
      return false;
    }
    return true;
  }

  function del(key) {
    return store.delete(key);
  }

  function clear() {
    store.clear();
    hits = 0;
    misses = 0;
    evictions = 0;
  }

  function size() {
    // Purge expired entries to return accurate count
    evictExpired();
    return store.size;
  }

  function stats() {
    const total = hits + misses;
    return {
      name,
      hits,
      misses,
      hitRate: total === 0 ? 0 : hits / total,
      size: store.size,
      evictions,
    };
  }

  return { get, set, has, delete: del, clear, size, stats };
}

// Singleton caches for common use cases
export const configCache = createCache({ ttlMs: 30_000, maxSize: 50, name: "config" });
export const knowledgeCache = createCache({ ttlMs: 120_000, maxSize: 200, name: "knowledge" });
export const userCache = createCache({ ttlMs: 60_000, maxSize: 500, name: "user" });
