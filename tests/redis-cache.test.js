/**
 * Tests for lib/redis-cache.js (Phase 35.1).
 *
 * The "fallback" path uses the in-memory LRU and runs without Redis.
 * The "Redis-backed" path injects a tiny mock client to validate the
 * Redis code paths without requiring a live server.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createRedisCache } from "../lib/redis-cache.js";

// ─── In-memory fallback (no REDIS_URL, no injected client) ───

test("redis-cache: get/set/has/delete via memory fallback", async () => {
  const c = createRedisCache({ ttlMs: 5000, keyPrefix: "t1:", redisUrl: "" });
  await c.set("k1", { hello: "world" });
  assert.deepEqual(await c.get("k1"), { hello: "world" });
  assert.equal(await c.has("k1"), true);
  assert.equal(await c.delete("k1"), true);
  assert.equal(await c.get("k1"), undefined);
  assert.equal(await c.has("k1"), false);
});

test("redis-cache: get returns undefined for missing key", async () => {
  const c = createRedisCache({ ttlMs: 5000, keyPrefix: "t2:", redisUrl: "" });
  assert.equal(await c.get("nope"), undefined);
});

test("redis-cache: TTL expiration on memory fallback", async () => {
  const c = createRedisCache({ ttlMs: 50, keyPrefix: "t3:", redisUrl: "" });
  await c.set("k", "val");
  assert.equal(await c.get("k"), "val");
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(await c.get("k"), undefined);
});

test("redis-cache: custom TTL per entry", async () => {
  const c = createRedisCache({ ttlMs: 5000, keyPrefix: "t4:", redisUrl: "" });
  await c.set("short", "v", 50);
  await c.set("long", "v", 5000);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(await c.get("short"), undefined);
  assert.equal(await c.get("long"), "v");
});

test("redis-cache: stats tracks hits, misses, and hitRate", async () => {
  const c = createRedisCache({ ttlMs: 5000, keyPrefix: "t5:", redisUrl: "" });
  await c.set("a", 1);
  await c.get("a"); // hit
  await c.get("a"); // hit
  await c.get("missing"); // miss
  const s = await c.stats();
  assert.equal(s.hits, 2);
  assert.equal(s.misses, 1);
  assert.ok(Math.abs(s.hitRate - 2 / 3) < 1e-9);
  assert.equal(s.backend, "memory");
  assert.equal(s.connected, false);
});

test("redis-cache: clear removes all keys and resets counters", async () => {
  const c = createRedisCache({ ttlMs: 5000, keyPrefix: "t6:", redisUrl: "" });
  await c.set("a", 1);
  await c.set("b", 2);
  await c.get("a"); // hit (pre-clear)
  await c.clear();
  assert.equal(await c.get("a"), undefined); // miss
  assert.equal(await c.get("b"), undefined); // miss
  const s = await c.stats();
  assert.equal(s.hits, 0);
  assert.equal(s.misses, 2);
});

test("redis-cache: deletePattern removes matching keys (memory)", async () => {
  const c = createRedisCache({ ttlMs: 5000, keyPrefix: "tp:", redisUrl: "" });
  await c.set("user:1", "alice");
  await c.set("user:2", "bob");
  await c.set("post:1", "hi");
  const removed = await c.deletePattern("user:*");
  assert.equal(removed, 2);
  assert.equal(await c.get("user:1"), undefined);
  assert.equal(await c.get("user:2"), undefined);
  assert.equal(await c.get("post:1"), "hi");
});

test("redis-cache: isConnected reports false in pure-memory mode", async () => {
  const c = createRedisCache({ ttlMs: 5000, keyPrefix: "t7:", redisUrl: "" });
  assert.equal(c.isConnected(), false);
});

test("redis-cache: round-trips complex JSON values", async () => {
  const c = createRedisCache({ ttlMs: 5000, keyPrefix: "t8:", redisUrl: "" });
  const val = { nested: { arr: [1, 2, 3], flag: true }, name: "x" };
  await c.set("obj", val);
  assert.deepEqual(await c.get("obj"), val);
});

test("redis-cache: close clears state", async () => {
  const c = createRedisCache({ ttlMs: 5000, keyPrefix: "t9:", redisUrl: "" });
  await c.set("a", 1);
  await c.close();
  assert.equal(await c.get("a"), undefined);
  assert.equal(c.isConnected(), false);
});

// ─── Redis-backed path via mock client ───

function makeMockRedisClient() {
  const store = new Map();
  const expiries = new Map();
  function isLive(k) {
    const exp = expiries.get(k);
    if (exp == null) return true;
    if (Date.now() >= exp) {
      store.delete(k);
      expiries.delete(k);
      return false;
    }
    return true;
  }
  return {
    on() {},
    async connect() {},
    async quit() {},
    async get(k) {
      if (!isLive(k)) return null;
      return store.has(k) ? store.get(k) : null;
    },
    async set(k, v, opts) {
      store.set(k, v);
      if (opts && typeof opts.EX === "number") {
        expiries.set(k, Date.now() + opts.EX * 1000);
      } else {
        expiries.delete(k);
      }
      return "OK";
    },
    async exists(k) {
      return isLive(k) && store.has(k) ? 1 : 0;
    },
    async del(keyOrKeys) {
      const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
      let n = 0;
      for (const k of keys) {
        if (store.delete(k)) n++;
        expiries.delete(k);
      }
      return n;
    },
    async scan(cursor, opts) {
      const match = (opts && opts.MATCH) || "*";
      const re = new RegExp("^" + match.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
      const keys = [];
      for (const k of store.keys()) {
        if (isLive(k) && re.test(k)) keys.push(k);
      }
      return { cursor: 0, keys };
    },
  };
}

test("redis-cache: uses injected redis client end-to-end", async () => {
  const mock = makeMockRedisClient();
  const c = createRedisCache({ ttlMs: 5000, keyPrefix: "rt:", redisClient: mock });
  assert.equal(c.isConnected(), true);
  await c.set("alpha", { v: 1 });
  assert.deepEqual(await c.get("alpha"), { v: 1 });
  assert.equal(await c.has("alpha"), true);
  const s = await c.stats();
  assert.equal(s.backend, "redis");
  assert.equal(s.redisHits, 1);
});

test("redis-cache: deletePattern via mocked SCAN", async () => {
  const mock = makeMockRedisClient();
  const c = createRedisCache({ ttlMs: 5000, keyPrefix: "rp:", redisClient: mock });
  await c.set("a:1", 1);
  await c.set("a:2", 2);
  await c.set("b:1", 3);
  const n = await c.deletePattern("a:*");
  assert.equal(n, 2);
  assert.equal(await c.get("a:1"), undefined);
  assert.equal(await c.get("b:1"), 3);
});

test("redis-cache: clear scans and deletes prefixed keys", async () => {
  const mock = makeMockRedisClient();
  const c = createRedisCache({ ttlMs: 5000, keyPrefix: "rc:", redisClient: mock });
  await c.set("x", 1);
  await c.set("y", 2);
  await c.clear();
  assert.equal(await c.get("x"), undefined);
  assert.equal(await c.get("y"), undefined);
});

test("redis-cache: errors from redis client are counted, not thrown", async () => {
  const broken = {
    on() {},
    async connect() {},
    async quit() {},
    async get() { throw new Error("boom"); },
    async set() { throw new Error("boom"); },
    async exists() { throw new Error("boom"); },
    async del() { throw new Error("boom"); },
    async scan() { throw new Error("boom"); },
  };
  const c = createRedisCache({ ttlMs: 5000, keyPrefix: "err:", redisClient: broken });
  await c.set("k", "v"); // set fails on redis but succeeds on memory fallback
  // get on redis throws -> falls through to memory which has it.
  const v = await c.get("k");
  assert.equal(v, "v");
  const s = await c.stats();
  assert.ok(s.errors >= 2);
});
