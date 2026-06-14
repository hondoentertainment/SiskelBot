import test from "node:test";
import assert from "node:assert/strict";
import { createCache, configCache, knowledgeCache, userCache } from "../lib/cache.js";
import { cacheResponse } from "../lib/cache-middleware.js";

// ─── createCache: get / set / has / delete / clear ───

test("cache: set and get a value", () => {
  const c = createCache({ ttlMs: 5000, maxSize: 10 });
  c.set("k1", "v1");
  assert.equal(c.get("k1"), "v1");
});

test("cache: has returns true for existing key", () => {
  const c = createCache({ ttlMs: 5000, maxSize: 10 });
  c.set("k1", 42);
  assert.equal(c.has("k1"), true);
  assert.equal(c.has("k2"), false);
});

test("cache: delete removes a key", () => {
  const c = createCache({ ttlMs: 5000, maxSize: 10 });
  c.set("k1", "v1");
  assert.equal(c.delete("k1"), true);
  assert.equal(c.get("k1"), undefined);
  assert.equal(c.has("k1"), false);
});

test("cache: clear removes all keys and resets stats", () => {
  const c = createCache({ ttlMs: 5000, maxSize: 10 });
  c.set("a", 1);
  c.set("b", 2);
  c.get("a"); // hit
  c.get("miss"); // miss
  c.clear();
  assert.equal(c.size(), 0);
  const s = c.stats();
  assert.equal(s.hits, 0);
  assert.equal(s.misses, 0);
});

test("cache: size returns count of live entries", () => {
  const c = createCache({ ttlMs: 5000, maxSize: 10 });
  c.set("a", 1);
  c.set("b", 2);
  c.set("c", 3);
  assert.equal(c.size(), 3);
});

test("cache: get returns undefined for missing key", () => {
  const c = createCache({ ttlMs: 5000, maxSize: 10 });
  assert.equal(c.get("nope"), undefined);
});

test("cache: overwrite existing key", () => {
  const c = createCache({ ttlMs: 5000, maxSize: 10 });
  c.set("k", "old");
  c.set("k", "new");
  assert.equal(c.get("k"), "new");
  // Should not increase size
  assert.equal(c.size(), 1);
});

// ─── TTL expiration ───

test("cache: TTL expiration removes stale entry", async () => {
  const c = createCache({ ttlMs: 50, maxSize: 10 });
  c.set("k1", "val");
  assert.equal(c.get("k1"), "val");
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(c.get("k1"), undefined);
  assert.equal(c.has("k1"), false);
});

test("cache: custom TTL per entry", async () => {
  const c = createCache({ ttlMs: 5000, maxSize: 10 });
  c.set("short", "val", 50);
  c.set("long", "val", 5000);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(c.get("short"), undefined);
  assert.equal(c.get("long"), "val");
});

// ─── LRU eviction ───

test("cache: LRU eviction when maxSize exceeded", () => {
  const c = createCache({ ttlMs: 60000, maxSize: 3 });
  c.set("a", 1);
  c.set("b", 2);
  c.set("c", 3);
  // All three present
  assert.equal(c.size(), 3);
  // Adding a 4th should evict "a" (oldest / least recently used)
  c.set("d", 4);
  assert.equal(c.size(), 3);
  assert.equal(c.has("a"), false);
  assert.equal(c.get("b"), 2);
  assert.equal(c.get("c"), 3);
  assert.equal(c.get("d"), 4);
});

test("cache: accessing a key makes it most recently used", () => {
  const c = createCache({ ttlMs: 60000, maxSize: 3 });
  c.set("a", 1);
  c.set("b", 2);
  c.set("c", 3);
  // Access "a" to promote it
  c.get("a");
  // Insert "d" — should evict "b" (now the least recently used)
  c.set("d", 4);
  assert.equal(c.has("b"), false);
  assert.equal(c.get("a"), 1);
  assert.equal(c.get("c"), 3);
  assert.equal(c.get("d"), 4);
});

test("cache: evictions counter increments", () => {
  const c = createCache({ ttlMs: 60000, maxSize: 2 });
  c.set("a", 1);
  c.set("b", 2);
  c.set("c", 3); // evicts "a"
  c.set("d", 4); // evicts "b"
  const s = c.stats();
  assert.equal(s.evictions, 2);
});

// ─── Stats tracking ───

