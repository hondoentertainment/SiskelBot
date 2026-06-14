/**
 * Hardware Security Module (HSM) abstraction layer.
 * Supports: software (default), aws-kms, gcp-kms, azure-keyvault, pkcs11.
 *
 * All providers expose the same interface:
 *   generateKey, sign, verify, encrypt, decrypt,
 *   listKeys, getKeyMetadata, deleteKey, wrapKey, unwrapKey
 *
 * Usage:
 *   import { createHSMClient } from "./lib/hsm.js";
 *   const hsm = createHSMClient("software", {});
 *   const { keyId } = await hsm.generateKey("my-key", "aes-256");
 *   const encrypted = await hsm.encrypt(keyId, "plaintext");
 */

import { randomBytes, createCipheriv, createDecipheriv, createHash, createSign, createVerify, generateKeyPairSync } from "node:crypto";

/**
 * Create an HSM client for the specified provider.
 * @param {'software'|'aws-kms'|'gcp-kms'|'azure-keyvault'|'pkcs11'} provider
 * @param {object} config
 */
export function createHSMClient(provider = "software", config = {}) {
  const providerImpl = PROVIDERS[provider];
  if (!providerImpl) {
    throw new Error(`Unknown HSM provider: ${provider}. Supported: ${Object.keys(PROVIDERS).join(", ")}`);
  }
  return providerImpl.create(config);
}

/**
 * Software HSM — pure JavaScript implementation using Node's crypto module.
 * Keys are stored in-memory (or optionally persisted via the config.storage callback).
 * Suitable for development, testing, and low-security deployments.
 */
