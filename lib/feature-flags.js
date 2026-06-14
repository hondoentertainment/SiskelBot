/**
 * Feature flags with targeting (workspace allowlist, user allowlist,
 * percentage rollout, date window). Storage-backed with a 30s in-memory cache.
 *
 * Storage shape (per-flag, type "feature_flags", id = flag key):
 *   {
 *     id: "experimental_swarm",
 *     key: "experimental_swarm",
 *     enabled: true,
 *     value: true,                      // value when targeting matches
 *     defaultValue: false,              // value when targeting does NOT match
 *     targeting: {
 *       workspaces: ["acme-corp"],      // optional allowlist
 *       users: ["user-uuid"],           // optional allowlist
 *       percentage: 25,                 // 0-100; deterministic via hash(userId)
 *       startDate: "2026-01-01T00:00:00Z",  // optional
 *       endDate: "2026-12-31T23:59:59Z",    // optional
 *     },
 *     description: "Use new swarm engine",
 *     createdAt: "...",
 *     updatedAt: "...",
 *   }
 *
 * @module feature-flags
 */
import { createHash } from "node:crypto";

const CACHE_TTL_MS = 30_000;
const STORAGE_TYPE = "feature_flags";
const STORAGE_WORKSPACE = "default";
const STORAGE_USER = "system";

/** @type {Map<string, { value: any, expiresAt: number }>} */
const cache = new Map();

function evaluateTargeting(flag, ctx) {
  if (!flag || !flag.enabled) return false;
  const { workspaceId, userId } = ctx || {};
  const t = flag.targeting || {};

  // Date window
  const now = Date.now();
  if (t.startDate && now < new Date(t.startDate).getTime()) return false;
  if (t.endDate && now > new Date(t.endDate).getTime()) return false;

  // Workspace allowlist
  if (Array.isArray(t.workspaces) && t.workspaces.length > 0) {
    if (!workspaceId || !t.workspaces.includes(workspaceId)) return false;
    return true; // allowlist match short-circuits to true
  }

  // User allowlist
  if (Array.isArray(t.users) && t.users.length > 0) {
    if (userId && t.users.includes(userId)) return true;
    // Fall through to percentage / default
  }

  // Percentage rollout (deterministic)
  if (typeof t.percentage === "number" && t.percentage > 0 && t.percentage <= 100) {
    if (t.percentage === 100) return true;
    if (!userId) return false;
    const hash = createHash("sha256").update(`${flag.key}\0${userId}`).digest();
    const bucket = hash.readUInt32BE(0) % 100;
    return bucket < t.percentage;
  }

  // If a user allowlist was specified but didn't match and no percentage rollout, deny.
  if (Array.isArray(t.users) && t.users.length > 0) return false;

  // No targeting rules → enabled flag means everyone gets `value`
  return true;
}

function cacheKeyFor(key, ctx) {
  return `${key}\0${ctx?.workspaceId || ""}\0${ctx?.userId || ""}`;
}

export async function getFlag(storage, key, ctx) {
  const cKey = cacheKeyFor(key, ctx);
  const cached = cache.get(cKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const flag = await storage.getItem(STORAGE_TYPE, key, STORAGE_WORKSPACE, STORAGE_USER);
  if (!flag) {
    cache.set(cKey, { value: undefined, expiresAt: Date.now() + CACHE_TTL_MS });
    return undefined;
  }

  const matched = evaluateTargeting(flag, ctx);
  const result = matched ? flag.value : flag.defaultValue;
  cache.set(cKey, { value: result, expiresAt: Date.now() + CACHE_TTL_MS });
  return result;
}

export async function isEnabled(storage, key, ctx) {
  const v = await getFlag(storage, key, ctx);
  return v === true;
}

export async function listFlags(storage) {
  const items = await storage.listItems(STORAGE_TYPE, STORAGE_WORKSPACE, STORAGE_USER);
  return Array.isArray(items) ? items : [];
}

export async function setFlag(storage, key, definition) {
  if (!key || typeof key !== "string") {
    throw new Error("Flag key required");
  }
  const existing = await storage.getItem(STORAGE_TYPE, key, STORAGE_WORKSPACE, STORAGE_USER);
  const now = new Date().toISOString();
  const flag = {
    ...(existing || {}),
    ...(definition || {}),
    id: key,
    key,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };

  if (typeof storage.setItem === "function") {
    await storage.setItem(STORAGE_TYPE, key, flag, STORAGE_WORKSPACE, STORAGE_USER);
  } else if (typeof storage.add === "function") {
    await storage.add(STORAGE_TYPE, flag, STORAGE_WORKSPACE, true, STORAGE_USER);
  } else {
    throw new Error("Storage backend does not support setItem/add");
  }

  invalidateCache(key);
  return flag;
}

export async function deleteFlag(storage, key) {
  await storage.deleteItem(STORAGE_TYPE, key, STORAGE_WORKSPACE, STORAGE_USER);
  invalidateCache(key);
}

function invalidateCache(key) {
  for (const k of cache.keys()) {
    if (k.startsWith(`${key}\0`)) cache.delete(k);
  }
}

export function __resetCacheForTests() {
  cache.clear();
}

export { evaluateTargeting };
