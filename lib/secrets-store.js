import { randomUUID, createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const MAX_SECRETS_PER_SCOPE = 100;
const ALGORITHM = "aes-256-gcm";

let _derivedKey = null;

function getEncryptionKey() {
  if (_derivedKey) return _derivedKey;
  const raw = process.env.SECRETS_ENCRYPTION_KEY;
  if (!raw) {
    console.warn(
      "[secrets-store] SECRETS_ENCRYPTION_KEY is not set — using insecure dev key. DO NOT use in production."
    );
    _derivedKey = scryptSync("dev-insecure-key-siskelbot", "siskelbot-salt", 32);
  } else {
    _derivedKey = scryptSync(raw, "siskelbot-salt", 32);
  }
  return _derivedKey;
}

function scopePath(scopeType, scopeId) {
  return join(getDataDir(), "secrets", `${scopeType}-${scopeId}.json`);
}

function encrypt(plaintext) {
  const key = getEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    encryptedValue: encrypted.toString("hex"),
    iv: iv.toString("hex"),
    authTag: authTag.toString("hex"),
  };
}

function decrypt(encryptedValue, iv, authTag) {
  const key = getEncryptionKey();
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, "hex"));
  decipher.setAuthTag(Buffer.from(authTag, "hex"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedValue, "hex")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

function stripSensitive(record) {
  const { encryptedValue: _e, iv: _i, authTag: _a, ...safe } = record;
  return safe;
}

export async function setSecret(scopeType, scopeId, name, value, description = "") {
  const path = scopePath(scopeType, scopeId);
  return withPathLock(path, async () => {
    const store = await readJsonPath(path, { secrets: [] });
    if (!Array.isArray(store.secrets)) store.secrets = [];

    const existing = store.secrets.find((s) => s.name === name);
    if (!existing && store.secrets.length >= MAX_SECRETS_PER_SCOPE) {
      throw new Error(`MAX_SECRETS_PER_SCOPE (${MAX_SECRETS_PER_SCOPE}) reached for scope ${scopeType}:${scopeId}`);
    }

    const { encryptedValue, iv, authTag } = encrypt(value);
    const now = Date.now();

    if (existing) {
      existing.encryptedValue = encryptedValue;
      existing.iv = iv;
      existing.authTag = authTag;
      existing.updatedAt = now;
      existing.description = description;
      await writeJsonPath(path, store);
      return stripSensitive(existing);
    }

    const record = {
      secretId: randomUUID(),
      scopeType,
      scopeId,
      name,
      encryptedValue,
      iv,
      authTag,
      createdAt: now,
      updatedAt: now,
      description,
    };
    store.secrets.push(record);
    await writeJsonPath(path, store);
    return stripSensitive(record);
  });
}

export async function getSecretValue(scopeType, scopeId, name) {
  const path = scopePath(scopeType, scopeId);
  const store = await readJsonPath(path, { secrets: [] });
  if (!Array.isArray(store.secrets)) return null;
  const record = store.secrets.find((s) => s.name === name);
  if (!record) return null;
  try {
    return decrypt(record.encryptedValue, record.iv, record.authTag);
  } catch {
    return null;
  }
}

export async function listSecrets(scopeType, scopeId) {
  const path = scopePath(scopeType, scopeId);
  const store = await readJsonPath(path, { secrets: [] });
  if (!Array.isArray(store.secrets)) return [];
  return store.secrets.map(stripSensitive);
}

export async function deleteSecret(scopeType, scopeId, name) {
  const path = scopePath(scopeType, scopeId);
  return withPathLock(path, async () => {
    const store = await readJsonPath(path, { secrets: [] });
    if (!Array.isArray(store.secrets)) return { deleted: false };
    const idx = store.secrets.findIndex((s) => s.name === name);
    if (idx === -1) return { deleted: false };
    store.secrets.splice(idx, 1);
    await writeJsonPath(path, store);
    return { deleted: true };
  });
}

export async function injectSecretsIntoEnv(scopeType, scopeId) {
  const path = scopePath(scopeType, scopeId);
  const store = await readJsonPath(path, { secrets: [] });
  if (!Array.isArray(store.secrets)) return {};
  const result = {};
  for (const record of store.secrets) {
    try {
      result[record.name] = decrypt(record.encryptedValue, record.iv, record.authTag);
    } catch {
      // skip secrets that fail to decrypt
    }
  }
  return result;
}

export async function resolveSessionSecrets(orgId, workspaceId, sessionId) {
  const [orgEnv, wsEnv, sessionEnv] = await Promise.all([
    injectSecretsIntoEnv("org", orgId),
    injectSecretsIntoEnv("workspace", workspaceId),
    injectSecretsIntoEnv("session", sessionId),
  ]);
  return { ...orgEnv, ...wsEnv, ...sessionEnv };
}