function createSoftwareHSM(config = {}) {
  const keys = new Map(); // keyId -> { type, material, metadata }
  const storage = config.storage || null;

  async function generateKey(keyId, keyType = "aes-256") {
    if (!keyId || typeof keyId !== "string") {
      throw new Error("keyId is required");
    }
    if (keys.has(keyId)) {
      throw new Error(`Key already exists: ${keyId}`);
    }
    let material;
    if (keyType === "aes-256" || keyType === "aes-256-gcm") {
      material = { type: "symmetric", algorithm: "aes-256-gcm", key: randomBytes(32) };
    } else if (keyType === "rsa-2048" || keyType === "rsa") {
      const { publicKey, privateKey } = generateKeyPairSync("rsa", {
        modulusLength: 2048,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      });
      material = { type: "asymmetric", algorithm: "rsa-2048", publicKey, privateKey };
    } else if (keyType === "ec" || keyType === "ecdsa-p256") {
      const { publicKey, privateKey } = generateKeyPairSync("ec", {
        namedCurve: "prime256v1",
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      });
      material = { type: "asymmetric", algorithm: "ecdsa-p256", publicKey, privateKey };
    } else {
      throw new Error(`Unsupported key type: ${keyType}`);
    }
    const record = {
      keyId,
      keyType,
      material,
      createdAt: new Date().toISOString(),
      metadata: {},
    };
    keys.set(keyId, record);
    if (storage?.set) await storage.set(keyId, serializeKey(record));
    return { keyId, keyType, createdAt: record.createdAt };
  }

  async function sign(keyId, data) {
    const record = keys.get(keyId);
    if (!record) throw new Error(`Key not found: ${keyId}`);
    if (record.material.type !== "asymmetric") {
      throw new Error(`Cannot sign with symmetric key: ${keyId}`);
    }
    const signer = createSign(record.material.algorithm === "ecdsa-p256" ? "SHA256" : "RSA-SHA256");
    signer.update(Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8"));
    signer.end();
    const signature = signer.sign(record.material.privateKey);
    return signature.toString("base64");
  }

  async function verify(keyId, data, signature) {
    const record = keys.get(keyId);
    if (!record) throw new Error(`Key not found: ${keyId}`);
    if (record.material.type !== "asymmetric") {
      throw new Error(`Cannot verify with symmetric key: ${keyId}`);
    }
    const verifier = createVerify(record.material.algorithm === "ecdsa-p256" ? "SHA256" : "RSA-SHA256");
    verifier.update(Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8"));
    verifier.end();
    const sigBuffer = Buffer.isBuffer(signature) ? signature : Buffer.from(signature, "base64");
    return verifier.verify(record.material.publicKey, sigBuffer);
  }

  async function encrypt(keyId, plaintext) {
    const record = keys.get(keyId);
    if (!record) throw new Error(`Key not found: ${keyId}`);
    if (record.material.type !== "symmetric") {
      throw new Error(`Cannot encrypt with asymmetric key: ${keyId}`);
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", record.material.key, iv);
    const pt = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext), "utf8");
    const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return {
      ciphertext: ct.toString("base64"),
      iv: iv.toString("base64"),
      authTag: authTag.toString("base64"),
      keyId,
    };
  }

  async function decrypt(keyId, ciphertext, iv, authTag) {
    const record = keys.get(keyId);
    if (!record) throw new Error(`Key not found: ${keyId}`);
    if (record.material.type !== "symmetric") {
      throw new Error(`Cannot decrypt with asymmetric key: ${keyId}`);
    }
    // Accept object form or separate args
    if (typeof ciphertext === "object" && ciphertext !== null && !Buffer.isBuffer(ciphertext)) {
      iv = ciphertext.iv;
      authTag = ciphertext.authTag;
      ciphertext = ciphertext.ciphertext;
    }
    const ctBuf = Buffer.isBuffer(ciphertext) ? ciphertext : Buffer.from(ciphertext, "base64");
    const ivBuf = Buffer.isBuffer(iv) ? iv : Buffer.from(iv, "base64");
    const tagBuf = Buffer.isBuffer(authTag) ? authTag : Buffer.from(authTag, "base64");
    const decipher = createDecipheriv("aes-256-gcm", record.material.key, ivBuf);
    decipher.setAuthTag(tagBuf);
    const pt = Buffer.concat([decipher.update(ctBuf), decipher.final()]);
    return pt.toString("utf8");
  }

  async function listKeys() {
    return Array.from(keys.values()).map((r) => ({
      keyId: r.keyId,
      keyType: r.keyType,
      createdAt: r.createdAt,
    }));
  }

  async function getKeyMetadata(keyId) {
    const record = keys.get(keyId);
    if (!record) return null;
    return {
      keyId,
      keyType: record.keyType,
      createdAt: record.createdAt,
      metadata: { ...record.metadata },
      algorithm: record.material.algorithm,
      hasPublicKey: record.material.type === "asymmetric",
    };
  }

  async function deleteKey(keyId) {
    const existed = keys.delete(keyId);
    if (storage?.delete) await storage.delete(keyId);
    return existed;
  }

  async function wrapKey(wrappingKeyId, targetKeyId) {
    const target = keys.get(targetKeyId);
    if (!target) throw new Error(`Target key not found: ${targetKeyId}`);
    const serialized = JSON.stringify(serializeKey(target));
    return await encrypt(wrappingKeyId, serialized);
  }

  async function unwrapKey(wrappingKeyId, wrappedKey) {
    const decrypted = await decrypt(wrappingKeyId, wrappedKey);
    const parsed = JSON.parse(decrypted);
    const record = deserializeKey(parsed);
    keys.set(record.keyId, record);
    return { keyId: record.keyId, keyType: record.keyType };
  }

  return {
    provider: "software",
    generateKey,
    sign,
    verify,
    encrypt,
    decrypt,
    listKeys,
    getKeyMetadata,
    deleteKey,
    wrapKey,
    unwrapKey,
  };
}

function serializeKey(record) {
  const out = {
    keyId: record.keyId,
    keyType: record.keyType,
    createdAt: record.createdAt,
    metadata: record.metadata,
    material: { type: record.material.type, algorithm: record.material.algorithm },
  };
  if (record.material.type === "symmetric") {
    out.material.key = record.material.key.toString("base64");
  } else {
    out.material.publicKey = record.material.publicKey;
    out.material.privateKey = record.material.privateKey;
  }
  return out;
}

function deserializeKey(serialized) {
  const record = {
    keyId: serialized.keyId,
    keyType: serialized.keyType,
    createdAt: serialized.createdAt,
    metadata: serialized.metadata || {},
    material: {
      type: serialized.material.type,
      algorithm: serialized.material.algorithm,
    },
  };
  if (record.material.type === "symmetric") {
    record.material.key = Buffer.from(serialized.material.key, "base64");
  } else {
    record.material.publicKey = serialized.material.publicKey;
    record.material.privateKey = serialized.material.privateKey;
  }
  return record;
}

/**
 * AWS KMS provider.
 * Uses @aws-sdk/client-kms (already in project deps).
 */
function createAWSKMSHSM(config = {}) {
  let kmsClient = null;
  async function getClient() {
    if (kmsClient) return kmsClient;
    const { KMSClient } = await import("@aws-sdk/client-kms");
    kmsClient = new KMSClient({ region: config.region || process.env.AWS_REGION });
    return kmsClient;
  }

  async function generateKey(keyId, keyType = "aes-256") {
    const client = await getClient();
    const { CreateKeyCommand } = await import("@aws-sdk/client-kms");
    const keySpec = keyType.startsWith("rsa") ? "RSA_2048" : keyType.startsWith("ec") ? "ECC_NIST_P256" : "SYMMETRIC_DEFAULT";
    const cmd = new CreateKeyCommand({ KeySpec: keySpec, KeyUsage: "ENCRYPT_DECRYPT", Description: keyId });
    const res = await client.send(cmd);
    return { keyId: res.KeyMetadata?.KeyId || keyId, keyType, createdAt: new Date().toISOString() };
  }

  async function sign(keyId, data) {
    const client = await getClient();
    const { SignCommand } = await import("@aws-sdk/client-kms");
    const cmd = new SignCommand({
      KeyId: keyId,
      Message: Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8"),
      MessageType: "RAW",
      SigningAlgorithm: "RSASSA_PKCS1_V1_5_SHA_256",
    });
    const res = await client.send(cmd);
    return Buffer.from(res.Signature).toString("base64");
  }

  async function verify(keyId, data, signature) {
    const client = await getClient();
    const { VerifyCommand } = await import("@aws-sdk/client-kms");
    const cmd = new VerifyCommand({
      KeyId: keyId,
      Message: Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8"),
      MessageType: "RAW",
      Signature: Buffer.isBuffer(signature) ? signature : Buffer.from(signature, "base64"),
      SigningAlgorithm: "RSASSA_PKCS1_V1_5_SHA_256",
    });
    const res = await client.send(cmd);
    return res.SignatureValid || false;
  }

  async function encrypt(keyId, plaintext) {
    const client = await getClient();
    const { EncryptCommand } = await import("@aws-sdk/client-kms");
    const cmd = new EncryptCommand({
      KeyId: keyId,
      Plaintext: Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext), "utf8"),
    });
    const res = await client.send(cmd);
    return { ciphertext: Buffer.from(res.CiphertextBlob).toString("base64"), keyId };
  }

  async function decrypt(keyId, ciphertext) {
    const client = await getClient();
    const { DecryptCommand } = await import("@aws-sdk/client-kms");
    const ct = typeof ciphertext === "object" && ciphertext !== null ? ciphertext.ciphertext : ciphertext;
    const cmd = new DecryptCommand({
      KeyId: keyId,
      CiphertextBlob: Buffer.from(ct, "base64"),
    });
    const res = await client.send(cmd);
    return Buffer.from(res.Plaintext).toString("utf8");
  }

  async function listKeys() {
    const client = await getClient();
    const { ListKeysCommand } = await import("@aws-sdk/client-kms");
    const res = await client.send(new ListKeysCommand({}));
    return (res.Keys || []).map((k) => ({ keyId: k.KeyId, createdAt: null }));
  }

  async function getKeyMetadata(keyId) {
    const client = await getClient();
    const { DescribeKeyCommand } = await import("@aws-sdk/client-kms");
    try {
      const res = await client.send(new DescribeKeyCommand({ KeyId: keyId }));
      return {
        keyId,
        keyType: res.KeyMetadata?.KeySpec || "symmetric",
        createdAt: res.KeyMetadata?.CreationDate?.toISOString(),
        algorithm: res.KeyMetadata?.KeyUsage,
      };
    } catch {
      return null;
    }
  }

  async function deleteKey(keyId) {
    const client = await getClient();
    const { ScheduleKeyDeletionCommand } = await import("@aws-sdk/client-kms");
    await client.send(new ScheduleKeyDeletionCommand({ KeyId: keyId, PendingWindowInDays: 7 }));
    return true;
  }

  async function wrapKey(_wrappingKeyId, _targetKeyId) {
    throw new Error("wrapKey not implemented for aws-kms provider");
  }

  async function unwrapKey(_wrappingKeyId, _wrappedKey) {
    throw new Error("unwrapKey not implemented for aws-kms provider");
  }

  return {
    provider: "aws-kms",
    generateKey,
    sign,
    verify,
    encrypt,
    decrypt,
    listKeys,
    getKeyMetadata,
    deleteKey,
    wrapKey,
    unwrapKey,
  };
}

