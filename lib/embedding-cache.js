/**
 * Phase 35.2: Embedding cache — content-addressable storage for embeddings.
 *
 * Identical text always produces identical embeddings for a given model,
 * so we cache them by SHA-256 of (model + normalized text + version).
 *
 * Storage options:
 *   - memory: in-process Map with LRU eviction (fast, lost on restart)
 *   - file:   periodic JSON flush to disk (survives restarts)
 *   - redis:  distributed cache (placeholder; falls back to memory if unavailable)
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const CACHE_VERSION = 1;
const DEFAULT_MAX_SIZE = 10_000;

/**
 * Normalize text for cache keying: trim + collapse whitespace.
 * @param {string} text
 * @returns {string}
 */
export function normalizeText(text) {
  return String(text == null ? "" : text).trim().replace(/\s+/g, " ");
}

/**
 * Content-addressable hash for an embedding entry.
 * Uses SHA-256 of (model + "\0" + normalized text + "\0" + version).
 * @param {string} text
 * @param {string} model
 * @returns {string} hex sha256
 */
export function hashText(text, model) {
  const norm = normalizeText(text);
  const m = String(model || "");
  const h = createHash("sha256");
  h.update(`${m}\0${norm}\0v${CACHE_VERSION}`);
  return h.digest("hex");
}

/**
 * Rough byte size estimate for an embedding vector.
 * Float64 per number + overhead.
 * @param {number[]} vec
 * @returns {number}
 */
function estimateBytes(vec) {
  if (!Array.isArray(vec)) return 0;
  // 8 bytes per float + 64 bytes key/metadata overhead
  return vec.length * 8 + 64;
}

/**
 * Create an embedding cache instance.
 *
 * @param {object} [options]
 * @param {number} [options.maxSize=10000] - Max number of entries (LRU eviction beyond).
 * @param {"memory"|"file"|"redis"} [options.storage="memory"]
 * @returns {{
 *   get(text: string, model: string): Promise<number[]|null>,
 *   set(text: string, model: string, embedding: number[]): Promise<void>,
 *   has(text: string, model: string): Promise<boolean>,
 *   getBatch(texts: string[], model: string): Promise<{cached: Record<number, number[]>, missing: {idx: number, text: string}[]}>,
 *   setBatch(texts: string[], model: string, embeddings: number[][]): Promise<void>,
 *   size(): number,
 *   stats(): {hits:number, misses:number, hitRate:number, memoryBytes:number, savedApiCalls:number, size:number, maxSize:number, storage:string},
 *   clear(): void,
 *   persist(path: string): Promise<void>,
 *   load(path: string): Promise<number>,
 * }}
 */
