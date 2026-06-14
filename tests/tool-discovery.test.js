/**
 * Phase 32.3: Tool discovery tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  createToolDiscovery,
  classifyTaskType,
  globalToolDiscovery,
} from "../lib/tool-discovery.js";

test("classifyTaskType identifies common task types", () => {
  assert.equal(classifyTaskType("search the knowledge base").type, "search");
  assert.equal(classifyTaskType("find a doc about auth").type, "search");
  assert.equal(classifyTaskType("create a new recipe").type, "create");
  assert.equal(classifyTaskType("add a user record").type, "create");
  assert.equal(classifyTaskType("analyze this trace").type, "analyze");
  assert.equal(classifyTaskType("modify the config file").type, "modify");
  assert.equal(classifyTaskType("delete the stale entry").type, "delete");
  assert.equal(classifyTaskType("run the deploy script").type, "execute");
  assert.equal(classifyTaskType("summarize the report").type, "summarize");
  assert.equal(classifyTaskType("explain how this works").type, "explain");
});

test("classifyTaskType returns general for unknown input", () => {
  assert.equal(classifyTaskType("asdf qwer zxcv").type, "general");
  assert.equal(classifyTaskType("").type, "general");
  assert.equal(classifyTaskType(null).type, "general");
  assert.equal(classifyTaskType(undefined).type, "general");
  assert.equal(classifyTaskType(42).type, "general");
});

test("classifyTaskType produces a confidence score", () => {
  const search = classifyTaskType("search and find the doc");
  assert.ok(search.confidence > 0);
  assert.ok(search.confidence <= 1);
  const unknown = classifyTaskType("nothing relevant here");
  assert.equal(unknown.confidence, 0);
});

test("recordToolUsage accumulates stats", () => {
  const d = createToolDiscovery();
  d.recordToolUsage("search_context", { taskType: "search", success: true, durationMs: 120 });
  d.recordToolUsage("search_context", { taskType: "search", success: true, durationMs: 80 });
  d.recordToolUsage("search_context", { taskType: "search", success: false, durationMs: 200 });

  const stats = d.getToolStats("search_context");
  assert.ok(stats);
  assert.equal(stats.uses, 3);
  assert.equal(stats.successes, 2);
  assert.ok(Math.abs(stats.successRate - 2 / 3) < 0.01);
  // Avg duration = (120 + 80 + 200) / 3 = 133.33
  assert.ok(stats.avgDuration > 130 && stats.avgDuration < 135);
});

test("getToolStats returns null for unknown tool", () => {
  const d = createToolDiscovery();
  assert.equal(d.getToolStats("nonexistent_tool"), null);
});

test("recordToolUsage tracks per-task-type buckets", () => {
  const d = createToolDiscovery();
  d.recordToolUsage("search_context", { taskType: "search", success: true, durationMs: 50 });
  d.recordToolUsage("search_context", { taskType: "search", success: true, durationMs: 60 });
  d.recordToolUsage("search_context", { taskType: "analyze", success: false, durationMs: 300 });

  const stats = d.getToolStats("search_context");
  const searchBucket = stats.topTaskTypes.find((t) => t.type === "search");
  const analyzeBucket = stats.topTaskTypes.find((t) => t.type === "analyze");
  assert.equal(searchBucket.uses, 2);
  assert.equal(searchBucket.successRate, 1);
  assert.equal(analyzeBucket.uses, 1);
  assert.equal(analyzeBucket.successRate, 0);
});

test("getToolEffectivenessByTask ranks tools for a task type", () => {
  const d = createToolDiscovery();
  // search_context: high success for search tasks
  for (let i = 0; i < 10; i++) {
    d.recordToolUsage("search_context", { taskType: "search", success: true, durationMs: 50 });
  }
  // semantic_search_context: moderate success
  for (let i = 0; i < 5; i++) {
    d.recordToolUsage("semantic_search_context", { taskType: "search", success: i < 3, durationMs: 200 });
  }
  // execute_step: unrelated task type
  d.recordToolUsage("execute_step", { taskType: "execute", success: true, durationMs: 500 });

  const rows = d.getToolEffectivenessByTask("search");
  assert.equal(rows.length, 2);
  // search_context should rank first (higher success rate and more uses)
  assert.equal(rows[0].tool, "search_context");
  assert.equal(rows[0].successRate, 1);
  assert.equal(rows[0].uses, 10);
  assert.equal(rows[1].tool, "semantic_search_context");
  assert.ok(rows[0].score >= rows[1].score);
});

test("getToolEffectivenessByTask returns empty array for missing taskType", () => {
  const d = createToolDiscovery();
  d.recordToolUsage("search_context", { taskType: "search", success: true, durationMs: 10 });
  assert.deepEqual(d.getToolEffectivenessByTask("nonexistent_type"), []);
  assert.deepEqual(d.getToolEffectivenessByTask(""), []);
});

test("recommendToolsForTask returns tools matching inferred task type", () => {
  const d = createToolDiscovery();
  for (let i = 0; i < 8; i++) {
    d.recordToolUsage("search_context", { taskType: "search", success: true, durationMs: 40 });
  }
  for (let i = 0; i < 3; i++) {
    d.recordToolUsage("list_context", { taskType: "search", success: true, durationMs: 20 });
  }

  const recs = d.recommendToolsForTask("search the docs for info about auth");
  assert.ok(recs.length > 0);
  assert.ok(recs.length <= 5);
  const names = recs.map((r) => r.tool);
  assert.ok(names.includes("search_context"));
  // Each recommendation has tool, reason, confidence
  for (const r of recs) {
    assert.equal(typeof r.tool, "string");
    assert.equal(typeof r.reason, "string");
    assert.equal(typeof r.confidence, "number");
    assert.ok(r.confidence >= 0 && r.confidence <= 1);
  }
});

test("recommendToolsForTask falls back to global ranking when no task history", () => {
  const d = createToolDiscovery();
  d.recordToolUsage("execute_step", { taskType: "execute", success: true, durationMs: 500 });
  d.recordToolUsage("execute_step", { taskType: "execute", success: true, durationMs: 450 });

  // Use a task description that won't match the execute task type history
  const recs = d.recommendToolsForTask("xyz abc qrstuv");
  assert.ok(recs.length > 0);
  assert.equal(recs[0].tool, "execute_step");
});

test("getGlobalRanking sorts tools by overall score", () => {
  const d = createToolDiscovery();
  // Tool A: 10 uses, 100% success, fast
  for (let i = 0; i < 10; i++) {
    d.recordToolUsage("tool_a", { taskType: "search", success: true, durationMs: 50 });
  }
  // Tool B: 5 uses, 60% success, slow
  for (let i = 0; i < 5; i++) {
    d.recordToolUsage("tool_b", { taskType: "search", success: i < 3, durationMs: 800 });
  }
  // Tool C: 1 use
  d.recordToolUsage("tool_c", { taskType: "search", success: true, durationMs: 100 });

  const ranking = d.getGlobalRanking();
  assert.equal(ranking.length, 3);
  // Tool A has the best score (high volume, high success, fast)
  assert.equal(ranking[0].tool, "tool_a");
  // Score must be monotonically decreasing
  for (let i = 1; i < ranking.length; i++) {
    assert.ok(ranking[i - 1].score >= ranking[i].score);
  }
  // Each ranking row has the expected fields
  for (const row of ranking) {
    assert.equal(typeof row.score, "number");
    assert.equal(typeof row.successRate, "number");
    assert.equal(typeof row.uses, "number");
    assert.equal(typeof row.avgDuration, "number");
  }
});

test("global ranking formula uses successRate * log(uses) / normalizedDuration", () => {
  const d = createToolDiscovery();
  // Two tools, same success rate, same duration, but different use counts
  for (let i = 0; i < 20; i++) {
    d.recordToolUsage("popular", { taskType: "search", success: true, durationMs: 100 });
  }
  for (let i = 0; i < 2; i++) {
    d.recordToolUsage("rare", { taskType: "search", success: true, durationMs: 100 });
  }
  const ranking = d.getGlobalRanking();
  const popular = ranking.find((r) => r.tool === "popular");
  const rare = ranking.find((r) => r.tool === "rare");
  // Popular should outrank rare: same success rate, same latency, more uses
  assert.ok(popular.score > rare.score);
});

test("exportLearning and importLearning round-trip", () => {
  const src = createToolDiscovery();
  src.recordToolUsage("search_context", { taskType: "search", success: true, durationMs: 100 });
  src.recordToolUsage("search_context", { taskType: "analyze", success: false, durationMs: 250 });
  src.recordToolUsage("list_context", { taskType: "search", success: true, durationMs: 30 });

  const dump = src.exportLearning();
  assert.equal(dump.version, 1);
  assert.ok(dump.tools.search_context);

  const dst = createToolDiscovery();
  dst.importLearning(dump);
  const restored = dst.getToolStats("search_context");
  assert.equal(restored.uses, 2);
  assert.equal(restored.successes, 1);

  const listStats = dst.getToolStats("list_context");
  assert.equal(listStats.uses, 1);

  // Effectiveness by task should also round-trip
  const searchEffect = dst.getToolEffectivenessByTask("search");
  assert.equal(searchEffect.length, 2);
});

test("importLearning tolerates malformed data", () => {
  const d = createToolDiscovery();
  d.importLearning(null);
  d.importLearning({});
  d.importLearning({ tools: null });
  d.importLearning({ tools: { bad: null } });
  d.importLearning({ tools: { ok: { uses: "not a number" } } });
  // Should not throw and should have at least one sanitized entry
  const stats = d.getToolStats("ok");
  assert.ok(stats);
  assert.equal(stats.uses, 0);
});

test("userRating is accumulated when provided", () => {
  const d = createToolDiscovery();
  d.recordToolUsage("t", { taskType: "search", success: true, durationMs: 10, userRating: 5 });
  d.recordToolUsage("t", { taskType: "search", success: true, durationMs: 10, userRating: 3 });
  d.recordToolUsage("t", { taskType: "search", success: true, durationMs: 10 }); // no rating
  const stats = d.getToolStats("t");
  assert.equal(stats.avgRating, 4);
});

test("globalToolDiscovery singleton is exported and usable", () => {
  globalToolDiscovery.reset();
  globalToolDiscovery.recordToolUsage("probe", { taskType: "search", success: true, durationMs: 12 });
  const s = globalToolDiscovery.getToolStats("probe");
  assert.ok(s);
  assert.equal(s.uses, 1);
  globalToolDiscovery.reset();
  assert.equal(globalToolDiscovery.getToolStats("probe"), null);
});

test("recordToolUsage ignores empty tool names", () => {
  const d = createToolDiscovery();
  d.recordToolUsage("", { taskType: "search", success: true });
  d.recordToolUsage(null, { taskType: "search", success: true });
  assert.deepEqual(d.getAllStats(), {});
});
