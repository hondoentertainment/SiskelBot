/**
 * Local file-based encrypted secret provider.
 *
 * Stores secrets in data/secrets-local.json encrypted with AES-256-GCM using
 * SECRET_STORE_KEY (32 bytes, base64 or hex). When the key is not set, a
 * development fallback key derived from SESSION_SECRET is used; this should
 * NOT be relied upon in production.
 *
 * Each entry has the shape:
 *   { id, ciphertext, iv, tag, version, updatedAt }
 *
 * Exports: getSecret(id), setSecret(id, value), deleteSecret(id), listSecrets()
 */
import { join } from "path";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "../json-path-store.js";

const STORE_VERSION = 1;
const ALGO = "aes-256-gcm";

function storePath() {
  return join(getDataDir(), "secrets-local.json");
}

function deriveKey() {
  const raw = process.env.SECRET_STORE_KEY;
  if (raw && raw.trim()) {
    const trimmed = raw.trim();
    // Try base64 first (44 chars for 32 bytes), then hex (64 chars for 32 bytes).
    try {
      const buf = Buffer.from(trimmed, "base64");
      if (buf.length === 32) return buf;
    } catch {}
    try {
      const buf = Buffer.from(trimmed, "hex");
      if (buf.length === 32) return buf;
    } catch {}
    // Fallback: hash string directly to 32 bytes.
    return createHash("sha256").update(trimmed).digest();
  }
  const seed = process.env.SESSION_SECRET || "siskelbot-local-secret-fallback";
  return createHash("sha256").update(String(seed)).digest();
}

function encrypt(plaintext) {
  const key = deriveKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: enc.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
  };
}

function decrypt(entry) {
  if (!entry || !entry.ciphertext || !entry.iv || !entry.tag) return null;
  const key = deriveKey();
  const iv = Buffer.from(entry.iv, "base64");
  const tag = Buffer.from(entry.tag, "base64");
  const ciphertext = Buffer.from(entry.ciphertext, "base64");
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return dec.toString("utf8");
}

async function loadAll() {
  const data = await readJsonPath(storePath(), { _version: STORE_VERSION, items: {} });
  if (!data.items || typeof data.items !== "object") data.items = {};
  return data;
}

export async function getSecret(id) {
  if (!id) throw new Error("getSecret: id required");
  const data = await loadAll();
  const entry = data.items[id];
  if (!entry) return null;
  try {
    const value = decrypt(entry);
    return { id, value, version: entry.version || 1, updatedAt: entry.updatedAt };
  } catch (e) {
    throw new Error(`Failed to decrypt secret ${id}: ${e.message}`);
  }
}

export async function setSecret(id, value) {
  if (!id) throw new Error("setSecret: id required");
  if (value == null) throw new Error("setSecret: value required");
  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadAll();
    const existing = data.items[id];
    const nextVersion = existing ? (existing.version || 1) + 1 : 1;
    const enc = encrypt(value);
    data.items[id] = {
      id,
      ...enc,
      version: nextVersion,
      updatedAt: new Date().toISOString(),
    };
    data._version = STORE_VERSION;
    await writeJsonPath(path, data);
    return { id, version: nextVersion, updatedAt: data.items[id].updatedAt };
  });
}

export async function deleteSecret(id) {
  if (!id) throw new Error("deleteSecret: id required");
  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadAll();
    if (!data.items[id]) return false;
    delete data.items[id];
    data._version = STORE_VERSION;
    await writeJsonPath(path, data);
    return true;
  });
}

export async function listSecrets() {
  const data = await loadAll();
  return Object.values(data.items).map((e) => ({
    id: e.id,
    version: e.version || 1,
    updatedAt: e.updatedAt,
  }));
}
