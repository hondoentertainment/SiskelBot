/**
 * Phase 30: API key store for data/api-keys.json.
 * Phase 68: Durable store via json-path-store; Postgres uses in-memory cache warmed at startup.
 */
import { join } from "path";
import { createHash, randomBytes as nodeRandomBytes } from "crypto";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir, readJsonPathSync } from "./json-path-store.js";
import { postgresKvEnabled } from "./storage-postgres-kv.js";

const DEFAULT_SCOPES = ["read", "write"];
const VALID_SCOPES = new Set(["read", "write", "admin", "embed"]);

/** @type {Array<object> | null} */
let _pgKeysCache = null;

function apiKeysPath() {
  return join(getDataDir(), "api-keys.json");
}

function parseKeys(data) {
  return Array.isArray(data?.keys) ? data.keys : [];
}

/**
 * Phase 68: Load keys from Postgres into memory before rate limiting / isAuthConfigured.
 */
export async function warmApiKeysCache() {
  if (!postgresKvEnabled()) return;
  const data = await readJsonPath(apiKeysPath(), { keys: [] });
  _pgKeysCache = parseKeys(data);
}

export function _resetApiKeysCacheForTesting() {
  _pgKeysCache = null;
}

function hashKey(key) {
  return createHash("sha256").update(String(key)).digest("hex");
}

function maskKey(key) {
  if (!key || key.length < 8) return "****";
  return key.slice(0, 4) + "****" + key.slice(-4);
}

/**
 * @returns {Array<{ id: string, keyHash: string, userId: string, scopes: string[], createdAt: string }>}
 */
export function loadApiKeys() {
  if (postgresKvEnabled()) {
    return _pgKeysCache ?? [];
  }
  const data = readJsonPathSync(apiKeysPath(), { keys: [] });
  return parseKeys(data);
}

/**
 * Find key info by raw key (for auth lookup).
 * @param {string} rawKey
 * @returns {{ id: string, userId: string, scopes: string[] } | null}
 */
export function findKeyByRaw(rawKey) {
  if (!rawKey || typeof rawKey !== "string") return null;
  const keyHash = hashKey(rawKey);
  const keys = loadApiKeys();
  const entry = keys.find((k) => k.keyHash === keyHash);
  if (!entry) return null;
  return { id: entry.id, userId: entry.userId, scopes: entry.scopes || DEFAULT_SCOPES };
}

/**
 * List keys for admin (masked, no raw keys).
 */
export function listKeysForAdmin() {
  const keys = loadApiKeys();
  return keys.map((k) => ({
    id: k.id,
    masked: k.masked || "****",
    userId: k.userId,
    scopes: k.scopes || DEFAULT_SCOPES,
    createdAt: k.createdAt,
  }));
}

/**
 * Add a new API key. Returns raw key only on creation.
 * @param {{ userId: string, scopes?: string[] }} opts
 * @returns {Promise<{ ok: boolean, id?: string, key?: string, masked?: string, error?: string }>}
 */
export async function addKey(opts) {
  const userId = opts?.userId?.trim();
  if (!userId) return { ok: false, error: "userId required" };

  let scopes = Array.isArray(opts?.scopes) ? opts.scopes : DEFAULT_SCOPES;
  scopes = scopes
    .map((s) => String(s).trim().toLowerCase())
    .filter((s) => VALID_SCOPES.has(s));
  if (scopes.length === 0) scopes = DEFAULT_SCOPES;

  const rawKey = "sk-" + nodeRandomBytes(24).toString("hex");
  const keyHash = hashKey(rawKey);
  const id = `key_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

  const path = apiKeysPath();
  return withPathLock(path, async () => {
    const data = await readJsonPath(path, { keys: [], _version: 1 });
    const keys = parseKeys(data);
    const entry = {
      id,
      keyHash,
      masked: maskKey(rawKey),
      userId,
      scopes,
      createdAt: new Date().toISOString(),
    };
    keys.push(entry);
    await writeJsonPath(path, { keys, _version: 1 });
    if (postgresKvEnabled()) _pgKeysCache = keys;
    return { ok: true, id, key: rawKey, masked: maskKey(rawKey) };
  });
}

/**
 * Revoke (remove) an API key by id.
 * @param {string} keyId
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function revokeKey(keyId) {
  const id = keyId?.trim();
  if (!id) return { ok: false, error: "keyId required" };

  const path = apiKeysPath();
  return withPathLock(path, async () => {
    const data = await readJsonPath(path, { keys: [], _version: 1 });
    const all = parseKeys(data);
    const keys = all.filter((k) => k.id !== id);
    if (keys.length === all.length) return { ok: false, error: "Key not found" };
    await writeJsonPath(path, { keys, _version: 1 });
    if (postgresKvEnabled()) _pgKeysCache = keys;
    return { ok: true };
  });
}
