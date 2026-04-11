/**
 * Phase 36.4: Field-level encryption tests.
 * Covers envelope detection, recursive encrypt/decrypt, blind index
 * generation and search, and per-workspace configuration.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.ENCRYPTION_SECRET = process.env.ENCRYPTION_SECRET || "field-encryption-test-secret";

import {
  ALWAYS_ENCRYPTED_FIELDS,
  encryptFields,
  decryptFields,
  isFieldEncrypted,
  createBlindIndex,
  computeBlindIndexes,
  shouldEncryptField,
  setEncryptedFields,
  getEncryptedFields,
  searchEncryptedField,
  canEncrypt,
  _resetEncryptedFieldsForTesting,
} from "../lib/field-encryption.js";

test("ALWAYS_ENCRYPTED_FIELDS contains expected sensitive fields", () => {
  for (const f of ["apiKey", "password", "token", "secret", "privateKey", "ssn", "creditCard", "bankAccount"]) {
    assert.ok(ALWAYS_ENCRYPTED_FIELDS.has(f), `missing ${f}`);
  }
});

test("canEncrypt returns true when ENCRYPTION_SECRET is set", () => {
  assert.equal(canEncrypt(), true);
});

// ---------------------------------------------------------------------------
// shouldEncryptField
// ---------------------------------------------------------------------------

test("shouldEncryptField matches always-encrypted fields case-insensitively", () => {
  assert.equal(shouldEncryptField("apiKey"), true);
  assert.equal(shouldEncryptField("APIKey"), true);
  assert.equal(shouldEncryptField("openaiApiKey"), true);
  assert.equal(shouldEncryptField("user_password"), true);
  assert.equal(shouldEncryptField("accessToken"), true);
  assert.equal(shouldEncryptField("oauth_secret"), true);
  assert.equal(shouldEncryptField("privateKey"), true);
  assert.equal(shouldEncryptField("ssnNumber"), true);
  assert.equal(shouldEncryptField("creditCardNumber"), true);
  assert.equal(shouldEncryptField("bankAccountNumber"), true);
});

test("shouldEncryptField returns false for non-sensitive names", () => {
  assert.equal(shouldEncryptField("name"), false);
  assert.equal(shouldEncryptField("id"), false);
  assert.equal(shouldEncryptField("createdAt"), false);
  assert.equal(shouldEncryptField("description"), false);
});

test("shouldEncryptField honors custom fields list", () => {
  assert.equal(shouldEncryptField("email", ["email"]), true);
  assert.equal(shouldEncryptField("userEmail", ["email"]), true);
  assert.equal(shouldEncryptField("phone", ["phone"]), true);
  assert.equal(shouldEncryptField("phone", []), false);
});

// ---------------------------------------------------------------------------
// encryptFields / decryptFields roundtrip
// ---------------------------------------------------------------------------

test("encryptFields replaces sensitive values with envelopes", () => {
  const obj = { id: "1", name: "Alice", apiKey: "sk-live-abc123", createdAt: "2024-01-01" };
  const enc = encryptFields(obj);
  assert.equal(enc.id, "1");
  assert.equal(enc.name, "Alice");
  assert.equal(enc.createdAt, "2024-01-01");
  assert.equal(isFieldEncrypted(enc.apiKey), true);
  assert.notEqual(enc.apiKey, "sk-live-abc123");
});

test("encryptFields/decryptFields roundtrip preserves primitive values", () => {
  const obj = { name: "Alice", apiKey: "sk-live-abc123", age: 30 };
  const enc = encryptFields(obj);
  const dec = decryptFields(enc);
  assert.deepEqual(dec, obj);
});

test("encryptFields handles nested objects recursively", () => {
  const obj = {
    id: "u1",
    profile: {
      name: "Bob",
      credentials: {
        password: "hunter2",
        token: "jwt.ey.z",
      },
    },
    metadata: { createdAt: "2024-01-01" },
  };
  const enc = encryptFields(obj);
  assert.equal(enc.profile.name, "Bob");
  assert.equal(isFieldEncrypted(enc.profile.credentials.password), true);
  assert.equal(isFieldEncrypted(enc.profile.credentials.token), true);
  assert.equal(enc.metadata.createdAt, "2024-01-01");

  const dec = decryptFields(enc);
  assert.deepEqual(dec, obj);
});

test("encryptFields handles arrays of objects", () => {
  const list = [
    { id: 1, apiKey: "key-one" },
    { id: 2, apiKey: "key-two" },
    { id: 3, apiKey: "key-three" },
  ];
  const enc = encryptFields(list);
  assert.ok(Array.isArray(enc));
  assert.equal(enc.length, 3);
  for (const item of enc) assert.equal(isFieldEncrypted(item.apiKey), true);

  const dec = decryptFields(enc);
  assert.deepEqual(dec, list);
});

test("encryptFields is idempotent: doesn't double-encrypt envelopes", () => {
  const obj = { apiKey: "sk-live-abc" };
  const once = encryptFields(obj);
  const twice = encryptFields(once);
  assert.equal(isFieldEncrypted(twice.apiKey), true);
  // Decrypting twice-encrypted should still yield the original plaintext.
  const dec = decryptFields(twice);
  assert.equal(dec.apiKey, "sk-live-abc");
});

test("encryptFields supports custom field list", () => {
  const obj = { id: "u1", email: "alice@example.com", name: "Alice" };
  const enc = encryptFields(obj, ["email"]);
  assert.equal(enc.name, "Alice");
  assert.equal(isFieldEncrypted(enc.email), true);
  const dec = decryptFields(enc);
  assert.equal(dec.email, "alice@example.com");
});

test("encryptFields roundtrips non-string primitives via JSON", () => {
  const obj = { apiKey: 42, token: true, secret: { nested: "value" } };
  const enc = encryptFields(obj);
  assert.equal(isFieldEncrypted(enc.apiKey), true);
  assert.equal(isFieldEncrypted(enc.token), true);
  assert.equal(isFieldEncrypted(enc.secret), true);
  const dec = decryptFields(enc);
  assert.equal(dec.apiKey, 42);
  assert.equal(dec.token, true);
  assert.deepEqual(dec.secret, { nested: "value" });
});

test("encryptFields leaves null and undefined untouched", () => {
  const obj = { apiKey: null, token: undefined, name: "Alice" };
  const enc = encryptFields(obj);
  assert.equal(enc.apiKey, null);
  assert.equal(enc.token, undefined);
  assert.equal(enc.name, "Alice");
});

test("decryptFields is a no-op for fully plaintext objects", () => {
  const obj = { id: "1", name: "Alice", nested: { count: 2 } };
  const dec = decryptFields(obj);
  assert.deepEqual(dec, obj);
});

// ---------------------------------------------------------------------------
// isFieldEncrypted
// ---------------------------------------------------------------------------

test("isFieldEncrypted detects envelope objects", () => {
  assert.equal(
    isFieldEncrypted({ _encrypted: true, ciphertext: "a", iv: "b", authTag: "c" }),
    true
  );
});

test("isFieldEncrypted rejects non-envelopes", () => {
  assert.equal(isFieldEncrypted(null), false);
  assert.equal(isFieldEncrypted(undefined), false);
  assert.equal(isFieldEncrypted("string"), false);
  assert.equal(isFieldEncrypted(123), false);
  assert.equal(isFieldEncrypted([]), false);
  assert.equal(isFieldEncrypted({}), false);
  assert.equal(isFieldEncrypted({ _encrypted: true }), false);
  assert.equal(isFieldEncrypted({ _encrypted: false, ciphertext: "a", iv: "b", authTag: "c" }), false);
});

// ---------------------------------------------------------------------------
// Blind index
// ---------------------------------------------------------------------------

test("createBlindIndex is deterministic for the same input", () => {
  const a = createBlindIndex("alice@example.com", "email");
  const b = createBlindIndex("alice@example.com", "email");
  assert.equal(a, b);
});

test("createBlindIndex differs for different values", () => {
  const a = createBlindIndex("alice@example.com", "email");
  const b = createBlindIndex("bob@example.com", "email");
  assert.notEqual(a, b);
});

test("createBlindIndex differs across field names (domain separation)", () => {
  const a = createBlindIndex("same-value", "apiKey");
  const b = createBlindIndex("same-value", "password");
  assert.notEqual(a, b);
});

test("createBlindIndex returns a hex string", () => {
  const idx = createBlindIndex("test", "field");
  assert.match(idx, /^[0-9a-f]{64}$/);
});

test("createBlindIndex throws when ENCRYPTION_SECRET is missing", () => {
  const orig = process.env.ENCRYPTION_SECRET;
  delete process.env.ENCRYPTION_SECRET;
  try {
    assert.throws(() => createBlindIndex("test", "field"), /ENCRYPTION_SECRET/);
  } finally {
    process.env.ENCRYPTION_SECRET = orig;
  }
});

test("createBlindIndex throws when fieldName is missing", () => {
  assert.throws(() => createBlindIndex("value", ""), /fieldName/);
});

test("computeBlindIndexes walks nested structures", () => {
  const obj = {
    id: 1,
    apiKey: "sk-live-abc",
    nested: { password: "hunter2" },
    list: [{ token: "jwt.ey.z" }],
  };
  const idx = computeBlindIndexes(obj);
  assert.ok(idx.apiKey);
  assert.ok(idx.password);
  assert.ok(idx.token);
  assert.equal(idx.apiKey[0], createBlindIndex("sk-live-abc", "apiKey"));
});

// ---------------------------------------------------------------------------
// searchEncryptedField with a stub storage
// ---------------------------------------------------------------------------

test("searchEncryptedField finds records by blind index", async () => {
  const items = [
    { id: "a", apiKey: "sk-live-aaa" },
    { id: "b", apiKey: "sk-live-bbb" },
    { id: "c", apiKey: "sk-live-ccc" },
  ];
  const stored = items.map((it) => {
    const enc = encryptFields(it);
    return { ...enc, _blindIndex: computeBlindIndexes(it) };
  });
  const stubStorage = {
    list: async () => stored,
  };
  const matches = await searchEncryptedField("ws1", "apiKey", "sk-live-bbb", { storage: stubStorage });
  assert.deepEqual(matches, ["b"]);
});

test("searchEncryptedField returns empty when no match", async () => {
  const stored = [{ id: "a", apiKey: "x", _blindIndex: computeBlindIndexes({ apiKey: "x" }) }];
  const stubStorage = { list: async () => stored };
  const matches = await searchEncryptedField("ws1", "apiKey", "not-in-set", { storage: stubStorage });
  assert.deepEqual(matches, []);
});

test("searchEncryptedField falls back to on-the-fly index on plaintext items", async () => {
  // No `_blindIndex` attached; the values are still plaintext (not yet migrated).
  const items = [
    { id: "a", apiKey: "alpha" },
    { id: "b", apiKey: "beta" },
  ];
  const stubStorage = { list: async () => items };
  const matches = await searchEncryptedField("ws1", "apiKey", "beta", { storage: stubStorage });
  assert.deepEqual(matches, ["b"]);
});

// ---------------------------------------------------------------------------
// Per-workspace config
// ---------------------------------------------------------------------------

test("setEncryptedFields and getEncryptedFields roundtrip per workspace", async () => {
  _resetEncryptedFieldsForTesting();
  await setEncryptedFields("ws-a", ["email", "phone"]);
  await setEncryptedFields("ws-b", ["dob"]);
  assert.deepEqual((await getEncryptedFields("ws-a")).sort(), ["email", "phone"]);
  assert.deepEqual(await getEncryptedFields("ws-b"), ["dob"]);
  assert.deepEqual(await getEncryptedFields("ws-unknown"), []);
});

test("custom workspace fields apply to encryptFields when passed in", async () => {
  _resetEncryptedFieldsForTesting();
  await setEncryptedFields("ws-pii", ["email", "phone"]);
  const fields = await getEncryptedFields("ws-pii");
  const obj = { id: "u1", email: "alice@example.com", phone: "555-1234", name: "Alice" };
  const enc = encryptFields(obj, fields);
  assert.equal(enc.name, "Alice");
  assert.equal(isFieldEncrypted(enc.email), true);
  assert.equal(isFieldEncrypted(enc.phone), true);
  const dec = decryptFields(enc);
  assert.deepEqual(dec, obj);
});
