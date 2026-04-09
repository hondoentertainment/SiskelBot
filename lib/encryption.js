/**
 * Phase 25: Field-level encryption utilities.
 * Uses AES-256-GCM for authenticated encryption.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const SALT = "siskelbot-encryption-salt-v1";

/**
 * Encrypt plaintext using AES-256-GCM.
 * @param {string} plaintext
 * @param {Buffer} key - 32-byte AES key
 * @returns {{ encrypted: string, iv: string, authTag: string }} all base64-encoded
 */
export function encrypt(plaintext, key) {
  if (!plaintext || typeof plaintext !== "string") {
    throw new Error("plaintext must be a non-empty string");
  }
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error("key must be a 32-byte Buffer");
  }
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plaintext, "utf8", "base64");
  encrypted += cipher.final("base64");
  const authTag = cipher.getAuthTag();
  return {
    encrypted,
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
  };
}

/**
 * Decrypt ciphertext using AES-256-GCM.
 * @param {string} encrypted - base64-encoded ciphertext
 * @param {string} iv - base64-encoded initialization vector
 * @param {string} authTag - base64-encoded authentication tag
 * @param {Buffer} key - 32-byte AES key
 * @returns {string} plaintext
 */
export function decrypt(encrypted, iv, authTag, key) {
  if (!encrypted || typeof encrypted !== "string") {
    throw new Error("encrypted must be a non-empty string");
  }
  if (!iv || typeof iv !== "string") {
    throw new Error("iv must be a non-empty string");
  }
  if (!authTag || typeof authTag !== "string") {
    throw new Error("authTag must be a non-empty string");
  }
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error("key must be a 32-byte Buffer");
  }
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(authTag, "base64"));
  let decrypted = decipher.update(encrypted, "base64", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

/**
 * Derive a 32-byte AES key from a secret string using scrypt.
 * @param {string} secret
 * @returns {Buffer}
 */
export function deriveKey(secret) {
  if (!secret || typeof secret !== "string") {
    throw new Error("secret must be a non-empty string");
  }
  return scryptSync(secret, SALT, 32);
}

/**
 * Check if ENCRYPTION_SECRET is configured.
 * @returns {boolean}
 */
export function isEncryptionConfigured() {
  return Boolean(process.env.ENCRYPTION_SECRET);
}

/**
 * Get the derived key from ENCRYPTION_SECRET env var.
 * @returns {Buffer}
 */
function getEnvKey() {
  const secret = process.env.ENCRYPTION_SECRET;
  if (!secret) {
    throw new Error("ENCRYPTION_SECRET environment variable is not set");
  }
  return deriveKey(secret);
}

/**
 * Encrypt a value using the ENCRYPTION_SECRET env var.
 * @param {string} value
 * @returns {{ encrypted: string, iv: string, authTag: string }}
 */
export function encryptField(value) {
  return encrypt(value, getEnvKey());
}

/**
 * Decrypt a value using the ENCRYPTION_SECRET env var.
 * @param {{ encrypted: string, iv: string, authTag: string }} encryptedObj
 * @returns {string}
 */
export function decryptField(encryptedObj) {
  if (!encryptedObj || typeof encryptedObj !== "object") {
    throw new Error("encryptedObj must be an object with encrypted, iv, and authTag fields");
  }
  return decrypt(encryptedObj.encrypted, encryptedObj.iv, encryptedObj.authTag, getEnvKey());
}
