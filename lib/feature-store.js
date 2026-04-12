/**
 * Phase 57.5: Feature store.
 *
 * A minimal online + offline feature store. Features are declared with a
 * name, type, and optional TTL. Online writes land in a hot key-value map
 * keyed by (feature, entity); offline writes append to a per-feature log
 * for later training-set reconstruction.
 *
 * Storage layout:
 *   data/feature-store/features/{feature}.json  — feature definition
 *   data/feature-store/online/{feature}.json    — online KV: { [entity]: { value, ts, expiresAt } }
 *   data/feature-store/offline/{feature}.json   — offline log: [{ entity, value, ts }]
 *   data/feature-store/_index.json              — known features
 */
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

export const FEATURE_TYPES = Object.freeze(["numeric", "categorical", "boolean", "string", "vector"]);

function sanitize(v) {
  return String(v || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || "default";
}

function featurePath(name) {
  return join(getDataDir(), "feature-store", "features", `${sanitize(name)}.json`);
}

function onlinePath(name) {
  return join(getDataDir(), "feature-store", "online", `${sanitize(name)}.json`);
}

function offlinePath(name) {
  return join(getDataDir(), "feature-store", "offline", `${sanitize(name)}.json`);
}

function indexPath() {
  return join(getDataDir(), "feature-store", "_index.json");
}

async function touchIndex(name) {
  return withPathLock(indexPath(), async () => {
    const idx = await readJsonPath(indexPath(), { features: [] });
    const list = Array.isArray(idx.features) ? idx.features : [];
    if (!list.includes(name)) {
      list.push(name);
      await writeJsonPath(indexPath(), { features: list });
    }
  });
}

function validateValue(type, value) {
  if (type === "numeric") return typeof value === "number" && Number.isFinite(value);
  if (type === "categorical" || type === "string") return typeof value === "string";
  if (type === "boolean") return typeof value === "boolean";
  if (type === "vector") return Array.isArray(value) && value.every((x) => typeof x === "number");
  return true;
}

/**
 * Define a new feature (or replace metadata on an existing one).
 *
 * @param {{ name: string, type: string, ttlMs?: number, description?: string }} def
 */
export async function defineFeature(def) {
  if (!def || !def.name) throw new Error("name is required");
  if (!FEATURE_TYPES.includes(def.type)) {
    throw new Error(`type must be one of ${FEATURE_TYPES.join(", ")}`);
  }
  const name = sanitize(def.name);
  const record = {
    name,
    type: def.type,
    ttlMs: Number(def.ttlMs) > 0 ? Number(def.ttlMs) : 0,
    description: def.description ? String(def.description).slice(0, 500) : "",
    createdAt: new Date().toISOString(),
  };
  await writeJsonPath(featurePath(name), record);
  await touchIndex(name);
  return record;
}

/**
 * Write a feature value for an entity. Always updates the online store; also
 * appends to the offline log when `options.offline !== false`.
 */
export async function writeFeature(name, entity, value, options = {}) {
  if (!name) throw new Error("name is required");
  if (!entity) throw new Error("entity is required");
  const def = await readJsonPath(featurePath(name), null);
  if (!def || !def.name) throw new Error(`feature ${name} not defined`);
  if (!validateValue(def.type, value)) {
    throw new Error(`value does not match feature type ${def.type}`);
  }
  const now = options.timestamp || Date.now();
  const expiresAt = def.ttlMs > 0 ? now + def.ttlMs : null;

  await withPathLock(onlinePath(name), async () => {
    const online = await readJsonPath(onlinePath(name), { values: {} });
    if (!online.values || typeof online.values !== "object") online.values = {};
    online.values[String(entity)] = { value, ts: now, expiresAt };
    await writeJsonPath(onlinePath(name), online);
  });

  if (options.offline !== false) {
    await withPathLock(offlinePath(name), async () => {
      const offline = await readJsonPath(offlinePath(name), { entries: [] });
      const entries = Array.isArray(offline.entries) ? offline.entries : [];
      entries.push({ entity: String(entity), value, ts: now });
      const maxOffline = Number(process.env.FEATURE_STORE_MAX_OFFLINE) || 100_000;
      const trimmed = entries.length > maxOffline ? entries.slice(-maxOffline) : entries;
      await writeJsonPath(offlinePath(name), { entries: trimmed });
    });
  }
  return { feature: name, entity: String(entity), value, ts: now, expiresAt };
}

/**
 * Read the latest online value for an entity. Returns null if expired or missing.
 */
export async function readFeature(name, entity, options = {}) {
  const online = await readJsonPath(onlinePath(name), { values: {} });
  const entry = online.values?.[String(entity)];
  if (!entry) return null;
  const now = options.now || Date.now();
  if (entry.expiresAt != null && entry.expiresAt < now) return null;
  return { feature: sanitize(name), entity: String(entity), ...entry };
}

/**
 * Read multiple features/entities at once. Input is an array of `{feature, entity}`.
 */
export async function batchRead(requests) {
  if (!Array.isArray(requests)) throw new Error("requests must be an array");
  const out = [];
  for (const r of requests) {
    if (!r || !r.feature || !r.entity) {
      out.push(null);
      continue;
    }
    out.push(await readFeature(r.feature, r.entity));
  }
  return out;
}

/**
 * List all defined features.
 */
export async function listFeatures() {
  const idx = await readJsonPath(indexPath(), { features: [] });
  const list = Array.isArray(idx.features) ? idx.features : [];
  const out = [];
  for (const name of list) {
    const rec = await readJsonPath(featurePath(name), null);
    if (rec && rec.name) out.push(rec);
  }
  return out;
}

/**
 * Fetch the offline log for training dataset construction. Supports
 * `since` / `until` timestamps and `limit`.
 */
export async function readOffline(name, options = {}) {
  const off = await readJsonPath(offlinePath(name), { entries: [] });
  let entries = Array.isArray(off.entries) ? off.entries.slice() : [];
  if (options.since) entries = entries.filter((e) => e.ts >= options.since);
  if (options.until) entries = entries.filter((e) => e.ts <= options.until);
  if (options.entity) entries = entries.filter((e) => e.entity === options.entity);
  if (options.limit) entries = entries.slice(-options.limit);
  return entries;
}

/**
 * Test helper.
 */
export async function _reset() {
  const idx = await readJsonPath(indexPath(), { features: [] });
  const list = Array.isArray(idx.features) ? idx.features : [];
  for (const name of list) {
    await writeJsonPath(featurePath(name), { _deleted: true });
    await writeJsonPath(onlinePath(name), { values: {} });
    await writeJsonPath(offlinePath(name), { entries: [] });
  }
  await writeJsonPath(indexPath(), { features: [] });
}

export const _internals = { validateValue, featurePath, onlinePath, offlinePath };
