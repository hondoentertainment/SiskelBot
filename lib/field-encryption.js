// @ts-check
/**
 * Phase 36.4: Field-level encryption with transparent encrypt/decrypt.
 *
 * Sits on top of lib/encryption.js (AES-256-GCM) and provides:
 *   - An allowlist of always-encrypted field names
 *   - Per-workspace configurable encrypted field names
 *   - Recursive encryption/decryption of object trees
 *   - Deterministic blind index (HMAC) for searchable equality on encrypted fields
 *
 * An "encrypted value" is an object of the shape:
 *   { _encrypted: true, ciphertext, iv, authTag }
 * The `isFieldEncrypted` helper detects these envelopes for decryption on read.
 * @module field-encryption
 */
import { createHmac } from "crypto";
import { encrypt, decrypt, deriveKey, isEncryptionConfigured } from "./encryption.js";

/**
 * Fields that are always encrypted regardless of per-workspace configuration.
 * Matched case-insensitively as a substring of the field name so that e.g.
 * `apiKey`, `api_key`, `openaiApiKey`, `ssnNumber`, and `creditCardNumber`
 * all match.
 * @type {Set<string>}
 */
export const ALWAYS_ENCRYPTED_FIELDS = new Set([
  "apiKey",
  "password",
  "token",
  "secret",
  "privateKey",
  "ssn",
  "creditCard",
  "bankAccount",
]);

const ALWAYS_ENCRYPTED_LC = new Set(Array.from(ALWAYS_ENCRYPTED_FIELDS).map((f) => f.toLowerCase()));

// In-memory store of per-workspace encrypted field configs.
// Persisted via storage.js from higher layers if desired; kept simple here.
/** @type {Map<string, Set<string>>} */
const _workspaceFields = new Map();

/**
 * Normalize a set of field names (strings) to a Set<string>.
 * @param {string[] | Set<string> | null | undefined} fields
 * @returns {Set<string>}
 */
function toFieldSet(fields) {
  if (!fields) return new Set();
  if (fields instanceof Set) return new Set(Array.from(fields).map((f) => String(f)));
  if (Array.isArray(fields)) return new Set(fields.map((f) => String(f)));
  return new Set();
}

/**
 * Configure the custom encrypted field list for a workspace.
 * Overrides any existing list (combined at lookup time with the always list).
 * @param {string} workspaceId
 * @param {string[] | Set<string>} fields
 * @returns {Promise<void>}
 */
export async function setEncryptedFields(workspaceId, fields) {
  const ws = String(workspaceId || "default");
  _workspaceFields.set(ws, toFieldSet(fields));
}

/**
 * Get the custom encrypted field list for a workspace.
 * Returns the custom list only (does NOT include ALWAYS_ENCRYPTED_FIELDS).
 * @param {string} workspaceId
 * @returns {Promise<string[]>}
 */
export async function getEncryptedFields(workspaceId) {
  const ws = String(workspaceId || "default");
  const set = _workspaceFields.get(ws);
  return set ? Array.from(set) : [];
}

/**
 * Reset all in-memory workspace config. Intended for tests.
 */
export function _resetEncryptedFieldsForTesting() {
  _workspaceFields.clear();
}

/**
 * Check whether a field name should be encrypted.
 * @param {string} fieldName
 * @param {Set<string> | string[] | null} [customFields]
 * @returns {boolean}
 */
export function shouldEncryptField(fieldName, customFields) {
  if (!fieldName || typeof fieldName !== "string") return false;
  const lc = fieldName.toLowerCase();
  for (const always of ALWAYS_ENCRYPTED_LC) {
    if (lc.includes(always)) return true;
  }
  const extra = toFieldSet(customFields || null);
  for (const f of extra) {
    if (!f) continue;
    const fl = String(f).toLowerCase();
    if (lc === fl || lc.includes(fl)) return true;
  }
  return false;
}

/**
 * Detect an encrypted envelope object.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isFieldEncrypted(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      /** @type {any} */ (value)._encrypted === true &&
      typeof /** @type {any} */ (value).ciphertext === "string" &&
      typeof /** @type {any} */ (value).iv === "string" &&
      typeof /** @type {any} */ (value).authTag === "string"
  );
}

function getEncryptionKey() {
  const secret = process.env.ENCRYPTION_SECRET;
  if (!secret) {
    throw new Error("ENCRYPTION_SECRET environment variable is not set");
  }
  return deriveKey(secret);
}

/**
 * Encrypt a single primitive value into the envelope format.
 * Values that cannot be stringified are returned unchanged.
 * @param {unknown} value
 * @returns {{ _encrypted: true, ciphertext: string, iv: string, authTag: string } | unknown}
 */
function encryptValueEnvelope(value) {
  if (value == null) return value;
  // Avoid double-encryption.
  if (isFieldEncrypted(value)) return value;
  const key = getEncryptionKey();
  const plaintext = typeof value === "string" ? value : JSON.stringify(value);
  if (!plaintext) return value;
  const { encrypted, iv, authTag } = encrypt(plaintext, key);
  return { _encrypted: true, ciphertext: encrypted, iv, authTag };
}

/**
 * Decrypt a single envelope value into plaintext.
 * Attempts to JSON.parse the result so that non-string values round-trip.
 * @param {any} envelope
 * @returns {unknown}
 */
