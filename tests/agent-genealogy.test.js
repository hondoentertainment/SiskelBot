/**
 * Tests for cross-run decision genealogy (per-workspace tool success rates).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const tmpRoot = mkdtempSync(join(tmpdir(), "siskel-genealogy-"));
process.env.STORAGE_PATH = tmpRoot;

const {
  recordToolOutcomes,
  loadToolOutcomes,
  getToolReliability,
  rankByReliability,
  buildReliabilityHint,
  resetGenealogy,
} = await import("../lib/agent-genealogy.js");

function uniqueWs(tag) {
  return `t-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

test.after(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
});

test("recordToolOutcomes: accumulates successes and failures per tool", async () => {
  const ws = uniqueWs("accum");
  await recordToolOutcomes(ws, [
    { tool: "search_context", ok: true },
    { tool: "search_context", ok: true },
    { tool: "search_context", ok: false },
    { tool: "web_search", ok: false },
  ]);
  const stats = await loadToolOutcomes(ws);
  assert.equal(stats.tools.search_context.successes, 2);
  assert.equal(stats.tools.search_context.failures, 1);
  assert.equal(stats.tools.web_search.successes, 0);
  assert.equal(stats.tools.web_search.failures, 1);
});

test("recordToolOutcomes: empty array is a no-op", async () => {
  const ws = uniqueWs("empty");
  await recordToolOutcomes(ws, []);
  const stats = await loadToolOutcomes(ws);
  assert.equal(Object.keys(stats.tools).length, 0);
});

test("recordToolOutcomes: skips malformed entries", async () => {
  const ws = uniqueWs("malformed");
  await recordToolOutcomes(ws, [
    { tool: "ok", ok: true },
    null,
    { tool: "", ok: true },
    { ok: true },
  ]);
  const stats = await loadToolOutcomes(ws);
  assert.equal(Object.keys(stats.tools).length, 1);
  assert.equal(stats.tools.ok.successes, 1);
});

test("getToolReliability: unknown tool returns 0.5 smoothed rate, 0 samples", async () => {
  const stats = await loadToolOutcomes(uniqueWs("rely-unknown"));
  const r = getToolReliability(stats, "any");
  assert.equal(r.sampleSize, 0);
  assert.equal(r.successRate, 0.5);
});

test("getToolReliability: Laplace-smoothed rate pulls small-n tools toward 0.5", async () => {
  const ws = uniqueWs("rely-smooth");
  await recordToolOutcomes(ws, [
    { tool: "one_fail", ok: false },
  ]);
  const stats = await loadToolOutcomes(ws);
  const r = getToolReliability(stats, "one_fail");
  // With PRIOR_STRENGTH=2: (0 + 1) / (1 + 2) = 0.333..
  assert.ok(r.successRate > 0.2 && r.successRate < 0.5);
  assert.equal(r.sampleSize, 1);
});

test("getToolReliability: many samples converges near raw rate", async () => {
  const ws = uniqueWs("rely-many");
  const outs = [];
  for (let i = 0; i < 100; i++) outs.push({ tool: "reliable", ok: true });
  for (let i = 0; i < 10; i++) outs.push({ tool: "reliable", ok: false });
  await recordToolOutcomes(ws, outs);
  const stats = await loadToolOutcomes(ws);
  const r = getToolReliability(stats, "reliable");
  assert.ok(r.successRate > 0.88);
  assert.equal(r.sampleSize, 110);
});

test("rankByReliability: sorts descending by smoothed rate, drops below minSamples", async () => {
  const ws = uniqueWs("rank");
  const outs = [];
  for (let i = 0; i < 10; i++) outs.push({ tool: "good", ok: true });
  for (let i = 0; i < 5; i++) outs.push({ tool: "okay", ok: true });
  for (let i = 0; i < 5; i++) outs.push({ tool: "okay", ok: false });
  outs.push({ tool: "bad", ok: false });
  outs.push({ tool: "bad", ok: false });
  outs.push({ tool: "bad", ok: false });
  outs.push({ tool: "noise", ok: true }); // only 1 sample -> dropped by minSamples
  await recordToolOutcomes(ws, outs);
  const stats = await loadToolOutcomes(ws);
  const ranked = rankByReliability(stats, { minSamples: 3 });
  assert.equal(ranked[0].tool, "good");
  assert.equal(ranked[ranked.length - 1].tool, "bad");
  assert.ok(ranked.every((r) => r.tool !== "noise"));
});

test("buildReliabilityHint: empty store produces empty hint", async () => {
  const hint = await buildReliabilityHint(uniqueWs("empty-hint"));
  assert.equal(hint, "");
});

test("buildReliabilityHint: flags tools above/below thresholds", async () => {
  const ws = uniqueWs("hint");
  const outs = [];
  for (let i = 0; i < 10; i++) outs.push({ tool: "winner", ok: true });
  for (let i = 0; i < 8; i++) outs.push({ tool: "loser", ok: false });
  for (let i = 0; i < 5; i++) outs.push({ tool: "middle", ok: true });
  for (let i = 0; i < 5; i++) outs.push({ tool: "middle", ok: false });
  await recordToolOutcomes(ws, outs);
  const hint = await buildReliabilityHint(ws);
  assert.match(hint, /winner/);
  assert.match(hint, /loser/);
  assert.match(hint, /High success/);
  assert.match(hint, /Chronic failures/);
  // middle is around 50% — should NOT appear in either bucket under defaults
  assert.doesNotMatch(hint, /\bmiddle\b/);
});

test("buildReliabilityHint: respects preferAbove / avoidBelow overrides", async () => {
  const ws = uniqueWs("thresh");
  const outs = [];
  for (let i = 0; i < 6; i++) outs.push({ tool: "decent", ok: true });
  for (let i = 0; i < 4; i++) outs.push({ tool: "decent", ok: false });
  await recordToolOutcomes(ws, outs);
  // 60% is not above 0.8, so default hint should not list it
  const def = await buildReliabilityHint(ws);
  assert.equal(def, "");
  // Lower threshold - should now list it
  const looser = await buildReliabilityHint(ws, { preferAbove: 0.55 });
  assert.match(looser, /decent/);
});

test("resetGenealogy: clears all tools for a workspace", async () => {
  const ws = uniqueWs("reset");
  await recordToolOutcomes(ws, [{ tool: "x", ok: true }]);
  await resetGenealogy(ws);
  const stats = await loadToolOutcomes(ws);
  assert.equal(Object.keys(stats.tools).length, 0);
});

test("extractTaskKeywords: tokenizes and stems task text", async () => {
  const { extractTaskKeywords } = await import("../lib/agent-genealogy.js");
  const kw = extractTaskKeywords("Please search the docs for a user guide.");
  assert.ok(kw.has("search"));
  assert.ok(kw.has("docs"));
  assert.ok(kw.has("doc"), "should stem 'docs' to 'doc'");
  assert.ok(kw.has("user"));
  assert.ok(kw.has("guide"));
  // stopwords dropped
  assert.ok(!kw.has("the"));
  assert.ok(!kw.has("please"));
});

test("extractTaskKeywords: empty / non-string returns empty set", async () => {
  const { extractTaskKeywords } = await import("../lib/agent-genealogy.js");
  assert.equal(extractTaskKeywords("").size, 0);
  assert.equal(extractTaskKeywords(null).size, 0);
});

test("toolMatchesTask: matches on underscore-separated parts and prefixes", async () => {
  const { toolMatchesTask, extractTaskKeywords } = await import("../lib/agent-genealogy.js");
  const task = extractTaskKeywords("search for a document in the knowledge base");
  assert.equal(toolMatchesTask("search_context", task), true);
  assert.equal(toolMatchesTask("semantic_search_context", task), true);
  assert.equal(toolMatchesTask("get_context_document", task), true);
  assert.equal(toolMatchesTask("fetch_allowed_url", task), false);
});

test("buildReliabilityHint: task text restricts to relevant tools", async () => {
  const { recordToolOutcomes, buildReliabilityHint } = await import("../lib/agent-genealogy.js");
  const ws = `wsTaskAware-${Date.now()}`;
  const outs = [];
  // Reliable search tool
  for (let i = 0; i < 10; i++) outs.push({ tool: "search_context", ok: true });
  // Reliable URL fetcher - NOT relevant to a "search for docs" task
  for (let i = 0; i < 10; i++) outs.push({ tool: "fetch_allowed_url", ok: true });
  await recordToolOutcomes(ws, outs);

  const taskHint = await buildReliabilityHint(ws, { taskText: "search for a user guide in the docs" });
  assert.match(taskHint, /Task-relevant/);
  assert.match(taskHint, /search_context/);
  assert.doesNotMatch(taskHint, /fetch_allowed_url/);
});

test("buildReliabilityHint: falls back to full hint when no tool names match task", async () => {
  const { recordToolOutcomes, buildReliabilityHint } = await import("../lib/agent-genealogy.js");
  const ws = `wsTaskFallback-${Date.now()}`;
  const outs = [];
  for (let i = 0; i < 10; i++) outs.push({ tool: "search_context", ok: true });
  await recordToolOutcomes(ws, outs);
  // Task that shares no words with the tool name
  const hint = await buildReliabilityHint(ws, { taskText: "lorem ipsum random words" });
  // Falls back to non-task header
  assert.doesNotMatch(hint, /Task-relevant/);
  assert.match(hint, /search_context/);
});

test("buildReliabilityHint: empty taskText behaves like un-scoped call", async () => {
  const { recordToolOutcomes, buildReliabilityHint } = await import("../lib/agent-genealogy.js");
  const ws = `wsTaskEmpty-${Date.now()}`;
  const outs = [];
  for (let i = 0; i < 10; i++) outs.push({ tool: "search_context", ok: true });
  await recordToolOutcomes(ws, outs);
  const a = await buildReliabilityHint(ws);
  const b = await buildReliabilityHint(ws, { taskText: "" });
  assert.equal(a, b);
});

test("workspace isolation: outcomes in ws1 do not leak into ws2", async () => {
  const ws1 = uniqueWs("iso1");
  const ws2 = uniqueWs("iso2");
  await recordToolOutcomes(ws1, [{ tool: "t", ok: true }]);
  const s1 = await loadToolOutcomes(ws1);
  const s2 = await loadToolOutcomes(ws2);
  assert.equal(s1.tools.t.successes, 1);
  assert.equal(s2.tools.t, undefined);
});