/**
 * GCP KMS provider — REST API via fetch (no SDK dependency).
 * Requires GOOGLE_APPLICATION_CREDENTIALS or config.accessToken.
 */
function createGCPKMSHSM(config = {}) {
  const projectId = config.projectId || process.env.GCP_PROJECT_ID;
  const location = config.location || "global";
  const keyRing = config.keyRing || "siskelbot";

  function getAccessToken() {
    // In production, use google-auth-library; for now return from config
    return config.accessToken || process.env.GCP_ACCESS_TOKEN;
  }

  function buildUrl(path) {
    return `https://cloudkms.googleapis.com/v1/projects/${projectId}/locations/${location}/keyRings/${keyRing}${path}`;
  }

  async function gcpFetch(path, options = {}) {
    const token = getAccessToken();
    if (!token) throw new Error("GCP access token not configured");
    const res = await fetch(buildUrl(path), {
      ...options,
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });
    if (!res.ok) throw new Error(`GCP KMS error: ${res.status} ${await res.text()}`);
    return res.json();
  }

  return {
    provider: "gcp-kms",
    async generateKey(keyId, keyType = "aes-256") {
      const purpose = keyType.startsWith("rsa") || keyType.startsWith("ec") ? "ASYMMETRIC_SIGN" : "ENCRYPT_DECRYPT";
      await gcpFetch(`/cryptoKeys?cryptoKeyId=${encodeURIComponent(keyId)}`, {
        method: "POST",
        body: JSON.stringify({ purpose }),
      });
      return { keyId, keyType, createdAt: new Date().toISOString() };
    },
    async sign(keyId, data) {
      const res = await gcpFetch(`/cryptoKeys/${keyId}/cryptoKeyVersions/1:asymmetricSign`, {
        method: "POST",
        body: JSON.stringify({ digest: { sha256: createHash("sha256").update(data).digest("base64") } }),
      });
      return res.signature;
    },
    async verify() { throw new Error("GCP KMS verify requires separate public key"); },
    async encrypt(keyId, plaintext) {
      const pt = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext), "utf8");
      const res = await gcpFetch(`/cryptoKeys/${keyId}:encrypt`, {
        method: "POST",
        body: JSON.stringify({ plaintext: pt.toString("base64") }),
      });
      return { ciphertext: res.ciphertext, keyId };
    },
    async decrypt(keyId, ciphertext) {
      const ct = typeof ciphertext === "object" && ciphertext !== null ? ciphertext.ciphertext : ciphertext;
      const res = await gcpFetch(`/cryptoKeys/${keyId}:decrypt`, {
        method: "POST",
        body: JSON.stringify({ ciphertext: ct }),
      });
      return Buffer.from(res.plaintext, "base64").toString("utf8");
    },
    async listKeys() {
      const res = await gcpFetch(`/cryptoKeys`);
      return (res.cryptoKeys || []).map((k) => ({ keyId: k.name?.split("/").pop(), createdAt: k.createTime }));
    },
    async getKeyMetadata(keyId) {
      try {
        const res = await gcpFetch(`/cryptoKeys/${keyId}`);
        return { keyId, keyType: res.purpose, createdAt: res.createTime };
      } catch {
        return null;
      }
    },
    async deleteKey(keyId) {
      await gcpFetch(`/cryptoKeys/${keyId}/cryptoKeyVersions/1:destroy`, { method: "POST" });
      return true;
    },
    async wrapKey() { throw new Error("wrapKey not implemented for gcp-kms provider"); },
    async unwrapKey() { throw new Error("unwrapKey not implemented for gcp-kms provider"); },
  };
}

