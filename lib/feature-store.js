// @ts-check
/**
 * Phase 57.5: Feature store.
 *
 * A thin online/offline feature store. Features are registered with a
 * name, type, and optional TTL. Writes land in both an "online" map
 * keyed by `(feature, entityId)` and an append-only "offline" log
 * suitable for training-time reconstruction. Online reads honor TTLs;
 * the offline log retains every write.
 *
 * Exports:
 *   - registerFeature(spec)
 *   - writeFeature(name, entityId, value, opts?)
 *   - readFeature(name, entityId, opts?)
 *   - listFeatures()
 *   - batchReadFeatures(names, entityId)
 *   - getOfflineHistory(name, entityId)
 *   - deleteFeature(name)
 *
 * @module feature-store
 */
import { join } from "path";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h

function storePath() {
  return join(getDataDir(), "feature-store.json");
}

function now() {
  return new Date().toISOString();
}

/* -------------------------------------------------------------------------- */
/* Store                                                                      */
/* -------------------------------------------------------------------------- */

async function loadStore() {
  const raw = await readJsonPath(storePath(), {
    version: STORE_VERSION,
    features: {},
    online: {},
    offline: {},
  });
  if (!raw || typeof raw !== "object") {
    return { version: STORE_VERSION, features: {}, online: {}, offline: {} };
  }
  if (!raw.features || typeof raw.features !== "object") raw.features = {};
  if (!raw.online || typeof raw.online !== "object") raw.online = {};
  if (!raw.offline || typeof raw.offline !== "object") raw.offline = {};
  raw.version = STORE_VERSION;
  return raw;
}

async function saveStore(store) {
  await writeJsonPath(storePath(), {
    version: STORE_VERSION,
    features: store.features || {},
    online: store.online || {},
    offline: store.offline || {},
  });
}

/* -------------------------------------------------------------------------- */
/* Type validation                                                            */
/* -------------------------------------------------------------------------- */

function validateValue(type, value) {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return value && typeof value === "object" && !Array.isArray(value);
    case "any":
    default:
      return value !== undefined;
  }
}

/* -------------------------------------------------------------------------- */
/* Registration                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Register a feature specification.
 * @param {object} spec
 * @param {string} spec.name
 * @param {string} [spec.type]
 * @param {number} [spec.ttlMs]
 * @param {string} [spec.description]
 * @param {any} [spec.defaultValue]
 */
export async function registerFeature(spec) {
  if (!spec || typeof spec !== "object") throw new Error("spec required");
  const name = typeof spec.name === "string" && spec.name.trim() ? spec.name.trim() : "";
  if (!name) throw new Error("feature name required");
  const type = spec.type || "any";
  if (!["string", "number", "boolean", "array", "object", "any"].includes(type)) {
    throw new Error(`unknown feature type "${type}"`);
  }
  const ttlMs = Number.isFinite(spec.ttlMs) && spec.ttlMs > 0 ? Math.floor(spec.ttlMs) : DEFAULT_TTL_MS;
  return withPathLock(storePath(), async () => {
    const store = await loadStore();
    store.features[name] = {
      name,
      type,
      ttlMs,
      description: typeof spec.description === "string" ? spec.description : "",
      defaultValue: spec.defaultValue !== undefined ? spec.defaultValue : null,
      createdAt: store.features[name]?.createdAt || now(),
      updatedAt: now(),
      version: 1,
    };
    await saveStore(store);
    return store.features[name];
  });
}

/** List all registered features. */
export async function listFeatures() {
  const store = await loadStore();
  return Object.values(store.features || {});
}

/** Delete a feature and all its online/offline data. */
export async function deleteFeature(name) {
  if (!name) throw new Error("name required");
  return withPathLock(storePath(), async () => {
    const store = await loadStore();
    if (!store.features[name]) return false;
    delete store.features[name];
    if (store.online[name]) delete store.online[name];
    if (store.offline[name]) delete store.offline[name];
    await saveStore(store);
    return true;
  });
}

/* -------------------------------------------------------------------------- */
/* Writes                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Write a feature value for an entity. Stores in online + offline.
 * @param {string} name
 * @param {string} entityId
 * @param {any} value
 * @param {object} [opts]
 */
export async function writeFeature(name, entityId, value, opts = {}) {
  if (!name || !entityId) throw new Error("name and entityId required");
  return withPathLock(storePath(), async () => {
    const store = await loadStore();
    const spec = store.features[name];
    if (!spec) throw new Error(`unknown feature "${name}"`);
    if (!validateValue(spec.type, value)) {
      throw new Error(`value does not match feature type "${spec.type}"`);
    }
    const ts = opts && typeof opts.timestamp === "string" ? opts.timestamp : now();
    store.online[name] = store.online[name] || {};
    store.online[name][entityId] = { value, at: ts };
    store.offline[name] = store.offline[name] || {};
    store.offline[name][entityId] = store.offline[name][entityId] || [];
    store.offline[name][entityId].push({ value, at: ts });
    if (store.offline[name][entityId].length > 1000) {
      store.offline[name][entityId] = store.offline[name][entityId].slice(-1000);
    }
    await saveStore(store);
    return { name, entityId, value, at: ts };
  });
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

function isExpired(spec, at) {
  if (!spec || !spec.ttlMs || !at) return false;
  const written = new Date(at).getTime();
  if (!Number.isFinite(written)) return false;
  return (Date.now() - written) > spec.ttlMs;
}

/**
 * Read a feature value for an entity. Honors TTL. Returns
 * `defaultValue` if the feature is unset or expired.
 * @param {string} name
 * @param {string} entityId
 * @param {object} [opts]
 */
export async function readFeature(name, entityId, opts = {}) {
  if (!name || !entityId) throw new Error("name and entityId required");
  const store = await loadStore();
  const spec = store.features[name];
  if (!spec) throw new Error(`unknown feature "${name}"`);
  const row = store.online[name]?.[entityId];
  if (!row) {
    return { name, entityId, value: spec.defaultValue, fresh: false, at: null };
  }
  const expired = isExpired(spec, row.at);
  if (expired && !opts.allowStale) {
    return { name, entityId, value: spec.defaultValue, fresh: false, at: row.at, expired: true };
  }
  return { name, entityId, value: row.value, fresh: !expired, at: row.at, expired };
}

/**
 * Batch read multiple features for one entity.
 * @param {string[]} names
 * @param {string} entityId
 */
export async function batchReadFeatures(names, entityId) {
  if (!Array.isArray(names)) throw new Error("names array required");
  if (!entityId) throw new Error("entityId required");
  const out = /** @type {Record<string, any>} */ ({});
  for (const n of names) {
    try {
      out[n] = await readFeature(n, entityId);
    } catch (err) {
      out[n] = { name: n, entityId, value: null, error: err?.message || String(err) };
    }
  }
  return out;
}

/**
 * Get the offline write history for a feature/entity (for training).
 * @param {string} name
 * @param {string} entityId
 */
export async function getOfflineHistory(name, entityId) {
  if (!name || !entityId) throw new Error("name and entityId required");
  const store = await loadStore();
  if (!store.features[name]) throw new Error(`unknown feature "${name}"`);
  return Array.isArray(store.offline[name]?.[entityId])
    ? store.offline[name][entityId].slice()
    : [];
}
