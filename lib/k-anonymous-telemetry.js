/**
 * Phase 72.4: k-anonymous telemetry.
 *
 * Event aggregation that only emits buckets (combinations of dimensions)
 * backed by at least k distinct users. Buckets below the threshold are
 * suppressed entirely so no single-user telemetry escapes the aggregation
 * boundary.
 *
 * Storage layout:
 *   data/k-telemetry/config.json            — { k }
 *   data/k-telemetry/{eventName}.json       — { buckets: { [bucketKey]: { dimensions, users: [userId], count } } }
 *   data/k-telemetry/_index.json            — { events: [eventName] }
 */
import { join } from "path";
import { createHash } from "crypto";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const DEFAULT_K = 5;

function sanitizeId(val, fallback = "default") {
  if (typeof val !== "string" || !val.trim()) return fallback;
  return val.trim().replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || fallback;
}

function configPath() {
  return join(getDataDir(), "k-telemetry", "config.json");
}

function eventPath(eventName) {
  return join(getDataDir(), "k-telemetry", `${sanitizeId(eventName, "event")}.json`);
}

function indexPath() {
  return join(getDataDir(), "k-telemetry", "_index.json");
}

function hashBucket(dimensions) {
  const obj = dimensions && typeof dimensions === "object" ? dimensions : {};
  const keys = Object.keys(obj).sort();
  const pairs = keys.map((k) => `${k}=${obj[k] == null ? "" : String(obj[k])}`);
  const hash = createHash("sha256").update(pairs.join("|")).digest("hex").slice(0, 16);
  return hash;
}

function normalizeDimensions(dimensions) {
  if (!dimensions || typeof dimensions !== "object") return {};
  const out = {};
  for (const k of Object.keys(dimensions).sort()) {
    const v = dimensions[k];
    if (v === null || v === undefined) continue;
    out[k] = String(v).slice(0, 200);
  }
  return out;
}

export async function setKThreshold(k) {
  const n = Math.max(1, Math.min(10000, Math.floor(Number(k) || DEFAULT_K)));
  await withPathLock(configPath(), async () => {
    await writeJsonPath(configPath(), { k: n });
  });
  return n;
}

export async function getKThreshold() {
  const cfg = await readJsonPath(configPath(), { k: DEFAULT_K });
  const n = Number(cfg.k);
  return Number.isFinite(n) && n >= 1 ? n : DEFAULT_K;
}

async function indexEvent(eventName) {
  const ev = sanitizeId(eventName, "event");
  await withPathLock(indexPath(), async () => {
    const idx = await readJsonPath(indexPath(), { events: [] });
    const list = Array.isArray(idx.events) ? idx.events : [];
    if (!list.includes(ev)) {
      list.push(ev);
      await writeJsonPath(indexPath(), { events: list });
    }
  });
}

export async function recordEvent({ eventName, dimensions, userId } = {}) {
  if (!eventName || typeof eventName !== "string") throw new Error("eventName is required");
  if (!userId || typeof userId !== "string") throw new Error("userId is required");
  const ev = sanitizeId(eventName, "event");
  const dims = normalizeDimensions(dimensions);
  const key = hashBucket(dims);
  const file = eventPath(ev);
  let updated;
  await withPathLock(file, async () => {
    const data = await readJsonPath(file, { buckets: {} });
    data.buckets = data.buckets && typeof data.buckets === "object" ? data.buckets : {};
    const existing = data.buckets[key] || { bucketKey: key, dimensions: dims, users: [], count: 0 };
    if (!existing.users.includes(userId)) existing.users.push(userId);
    existing.count += 1;
    existing.lastSeenAt = Date.now();
    data.buckets[key] = existing;
    await writeJsonPath(file, data);
    updated = { bucketKey: key, count: existing.count, uniqueUsers: existing.users.length };
  });
  await indexEvent(ev);
  return updated;
}

export async function aggregate({ eventName, dimensions, k } = {}) {
  if (!eventName) throw new Error("eventName is required");
  const ev = sanitizeId(eventName, "event");
  const threshold = k == null ? await getKThreshold() : Math.max(1, Math.floor(Number(k)));
  const data = await readJsonPath(eventPath(ev), { buckets: {} });
  const all = Object.values(data.buckets || {});
  const filterDims = normalizeDimensions(dimensions);
  const hasFilter = Object.keys(filterDims).length > 0;
  const filtered = [];
  for (const b of all) {
    if (hasFilter) {
      let match = true;
      for (const fk of Object.keys(filterDims)) {
        if (b.dimensions?.[fk] !== filterDims[fk]) {
          match = false;
          break;
        }
      }
      if (!match) continue;
    }
    const uniqueUsers = Array.isArray(b.users) ? b.users.length : 0;
    if (uniqueUsers < threshold) continue;
    filtered.push({
      bucketKey: b.bucketKey,
      dimensions: b.dimensions || {},
      count: b.count || 0,
      uniqueUsers,
    });
  }
  filtered.sort((a, b) => b.count - a.count);
  return {
    eventName: ev,
    k: threshold,
    buckets: filtered,
    totalSuppressed: all.length - filtered.length,
  };
}

export async function listBuckets(eventName) {
  if (!eventName) return [];
  const ev = sanitizeId(eventName, "event");
  const data = await readJsonPath(eventPath(ev), { buckets: {} });
  return Object.values(data.buckets || {}).map((b) => ({
    bucketKey: b.bucketKey,
    dimensions: b.dimensions || {},
    count: b.count || 0,
    uniqueUsers: Array.isArray(b.users) ? b.users.length : 0,
  }));
}

export async function _reset() {
  const idx = await readJsonPath(indexPath(), { events: [] });
  const list = Array.isArray(idx.events) ? idx.events : [];
  for (const ev of list) {
    await writeJsonPath(eventPath(ev), { buckets: {} });
  }
  await writeJsonPath(indexPath(), { events: [] });
  await writeJsonPath(configPath(), { k: DEFAULT_K });
}

export const _internals = { sanitizeId, eventPath, indexPath, configPath, hashBucket, normalizeDimensions, DEFAULT_K };