/**
 * Azure Key Vault provider — REST API via fetch.
 */
function createAzureKeyVaultHSM(config = {}) {
  const vaultName = config.vaultName || process.env.AZURE_KEY_VAULT_NAME;
  const apiVersion = "7.4";

  function buildUrl(path) {
    return `https://${vaultName}.vault.azure.net${path}?api-version=${apiVersion}`;
  }

  async function azureFetch(path, options = {}) {
    const token = config.accessToken || process.env.AZURE_ACCESS_TOKEN;
    if (!token) throw new Error("Azure access token not configured");
    const res = await fetch(buildUrl(path), {
      ...options,
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });
    if (!res.ok) throw new Error(`Azure Key Vault error: ${res.status} ${await res.text()}`);
    return res.json();
  }

  return {
    provider: "azure-keyvault",
    async generateKey(keyId, keyType = "aes-256") {
      const kty = keyType.startsWith("rsa") ? "RSA" : keyType.startsWith("ec") ? "EC" : "oct";
      await azureFetch(`/keys/${encodeURIComponent(keyId)}/create`, {
        method: "POST",
        body: JSON.stringify({ kty, key_size: kty === "RSA" ? 2048 : undefined }),
      });
      return { keyId, keyType, createdAt: new Date().toISOString() };
    },
    async sign(keyId, data) {
      const digest = createHash("sha256").update(data).digest("base64");
      const res = await azureFetch(`/keys/${keyId}//sign`, {
        method: "POST",
        body: JSON.stringify({ alg: "RS256", value: digest }),
      });
      return res.value;
    },
    async verify() { throw new Error("Azure Key Vault verify requires separate implementation"); },
    async encrypt(keyId, plaintext) {
      const pt = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext), "utf8");
      const res = await azureFetch(`/keys/${keyId}//encrypt`, {
        method: "POST",
        body: JSON.stringify({ alg: "RSA-OAEP-256", value: pt.toString("base64") }),
      });
      return { ciphertext: res.value, keyId };
    },
    async decrypt(keyId, ciphertext) {
      const ct = typeof ciphertext === "object" && ciphertext !== null ? ciphertext.ciphertext : ciphertext;
      const res = await azureFetch(`/keys/${keyId}//decrypt`, {
        method: "POST",
        body: JSON.stringify({ alg: "RSA-OAEP-256", value: ct }),
      });
      return Buffer.from(res.value, "base64").toString("utf8");
    },
    async listKeys() {
      const res = await azureFetch(`/keys`);
      return (res.value || []).map((k) => ({ keyId: k.kid?.split("/").pop(), createdAt: k.attributes?.created }));
    },
    async getKeyMetadata(keyId) {
      try {
        const res = await azureFetch(`/keys/${keyId}`);
        return { keyId, keyType: res.key?.kty, createdAt: res.attributes?.created };
      } catch {
        return null;
      }
    },
    async deleteKey(keyId) {
      await azureFetch(`/keys/${keyId}`, { method: "DELETE" });
      return true;
    },
    async wrapKey() { throw new Error("wrapKey not implemented for azure-keyvault provider"); },
    async unwrapKey() { throw new Error("unwrapKey not implemented for azure-keyvault provider"); },
  };
}

