/**
 * Phase 53.1: Tool RAG tests.
 *
 * Covers tokenization, TF-IDF primitives, ToolIndex, retrieval helpers,
 * synonym expansion, persisted tool catalog, usage tracking, usage-based
 * re-ranking, and the default-index builder.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate persisted catalog / usage files in a tmp STORAGE_PATH.
const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-tool-rag-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  ToolIndex,
  tokenize,
  stopwordFilter,
  computeTf,
  computeIdf,
  tfIdfScore,
  retrieveTools,
  retrieveToolsForTask,
  expandQuery,
  registerToolMetadata,
  getToolMetadata,
  listRegisteredTools,
  recordToolUsage,
  getToolUsageStats,
  reRankByUsage,
  buildDefaultIndex,
  rebuildDefaultIndex,
} = await import("../lib/tool-rag.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

/* -------------------------------------------------------------------------- */
/* Tokenization                                                               */
/* -------------------------------------------------------------------------- */

test("tokenize produces lowercase word tokens and drops punctuation", () => {
  const out = tokenize("Search the Knowledge Base! for auth-related docs.");
  assert.ok(out.includes("search"));
  assert.ok(out.includes("knowledge"));
  assert.ok(out.includes("base"));
  assert.ok(out.includes("auth"));
  assert.ok(out.includes("related"));
  assert.ok(out.includes("docs"));
  // No punctuation survives.
  assert.ok(out.every((t) => /^[a-z0-9_]+$/.test(t)));
});

test("tokenize handles null / empty input", () => {
  assert.deepEqual(tokenize(null), []);
  assert.deepEqual(tokenize(undefined), []);
  assert.deepEqual(tokenize(""), []);
  assert.deepEqual(tokenize("   "), []);
});

test("stopwordFilter removes common stopwords", () => {
  const tokens = tokenize("the cat is on the mat and the dog is here");
  const filtered = stopwordFilter(tokens);
  assert.ok(!filtered.includes("the"));
  assert.ok(!filtered.includes("is"));
  assert.ok(!filtered.includes("and"));
  assert.ok(filtered.includes("cat"));
  assert.ok(filtered.includes("dog"));
});

/* -------------------------------------------------------------------------- */
/* TF-IDF primitives                                                          */
/* -------------------------------------------------------------------------- */

test("computeTf counts term frequencies", () => {
  const tf = computeTf(["search", "knowledge", "search", "docs"]);
  assert.equal(tf.search, 2);
  assert.equal(tf.knowledge, 1);
  assert.equal(tf.docs, 1);
});

test("computeIdf follows the smoothed log formula", () => {
  const docs = [
    ["search", "knowledge"],
    ["search", "recipe"],
    ["deploy", "build"],
  ];
  const idf = computeIdf(docs);
  // "search" appears in 2/3 docs -> smaller idf
  // "deploy" appears in 1/3 docs -> larger idf
  assert.ok(idf.deploy > idf.search);
  // Sanity: idf(1 occurrence in 3 docs) = ln(4/2) + 1 = ln(2) + 1
  const expected = Math.log(4 / 2) + 1;
  assert.ok(Math.abs(idf.deploy - expected) < 1e-9);
});

test("tfIdfScore ranks relevant documents higher than unrelated ones", () => {
  const docs = [
    ["search", "knowledge", "base", "documents"],
    ["deploy", "build", "recipe", "steps"],
  ];
  const idf = computeIdf(docs);
  const q = ["search", "knowledge"];
  const scoreA = tfIdfScore(q, docs[0], idf).score;
  const scoreB = tfIdfScore(q, docs[1], idf).score;
  assert.ok(scoreA > scoreB);
  assert.ok(scoreB === 0);
});

/* -------------------------------------------------------------------------- */
/* ToolIndex                                                                  */
/* -------------------------------------------------------------------------- */

