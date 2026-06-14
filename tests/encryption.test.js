/**
 * Phase 25: Encryption utility tests.
 * Tests lib/encryption.js — encrypt/decrypt roundtrip, key derivation, field encryption.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "crypto";

import {
  encrypt,
  decrypt,
  deriveKey,
  encryptField,
  decryptField,
  isEncryptionConfigured,
} from "../lib/encryption.js";

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

test("deriveKey produces a 32-byte Buffer", () => {
  const key = deriveKey("my-secret-passphrase");
  assert.ok(Buffer.isBuffer(key));
  assert.equal(key.length, 32);
});

test("deriveKey is deterministic for the same secret", () => {
  const k1 = deriveKey("same-secret");
  const k2 = deriveKey("same-secret");
  assert.deepEqual(k1, k2);
});

test("deriveKey produces different keys for different secrets", () => {
  const k1 = deriveKey("secret-one");
  const k2 = deriveKey("secret-two");
  assert.notDeepEqual(k1, k2);
});

test("deriveKey throws on empty or non-string input", () => {
  assert.throws(() => deriveKey(""), /non-empty string/);
  assert.throws(() => deriveKey(null), /non-empty string/);
  assert.throws(() => deriveKey(undefined), /non-empty string/);
});

// ---------------------------------------------------------------------------
// Encrypt / Decrypt roundtrip
// ---------------------------------------------------------------------------

test("encrypt/decrypt roundtrip produces original plaintext", () => {
  const key = deriveKey("test-secret-roundtrip");
  const plaintext = "Hello, World! This is sensitive data.";

  const result = encrypt(plaintext, key);
  assert.ok(result.encrypted);
  assert.ok(result.iv);
  assert.ok(result.authTag);

  const decrypted = decrypt(result.encrypted, result.iv, result.authTag, key);
  assert.equal(decrypted, plaintext);
});

test("encrypt produces different ciphertexts for same plaintext (random IV)", () => {
  const key = deriveKey("test-secret-iv");
  const plaintext = "same input";

  const r1 = encrypt(plaintext, key);
  const r2 = encrypt(plaintext, key);

  assert.notEqual(r1.encrypted, r2.encrypted, "different encryptions should produce different ciphertexts");
  assert.notEqual(r1.iv, r2.iv, "IVs should differ");
});

test("encrypt/decrypt handles unicode content", () => {
  const key = deriveKey("test-unicode");
  const plaintext = "Bonjour le monde! 你好世界 🌍 日本語テスト";

  const result = encrypt(plaintext, key);
  const decrypted = decrypt(result.encrypted, result.iv, result.authTag, key);
  assert.equal(decrypted, plaintext);
});

test("encrypt/decrypt handles long content", () => {
  const key = deriveKey("test-long-content");
  const plaintext = "x".repeat(100000);

  const result = encrypt(plaintext, key);
  const decrypted = decrypt(result.encrypted, result.iv, result.authTag, key);
  assert.equal(decrypted, plaintext);
});

test("decrypt fails with wrong key", () => {
  const key1 = deriveKey("correct-key");
  const key2 = deriveKey("wrong-key");
  const plaintext = "secret data";

  const result = encrypt(plaintext, key1);
  assert.throws(() => decrypt(result.encrypted, result.iv, result.authTag, key2));
});

test("decrypt fails with tampered ciphertext", () => {
  const key = deriveKey("tamper-test");
  const result = encrypt("secret data", key);

  // Tamper with encrypted data
  const tampered = Buffer.from(result.encrypted, "base64");
  tampered[0] ^= 0xff;
  const tamperedStr = tampered.toString("base64");

  assert.throws(() => decrypt(tamperedStr, result.iv, result.authTag, key));
});

test("decrypt fails with tampered auth tag", () => {
  const key = deriveKey("tamper-tag-test");
  const result = encrypt("secret data", key);

  // Tamper with auth tag
  const tampered = Buffer.from(result.authTag, "base64");
  tampered[0] ^= 0xff;
  const tamperedTag = tampered.toString("base64");

  assert.throws(() => decrypt(result.encrypted, result.iv, tamperedTag, key));
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

test("encrypt throws on empty plaintext", () => {
  const key = deriveKey("test");
  assert.throws(() => encrypt("", key), /non-empty string/);
  assert.throws(() => encrypt(null, key), /non-empty string/);
});

test("encrypt throws on invalid key", () => {
  assert.throws(() => encrypt("hello", Buffer.alloc(16)), /32-byte Buffer/);
  assert.throws(() => encrypt("hello", "not-a-buffer"), /32-byte Buffer/);
});

test("decrypt throws on invalid inputs", () => {
  const key = deriveKey("test");
  assert.throws(() => decrypt("", "iv", "tag", key), /non-empty string/);
  assert.throws(() => decrypt("data", "", "tag", key), /non-empty string/);
  assert.throws(() => decrypt("data", "iv", "", key), /non-empty string/);
  assert.throws(() => decrypt("data", "iv", "tag", Buffer.alloc(16)), /32-byte Buffer/);
});

// ---------------------------------------------------------------------------
// Field encryption (env-var based)
// ---------------------------------------------------------------------------

test("isEncryptionConfigured returns false when ENCRYPTION_SECRET is not set", () => {
  const orig = process.env.ENCRYPTION_SECRET;
  delete process.env.ENCRYPTION_SECRET;
  assert.equal(isEncryptionConfigured(), false);
  if (orig) process.env.ENCRYPTION_SECRET = orig;
});

test("isEncryptionConfigured returns true when ENCRYPTION_SECRET is set", () => {
  const orig = process.env.ENCRYPTION_SECRET;
  process.env.ENCRYPTION_SECRET = "test-secret-configured";
  assert.equal(isEncryptionConfigured(), true);
  if (orig) {
    process.env.ENCRYPTION_SECRET = orig;
  } else {
    delete process.env.ENCRYPTION_SECRET;
  }
});

test("encryptField/decryptField roundtrip using ENCRYPTION_SECRET", () => {
  const orig = process.env.ENCRYPTION_SECRET;
  process.env.ENCRYPTION_SECRET = "my-field-encryption-secret";

  try {
    const value = "sensitive-api-key-12345";
    const encrypted = encryptField(value);

    assert.ok(encrypted.encrypted);
    assert.ok(encrypted.iv);
    assert.ok(encrypted.authTag);

    const decrypted = decryptField(encrypted);
    assert.equal(decrypted, value);
  } finally {
    if (orig) {
      process.env.ENCRYPTION_SECRET = orig;
    } else {
      delete process.env.ENCRYPTION_SECRET;
    }
  }
});

test("encryptField throws when ENCRYPTION_SECRET is not set", () => {
  const orig = process.env.ENCRYPTION_SECRET;
  delete process.env.ENCRYPTION_SECRET;

  try {
    assert.throws(() => encryptField("test"), /ENCRYPTION_SECRET/);
  } finally {
    if (orig) process.env.ENCRYPTION_SECRET = orig;
  }
});

test("decryptField throws on invalid input", () => {
  const orig = process.env.ENCRYPTION_SECRET;
  process.env.ENCRYPTION_SECRET = "test-secret";

  try {
    assert.throws(() => decryptField(null), /must be an object/);
    assert.throws(() => decryptField("string"), /must be an object/);
  } finally {
    if (orig) {
      process.env.ENCRYPTION_SECRET = orig;
    } else {
      delete process.env.ENCRYPTION_SECRET;
    }
  }
});

test("decryptField fails with wrong ENCRYPTION_SECRET", () => {
  process.env.ENCRYPTION_SECRET = "secret-one";
  const encrypted = encryptField("my-data");

  process.env.ENCRYPTION_SECRET = "secret-two";
  assert.throws(() => decryptField(encrypted));

  delete process.env.ENCRYPTION_SECRET;
});

// ---------------------------------------------------------------------------
// Output format
// ---------------------------------------------------------------------------

test("encrypt returns base64-encoded strings", () => {
  const key = deriveKey("base64-test");
  const result = encrypt("test data", key);

  // All values should be valid base64
  assert.doesNotThrow(() => Buffer.from(result.encrypted, "base64"));
  assert.doesNotThrow(() => Buffer.from(result.iv, "base64"));
  assert.doesNotThrow(() => Buffer.from(result.authTag, "base64"));

  // IV should decode to 12 bytes (GCM standard)
  assert.equal(Buffer.from(result.iv, "base64").length, 12);

  // Auth tag should decode to 16 bytes (GCM standard)
  assert.equal(Buffer.from(result.authTag, "base64").length, 16);
});
