/**
 * Tests for lib/query-cache.js (Phase 35.1).
 *
 * These exercise the wrap/invalidate flow against an in-memory backed
 * redis-cache (no live Redis required).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createRedisCache } from "../lib/redis-cache.js";
import { createQueryCache, hashKeySource } from "../lib/query-cache.js";

function makeCache(prefix) {
  return createRedisCache({ ttlMs: 5000, keyPrefix: prefix, redisUrl: "" });
}

test("query-cache: wrap caches the result, fn runs only once", async () => {
  const qc = createQueryCache(makeCache("qc1:"));
  let calls = 0;
  const fn = async () => {
    calls++;
    return { value: 42 };
  };

  const a = await qc.wrap({ kind: "x", id: 1 }, fn);
  const b = await qc.wrap({ kind: "x", id: 1 }, fn);
  assert.deepEqual(a, { value: 42 });
  assert.deepEqual(b, { value: 42 });
  assert.equal(calls, 1);
});

test("query-cache: distinct key sources cache independently", async () => {
  const qc = createQueryCache(makeCache("qc2:"));
  let calls = 0;
  const fn = async (label) => {
    calls++;
    return { label };
  };

  const a = await qc.wrap({ id: 1 }, () => fn("a"));
  const b = await qc.wrap({ id: 2 }, () => fn("b"));
  assert.equal(a.label, "a");
  assert.equal(b.label, "b");
  assert.equal(calls, 2);
});

test("query-cache: object key order does not affect hash", async () => {
  const qc = createQueryCache(makeCache("qc3:"));
  let calls = 0;
  const fn = async () => {
    calls++;
    return "result";
  };

  await qc.wrap({ a: 1, b: 2 }, fn);
  await qc.wrap({ b: 2, a: 1 }, fn);
  assert.equal(calls, 1);
});

test("query-cache: hashKeySource is deterministic and stable", () => {
  const h1 = hashKeySource({ a: [1, 2], b: "x" });
  const h2 = hashKeySource({ b: "x", a: [1, 2] });
  assert.equal(h1, h2);
  assert.notEqual(h1, hashKeySource({ a: [1, 2], b: "y" }));
});

test("query-cache: invalidate('*') clears all entries", async () => {
  const qc = createQueryCache(makeCache("qc4:"));
  let calls = 0;
  const fn = async () => {
    calls++;
    return "v";
  };
  await qc.wrap({ id: 1 }, fn);
  await qc.invalidate("*");
  await qc.wrap({ id: 1 }, fn);
  assert.equal(calls, 2);
});

test("query-cache: invalidateKey clears a single entry", async () => {
  const qc = createQueryCache(makeCache("qc5:"));
  let calls = 0;
  const fn = async () => {
    calls++;
    return "v";
  };
  await qc.wrap({ id: 1 }, fn);
  await qc.wrap({ id: 2 }, fn);
  await qc.invalidateKey({ id: 1 });
  await qc.wrap({ id: 1 }, fn); // miss -> calls++
  await qc.wrap({ id: 2 }, fn); // hit -> no call
  assert.equal(calls, 3);
});

test("query-cache: getStats reports wrap hits/misses", async () => {
  const qc = createQueryCache(makeCache("qc6:"));
  const fn = async () => ({ ok: true });
  await qc.wrap("k", fn); // miss
  await qc.wrap("k", fn); // hit
  await qc.wrap("k", fn); // hit
  const s = await qc.getStats();
  assert.equal(s.wrapHits, 2);
  assert.equal(s.wrapMisses, 1);
  assert.ok(Math.abs(s.wrapHitRate - 2 / 3) < 1e-9);
});

test("query-cache: ttlMs override is honored", async () => {
  const qc = createQueryCache(makeCache("qc7:"));
  let calls = 0;
  const fn = async () => {
    calls++;
    return "v";
  };
  await qc.wrap("expiring", fn, 50);
  await new Promise((r) => setTimeout(r, 80));
  await qc.wrap("expiring", fn, 50);
  assert.equal(calls, 2);
});

test("query-cache: undefined return value is not cached", async () => {
  const qc = createQueryCache(makeCache("qc8:"));
  let calls = 0;
  const fn = async () => {
    calls++;
    return undefined;
  };
  await qc.wrap("u", fn);
  await qc.wrap("u", fn);
  assert.equal(calls, 2);
});
