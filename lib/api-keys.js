/**
 * Phase 30: API key store for data/api-keys.json.
 * Keys are stored as { id, keyHash, userId, scopes, createdAt }.
 * Raw keys are only returned on creation; after that only masked id is available.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createHash, randomBytes as nodeRandomBytes } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.STORAGE_PATH || join(process.cwd(), "data");
const API_KEYS_PATH = join(DATA_DIR, "api-keys.json");

const DEFAULT_SCOPES = ["read", "write"];
const VALID_SCOPES = new Set(["read", "write", "admin", "embed"]);

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function hashKey(key) {
  return createHash("sha256").update(String(key)).digest("hex");
}

function maskKey(key) {
  if (!key || key.length < 8) return "****";
  return key.slice(0, 4) + "****" + key.slice(-4);
}

/**
 * Load keys from data/api-keys.json.
 * @returns {Array<{ id: string, keyHash: string, userId: string, scopes: string[], createdAt: string }>}
 */
export function loadApiKeys() {
  try {
    if (existsSync(API_KEYS_PATH)) {
      const raw = readFileSync(API_KEYS_PATH, "utf8");
      const data = JSON.parse(raw);
      return Array.isArray(data.keys) ? data.keys : [];
    }
  } catch (e) {
    console.warn("[api-keys] Failed to load api-keys.json:", e.message);
  }
  return [];
}

/**
 * Save keys to data/api-keys.json.
 * @param {Array} keys
 */
function saveApiKeys(keys) {
  ensureDataDir();
  writeFileSync(API_KEYS_PATH, JSON.stringify({ keys, _version: 1 }, null, 2), "utf8");
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
 * @returns {Array<{ id: string, masked: string, userId: string, scopes: string[], createdAt: string }>}
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
 * @returns {{ ok: boolean, id?: string, key?: string, masked?: string, error?: string }}
 */
export function addKey(opts) {
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

  const keys = loadApiKeys();
  const entry = {
    id,
    keyHash,
    masked: maskKey(rawKey),
    userId,
    scopes,
    createdAt: new Date().toISOString(),
  };
  keys.push(entry);
  saveApiKeys(keys);

  return { ok: true, id, key: rawKey, masked: maskKey(rawKey) };
}

/**
 * Revoke (remove) an API key by id.
 * @param {string} keyId
 * @returns {{ ok: boolean, error?: string }}
 */
export function revokeKey(keyId) {
  const id = keyId?.trim();
  if (!id) return { ok: false, error: "keyId required" };

  const all = loadApiKeys();
  const keys = all.filter((k) => k.id !== id);
  if (keys.length === all.length) return { ok: false, error: "Key not found" };
  saveApiKeys(keys);
  return { ok: true };
}