function decryptValueEnvelope(envelope) {
  if (!isFieldEncrypted(envelope)) return envelope;
  const key = getEncryptionKey();
  const plaintext = decrypt(envelope.ciphertext, envelope.iv, envelope.authTag, key);
  // Try to parse as JSON; if that fails, return as-is string.
  try {
    return JSON.parse(plaintext);
  } catch {
    return plaintext;
  }
}

/**
 * Recursively encrypt fields on an object tree. Non-plain objects and
 * primitives are returned unchanged. Arrays are mapped element-wise.
 *
 * Leaf encryption is triggered when a key matches either the always-encrypted
 * list or the supplied customFields list.
 *
 * @param {unknown} obj
 * @param {Set<string> | string[] | null} [customFields]
 * @returns {unknown}
 */
export function encryptFields(obj, customFields) {
  if (obj == null) return obj;
  if (Array.isArray(obj)) {
    return obj.map((item) => encryptFields(item, customFields));
  }
  if (typeof obj !== "object") return obj;
  if (isFieldEncrypted(obj)) return obj;
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (shouldEncryptField(k, customFields || null)) {
      out[k] = v == null ? v : encryptValueEnvelope(v);
    } else if (v && typeof v === "object") {
      out[k] = encryptFields(v, customFields);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Recursively decrypt any envelope values in an object tree.
 * @param {unknown} obj
 * @returns {unknown}
 */
export function decryptFields(obj) {
  if (obj == null) return obj;
  if (isFieldEncrypted(obj)) return decryptValueEnvelope(obj);
  if (Array.isArray(obj)) return obj.map((item) => decryptFields(item));
  if (typeof obj !== "object") return obj;
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (isFieldEncrypted(v)) {
      out[k] = decryptValueEnvelope(v);
    } else if (v && typeof v === "object") {
      out[k] = decryptFields(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Create a deterministic blind index for an encrypted field value.
 *
 * HMAC-SHA256(ENCRYPTION_SECRET, `${fieldName}:${value}`) encoded as hex.
 * The field name is mixed in so that the same value under different fields
 * yields different indexes, preventing cross-field correlation.
 *
 * @param {string | number | boolean | null | undefined} value
 * @param {string} fieldName
 * @returns {string} hex-encoded HMAC
 */
export function createBlindIndex(value, fieldName) {
  if (!fieldName || typeof fieldName !== "string") {
    throw new Error("fieldName must be a non-empty string");
  }
  const secret = process.env.ENCRYPTION_SECRET;
  if (!secret) {
    throw new Error("ENCRYPTION_SECRET environment variable is not set");
  }
  const v = value == null ? "" : String(value);
  const hmac = createHmac("sha256", secret);
  hmac.update(`${fieldName}:${v}`);
  return hmac.digest("hex");
}

/**
 * Convenience: compute the blind index for every value in an object tree
 * whose key matches an encrypted field. Returns a map of field -> indexes.
 * @param {unknown} obj
 * @param {Set<string> | string[] | null} [customFields]
 * @returns {Record<string, string[]>}
 */
export function computeBlindIndexes(obj, customFields) {
  /** @type {Record<string, string[]>} */
  const result = {};
  function walk(node) {
    if (node == null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    for (const [k, v] of Object.entries(node)) {
      if (shouldEncryptField(k, customFields || null)) {
        if (v != null && (typeof v === "string" || typeof v === "number" || typeof v === "boolean")) {
          if (!result[k]) result[k] = [];
          result[k].push(createBlindIndex(v, k));
        }
      } else if (v && typeof v === "object") {
        walk(v);
      }
    }
  }
  walk(obj);
  return result;
}

/**
 * Blind-index equality search over a workspace's stored items.
 * Loads records via lib/storage.js, walks each item, and returns IDs whose
 * blind index for the given field matches the provided searchTerm.
 *
 * @param {string} workspaceId
 * @param {string} fieldName
 * @param {string} searchTerm
 * @param {{ type?: string, userId?: string, storage?: any }} [opts]
 * @returns {Promise<string[]>} array of matching record IDs
 */
export async function searchEncryptedField(workspaceId, fieldName, searchTerm, opts = {}) {
  if (!fieldName || typeof fieldName !== "string") {
    throw new Error("fieldName must be a non-empty string");
  }
  const ws = String(workspaceId || "default");
  const type = opts.type || "context";
  const userId = opts.userId || "anonymous";
  const target = createBlindIndex(searchTerm, fieldName);

  let list;
  if (opts.storage && typeof opts.storage.list === "function") {
    list = opts.storage.list;
  } else {
    const mod = await import("./storage.js");
    list = mod.list;
  }
  const items = await list(type, ws, userId);
  /** @type {string[]} */
  const matches = [];
  for (const item of items) {
    const indexes =
      item && typeof item === "object" && item._blindIndex && typeof item._blindIndex === "object"
        ? item._blindIndex[fieldName]
        : null;
    if (Array.isArray(indexes) && indexes.includes(target)) {
      matches.push(String(item.id));
      continue;
    }
    // Fall back to walking the (possibly still-plaintext) object tree and
    // computing blind indexes on the fly.
    const computed = computeBlindIndexes(item);
    if (computed[fieldName] && computed[fieldName].includes(target)) {
      matches.push(String(item.id));
    }
  }
  return matches;
}

/**
 * Are we currently able to perform encryption? Wrapper around
 * lib/encryption.js to keep callers from importing both modules.
 * @returns {boolean}
 */
export function canEncrypt() {
  return isEncryptionConfigured();
}
