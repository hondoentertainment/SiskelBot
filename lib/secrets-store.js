import { randomUUID, createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const MAX_SECRETS_PER_SCOPE = 100;
const ALGORITHM = "aes-256-gcm";

const LEGACY_SALT = "siskelbot-salt";
let _warnedDevKey = false;

function assertSecretsKey() {
  if (!process.env.SECRETS_ENCRYPTION_KEY && process.env.NODE_ENV === "production") {
    throw new Error("SECRETS_ENCRYPTION_KEY is required in production");
  }
}

function keyForSalt(salt) {
  assertSecretsKey();
  const raw = process.env.SECRETS_ENCRYPTION_KEY;
  if (!raw && !_warnedDevKey) {
    _warnedDevKey = true;
    console.warn(
      "[secrets-store] SECRETS_ENCRYPTION_KEY is not set — using insecure dev key. DO NOT use in production."
    );
  }
  return scryptSync(raw || "dev-insecure-key-siskelbot", salt || LEGACY_SALT, 32);
}

function scopePath(scopeType, scopeId) {
  return join(getDataDir(), "secrets", `${scopeType}-${scopeId}.json`);
}

function encrypt(plaintext) {
  const salt = randomBytes(16).toString("hex");
  const key = keyForSalt(salt);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    encryptedValue: encrypted.toString("hex"),
    iv: iv.toString("hex"),
    authTag: authTag.toString("hex"),
    salt,
  };
}

function decrypt(encryptedValue, iv, authTag, salt) {
  const key = keyForSalt(salt || LEGACY_SALT);
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
  assertSecretsKey();
  const path = scopePath(scopeType, scopeId);
  return withPathLock(path, async () => {
    const store = await readJsonPath(path, { secrets: [] });
    if (!Array.isArray(store.secrets)) store.secrets = [];

    const existing = store.secrets.find((s) => s.name === name);
    if (!existing && store.secrets.length >= MAX_SECRETS_PER_SCOPE) {
      throw new Error(`MAX_SECRETS_PER_SCOPE (${MAX_SECRETS_PER_SCOPE}) reached for scope ${scopeType}:${scopeId}`);
    }

    const { encryptedValue, iv, authTag, salt } = encrypt(value);
    const now = Date.now();

    if (existing) {
      existing.encryptedValue = encryptedValue;
      existing.iv = iv;
      existing.authTag = authTag;
      existing.salt = salt;
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
      salt,
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
  assertSecretsKey();
  const path = scopePath(scopeType, scopeId);
  const store = await readJsonPath(path, { secrets: [] });
  if (!Array.isArray(store.secrets)) return null;
  const record = store.secrets.find((s) => s.name === name);
  if (!record) return null;
  try {
    return decrypt(record.encryptedValue, record.iv, record.authTag, record.salt);
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
      result[record.name] = decrypt(record.encryptedValue, record.iv, record.authTag, record.salt);
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
