/**
 * Subagent result memoization — caches (profile + goal_hash) results so
 * repeated research queries skip the LLM entirely.
 *
 * Storage: JSON file per workspace at data/subagent-memo/<workspace>.json
 * via json-path-store. Default TTL 7 days. Max 500 entries per workspace.
 * LRU eviction on overflow.
 *
 * @module subagent-memo
 */
import { createHash } from "crypto";
import { join } from "path";
import { getDataDir, readJsonPath, writeJsonPath, withPathLock } from "./json-path-store.js";

/** Default TTL: 7 days in milliseconds. */
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Default max entries per workspace. */
const DEFAULT_MAX_ENTRIES = 500;

function getTtlMs() {
  const env = process.env.SUBAGENT_MEMO_TTL_MS;
  if (env && Number.isFinite(Number(env)) && Number(env) > 0) return Number(env);
  return DEFAULT_TTL_MS;
}

function getMaxEntries() {
  const env = process.env.SUBAGENT_MEMO_MAX_ENTRIES;
  if (env && Number.isFinite(Number(env)) && Number(env) > 0) return Math.floor(Number(env));
  return DEFAULT_MAX_ENTRIES;
}

function storagePath(workspace) {
  return join(getDataDir(), "subagent-memo", `${workspace}.json`);
}

async function loadEntries(workspace) {
  const data = await readJsonPath(storagePath(workspace), { entries: {} });
  return typeof data.entries === "object" && data.entries !== null ? data.entries : {};
}

async function saveEntries(workspace, entries) {
  await writeJsonPath(storagePath(workspace), { entries });
}

/**
 * Compute a deterministic memo key from a profile name and goal string.
 * Uses SHA-256 of the concatenation profile + "\0" + goal.
 * @param {string} profile
 * @param {string} goal
 * @returns {string} Hex-encoded SHA-256 hash.
 */
export function computeMemoKey(profile, goal) {
  const normalized = `${String(profile || "default").trim().toLowerCase()}\0${String(goal || "")}`;
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

/**
 * Retrieve a cached memo entry. Returns null if not found or expired.
 * Increments hitCount on cache hit.
 * @param {string} workspace
 * @param {string} key
 * @returns {Promise<{ result: string, costUsd: number, iterations: number, cachedAt: string, hitCount: number } | null>}
 */
export async function getMemo(workspace, key) {
  const path = storagePath(workspace);
  return withPathLock(path, async () => {
    const entries = await loadEntries(workspace);
    const entry = entries[key];
    if (!entry) return null;

    // Check TTL expiry
    const ttl = getTtlMs();
    const age = Date.now() - new Date(entry.cachedAt).getTime();
    if (age > ttl) {
      delete entries[key];
      await saveEntries(workspace, entries);
      return null;
    }

    // Increment hit count and update lastAccessedAt
    entry.hitCount = (entry.hitCount || 0) + 1;
    entry.lastAccessedAt = new Date().toISOString();
    await saveEntries(workspace, entries);

    return {
      result: entry.result,
      costUsd: entry.costUsd,
      iterations: entry.iterations,
      cachedAt: entry.cachedAt,
      hitCount: entry.hitCount,
    };
  });
}

/**
 * Store a memo entry. Performs LRU eviction if max entries exceeded.
 * @param {string} workspace
 * @param {string} key
 * @param {{ result: string, costUsd?: number, iterations?: number, profile?: string, goal?: string }} value
 * @returns {Promise<void>}
 */
export async function setMemo(workspace, key, value) {
  const path = storagePath(workspace);
  return withPathLock(path, async () => {
    const entries = await loadEntries(workspace);
    const now = new Date().toISOString();

    entries[key] = {
      result: value.result,
      costUsd: value.costUsd ?? 0,
      iterations: value.iterations ?? 0,
      profile: value.profile ?? null,
      goal: value.goal ?? null,
      cachedAt: now,
      lastAccessedAt: now,
      hitCount: 0,
    };

    // LRU eviction if over max entries
    const maxEntries = getMaxEntries();
    const keys = Object.keys(entries);
    if (keys.length > maxEntries) {
      // Sort by lastAccessedAt ascending; break ties by hitCount ascending
      const sorted = keys.sort((a, b) => {
        const aTime = new Date(entries[a].lastAccessedAt || entries[a].cachedAt).getTime();
        const bTime = new Date(entries[b].lastAccessedAt || entries[b].cachedAt).getTime();
        if (aTime !== bTime) return aTime - bTime;
        return (entries[a].hitCount || 0) - (entries[b].hitCount || 0);
      });
      const toEvict = sorted.slice(0, keys.length - maxEntries);
      for (const evictKey of toEvict) {
        delete entries[evictKey];
      }
    }

    await saveEntries(workspace, entries);
  });
}

/**
 * Invalidate (delete) a memo entry.
 * @param {string} workspace
 * @param {string} key
 * @returns {Promise<boolean>} true if the entry existed and was removed.
 */
export async function invalidateMemo(workspace, key) {
  const path = storagePath(workspace);
  return withPathLock(path, async () => {
    const entries = await loadEntries(workspace);
    if (!(key in entries)) return false;
    delete entries[key];
    await saveEntries(workspace, entries);
    return true;
  });
}

/**
 * Get aggregate stats for memoized entries in a workspace.
 * @param {string} workspace
 * @returns {Promise<{ totalEntries: number, totalHits: number, estimatedSavingsUsd: number }>}
 */
export async function getMemoStats(workspace) {
  const entries = await loadEntries(workspace);
  let totalHits = 0;
  let estimatedSavingsUsd = 0;
  const values = Object.values(entries);

  for (const entry of values) {
    const hits = entry.hitCount || 0;
    totalHits += hits;
    estimatedSavingsUsd += hits * (entry.costUsd || 0);
  }

  return {
    totalEntries: values.length,
    totalHits,
    estimatedSavingsUsd,
  };
}

/**
 * Prune expired or excess memo entries.
 * @param {string} workspace
 * @param {{ maxAge?: number, maxEntries?: number }} [opts]
 * @returns {Promise<{ pruned: number }>}
 */
export async function pruneMemos(workspace, opts = {}) {
  const path = storagePath(workspace);
  return withPathLock(path, async () => {
    const entries = await loadEntries(workspace);
    const maxAge = opts.maxAge ?? getTtlMs();
    const maxEntries = opts.maxEntries ?? getMaxEntries();
    const now = Date.now();
    let pruned = 0;

    // Remove expired entries
    for (const key of Object.keys(entries)) {
      const age = now - new Date(entries[key].cachedAt).getTime();
      if (age > maxAge) {
        delete entries[key];
        pruned++;
      }
    }

    // Enforce max entries via LRU
    const keys = Object.keys(entries);
    if (keys.length > maxEntries) {
      const sorted = keys.sort((a, b) => {
        const aTime = new Date(entries[a].lastAccessedAt || entries[a].cachedAt).getTime();
        const bTime = new Date(entries[b].lastAccessedAt || entries[b].cachedAt).getTime();
        return aTime - bTime;
      });
      const toEvict = sorted.slice(0, keys.length - maxEntries);
      for (const evictKey of toEvict) {
        delete entries[evictKey];
        pruned++;
      }
    }

    await saveEntries(workspace, entries);
    return { pruned };
  });
}
