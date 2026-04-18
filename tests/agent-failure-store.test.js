/**
 * Tests for the persistent per-workspace failure store.
 * Uses an isolated STORAGE_PATH so tests don't touch the real data dir.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const tmpRoot = mkdtempSync(join(tmpdir(), "siskel-failure-store-"));
process.env.STORAGE_PATH = tmpRoot;

const {
  recordFailure,
  recordRunFailures,
  loadFailureStats,
  rankChronicFailures,
  isChronicallyBroken,
  resetFailureStats,
} = await import("../lib/agent-failure-store.js");

function uniqueWs(tag) {
  return `t-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

test.after(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
});

test("recordFailure: single failure creates tool entry", async () => {
  const ws = uniqueWs("single");
  const stats = await recordFailure(ws, "web_search", "rate_limit");
  assert.equal(stats.tools.web_search.total, 1);
  assert.equal(stats.tools.web_search.byCategory.rate_limit, 1);
  assert.ok(stats.tools.web_search.lastTs > 0);
});

test("recordFailure: accumulates across calls for same tool/category", async () => {
  const ws = uniqueWs("accum");
  await recordFailure(ws, "web_search", "rate_limit");
  await recordFailure(ws, "web_search", "rate_limit");
  const stats = await recordFailure(ws, "web_search", "timeout");
  assert.equal(stats.tools.web_search.total, 3);
  assert.equal(stats.tools.web_search.byCategory.rate_limit, 2);
  assert.equal(stats.tools.web_search.byCategory.timeout, 1);
});

test("recordRunFailures: batch write accumulates all entries", async () => {
  const ws = uniqueWs("batch");
  await recordRunFailures(ws, [
    { tool: "a", category: "permission" },
    { tool: "a", category: "permission" },
    { tool: "b", category: "timeout" },
  ]);
  const stats = await loadFailureStats(ws);
  assert.equal(stats.tools.a.total, 2);
  assert.equal(stats.tools.a.byCategory.permission, 2);
  assert.equal(stats.tools.b.byCategory.timeout, 1);
});

test("recordRunFailures: empty array is a no-op (no file write)", async () => {
  const ws = uniqueWs("empty");
  const before = await loadFailureStats(ws);
  assert.equal(Object.keys(before.tools).length, 0);
  await recordRunFailures(ws, []);
  const after = await loadFailureStats(ws);
  assert.equal(Object.keys(after.tools).length, 0);
});

test("recordRunFailures: skips malformed entries", async () => {
  const ws = uniqueWs("malformed");
  await recordRunFailures(ws, [
    { tool: "ok", category: "timeout" },
    null,
    { tool: "", category: "permission" },
    { tool: "no_cat" },
    { category: "lonely" },
  ]);
  const stats = await loadFailureStats(ws);
  assert.equal(Object.keys(stats.tools).length, 1);
  assert.equal(stats.tools.ok.total, 1);
});

test("rankChronicFailures: terminal categories weighted higher", async () => {
  const ws = uniqueWs("rank");
  await recordRunFailures(ws, [
    { tool: "sometimes_slow", category: "timeout" },
    { tool: "sometimes_slow", category: "timeout" },
    { tool: "sometimes_slow", category: "rate_limit" },
    { tool: "truly_broken", category: "permission" },
  ]);
  const ranked = await rankChronicFailures(ws, 5);
  // truly_broken: 5, sometimes_slow: 1+1+1 = 3
  assert.equal(ranked[0].tool, "truly_broken");
  assert.equal(ranked[1].tool, "sometimes_slow");
  assert.ok(ranked[0].score > ranked[1].score);
});

test("isChronicallyBroken: flags tool with >=3 terminal failures", async () => {
  const ws = uniqueWs("chronic");
  await recordRunFailures(ws, [
    { tool: "bad_tool", category: "permission" },
    { tool: "bad_tool", category: "permission" },
    { tool: "bad_tool", category: "permission" },
  ]);
  const c = await isChronicallyBroken(ws, "bad_tool");
  assert.equal(c.chronic, true);
  assert.equal(c.terminalCount, 3);
  assert.equal(c.dominantCategory, "permission");
});

test("isChronicallyBroken: transient-only failures do not trigger chronic", async () => {
  const ws = uniqueWs("transient");
  await recordRunFailures(ws, [
    { tool: "flaky", category: "rate_limit" },
    { tool: "flaky", category: "rate_limit" },
    { tool: "flaky", category: "network" },
    { tool: "flaky", category: "timeout" },
  ]);
  const c = await isChronicallyBroken(ws, "flaky");
  assert.equal(c.chronic, false);
  assert.equal(c.terminalCount, 0);
});

test("isChronicallyBroken: unknown tool returns no chronic", async () => {
  const ws = uniqueWs("unknown");
  const c = await isChronicallyBroken(ws, "never_seen");
  assert.equal(c.chronic, false);
  assert.equal(c.terminalCount, 0);
  assert.equal(c.dominantCategory, null);
});

test("isChronicallyBroken: respects custom minTerminalCount", async () => {
  const ws = uniqueWs("custom-min");
  await recordFailure(ws, "meh", "permission");
  const c1 = await isChronicallyBroken(ws, "meh");
  assert.equal(c1.chronic, false);
  const c2 = await isChronicallyBroken(ws, "meh", { minTerminalCount: 1 });
  assert.equal(c2.chronic, true);
});

test("resetFailureStats: clears all tools for a workspace", async () => {
  const ws = uniqueWs("reset");
  await recordFailure(ws, "x", "permission");
  await recordFailure(ws, "y", "timeout");
  await resetFailureStats(ws);
  const stats = await loadFailureStats(ws);
  assert.equal(Object.keys(stats.tools).length, 0);
});

test("loadFailureStats: returns empty shape for unknown workspace", async () => {
  const stats = await loadFailureStats(uniqueWs("fresh"));
  assert.equal(stats.version, 1);
  assert.deepEqual(stats.tools, {});
});

test("workspace isolation: failures in ws1 do not leak into ws2", async () => {
  const ws1 = uniqueWs("iso1");
  const ws2 = uniqueWs("iso2");
  await recordFailure(ws1, "tool", "permission");
  const s1 = await loadFailureStats(ws1);
  const s2 = await loadFailureStats(ws2);
  assert.equal(s1.tools.tool.total, 1);
  assert.equal(s2.tools.tool, undefined);
});
