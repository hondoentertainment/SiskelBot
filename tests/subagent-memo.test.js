/**
 * Tests for lib/subagent-memo.js — subagent result memoization with
 * TTL, LRU eviction, hit tracking, and workspace isolation.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  computeMemoKey,
  getMemo,
  setMemo,
  invalidateMemo,
  getMemoStats,
  pruneMemos,
} from "../lib/subagent-memo.js";

const WS = "test-memo-" + Date.now();
const WS2 = "test-memo-isolated-" + Date.now();

// ── computeMemoKey ──────────────────────────────────────────────────────────

test("computeMemoKey is deterministic", () => {
  const a = computeMemoKey("researcher", "What is Node.js?");
  const b = computeMemoKey("researcher", "What is Node.js?");
  assert.equal(a, b);
});

test("computeMemoKey produces different keys for different goals", () => {
  const a = computeMemoKey("researcher", "What is Node.js?");
  const b = computeMemoKey("researcher", "What is Python?");
  assert.notEqual(a, b);
});

test("computeMemoKey produces different keys for different profiles", () => {
  const a = computeMemoKey("researcher", "What is Node.js?");
  const b = computeMemoKey("executor", "What is Node.js?");
  assert.notEqual(a, b);
});

test("computeMemoKey normalizes profile to lowercase", () => {
  const a = computeMemoKey("Researcher", "goal");
  const b = computeMemoKey("researcher", "goal");
  assert.equal(a, b);
});

test("computeMemoKey returns a 64-char hex string (SHA-256)", () => {
  const key = computeMemoKey("researcher", "test");
  assert.match(key, /^[a-f0-9]{64}$/);
});

test("computeMemoKey handles null/undefined profile as default", () => {
  const a = computeMemoKey(null, "goal");
  const b = computeMemoKey(undefined, "goal");
  const c = computeMemoKey("default", "goal");
  assert.equal(a, b);
  assert.equal(a, c);
});

// ── setMemo + getMemo roundtrip ─────────────────────────────────────────────

test("setMemo + getMemo roundtrip returns stored result", async () => {
  const key = computeMemoKey("researcher", "roundtrip-test");
  await setMemo(WS, key, {
    result: "Node.js is a runtime",
    costUsd: 0.01,
    iterations: 3,
    profile: "researcher",
    goal: "roundtrip-test",
  });

  const memo = await getMemo(WS, key);
  assert.ok(memo);
  assert.equal(memo.result, "Node.js is a runtime");
  assert.equal(memo.costUsd, 0.01);
  assert.equal(memo.iterations, 3);
  assert.equal(memo.hitCount, 1);
  assert.ok(memo.cachedAt);
});

test("getMemo returns null for non-existent key", async () => {
  const memo = await getMemo(WS, "nonexistent-key-12345");
  assert.equal(memo, null);
});

test("getMemo increments hitCount on each call", async () => {
  const key = computeMemoKey("researcher", "hit-count-test");
  await setMemo(WS, key, { result: "cached", costUsd: 0.05, iterations: 2 });

  await getMemo(WS, key);
  await getMemo(WS, key);
  const memo = await getMemo(WS, key);
  assert.equal(memo.hitCount, 3);
});

// ── TTL expiry ──────────────────────────────────────────────────────────────

test("getMemo returns null for expired entries", async () => {
  const origTtl = process.env.SUBAGENT_MEMO_TTL_MS;
  try {
    // Set TTL to 1ms so the entry expires immediately
    process.env.SUBAGENT_MEMO_TTL_MS = "1";
    const key = computeMemoKey("researcher", "ttl-expiry-test-" + Date.now());
    await setMemo(WS, key, { result: "will expire", costUsd: 0.01, iterations: 1 });

    // Small delay to ensure expiry
    await new Promise((r) => setTimeout(r, 10));

    const memo = await getMemo(WS, key);
    assert.equal(memo, null);
  } finally {
    if (origTtl === undefined) delete process.env.SUBAGENT_MEMO_TTL_MS;
    else process.env.SUBAGENT_MEMO_TTL_MS = origTtl;
  }
});

// ── Max entries / LRU eviction ──────────────────────────────────────────────

test("setMemo evicts LRU entries when max entries exceeded", async () => {
  const origMax = process.env.SUBAGENT_MEMO_MAX_ENTRIES;
  const evictWs = "test-memo-evict-" + Date.now();
  try {
    process.env.SUBAGENT_MEMO_MAX_ENTRIES = "3";

    // Insert 3 entries
    const key1 = computeMemoKey("researcher", "evict-1");
    const key2 = computeMemoKey("researcher", "evict-2");
    const key3 = computeMemoKey("researcher", "evict-3");

    await setMemo(evictWs, key1, { result: "r1", costUsd: 0.01, iterations: 1 });
    await setMemo(evictWs, key2, { result: "r2", costUsd: 0.01, iterations: 1 });
    await setMemo(evictWs, key3, { result: "r3", costUsd: 0.01, iterations: 1 });

    // Access key1 so it becomes recently used
    await getMemo(evictWs, key1);

    // Insert a 4th entry — should evict key2 (LRU, since key1 was just accessed)
    const key4 = computeMemoKey("researcher", "evict-4");
    await setMemo(evictWs, key4, { result: "r4", costUsd: 0.01, iterations: 1 });

    const stats = await getMemoStats(evictWs);
    assert.equal(stats.totalEntries, 3);

    // key1 should still be there (recently accessed)
    const memo1 = await getMemo(evictWs, key1);
    assert.ok(memo1, "key1 should survive eviction (recently accessed)");

    // key4 should be there (just inserted)
    const memo4 = await getMemo(evictWs, key4);
    assert.ok(memo4, "key4 should exist (just inserted)");
  } finally {
    if (origMax === undefined) delete process.env.SUBAGENT_MEMO_MAX_ENTRIES;
    else process.env.SUBAGENT_MEMO_MAX_ENTRIES = origMax;
  }
});

// ── invalidateMemo ──────────────────────────────────────────────────────────

test("invalidateMemo removes an existing entry", async () => {
  const key = computeMemoKey("researcher", "invalidate-test");
  await setMemo(WS, key, { result: "to be invalidated", costUsd: 0.02, iterations: 1 });

  const removed = await invalidateMemo(WS, key);
  assert.equal(removed, true);

  const memo = await getMemo(WS, key);
  assert.equal(memo, null);
});

test("invalidateMemo returns false for non-existent key", async () => {
  const removed = await invalidateMemo(WS, "nonexistent-invalidate-key");
  assert.equal(removed, false);
});

// ── getMemoStats ─────────────────────────────────────────────────────────────

test("getMemoStats returns correct structure and values", async () => {
  const statsWs = "test-memo-stats-" + Date.now();
  const key = computeMemoKey("researcher", "stats-test");
  await setMemo(statsWs, key, { result: "stats result", costUsd: 0.10, iterations: 5 });

  // Access twice to build hits
  await getMemo(statsWs, key);
  await getMemo(statsWs, key);

  const stats = await getMemoStats(statsWs);
  assert.equal(stats.totalEntries, 1);
  assert.equal(stats.totalHits, 2);
  assert.equal(stats.estimatedSavingsUsd, 0.10 * 2);
});

test("getMemoStats returns zeros for empty workspace", async () => {
  const stats = await getMemoStats("test-memo-empty-" + Date.now());
  assert.equal(stats.totalEntries, 0);
  assert.equal(stats.totalHits, 0);
  assert.equal(stats.estimatedSavingsUsd, 0);
});

// ── pruneMemos ──────────────────────────────────────────────────────────────

test("pruneMemos removes expired entries", async () => {
  const pruneWs = "test-memo-prune-" + Date.now();
  const key = computeMemoKey("researcher", "prune-test");
  await setMemo(pruneWs, key, { result: "old", costUsd: 0.01, iterations: 1 });

  // Prune with maxAge=1ms (everything is expired)
  await new Promise((r) => setTimeout(r, 10));
  const { pruned } = await pruneMemos(pruneWs, { maxAge: 1 });
  assert.ok(pruned >= 1);

  const memo = await getMemo(pruneWs, key);
  assert.equal(memo, null);
});

test("pruneMemos enforces maxEntries via LRU", async () => {
  const pruneWs2 = "test-memo-prune2-" + Date.now();
  await setMemo(pruneWs2, computeMemoKey("a", "1"), { result: "r1" });
  await setMemo(pruneWs2, computeMemoKey("a", "2"), { result: "r2" });
  await setMemo(pruneWs2, computeMemoKey("a", "3"), { result: "r3" });

  const { pruned } = await pruneMemos(pruneWs2, { maxEntries: 1, maxAge: 999999999 });
  assert.equal(pruned, 2);

  const stats = await getMemoStats(pruneWs2);
  assert.equal(stats.totalEntries, 1);
});

test("pruneMemos returns zero when nothing to prune", async () => {
  const pruneWs3 = "test-memo-prune3-" + Date.now();
  await setMemo(pruneWs3, computeMemoKey("a", "fresh"), { result: "fresh" });

  const { pruned } = await pruneMemos(pruneWs3, { maxAge: 999999999, maxEntries: 500 });
  assert.equal(pruned, 0);
});

// ── Workspace isolation ─────────────────────────────────────────────────────

test("workspaces are isolated from each other", async () => {
  const key = computeMemoKey("researcher", "isolation-test");
  await setMemo(WS, key, { result: "ws1 result", costUsd: 0.01, iterations: 1 });

  const memoWs2 = await getMemo(WS2, key);
  assert.equal(memoWs2, null, "workspace 2 should not see workspace 1 entries");

  await setMemo(WS2, key, { result: "ws2 result", costUsd: 0.02, iterations: 2 });
  const memo1 = await getMemo(WS, key);
  const memo2 = await getMemo(WS2, key);
  assert.equal(memo1.result, "ws1 result");
  assert.equal(memo2.result, "ws2 result");
});