/**
 * PKCS#11 provider — requires pkcs11js optional dependency.
 * Throws a clear error if pkcs11js is not installed.
 */
function createPKCS11HSM(config = {}) {
  let pkcs11Module = null;
  async function getModule() {
    if (pkcs11Module) return pkcs11Module;
    try {
      pkcs11Module = await import("pkcs11js");
    } catch {
      throw new Error(
        "pkcs11js is not installed. Install with: npm install pkcs11js\n" +
          "Note: requires native libraries for your HSM vendor."
      );
    }
    return pkcs11Module;
  }

  return {
    provider: "pkcs11",
    async generateKey(keyId, keyType) {
      await getModule();
      throw new Error("PKCS#11 provider requires vendor-specific implementation");
    },
    async sign() { throw new Error("PKCS#11 not fully implemented"); },
    async verify() { throw new Error("PKCS#11 not fully implemented"); },
    async encrypt() { throw new Error("PKCS#11 not fully implemented"); },
    async decrypt() { throw new Error("PKCS#11 not fully implemented"); },
    async listKeys() { return []; },
    async getKeyMetadata() { return null; },
    async deleteKey() { return false; },
    async wrapKey() { throw new Error("PKCS#11 not fully implemented"); },
    async unwrapKey() { throw new Error("PKCS#11 not fully implemented"); },
  };
}

export const PROVIDERS = {
  software: { create: createSoftwareHSM },
  "aws-kms": { create: createAWSKMSHSM },
  "gcp-kms": { create: createGCPKMSHSM },
  "azure-keyvault": { create: createAzureKeyVaultHSM },
  pkcs11: { create: createPKCS11HSM },
};

export const AWS_KMS_PROVIDER = PROVIDERS["aws-kms"];
export const GCP_KMS_PROVIDER = PROVIDERS["gcp-kms"];
export const AZURE_KEYVAULT_PROVIDER = PROVIDERS["azure-keyvault"];
export const SOFTWARE_HSM_PROVIDER = PROVIDERS.software;

/**
 * Get the globally configured HSM client from env vars.
 */
let globalHSM = null;
export function getGlobalHSM() {
  if (globalHSM) return globalHSM;
  const provider = process.env.HSM_PROVIDER || "software";
  globalHSM = createHSMClient(provider, {
    region: process.env.AWS_REGION,
    projectId: process.env.GCP_PROJECT_ID,
    vaultName: process.env.AZURE_KEY_VAULT_NAME,
  });
  return globalHSM;
}

export function resetGlobalHSM() {
  globalHSM = null;
}

export function isHSMConfigured() {
  return Boolean(process.env.HSM_PROVIDER && process.env.HSM_PROVIDER !== "software");
}