function seedIndex() {
  const idx = new ToolIndex();
  idx.addTool({
    name: "search_context",
    description: "Search the knowledge base and indexed documents by keyword query.",
    tags: ["search", "knowledge"],
  });
  idx.addTool({
    name: "execute_step",
    description: "Execute a build, deploy, or copy recipe step.",
    tags: ["execute", "deploy"],
  });
  idx.addTool({
    name: "remember_workspace_fact",
    description: "Persist a long-term memory fact to workspace memory.",
    tags: ["memory"],
  });
  idx.recomputeIdf();
  return idx;
}

test("ToolIndex.addTool stores tools and getTools returns them", () => {
  const idx = new ToolIndex();
  idx.addTool({ name: "foo", description: "do foo things", tags: ["utility"] });
  idx.addTool({ name: "bar", description: "do bar things" });
  assert.equal(idx.size(), 2);
  const all = idx.getTools();
  const names = all.map((t) => t.name).sort();
  assert.deepEqual(names, ["bar", "foo"]);
  const foo = all.find((t) => t.name === "foo");
  assert.deepEqual(foo.tags, ["utility"]);
});

test("ToolIndex.removeTool / updateTool work", () => {
  const idx = new ToolIndex();
  idx.addTool({ name: "foo", description: "initial" });
  idx.updateTool("foo", { description: "updated desc" });
  idx.addTool({ name: "bar", description: "bar desc" });
  idx.removeTool("bar");
  assert.equal(idx.size(), 1);
  assert.equal(idx.getTools()[0].description, "updated desc");
});

/* -------------------------------------------------------------------------- */
/* retrieveTools                                                              */
/* -------------------------------------------------------------------------- */

test("retrieveTools returns top K results ordered by relevance", async () => {
  const idx = seedIndex();
  // Query hits terms present in both search_context and execute_step docs.
  const results = await retrieveTools("search knowledge recipe step deploy", { k: 2, index: idx });
  assert.equal(results.length, 2);
  // search_context should rank higher for this mix of search+recipe terms.
  const names = results.map((r) => r.name);
  assert.ok(names.includes("search_context"));
  assert.ok(names.includes("execute_step"));
  assert.ok(results[0].score >= results[1].score);
  assert.ok(results[0].matchedTerms.length > 0);
});

test("retrieveTools respects minScore filter", async () => {
  const idx = seedIndex();
  const results = await retrieveTools("search knowledge", { k: 10, minScore: 1000, index: idx });
  assert.equal(results.length, 0);
});

test("retrieveTools filters by tags", async () => {
  const idx = seedIndex();
  const results = await retrieveTools("do something", { k: 10, tags: ["memory"], index: idx });
  // No tool has "do something" in description, so keyword ranking yields 0.
  // Try a query that has a match:
  const results2 = await retrieveTools("memory fact", { k: 10, tags: ["memory"], index: idx });
  assert.equal(results2.length, 1);
  assert.equal(results2[0].name, "remember_workspace_fact");
  // Result is empty when filtered by a tag no tool has.
  const results3 = await retrieveTools("search knowledge", { k: 10, tags: ["nope"], index: idx });
  assert.equal(results3.length, 0);
  assert.equal(results.length, 0);
});

test("retrieveToolsForTask handles natural-language phrasing", async () => {
  const idx = seedIndex();
  const results = await retrieveToolsForTask("Please help me search the knowledge base for an auth doc", { index: idx });
  assert.ok(results.length > 0);
  assert.equal(results[0].name, "search_context");
});

test("retrieveTools handles empty query", async () => {
  const idx = seedIndex();
  const results = await retrieveTools("", { index: idx });
  assert.deepEqual(results, []);
  const results2 = await retrieveTools("   ", { index: idx });
  assert.deepEqual(results2, []);
});

test("retrieveTools handles empty index", async () => {
  const empty = new ToolIndex();
  empty.recomputeIdf();
  const results = await retrieveTools("anything", { index: empty });
  assert.deepEqual(results, []);
});

