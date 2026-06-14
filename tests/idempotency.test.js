import test from "node:test";
import assert from "node:assert/strict";
import { idempotencyLookup, idempotencyStore } from "../lib/idempotency.js";

test("idempotency: first request is not a duplicate", async () => {
  const key = "test-key-" + Date.now() + "-" + Math.random().toString(36).slice(2);
  const result = await idempotencyLookup(key, "POST:/api/test", "user1");
  assert.equal(result.hit, false);
});

test("idempotency: second request with same key returns cached response", async () => {
  const key = "test-cache-" + Date.now() + "-" + Math.random().toString(36).slice(2);
  const routeKey = "POST:/api/test-cache";
  const userId = "user-cache";

  // Store a response
  await idempotencyStore(key, routeKey, userId, 201, { id: "abc123" });

  // Lookup should hit
  const result = await idempotencyLookup(key, routeKey, userId);
  assert.equal(result.hit, true);
  assert.equal(result.status, 201);
  assert.deepEqual(result.body, { id: "abc123" });
});

test("idempotency: different keys are independent", async () => {
  const key1 = "test-diff1-" + Date.now() + "-" + Math.random().toString(36).slice(2);
  const key2 = "test-diff2-" + Date.now() + "-" + Math.random().toString(36).slice(2);
  const routeKey = "POST:/api/test-diff";
  const userId = "user-diff";

  await idempotencyStore(key1, routeKey, userId, 201, { id: "first" });

  const result1 = await idempotencyLookup(key1, routeKey, userId);
  assert.equal(result1.hit, true);
  assert.deepEqual(result1.body, { id: "first" });

  const result2 = await idempotencyLookup(key2, routeKey, userId);
  assert.equal(result2.hit, false);
});

test("idempotency: different route keys are independent", async () => {
  const key = "test-route-" + Date.now() + "-" + Math.random().toString(36).slice(2);
  const userId = "user-route";

  await idempotencyStore(key, "POST:/api/route-a", userId, 201, { route: "a" });

  const resultA = await idempotencyLookup(key, "POST:/api/route-a", userId);
  assert.equal(resultA.hit, true);

  const resultB = await idempotencyLookup(key, "POST:/api/route-b", userId);
  assert.equal(resultB.hit, false);
});

test("idempotency: different user IDs are independent", async () => {
  const key = "test-user-" + Date.now() + "-" + Math.random().toString(36).slice(2);
  const routeKey = "POST:/api/test-user";

  await idempotencyStore(key, routeKey, "user-a", 201, { user: "a" });

  const resultA = await idempotencyLookup(key, routeKey, "user-a");
  assert.equal(resultA.hit, true);

  const resultB = await idempotencyLookup(key, routeKey, "user-b");
  assert.equal(resultB.hit, false);
});

test("idempotency: short keys (< 8 chars) are ignored", async () => {
  const result = await idempotencyLookup("short", "POST:/api/test", "user1");
  assert.equal(result.hit, false);

  // Store should also be a no-op for short keys
  await idempotencyStore("short", "POST:/api/test", "user1", 201, { id: "x" });
  const result2 = await idempotencyLookup("short", "POST:/api/test", "user1");
  assert.equal(result2.hit, false);
});

test("idempotency: null/empty key returns no hit", async () => {
  assert.deepEqual(await idempotencyLookup(null, "POST:/x", "u"), { hit: false });
  assert.deepEqual(await idempotencyLookup("", "POST:/x", "u"), { hit: false });
  assert.deepEqual(await idempotencyLookup(undefined, "POST:/x", "u"), { hit: false });
});
