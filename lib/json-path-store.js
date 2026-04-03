/**
 * Phase 68: Durable JSON at arbitrary paths (same keys as on-disk files).
 * Routes through PostgreSQL KV → SQLite KV → JSON files when enabled, matching lib/storage.js.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { sqliteKvLoad, sqliteKvSave, sqliteKvEnabled } from "./storage-sqlite-kv.js";
import { postgresKvLoad, postgresKvSave, postgresKvEnabled } from "./storage-postgres-kv.js";

const locks = new Map();

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function getDataDir() {
  const dir = process.env.STORAGE_PATH || join(process.cwd(), "data");
  ensureDir(dir);
  return dir;
}

function cloneDefault(value) {
  if (value === undefined || value === null) return {};
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value));
  }
}

/**
 * @param {string} absPath - logical path (same string used for file and KV key)
 * @param {object} [defaultValue]
 * @returns {Promise<object>}
 */
export async function readJsonPath(absPath, defaultValue = null) {
  const fallback = () => cloneDefault(defaultValue ?? {});

  if (postgresKvEnabled()) {
    const fromPg = await postgresKvLoad(absPath);
    if (fromPg != null && typeof fromPg === "object") return fromPg;
    return fallback();
  }
  if (sqliteKvEnabled()) {
    const fromSql = sqliteKvLoad(absPath, getDataDir);
    if (fromSql != null && typeof fromSql === "object") return fromSql;
    return fallback();
  }
  try {
    if (existsSync(absPath)) {
      const raw = readFileSync(absPath, "utf8");
      return JSON.parse(raw);
    }
  } catch (e) {
    console.warn("[json-path-store] Failed to load", absPath, e.message);
  }
  return fallback();
}

/**
 * @param {string} absPath
 * @param {object} data
 * @returns {Promise<void>}
 */
export async function writeJsonPath(absPath, data) {
  if (postgresKvEnabled()) {
    const ok = await postgresKvSave(absPath, data);
    if (!ok) console.error("[json-path-store] Postgres save failed for", absPath);
    return;
  }
  if (sqliteKvEnabled() && sqliteKvSave(absPath, data, getDataDir)) {
    return;
  }
  ensureDir(dirname(absPath));
  writeFileSync(absPath, JSON.stringify(data, null, 0), "utf8");
}

/**
 * Serialize read-modify-write for a given path (same key as storage withLock).
 * @param {string} absPath
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function withPathLock(absPath, fn) {
  let queue = locks.get(absPath);
  if (!queue) {
    queue = Promise.resolve();
    locks.set(absPath, queue);
  }
  // Use .then(fn, () => fn()) so the queue always advances even if a prior call threw.
  // Store a settled version on the queue so the next caller can always proceed.
  let resolve, reject;
  const result = new Promise((res, rej) => { resolve = res; reject = rej; });
  const settled = queue.then(() => fn(), () => fn()).then(
    (val) => { resolve(val); },
    (err) => { reject(err); },
  );
  // The queue itself must never reject, so the next caller can always run.
  locks.set(absPath, settled.catch(() => {}));
  return result;
}

/**
 * Sync read when STORAGE_BACKEND≠postgres (file or SQLite KV). Used on hot paths that cannot await.
 */
export function readJsonPathSync(absPath, defaultValue = null) {
  if (postgresKvEnabled()) {
    throw new Error("readJsonPathSync is not available when STORAGE_BACKEND=postgres; use readJsonPath");
  }
  const fallback = () => cloneDefault(defaultValue ?? {});
  if (sqliteKvEnabled()) {
    const fromSql = sqliteKvLoad(absPath, getDataDir);
    if (fromSql != null && typeof fromSql === "object") return fromSql;
    return fallback();
  }
  try {
    if (existsSync(absPath)) {
      const raw = readFileSync(absPath, "utf8");
      return JSON.parse(raw);
    }
  } catch (e) {
    console.warn("[json-path-store] Failed to load (sync)", absPath, e.message);
  }
  return fallback();
}

/**
 * Sync write when STORAGE_BACKEND≠postgres.
 */
export function writeJsonPathSync(absPath, data) {
  if (postgresKvEnabled()) {
    throw new Error("writeJsonPathSync is not available when STORAGE_BACKEND=postgres; use writeJsonPath");
  }
  if (sqliteKvEnabled() && sqliteKvSave(absPath, data, getDataDir)) {
    return;
  }
  ensureDir(dirname(absPath));
  writeFileSync(absPath, JSON.stringify(data, null, 0), "utf8");
}
