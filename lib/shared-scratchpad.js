/**
 * Shared scratchpad: in-memory key-value store scoped per parent session.
 * Allows sibling subagents in a swarm to read/write shared context
 * without going through the parent agent.
 * @module shared-scratchpad
 */

const MAX_KEYS = 100;
const MAX_VALUE_BYTES = 64 * 1024; // 64KB
const EVICTION_MS = 60 * 60 * 1000; // 1 hour

/**
 * @typedef {{ value: unknown, author: string | null, updatedAt: string }} ScratchpadEntry
 */

/**
 * Top-level store: parentSessionId → { entries: Map<key, ScratchpadEntry>, lastAccess: number }
 * @type {Map<string, { entries: Map<string, ScratchpadEntry>, lastAccess: number }>}
 */
const store = new Map();

/**
 * Evict stale scratchpads on access (lazy). Returns true if the
 * requested pad was evicted (or never existed).
 * @param {string} parentSessionId
 * @returns {boolean}
 */
function evictIfStale(parentSessionId) {
  const pad = store.get(parentSessionId);
  if (!pad) return true;
  if (Date.now() - pad.lastAccess > EVICTION_MS) {
    store.delete(parentSessionId);
    return true;
  }
  return false;
}

/**
 * Touch the lastAccess timestamp of a pad.
 * @param {{ lastAccess: number }} pad
 */
function touch(pad) {
  pad.lastAccess = Date.now();
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function valueByteLength(value) {
  const json = JSON.stringify(value);
  return typeof Buffer !== "undefined" ? Buffer.byteLength(json, "utf8") : new TextEncoder().encode(json).byteLength;
}

/**
 * Get (or lazily create) a ScratchpadHandle for a parent session.
 *
 * @param {string} parentSessionId
 * @returns {{ write: Function, read: Function, list: Function, delete: Function, entries: Function, clear: Function }}
 */
export function getScratchpad(parentSessionId) {
  const id = String(parentSessionId || "").trim();
  if (!id) throw new Error("parentSessionId is required");

  // Evict stale pads for this id on access
  evictIfStale(id);

  function ensurePad() {
    let pad = store.get(id);
    if (!pad) {
      pad = { entries: new Map(), lastAccess: Date.now() };
      store.set(id, pad);
    }
    touch(pad);
    return pad;
  }

  return {
    /**
     * Write a key to the scratchpad.
     * @param {string} key
     * @param {unknown} value - Must be JSON-serializable
     * @param {{ author?: string }} [opts]
     */
    write(key, value, opts) {
      const k = String(key || "").trim();
      if (!k) throw new Error("key is required");

      // Validate JSON-serializable
      let serialized;
      try {
        serialized = JSON.stringify(value);
      } catch {
        throw new Error("value must be JSON-serializable");
      }

      // Size check
      const bytes = typeof Buffer !== "undefined"
        ? Buffer.byteLength(serialized, "utf8")
        : new TextEncoder().encode(serialized).byteLength;
      if (bytes > MAX_VALUE_BYTES) {
        const err = new Error(`Value exceeds maximum size of ${MAX_VALUE_BYTES} bytes`);
        err.code = "SCRATCHPAD_VALUE_TOO_LARGE";
        throw err;
      }

      const pad = ensurePad();

      // Key limit check (only if this is a new key)
      if (!pad.entries.has(k) && pad.entries.size >= MAX_KEYS) {
        const err = new Error(`Scratchpad key limit of ${MAX_KEYS} reached`);
        err.code = "SCRATCHPAD_KEY_LIMIT";
        throw err;
      }

      pad.entries.set(k, {
        value,
        author: typeof opts?.author === "string" ? opts.author : null,
        updatedAt: new Date().toISOString(),
      });
    },

    /**
     * Read a single key.
     * @param {string} key
     * @returns {{ value: unknown, author: string | null, updatedAt: string } | null}
     */
    read(key) {
      const k = String(key || "").trim();
      if (!k) return null;
      const pad = store.get(id);
      if (!pad) return null;
      touch(pad);
      const entry = pad.entries.get(k);
      return entry ? { value: entry.value, author: entry.author, updatedAt: entry.updatedAt } : null;
    },

    /**
     * List all keys with previews.
     * @returns {Array<{ key: string, author: string | null, updatedAt: string, preview: string }>}
     */
    list() {
      const pad = store.get(id);
      if (!pad) return [];
      touch(pad);
      const result = [];
      for (const [key, entry] of pad.entries) {
        const full = JSON.stringify(entry.value);
        result.push({
          key,
          author: entry.author,
          updatedAt: entry.updatedAt,
          preview: full.length > 200 ? full.slice(0, 200) : full,
        });
      }
      return result;
    },

    /**
     * Delete a single key.
     * @param {string} key
     * @returns {boolean}
     */
    delete(key) {
      const k = String(key || "").trim();
      if (!k) return false;
      const pad = store.get(id);
      if (!pad) return false;
      touch(pad);
      return pad.entries.delete(k);
    },

    /**
     * Return a Map of all entries (shallow copy).
     * @returns {Map<string, ScratchpadEntry>}
     */
    entries() {
      const pad = store.get(id);
      if (!pad) return new Map();
      touch(pad);
      return new Map(pad.entries);
    },

    /**
     * Clear all entries for this scratchpad.
     */
    clear() {
      const pad = store.get(id);
      if (!pad) return;
      pad.entries.clear();
      store.delete(id);
    },
  };
}

/**
 * Expose internal store reference for testing only.
 * @returns {Map<string, { entries: Map<string, ScratchpadEntry>, lastAccess: number }>}
 */
export function __getStoreForTests() {
  return store;
}