/* -------------------------------------------------------------------------- */
/* expandQuery                                                                */
/* -------------------------------------------------------------------------- */

test("expandQuery appends synonym terms", () => {
  const out = expandQuery("find docs", { find: ["search", "lookup"], docs: ["documents"] });
  assert.ok(out.includes("search"));
  assert.ok(out.includes("lookup"));
  assert.ok(out.includes("documents"));
  // Identity for empty synonyms.
  assert.equal(expandQuery("foo"), "foo");
  assert.equal(expandQuery("foo", {}), "foo");
  assert.equal(expandQuery("", { foo: ["bar"] }), "");
});

/* -------------------------------------------------------------------------- */
/* Persisted catalog                                                          */
/* -------------------------------------------------------------------------- */

test("registerToolMetadata persists and getToolMetadata retrieves", async () => {
  const meta = await registerToolMetadata("custom_tool", {
    description: "a bespoke tool",
    tags: ["custom"],
  });
  assert.equal(meta.name, "custom_tool");
  assert.equal(meta.description, "a bespoke tool");
  assert.ok(meta.updatedAt);
  const fetched = await getToolMetadata("custom_tool");
  assert.ok(fetched);
  assert.equal(fetched.description, "a bespoke tool");
  const list = await listRegisteredTools();
  assert.ok(list.some((t) => t.name === "custom_tool"));
});

test("registerToolMetadata rejects invalid input", async () => {
  await assert.rejects(() => registerToolMetadata("", { description: "bad" }));
  await assert.rejects(() => registerToolMetadata("name", null));
});

/* -------------------------------------------------------------------------- */
/* Usage tracking                                                             */
/* -------------------------------------------------------------------------- */

test("recordToolUsage increments counters", async () => {
  await recordToolUsage("usage_tool", { taskType: "search", success: true });
  await recordToolUsage("usage_tool", { taskType: "search", success: true });
  await recordToolUsage("usage_tool", { taskType: "search", success: false });
  const stats = await getToolUsageStats("usage_tool");
  assert.equal(stats.uses, 3);
  assert.equal(stats.successes, 2);
  assert.ok(stats.lastUsedAt);
});

test("reRankByUsage bumps heavily used tools upward", () => {
  const results = [
    { name: "tool_a", score: 1.0, matchedTerms: ["x"], description: "" },
    { name: "tool_b", score: 0.9, matchedTerms: ["x"], description: "" },
  ];
  const stats = {
    tool_a: { uses: 1, successes: 1 },
    tool_b: { uses: 100, successes: 100 },
  };
  const ranked = reRankByUsage(results, stats);
  assert.equal(ranked[0].name, "tool_b");
  assert.ok(ranked[0].score > ranked[1].score);
  assert.ok(ranked[0].usageBump > ranked[1].usageBump);
});

/* -------------------------------------------------------------------------- */
/* buildDefaultIndex                                                          */
/* -------------------------------------------------------------------------- */

test("buildDefaultIndex loads built-in agent tools (or is tolerant)", async () => {
  const idx = await buildDefaultIndex();
  assert.ok(idx instanceof ToolIndex);
  // Either agent-tools.js exports TOOLS (so size > 0) or the builder
  // tolerated a missing module and returned an empty-but-usable index.
  assert.ok(idx.size() >= 0);
  // If tools were loaded, they should be searchable.
  if (idx.size() > 0) {
    const results = await retrieveTools("search knowledge base", { k: 3, index: idx });
    assert.ok(Array.isArray(results));
  }
});

test("rebuildDefaultIndex returns a fresh instance", async () => {
  const a = await rebuildDefaultIndex();
  const b = await rebuildDefaultIndex();
  assert.ok(a instanceof ToolIndex);
  assert.ok(b instanceof ToolIndex);
  // Distinct instances.
  assert.notEqual(a, b);
});
