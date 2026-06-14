/**
 * Phase 35.2: Embedding cache tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  normalizeText,
  hashText,
  createEmbeddingCache,
  globalEmbeddingCache,
  getCacheStats,
} from "../lib/embedding-cache.js";

const MODEL = "text-embedding-3-small";

function vec(seed = 1, dims = 8) {
  const out = new Array(dims);
  for (let i = 0; i < dims; i++) out[i] = (seed + i) / 100;
  return out;
}

// ─── normalizeText ─────────────────────────────────────────────────────────

test("normalizeText: trims leading and trailing whitespace", () => {
  assert.equal(normalizeText("  hello  "), "hello");
});

test("normalizeText: collapses internal whitespace runs", () => {
  assert.equal(normalizeText("foo\t\tbar   baz"), "foo bar baz");
});

test("normalizeText: collapses newlines and tabs", () => {
  assert.equal(normalizeText("a\nb\rc\td"), "a b c d");
});

test("normalizeText: handles empty and null inputs", () => {
  assert.equal(normalizeText(""), "");
  assert.equal(normalizeText(null), "");
  assert.equal(normalizeText(undefined), "");
});

test("normalizeText: coerces non-string inputs", () => {
  assert.equal(normalizeText(42), "42");
});

// ─── hashText ──────────────────────────────────────────────────────────────

test("hashText: deterministic for the same input", () => {
  const a = hashText("hello world", MODEL);
  const b = hashText("hello world", MODEL);
  assert.equal(a, b);
  assert.equal(typeof a, "string");
  assert.equal(a.length, 64);
});

test("hashText: identical after normalization", () => {
  const a = hashText("  hello   world  ", MODEL);
  const b = hashText("hello world", MODEL);
  assert.equal(a, b);
});

test("hashText: differs across models", () => {
  const a = hashText("hello world", "model-a");
  const b = hashText("hello world", "model-b");
  assert.notEqual(a, b);
});

test("hashText: differs across distinct text", () => {
  const a = hashText("hello", MODEL);
  const b = hashText("world", MODEL);
  assert.notEqual(a, b);
});

// ─── get / set / has ───────────────────────────────────────────────────────

test("cache: set then get returns the embedding", async () => {
  const c = createEmbeddingCache();
  const v = vec(1);
  await c.set("hello", MODEL, v);
  const out = await c.get("hello", MODEL);
  assert.deepEqual(out, v);
});

test("cache: get on missing returns null", async () => {
  const c = createEmbeddingCache();
  const out = await c.get("missing", MODEL);
  assert.equal(out, null);
});

test("cache: has() reflects presence", async () => {
  const c = createEmbeddingCache();
  await c.set("yes", MODEL, vec(1));
  assert.equal(await c.has("yes", MODEL), true);
  assert.equal(await c.has("no", MODEL), false);
});

test("cache: get matches whitespace-equivalent text", async () => {
  const c = createEmbeddingCache();
  await c.set("hello world", MODEL, vec(2));
  const out = await c.get("  hello\tworld  ", MODEL);
  assert.deepEqual(out, vec(2));
});

test("cache: different model is a separate entry", async () => {
  const c = createEmbeddingCache();
  await c.set("hello", "model-a", vec(1));
  assert.equal(await c.get("hello", "model-b"), null);
});

// ─── stats tracking ────────────────────────────────────────────────────────

test("cache: stats tracks hits and misses", async () => {
  const c = createEmbeddingCache();
  await c.set("k1", MODEL, vec(1));
  await c.get("k1", MODEL); // hit
  await c.get("k1", MODEL); // hit
  await c.get("k2", MODEL); // miss
  const s = c.stats();
  assert.equal(s.hits, 2);
  assert.equal(s.misses, 1);
  assert.equal(s.savedApiCalls, 2);
  assert(Math.abs(s.hitRate - 2 / 3) < 1e-9);
  assert.equal(s.size, 1);
});

test("cache: stats memoryBytes increases as entries are added", async () => {
  const c = createEmbeddingCache();
  const before = c.stats().memoryBytes;
  await c.set("k", MODEL, vec(1, 16));
  const after = c.stats().memoryBytes;
  assert(after > before);
});

test("cache: clear resets stats and entries", async () => {
  const c = createEmbeddingCache();
  await c.set("a", MODEL, vec(1));
  await c.get("a", MODEL);
  await c.get("missing", MODEL);
  c.clear();
  const s = c.stats();
  assert.equal(s.hits, 0);
  assert.equal(s.misses, 0);
  assert.equal(s.size, 0);
  assert.equal(s.memoryBytes, 0);
});

// ─── batch get ─────────────────────────────────────────────────────────────

test("getBatch: returns all cached when fully populated", async () => {
  const c = createEmbeddingCache();
  await c.set("a", MODEL, vec(1));
  await c.set("b", MODEL, vec(2));
  const result = await c.getBatch(["a", "b"], MODEL);
  assert.equal(Object.keys(result.cached).length, 2);
  assert.deepEqual(result.cached[0], vec(1));
  assert.deepEqual(result.cached[1], vec(2));
  assert.equal(result.missing.length, 0);
});

test("getBatch: returns partial hits with missing entries", async () => {
  const c = createEmbeddingCache();
  await c.set("a", MODEL, vec(1));
  // "b" not cached
  await c.set("c", MODEL, vec(3));
  const result = await c.getBatch(["a", "b", "c"], MODEL);
  assert.deepEqual(result.cached[0], vec(1));
  assert.deepEqual(result.cached[2], vec(3));
  assert.equal(result.cached[1], undefined);
  assert.equal(result.missing.length, 1);
  assert.equal(result.missing[0].idx, 1);
  assert.equal(result.missing[0].text, "b");
});

test("getBatch: all missing yields empty cached", async () => {
  const c = createEmbeddingCache();
  const result = await c.getBatch(["x", "y"], MODEL);
  assert.equal(Object.keys(result.cached).length, 0);
  assert.equal(result.missing.length, 2);
});

test("getBatch: updates hit/miss stats", async () => {
  const c = createEmbeddingCache();
  await c.set("a", MODEL, vec(1));
  await c.getBatch(["a", "b", "c"], MODEL);
  const s = c.stats();
  assert.equal(s.hits, 1);
  assert.equal(s.misses, 2);
});

// ─── batch set ─────────────────────────────────────────────────────────────

test("setBatch: stores all entries", async () => {
  const c = createEmbeddingCache();
  await c.setBatch(["a", "b", "c"], MODEL, [vec(1), vec(2), vec(3)]);
  assert.equal(c.size(), 3);
  assert.deepEqual(await c.get("a", MODEL), vec(1));
  assert.deepEqual(await c.get("b", MODEL), vec(2));
  assert.deepEqual(await c.get("c", MODEL), vec(3));
});

test("setBatch: tolerates length mismatch (uses shorter)", async () => {
  const c = createEmbeddingCache();
  await c.setBatch(["a", "b", "c"], MODEL, [vec(1), vec(2)]);
  assert.equal(c.size(), 2);
  assert.equal(await c.get("c", MODEL), null);
});

test("setBatch: skips invalid entries", async () => {
  const c = createEmbeddingCache();
  await c.setBatch(["a", null, "c"], MODEL, [vec(1), vec(2), "not-an-array"]);
  assert.equal(c.size(), 1);
  assert.deepEqual(await c.get("a", MODEL), vec(1));
});

// ─── persistence ───────────────────────────────────────────────────────────

test("persist + load: round-trip preserves entries", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "embed-cache-"));
  const file = path.join(tmp, "cache.json");
  try {
    const c1 = createEmbeddingCache();
    await c1.set("hello", MODEL, vec(1));
    await c1.set("world", MODEL, vec(2));
    await c1.persist(file);

    const c2 = createEmbeddingCache();
    const n = await c2.load(file);
    assert.equal(n, 2);
    assert.deepEqual(await c2.get("hello", MODEL), vec(1));
    assert.deepEqual(await c2.get("world", MODEL), vec(2));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("load: missing file returns 0 without throwing", async () => {
  const c = createEmbeddingCache();
  const n = await c.load(path.join(os.tmpdir(), `missing-${Date.now()}.json`));
  assert.equal(n, 0);
});

test("persist: creates parent directory if missing", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "embed-cache-"));
  const file = path.join(tmp, "nested", "deep", "cache.json");
  try {
    const c = createEmbeddingCache();
    await c.set("k", MODEL, vec(1));
    await c.persist(file);
    const stat = await fs.stat(file);
    assert(stat.isFile());
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

// ─── LRU eviction ──────────────────────────────────────────────────────────

test("LRU: evicts oldest entry when maxSize exceeded", async () => {
  const c = createEmbeddingCache({ maxSize: 3 });
  await c.set("a", MODEL, vec(1));
  await c.set("b", MODEL, vec(2));
  await c.set("c", MODEL, vec(3));
  await c.set("d", MODEL, vec(4));
  assert.equal(c.size(), 3);
  assert.equal(await c.has("a", MODEL), false);
  assert.equal(await c.has("b", MODEL), true);
  assert.equal(await c.has("c", MODEL), true);
  assert.equal(await c.has("d", MODEL), true);
});

test("LRU: get() refreshes recency, protecting entry from eviction", async () => {
  const c = createEmbeddingCache({ maxSize: 3 });
  await c.set("a", MODEL, vec(1));
  await c.set("b", MODEL, vec(2));
  await c.set("c", MODEL, vec(3));
  await c.get("a", MODEL); // refresh "a"
  await c.set("d", MODEL, vec(4));
  // "b" is now the oldest and should be evicted
  assert.equal(await c.has("a", MODEL), true);
  assert.equal(await c.has("b", MODEL), false);
});

test("LRU: maxSize=1 keeps only most recent", async () => {
  const c = createEmbeddingCache({ maxSize: 1 });
  await c.set("a", MODEL, vec(1));
  await c.set("b", MODEL, vec(2));
  assert.equal(c.size(), 1);
  assert.equal(await c.has("a", MODEL), false);
  assert.equal(await c.has("b", MODEL), true);
});

// ─── globalEmbeddingCache ──────────────────────────────────────────────────

test("globalEmbeddingCache: exists and supports basic ops", async () => {
  const initialSize = globalEmbeddingCache.size();
  await globalEmbeddingCache.set("phase35.2-test", MODEL, vec(7));
  assert.equal(await globalEmbeddingCache.has("phase35.2-test", MODEL), true);
  // Cleanup so we don't leak across other tests
  globalEmbeddingCache.clear();
  assert.equal(globalEmbeddingCache.size(), 0);
  // initialSize is irrelevant after clear; assert post-clear state.
  assert(initialSize >= 0);
});

// ─── observability counters / getCacheStats ────────────────────────────────

test("getCacheStats: returns 0 hits/misses on a fresh global cache", () => {
  globalEmbeddingCache.clear();
  const s = getCacheStats();
  assert.equal(s.hits, 0);
  assert.equal(s.misses, 0);
  assert.equal(s.evictions.lru, 0);
  assert.equal(s.evictions.ttl, 0);
  assert.equal(s.evictions.manual, 0);
  assert.equal(s.size, 0);
  assert(typeof s.maxSize === "number" && s.maxSize > 0);
});

test("getCacheStats: after get-miss, set, get-hit shows 1 miss and 1 hit", async () => {
  globalEmbeddingCache.clear();
  await globalEmbeddingCache.get("stats-fresh", MODEL); // miss
  await globalEmbeddingCache.set("stats-fresh", MODEL, vec(9));
  await globalEmbeddingCache.get("stats-fresh", MODEL); // hit
  const s = getCacheStats();
  assert.equal(s.hits, 1);
  assert.equal(s.misses, 1);
  assert.equal(s.size, 1);
  globalEmbeddingCache.clear();
});

test("evictions: filling cache to max+1 increments lru eviction counter", async () => {
  const c = createEmbeddingCache({ maxSize: 2 });
  await c.set("a", MODEL, vec(1));
  await c.set("b", MODEL, vec(2));
  assert.equal(c.stats().evictions.lru, 0);
  await c.set("c", MODEL, vec(3)); // triggers LRU eviction of "a"
  const s = c.stats();
  assert.equal(s.evictions.lru, 1);
  assert.equal(s.size, 2);
});

test("evictions: manual evict() increments manual eviction counter", async () => {
  const c = createEmbeddingCache({ maxSize: 5 });
  await c.set("k", MODEL, vec(1));
  assert.equal(c.stats().evictions.manual, 0);
  const removed = c.evict("k", MODEL);
  assert.equal(removed, true);
  const s = c.stats();
  assert.equal(s.evictions.manual, 1);
  assert.equal(s.size, 0);
  // Evicting a missing key is a no-op
  assert.equal(c.evict("missing", MODEL), false);
  assert.equal(c.stats().evictions.manual, 1);
});

test("renderPrometheus: contains embedding cache metric lines", async () => {
  process.env.ENABLE_METRICS = "1";
  globalEmbeddingCache.clear();
  await globalEmbeddingCache.get("prom-miss", MODEL); // miss
  await globalEmbeddingCache.set("prom-hit", MODEL, vec(1));
  await globalEmbeddingCache.get("prom-hit", MODEL); // hit
  const { renderPrometheus } = await import("../lib/metrics.js");
  const out = renderPrometheus();
  assert.match(out, /# HELP siskelbot_embedding_cache_hits_total/);
  assert.match(out, /# TYPE siskelbot_embedding_cache_hits_total counter/);
  assert.match(out, /^siskelbot_embedding_cache_hits_total \d+/m);
  assert.match(out, /^siskelbot_embedding_cache_misses_total \d+/m);
  assert.match(out, /^siskelbot_embedding_cache_evictions_total\{reason="lru"\} \d+/m);
  assert.match(out, /^siskelbot_embedding_cache_evictions_total\{reason="ttl"\} \d+/m);
  assert.match(out, /^siskelbot_embedding_cache_evictions_total\{reason="manual"\} \d+/m);
  assert.match(out, /# TYPE siskelbot_embedding_cache_size gauge/);
  assert.match(out, /^siskelbot_embedding_cache_size \d+/m);
  globalEmbeddingCache.clear();
});