export function createEmbeddingCache(options) {
  const { maxSize = DEFAULT_MAX_SIZE, storage = "memory" } = options || {};

  /** @type {Map<string, number[]>} */
  const store = new Map();
  let hits = 0;
  let misses = 0;
  let memoryBytes = 0;

  function touch(key, value) {
    // Re-insert to move to most-recently-used position (Map preserves insertion order).
    store.delete(key);
    store.set(key, value);
  }

  function evictIfNeeded() {
    while (store.size > maxSize) {
      const oldest = store.keys().next().value;
      if (oldest === undefined) break;
      const vec = store.get(oldest);
      memoryBytes -= estimateBytes(vec);
      if (memoryBytes < 0) memoryBytes = 0;
      store.delete(oldest);
    }
  }

  async function get(text, model) {
    if (typeof text !== "string") {
      misses++;
      return null;
    }
    const key = hashText(text, model);
    const existing = store.get(key);
    if (existing) {
      hits++;
      touch(key, existing);
      return existing;
    }
    misses++;
    return null;
  }

  async function set(text, model, embedding) {
    if (typeof text !== "string") return;
    if (!Array.isArray(embedding)) return;
    const key = hashText(text, model);
    const prev = store.get(key);
    if (prev) {
      memoryBytes -= estimateBytes(prev);
      if (memoryBytes < 0) memoryBytes = 0;
    }
    store.delete(key);
    store.set(key, embedding);
    memoryBytes += estimateBytes(embedding);
    evictIfNeeded();
  }

  async function has(text, model) {
    if (typeof text !== "string") return false;
    const key = hashText(text, model);
    return store.has(key);
  }

  async function getBatch(texts, model) {
    const cached = {};
    const missing = [];
    if (!Array.isArray(texts)) return { cached, missing };
    for (let i = 0; i < texts.length; i++) {
      const t = texts[i];
      if (typeof t !== "string") {
        misses++;
        missing.push({ idx: i, text: t });
        continue;
      }
      const key = hashText(t, model);
      const existing = store.get(key);
      if (existing) {
        hits++;
        touch(key, existing);
        cached[i] = existing;
      } else {
        misses++;
        missing.push({ idx: i, text: t });
      }
    }
    return { cached, missing };
  }

  async function setBatch(texts, model, embeddings) {
    if (!Array.isArray(texts) || !Array.isArray(embeddings)) return;
    const n = Math.min(texts.length, embeddings.length);
    for (let i = 0; i < n; i++) {
      const t = texts[i];
      const e = embeddings[i];
      if (typeof t !== "string") continue;
      if (!Array.isArray(e)) continue;
      const key = hashText(t, model);
      const prev = store.get(key);
      if (prev) {
        memoryBytes -= estimateBytes(prev);
        if (memoryBytes < 0) memoryBytes = 0;
      }
      store.delete(key);
      store.set(key, e);
      memoryBytes += estimateBytes(e);
    }
    evictIfNeeded();
  }

  function size() {
    return store.size;
  }

  function stats() {
    const total = hits + misses;
    const hitRate = total > 0 ? hits / total : 0;
    return {
      hits,
      misses,
      hitRate,
      memoryBytes,
      savedApiCalls: hits,
      size: store.size,
      maxSize,
      storage,
    };
  }

  function clear() {
    store.clear();
    hits = 0;
    misses = 0;
    memoryBytes = 0;
  }

  async function persist(filePath) {
    if (!filePath) throw new Error("persist: path required");
    const entries = [];
    for (const [key, vec] of store) {
      entries.push([key, vec]);
    }
    const payload = {
      version: CACHE_VERSION,
      savedAt: new Date().toISOString(),
      stats: { hits, misses, memoryBytes },
      entries,
    };
    const dir = path.dirname(filePath);
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (_) {}
    const tmp = `${filePath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(payload), "utf8");
    await fs.rename(tmp, filePath);
  }

  async function load(filePath) {
    if (!filePath) throw new Error("load: path required");
    let raw;
    try {
      raw = await fs.readFile(filePath, "utf8");
    } catch (e) {
      if (e.code === "ENOENT") return 0;
      throw e;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new Error(`embedding-cache: invalid JSON in ${filePath}: ${e.message}`);
    }
    if (!parsed || parsed.version !== CACHE_VERSION) {
      return 0;
    }
    const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
    let loaded = 0;
    for (const ent of entries) {
      if (!Array.isArray(ent) || ent.length !== 2) continue;
      const [key, vec] = ent;
      if (typeof key !== "string" || !Array.isArray(vec)) continue;
      store.delete(key);
      store.set(key, vec);
      memoryBytes += estimateBytes(vec);
      loaded++;
    }
    evictIfNeeded();
    return loaded;
  }

  return {
    get,
    set,
    has,
    getBatch,
    setBatch,
    size,
    stats,
    clear,
    persist,
    load,
  };
}

/**
 * Process-wide default embedding cache used by lib/embeddings.js.
 */
export const globalEmbeddingCache = createEmbeddingCache({
  maxSize: Number(process.env.EMBEDDING_CACHE_MAX_SIZE) || DEFAULT_MAX_SIZE,
  storage: process.env.EMBEDDING_CACHE_STORAGE || "memory",
});
