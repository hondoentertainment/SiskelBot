/**
 * Redis KV storage backend — same logical paths as JSON/SQLite/Postgres.
 * Set STORAGE_BACKEND=redis and REDIS_URL (or UPSTASH_REDIS_URL).
 *
 * Values are JSON strings under key prefix `siskelbot:kv:`.
 * Durable on Vercel when backed by Upstash Redis.
 */
import { createClient } from "redis";

const KEY_PREFIX = "siskelbot:kv:";

let _client = null;
let _initPromise = null;
let _failed = false;

function redisUrl() {
  return (
    process.env.REDIS_URL?.trim() ||
    process.env.UPSTASH_REDIS_URL?.trim() ||
    process.env.KV_URL?.trim() ||
    ""
  );
}

export function redisKvEnabled() {
  return process.env.STORAGE_BACKEND?.trim()?.toLowerCase() === "redis" && Boolean(redisUrl());
}

async function ensureClient() {
  if (!redisKvEnabled() || _failed) return null;
  if (_client?.isOpen) return _client;
  if (!_initPromise) {
    _initPromise = (async () => {
      const client = createClient({ url: redisUrl() });
      client.on("error", (err) => {
        console.warn("[storage-redis-kv] client error:", err?.message || err);
      });
      await client.connect();
      _client = client;
      return client;
    })().catch((e) => {
      console.warn("[storage-redis-kv] Failed to init:", e.message);
      _failed = true;
      _initPromise = null;
      return null;
    });
  }
  return _initPromise;
}

function keyFor(filePath) {
  return `${KEY_PREFIX}${String(filePath)}`;
}

/**
 * @param {string} filePath
 * @returns {Promise<object|null>}
 */
export async function redisKvLoad(filePath) {
  try {
    const client = await ensureClient();
    if (!client) return null;
    const raw = await client.get(keyFor(filePath));
    if (raw == null) return null;
    return typeof raw === "object" ? raw : JSON.parse(String(raw));
  } catch (e) {
    console.warn("[storage-redis-kv] load failed:", e.message);
    return null;
  }
}

/**
 * @param {string} filePath
 * @param {object} data
 * @returns {Promise<boolean>}
 */
export async function redisKvSave(filePath, data) {
  try {
    const client = await ensureClient();
    if (!client) return false;
    await client.set(keyFor(filePath), JSON.stringify(data));
    return true;
  } catch (e) {
    console.warn("[storage-redis-kv] save failed:", e.message);
    return false;
  }
}

/** @returns {Promise<void>} */
export async function closeRedisKv() {
  if (_client?.isOpen) {
    await _client.quit().catch(() => {});
  }
  _client = null;
  _initPromise = null;
  _failed = false;
}

/**
 * @returns {Promise<Array<{ path: string, data: object }>>}
 */
export async function redisKvExportAll() {
  const client = await ensureClient();
  if (!client) return [];
  const out = [];
  for await (const key of client.scanIterator({ MATCH: `${KEY_PREFIX}*`, COUNT: 100 })) {
    const raw = await client.get(key);
    if (raw == null) continue;
    const path = String(key).slice(KEY_PREFIX.length);
    try {
      const data = typeof raw === "object" ? raw : JSON.parse(String(raw));
      if (data && typeof data === "object") out.push({ path, data });
    } catch {
      /* skip corrupt */
    }
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

/**
 * @param {Array<{ path: string, data: object }>} entries
 * @param {{ replaceAll?: boolean }} [opts]
 */
export async function redisKvImportSnapshot(entries, opts = {}) {
  const replaceAll = opts.replaceAll !== false;
  const client = await ensureClient();
  if (!client || !Array.isArray(entries)) return false;
  try {
    if (replaceAll) {
      const keys = [];
      for await (const key of client.scanIterator({ MATCH: `${KEY_PREFIX}*`, COUNT: 100 })) {
        keys.push(key);
      }
      if (keys.length) await client.del(keys);
    }
    for (const row of entries) {
      if (!row?.path || row.data == null || typeof row.data !== "object") continue;
      await client.set(keyFor(row.path), JSON.stringify(row.data));
    }
    return true;
  } catch (e) {
    console.warn("[storage-redis-kv] import snapshot failed:", e.message);
    return false;
  }
}
