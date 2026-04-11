// @ts-check
/**
 * Phase 66.4: Per-tenant encryption (simulated KMS).
 *
 * Each tenant is assigned an AES-256-GCM symmetric key. Keys can be
 * rotated (previous key is retained for decrypt); `encryptForTenant`
 * always uses the current key, while `decryptForTenant` looks up the
 * ciphertext's key id. Keys are base64-encoded in the persisted store
 * which should be treated as sensitive.
 *
 * Exports:
 *   - createTenantKey
 *   - rotateTenantKey
 *   - encryptForTenant
 *   - decryptForTenant
 *   - listKeys
 *   - deleteTenantKeys
 *
 * @module tenant-encryption
 */
import { join } from "path";
import { randomBytes, createCipheriv, createDecipheriv } from "crypto";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;
const ALGO = "aes-256-gcm";
const KEY_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;

function storePath() {
  return join(getDataDir(), "tenant-encryption.json");
}

function nowIso() {
  return new Date().toISOString();
}

function newKeyId() {
  return `k_${randomBytes(8).toString("hex")}`;
}

async function loadStore() {
  const data = await readJsonPath(storePath(), {
    version: STORE_VERSION,
    tenants: {},
  });
  if (!data.tenants || typeof data.tenants !== "object") data.tenants = {};
  return data;
}

async function saveStore(data) {
  await writeJsonPath(storePath(), {
    version: STORE_VERSION,
    tenants: data.tenants || {},
  });
}

function makeKeyRecord() {
  return {
    keyId: newKeyId(),
    keyBase64: randomBytes(KEY_LEN).toString("base64"),
    createdAt: nowIso(),
    status: "active",
  };
}

function decodeKey(record) {
  return Buffer.from(record.keyBase64, "base64");
}

/**
 * Create a fresh key for a tenant. Fails if one already exists.
 *
 * @param {string} tenantId
 * @returns {Promise<{tenantId: string, keyId: string, createdAt: string}>}
 */
export async function createTenantKey(tenantId) {
  if (!tenantId) throw new Error("tenantId required");
  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    if (data.tenants[tenantId]) {
      throw new Error(`tenant ${tenantId} already has keys`);
    }
    const rec = makeKeyRecord();
    data.tenants[tenantId] = {
      tenantId,
      currentKeyId: rec.keyId,
      keys: { [rec.keyId]: rec },
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    await saveStore(data);
    return { tenantId, keyId: rec.keyId, createdAt: rec.createdAt };
  });
}

/**
 * Rotate a tenant's key. Retains the old one as "retired" so previously
 * encrypted data can still be decrypted.
 *
 * @param {string} tenantId
 * @returns {Promise<{tenantId: string, newKeyId: string, previousKeyId: string}>}
 */
export async function rotateTenantKey(tenantId) {
  if (!tenantId) throw new Error("tenantId required");
  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    const t = data.tenants[tenantId];
    if (!t) throw new Error(`tenant ${tenantId} has no keys`);
    const previousKeyId = t.currentKeyId;
    if (t.keys[previousKeyId]) {
      t.keys[previousKeyId].status = "retired";
      t.keys[previousKeyId].retiredAt = nowIso();
    }
    const rec = makeKeyRecord();
    t.keys[rec.keyId] = rec;
    t.currentKeyId = rec.keyId;
    t.updatedAt = nowIso();
    data.tenants[tenantId] = t;
    await saveStore(data);
    return { tenantId, newKeyId: rec.keyId, previousKeyId };
  });
}

/**
 * Encrypt `plaintext` (string or Buffer) using the tenant's current key.
 *
 * @param {string} tenantId
 * @param {string | Buffer} plaintext
 * @returns {Promise<{keyId: string, iv: string, tag: string, ciphertext: string}>}
 */
export async function encryptForTenant(tenantId, plaintext) {
  if (!tenantId) throw new Error("tenantId required");
  if (plaintext == null) throw new Error("plaintext required");
  const data = await loadStore();
  const t = data.tenants[tenantId];
  if (!t) throw new Error(`tenant ${tenantId} has no keys`);
  const rec = t.keys[t.currentKeyId];
  if (!rec) throw new Error(`tenant ${tenantId} current key missing`);
  const key = decodeKey(rec);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const buf = typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext;
  const enc = Buffer.concat([cipher.update(buf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    keyId: rec.keyId,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: enc.toString("base64"),
  };
}

/**
 * Decrypt a previously encrypted payload using the bound keyId.
 *
 * @param {string} tenantId
 * @param {{keyId: string, iv: string, tag: string, ciphertext: string}} payload
 * @returns {Promise<string>}
 */
export async function decryptForTenant(tenantId, payload) {
  if (!tenantId) throw new Error("tenantId required");
  if (!payload || typeof payload !== "object") throw new Error("payload required");
  if (!payload.keyId || !payload.iv || !payload.tag || !payload.ciphertext) {
    throw new Error("malformed payload");
  }
  const data = await loadStore();
  const t = data.tenants[tenantId];
  if (!t) throw new Error(`tenant ${tenantId} has no keys`);
  const rec = t.keys[payload.keyId];
  if (!rec) throw new Error(`key ${payload.keyId} not found for tenant`);
  const key = decodeKey(rec);
  const iv = Buffer.from(payload.iv, "base64");
  const tag = Buffer.from(payload.tag, "base64");
  if (tag.length !== TAG_LEN) throw new Error("invalid auth tag length");
  const ciphertext = Buffer.from(payload.ciphertext, "base64");
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return dec.toString("utf8");
}

/**
 * List keys for a tenant (metadata only — not the raw key bytes).
 *
 * @param {string} [tenantId] - if omitted, returns all tenants.
 * @returns {Promise<Array<{tenantId: string, currentKeyId: string, keys: Array<{keyId: string, status: string, createdAt: string, retiredAt?: string}>}>>}
 */
export async function listKeys(tenantId) {
  const data = await loadStore();
  const tenants = Object.values(data.tenants || {});
  const filtered = tenantId ? tenants.filter((t) => t.tenantId === tenantId) : tenants;
  return filtered.map((t) => ({
    tenantId: t.tenantId,
    currentKeyId: t.currentKeyId,
    keys: Object.values(t.keys || {}).map((k) => ({
      keyId: k.keyId,
      status: k.status,
      createdAt: k.createdAt,
      retiredAt: k.retiredAt,
    })),
  }));
}

/**
 * Delete all keys for a tenant (irreversibly destroys ability to
 * decrypt their data). Useful for GDPR crypto-shredding.
 *
 * @param {string} tenantId
 * @returns {Promise<boolean>}
 */
export async function deleteTenantKeys(tenantId) {
  if (!tenantId) return false;
  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    if (!data.tenants[tenantId]) return false;
    delete data.tenants[tenantId];
    await saveStore(data);
    return true;
  });
}
