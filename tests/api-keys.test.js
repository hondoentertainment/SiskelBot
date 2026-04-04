import test from "node:test";
import assert from "node:assert/strict";
import { listKeysForAdmin, addKey, revokeKey, findKeyByRaw, _resetApiKeysCacheForTesting } from "../lib/api-keys.js";

// Reset postgres cache so tests use file-based store
_resetApiKeysCacheForTesting();

test("api-keys: listKeysForAdmin returns array", () => {
  const keys = listKeysForAdmin();
  assert.ok(Array.isArray(keys));
});

test("api-keys: addKey creates a new key with raw key returned", async () => {
  const result = await addKey({ userId: "test-user-" + Date.now() });
  assert.equal(result.ok, true);
  assert.ok(result.id);
  assert.ok(result.key);
  assert.ok(result.key.startsWith("sk-"));
  assert.ok(result.masked);

  // Cleanup
  if (result.id) {
    await revokeKey(result.id);
  }
});

test("api-keys: addKey requires userId", async () => {
  const result = await addKey({});
  assert.equal(result.ok, false);
  assert.ok(result.error.includes("userId"));
});

test("api-keys: addKey with empty userId fails", async () => {
  const result = await addKey({ userId: "  " });
  assert.equal(result.ok, false);
});

test("api-keys: revokeKey removes a key", async () => {
  const created = await addKey({ userId: "test-revoke-" + Date.now() });
  assert.equal(created.ok, true);

  const revoked = await revokeKey(created.id);
  assert.equal(revoked.ok, true);

  // Should no longer be findable
  const found = findKeyByRaw(created.key);
  assert.equal(found, null);
});

test("api-keys: revokeKey returns error for unknown id", async () => {
  const result = await revokeKey("nonexistent-key-id");
  assert.equal(result.ok, false);
  assert.ok(result.error);
});

test("api-keys: revokeKey requires keyId", async () => {
  const result = await revokeKey("");
  assert.equal(result.ok, false);
});

test("api-keys: findKeyByRaw returns null for unknown key", () => {
  const found = findKeyByRaw("sk-nonexistent-key-that-does-not-exist");
  assert.equal(found, null);
});

test("api-keys: findKeyByRaw returns null for empty input", () => {
  assert.equal(findKeyByRaw(null), null);
  assert.equal(findKeyByRaw(""), null);
  assert.equal(findKeyByRaw(undefined), null);
});

test("api-keys: addKey preserves custom scopes", async () => {
  const result = await addKey({ userId: "test-scopes-" + Date.now(), scopes: ["read", "admin"] });
  assert.equal(result.ok, true);

  // Find it and check scopes
  const found = findKeyByRaw(result.key);
  assert.ok(found);
  assert.ok(found.scopes.includes("read"));
  assert.ok(found.scopes.includes("admin"));

  // Cleanup
  await revokeKey(result.id);
});

test("api-keys: addKey filters invalid scopes to defaults", async () => {
  const result = await addKey({ userId: "test-invalid-scopes-" + Date.now(), scopes: ["bogus", "fake"] });
  assert.equal(result.ok, true);

  const found = findKeyByRaw(result.key);
  assert.ok(found);
  // Invalid scopes should fall back to defaults ["read", "write"]
  assert.ok(found.scopes.includes("read"));
  assert.ok(found.scopes.includes("write"));

  await revokeKey(result.id);
});
