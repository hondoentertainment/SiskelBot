/**
 * Phase 53.3: Progressive tool disclosure tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-tdp-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  estimateToolTokenCost,
  rankByRelevance,
  selectToolsForBudget,
  pruneToolSet,
  setPinnedTools,
  getPinnedTools,
} = await import("../lib/tool-disclosure-progressive.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

function tool(name, desc, extras = {}) {
  return {
    name,
    description: desc,
    parameters: extras.parameters || {
      type: "object",
      properties: { query: { type: "string", description: "search query" } },
    },
    tags: extras.tags || [],
  };
}

/* -------------------------------------------------------------------------- */
/* estimateToolTokenCost                                                      */
/* -------------------------------------------------------------------------- */

test("estimateToolTokenCost respects the minimum floor", () => {
  assert.ok(estimateToolTokenCost({ name: "x" }) >= 10);
});

test("estimateToolTokenCost grows with description length", () => {
  const small = estimateToolTokenCost(tool("a", "tiny"));
  const big = estimateToolTokenCost(tool("a", "very long description ".repeat(20)));
  assert.ok(big > small);
});

test("estimateToolTokenCost handles null safely", () => {
  assert.equal(estimateToolTokenCost(null), 10);
  assert.equal(estimateToolTokenCost(undefined), 10);
});

/* -------------------------------------------------------------------------- */
/* rankByRelevance                                                            */
/* -------------------------------------------------------------------------- */

test("rankByRelevance orders by keyword overlap", () => {
  const tools = [
    tool("deploy_app", "Deploy an application to production"),
    tool("search_docs", "Search the knowledge base for documents"),
    tool("count_tokens", "Count tokens in a string"),
  ];
  const ranked = rankByRelevance("please help me search knowledge docs", tools);
  assert.equal(ranked[0].name, "search_docs");
  assert.ok(ranked[0].relevance > 0);
});

test("rankByRelevance includes usage bump in final score", () => {
  const tools = [
    tool("a", "foo tool"),
    tool("b", "foo tool"),
  ];
  const ranked = rankByRelevance("foo", tools, {
    usage: { b: { uses: 50, successes: 50 } },
  });
  assert.equal(ranked[0].name, "b");
  assert.ok(ranked[0].usageBump > 0);
});

test("rankByRelevance handles empty task", () => {
  const tools = [tool("a", "desc")];
  const ranked = rankByRelevance("", tools);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].relevance, 0);
});

test("rankByRelevance tolerates non-array input", () => {
  assert.deepEqual(rankByRelevance("x", null), []);
});

/* -------------------------------------------------------------------------- */
/* selectToolsForBudget                                                       */
/* -------------------------------------------------------------------------- */

test("selectToolsForBudget fits tools within the budget", () => {
  const tools = [
    tool("search_docs", "Search knowledge documents"),
    tool("deploy_app", "Deploy an application"),
    tool("notify_team", "Send a team notification"),
    tool("run_query", "Run a database query"),
  ];
  const r = selectToolsForBudget("search for docs", tools, 500);
  assert.ok(r.selected.length > 0);
  assert.ok(r.used <= r.budget);
});

test("selectToolsForBudget excludes tools that overflow the budget", () => {
  const tools = [
    tool("search_docs", "search docs"),
    tool("expensive", "x".repeat(4000)),
  ];
  const r = selectToolsForBudget("search", tools, 60);
  assert.ok(r.excluded.some((t) => t.name === "expensive"));
});

test("selectToolsForBudget honors pinned tools even when over-budget", () => {
  const tools = [
    tool("always_on", "x".repeat(2000)),
    tool("cheap", "small"),
  ];
  const r = selectToolsForBudget("anything", tools, 20, { pinned: ["always_on"] });
  const names = r.selected.map((t) => t.name);
  assert.ok(names.includes("always_on"));
});

test("selectToolsForBudget honors minTools", () => {
  const tools = [
    tool("a", "a"),
    tool("b", "b"),
    tool("c", "c"),
  ];
  const r = selectToolsForBudget("irrelevant", tools, 1, { minTools: 2 });
  assert.ok(r.selected.length >= 2);
});

test("selectToolsForBudget applies reserveTokens", () => {
  const tools = [tool("a", "a".repeat(200))];
  const small = selectToolsForBudget("a", tools, 1000, { reserveTokens: 900 });
  assert.equal(small.budget, 100);
});

test("selectToolsForBudget handles empty input", () => {
  const r = selectToolsForBudget("", [], 100);
  assert.deepEqual(r.selected, []);
});

/* -------------------------------------------------------------------------- */
/* pruneToolSet                                                               */
/* -------------------------------------------------------------------------- */

test("pruneToolSet keeps only specified tools", () => {
  const tools = [tool("a", "a"), tool("b", "b"), tool("c", "c")];
  const kept = pruneToolSet(tools, ["b", "c"]);
  assert.equal(kept.length, 2);
  assert.ok(kept.every((t) => ["b", "c"].includes(t.name)));
});

test("pruneToolSet returns empty when keepNames is empty", () => {
  const tools = [tool("a", "a")];
  assert.deepEqual(pruneToolSet(tools, []), []);
});

test("pruneToolSet tolerates bad input", () => {
  assert.deepEqual(pruneToolSet(null, ["a"]), []);
  assert.deepEqual(pruneToolSet([tool("x", "x")], null), []);
});

/* -------------------------------------------------------------------------- */
/* Pinned tools persistence                                                   */
/* -------------------------------------------------------------------------- */

test("setPinnedTools persists and getPinnedTools retrieves", async () => {
  const saved = await setPinnedTools(["alpha", "beta", "alpha"]);
  assert.deepEqual(saved.sort(), ["alpha", "beta"]);
  const loaded = await getPinnedTools();
  assert.deepEqual(loaded.sort(), ["alpha", "beta"]);
});

test("setPinnedTools rejects non-array input", async () => {
  await assert.rejects(() => setPinnedTools("not-an-array"));
});