test("cache: stats tracks hits and misses", () => {
  const c = createCache({ ttlMs: 5000, maxSize: 10, name: "test-stats" });
  c.set("a", 1);
  c.get("a"); // hit
  c.get("a"); // hit
  c.get("b"); // miss
  const s = c.stats();
  assert.equal(s.name, "test-stats");
  assert.equal(s.hits, 2);
  assert.equal(s.misses, 1);
  assert.ok(Math.abs(s.hitRate - 2 / 3) < 0.001);
  assert.equal(s.size, 1);
});

test("cache: hitRate is 0 when no accesses", () => {
  const c = createCache({ ttlMs: 5000, maxSize: 10 });
  assert.equal(c.stats().hitRate, 0);
});

// ─── Singleton caches exist ───

test("cache: singleton caches are created", () => {
  assert.ok(configCache);
  assert.ok(knowledgeCache);
  assert.ok(userCache);
  assert.equal(typeof configCache.get, "function");
  assert.equal(typeof knowledgeCache.set, "function");
  assert.equal(typeof userCache.stats, "function");
});

// ─── Cache middleware ───

test("cache-middleware: returns MISS on first request, HIT on second", () => {
  const cache = createCache({ ttlMs: 5000, maxSize: 10 });
  const middleware = cacheResponse(cache, (req) => req.url);

  // First request — MISS
  let headersSent = {};
  let jsonBody = null;
  const req1 = { url: "/test" };
  const res1 = {
    statusCode: 200,
    setHeader(k, v) { headersSent[k] = v; },
    status(code) { res1.statusCode = code; return this; },
    json(body) { jsonBody = body; return this; },
  };
  // Bind original json
  res1.json = res1.json.bind(res1);

  let nextCalled = false;
  middleware(req1, res1, () => {
    nextCalled = true;
    // Simulate handler calling res.json
    res1.json({ data: "hello" });
  });

  assert.equal(nextCalled, true);
  assert.equal(headersSent["X-Cache"], "MISS");
  assert.deepEqual(jsonBody, { data: "hello" });

  // Second request — HIT
  headersSent = {};
  jsonBody = null;
  const req2 = { url: "/test" };
  const res2 = {
    statusCode: 200,
    setHeader(k, v) { headersSent[k] = v; },
    status(code) { res2.statusCode = code; return res2; },
    json(body) { jsonBody = body; return res2; },
  };

  let next2Called = false;
  middleware(req2, res2, () => { next2Called = true; });

  assert.equal(next2Called, false);
  assert.equal(headersSent["X-Cache"], "HIT");
  assert.deepEqual(jsonBody, { data: "hello" });
});

test("cache-middleware: does not cache error responses", () => {
  const cache = createCache({ ttlMs: 5000, maxSize: 10 });
  const middleware = cacheResponse(cache, (req) => req.url);

  const req1 = { url: "/error" };
  const res1 = {
    statusCode: 500,
    setHeader() {},
    status(code) { res1.statusCode = code; return res1; },
    json(_body) { return res1; },
  };

  middleware(req1, res1, () => {
    res1.json({ error: "fail" });
  });

  // Should not be cached
  assert.equal(cache.has("/error"), false);
});

// ─── Concurrent access ───

test("cache: concurrent set/get does not corrupt state", async () => {
  const c = createCache({ ttlMs: 5000, maxSize: 100 });
  const ops = [];
  for (let i = 0; i < 100; i++) {
    ops.push(
      new Promise((resolve) => {
        c.set(`key-${i}`, i);
        resolve();
      })
    );
  }
  await Promise.all(ops);

  // All 100 should be present
  assert.equal(c.size(), 100);
  for (let i = 0; i < 100; i++) {
    assert.equal(c.get(`key-${i}`), i);
  }
});

test("cache: concurrent reads and writes are safe", async () => {
  const c = createCache({ ttlMs: 5000, maxSize: 50 });
  // Pre-fill
  for (let i = 0; i < 50; i++) {
    c.set(`k-${i}`, i);
  }
  // Concurrent mixed reads/writes
  const ops = [];
  for (let i = 0; i < 100; i++) {
    ops.push(
      new Promise((resolve) => {
        if (i % 2 === 0) {
          c.set(`k-${i % 50}`, i * 10);
        } else {
          c.get(`k-${i % 50}`);
        }
        resolve();
      })
    );
  }
  await Promise.all(ops);
  // Cache should still be functional
  assert.ok(c.size() <= 50);
  assert.ok(c.size() > 0);
});
