/**
 * Tests for lib/gbrain-router.js and lib/gbrain-heuristics.js.
 *
 * Exercises strategy scoring, budget-aware selection, heuristic matchers,
 * dispatch to (mocked) subsystems, outcome recording, and adaptive routing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Use a per-process temp data dir so outcome state does not leak.
const DATA_DIR = mkdtempSync(join(tmpdir(), "gbrain-router-test-"));
process.env.STORAGE_PATH = DATA_DIR;
process.env.STORAGE_BACKEND = "json";

const {
  STRATEGIES,
  scoreStrategy,
  selectBestStrategy,
  routeToSubsystem,
  setSubsystem,
  resetSubsystems,
  recordStrategyOutcome,
  getStrategyStats,
  getAdaptiveStrategy,
} = await import("../lib/gbrain-router.js");
const {
  matchesSimpleQuestion,
  matchesToolRequired,
  matchesHighStakes,
  matchesLongRunning,
  assessComplexity,
  summarizeHeuristics,
} = await import("../lib/gbrain-heuristics.js");

test.after(() => {
  try {
    rmSync(DATA_DIR, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// ---------------------------------------------------------------------------
// STRATEGIES metadata
// ---------------------------------------------------------------------------

test("STRATEGIES: contains all expected strategies with required fields", () => {
  const expected = [
    "direct",
    "agent_loop",
    "swarm",
    "hierarchy",
    "consensus",
    "mission",
    "reflection",
  ];
  for (const id of expected) {
    assert.ok(STRATEGIES[id], `missing strategy ${id}`);
    const s = STRATEGIES[id];
    assert.equal(typeof s.name, "string");
    assert.ok(Array.isArray(s.bestFor));
    assert.equal(typeof s.costMultiplier, "number");
    assert.equal(typeof s.latencyMs, "number");
    assert.equal(typeof s.reliability, "number");
    assert.ok(s.reliability >= 0 && s.reliability <= 1);
  }
});

// ---------------------------------------------------------------------------
// Heuristics
// ---------------------------------------------------------------------------

test("matchesSimpleQuestion: detects wh-questions and conversational turns", () => {
  assert.equal(matchesSimpleQuestion("What is the capital of France?"), true);
  assert.equal(matchesSimpleQuestion("Hello there"), true);
  assert.equal(matchesSimpleQuestion("How do I exit vim?"), true);
  assert.equal(
    matchesSimpleQuestion(
      "Design an end-to-end pipeline that ingests clickstream data, trains a model, and deploys it to production across three regions using blue-green rollouts, monitoring, and alerting."
    ),
    false,
  );
});

test("matchesSimpleQuestion: handles object task shape", () => {
  assert.equal(matchesSimpleQuestion({ task: "Who won the 2020 election?" }), true);
  assert.equal(matchesSimpleQuestion({ prompt: "hi" }), true);
  assert.equal(matchesSimpleQuestion({}), false);
  assert.equal(matchesSimpleQuestion(null), false);
});

test("matchesToolRequired: detects tool-ish phrasing", () => {
  assert.equal(matchesToolRequired("Fetch the JSON from https://example.com/data"), true);
  assert.equal(matchesToolRequired("Please run sql to count users"), true);
  assert.equal(matchesToolRequired("Read file package.json and summarize"), true);
  assert.equal(matchesToolRequired("What is 2+2?"), false);
  assert.equal(matchesToolRequired("Explain quantum tunneling"), false);
});

test("matchesHighStakes: detects high-stakes keywords", () => {
  assert.equal(matchesHighStakes("This is a critical production incident"), true);
  assert.equal(matchesHighStakes("Please fact-check this claim"), true);
  assert.equal(matchesHighStakes("Review this legal contract"), true);
  assert.equal(matchesHighStakes("Tell me a joke"), false);
});

test("matchesLongRunning: detects long-running tasks", () => {
  assert.equal(matchesLongRunning("Monitor the build pipeline overnight"), true);
  assert.equal(matchesLongRunning("Run this autonomously for 48 hours"), true);
  assert.equal(matchesLongRunning("Summarize this paragraph"), false);
});

test("assessComplexity: buckets tasks appropriately", () => {
  assert.equal(assessComplexity("hi"), "trivial");
  assert.equal(assessComplexity("What is the capital of France?"), "simple");
  assert.equal(
    assessComplexity("Summarize the following article in three bullet points"),
    "moderate",
  );
  assert.equal(
    assessComplexity(
      "Design an end-to-end architecture for a real-time analytics platform including ingestion, storage, query, and visualization."
    ),
    "complex",
  );
  assert.equal(
    assessComplexity("Run this mission autonomously for several days"),
    "mission",
  );
});

test("summarizeHeuristics: returns combined object", () => {
  const out = summarizeHeuristics("Fetch https://example.com and verify the contract");
  assert.equal(out.toolRequired, true);
  assert.equal(out.highStakes, true);
  assert.equal(typeof out.complexity, "string");
});

// ---------------------------------------------------------------------------
// scoreStrategy
// ---------------------------------------------------------------------------

test("scoreStrategy: unknown strategy returns 0", () => {
  assert.equal(scoreStrategy("nope", { task: "anything" }), 0);
});

test("scoreStrategy: direct scores high on simple questions", () => {
  const analysis = { task: "What is the capital of France?" };
  const direct = scoreStrategy("direct", analysis);
  const mission = scoreStrategy("mission", analysis);
  assert.ok(direct > mission, `expected direct > mission, got ${direct} vs ${mission}`);
});

test("scoreStrategy: agent_loop beats direct when tools are required", () => {
  const analysis = { task: "Fetch https://example.com/data.json and summarize" };
  const agentLoop = scoreStrategy("agent_loop", analysis);
  const direct = scoreStrategy("direct", analysis);
  assert.ok(agentLoop > direct, `expected agent_loop > direct, got ${agentLoop} vs ${direct}`);
});

test("scoreStrategy: consensus wins on high-stakes tasks", () => {
  const analysis = { task: "Verify this critical production security incident" };
  const consensus = scoreStrategy("consensus", analysis);
  const direct = scoreStrategy("direct", analysis);
  assert.ok(consensus > direct, `expected consensus > direct, got ${consensus} vs ${direct}`);
});

test("scoreStrategy: mission wins on long-running tasks", () => {
  const analysis = {
    task: "Autonomously monitor the deploy overnight for 24 hours and report",
  };
  const mission = scoreStrategy("mission", analysis);
  const direct = scoreStrategy("direct", analysis);
  assert.ok(mission > direct, `expected mission > direct, got ${mission} vs ${direct}`);
});

test("scoreStrategy: score is clamped to [0, 1]", () => {
  const analysis = { task: "hi" };
  for (const id of Object.keys(STRATEGIES)) {
    const s = scoreStrategy(id, analysis);
    assert.ok(s >= 0 && s <= 1, `${id} score out of range: ${s}`);
  }
});

test("scoreStrategy: tight cost budget penalizes expensive strategies", () => {
  const analysis = { task: "Do an extensive research project" };
  const loose = scoreStrategy("mission", analysis, { costWeight: 0 });
  const tight = scoreStrategy("mission", analysis, {
    maxCost: 2,
    costWeight: 0.2,
  });
  assert.ok(tight < loose, `expected tight < loose, got ${tight} vs ${loose}`);
});

// ---------------------------------------------------------------------------
// selectBestStrategy
// ---------------------------------------------------------------------------

test("selectBestStrategy: picks direct for simple questions", () => {
  const result = selectBestStrategy({ task: "What is 2+2?" });
  assert.equal(result.strategy, "direct");
  assert.ok(result.score > 0);
  assert.ok(Array.isArray(result.ranking));
  assert.equal(result.ranking.length, Object.keys(STRATEGIES).length);
});

test("selectBestStrategy: picks agent_loop for tool-required tasks", () => {
  const result = selectBestStrategy({
    task: "Fetch https://example.com and summarize",
  });
  assert.equal(result.strategy, "agent_loop");
});

test("selectBestStrategy: picks consensus for high-stakes", () => {
  const result = selectBestStrategy({
    task: "Fact-check this legal contract for compliance issues",
    highStakes: true,
  });
  assert.equal(result.strategy, "consensus");
});

test("selectBestStrategy: picks mission for long-running", () => {
  const result = selectBestStrategy({
    task: "Run this research project autonomously for several days",
  });
  assert.equal(result.strategy, "mission");
});

test("selectBestStrategy: respects cost budget ceilings", () => {
  // maxCost: 2 keeps only strategies with costMultiplier <= 2, i.e. direct,
  // agent_loop, and reflection. Anything more expensive (swarm, hierarchy,
  // consensus, mission) must be marked out-of-budget in the ranking.
  const result = selectBestStrategy(
    { task: "Design a complex distributed system end-to-end architecture" },
    { maxCost: 2 },
  );
  const chosenCost = STRATEGIES[result.strategy].costMultiplier;
  assert.ok(
    chosenCost <= 2,
    `expected a within-budget strategy, got ${result.strategy} (cost ${chosenCost})`,
  );
  // Ranking still contains all strategies, but only those within budget
  // should have fitsBudget=true.
  for (const entry of result.ranking) {
    const cost = STRATEGIES[entry.strategy].costMultiplier;
    assert.equal(entry.fitsBudget, cost <= 2);
  }
});

test("selectBestStrategy: respects latency budget ceilings", () => {
  const result = selectBestStrategy(
    { task: "Research project over several days" },
    { maxLatencyMs: 1000 },
  );
  // direct is the only strategy with latencyMs <= 1000.
  assert.equal(result.strategy, "direct");
});

test("selectBestStrategy: falls back to best overall when budget is unsatisfiable", () => {
  const result = selectBestStrategy(
    { task: "Research project" },
    { maxCost: 0, maxLatencyMs: 0 },
  );
  // Nothing fits; we still get *a* strategy rather than throwing.
  assert.ok(STRATEGIES[result.strategy]);
});

// ---------------------------------------------------------------------------
// routeToSubsystem dispatch (mocked)
// ---------------------------------------------------------------------------

test("routeToSubsystem: dispatches to mocked subsystem", async () => {
  const calls = [];
  setSubsystem("agent_loop", async (task, ctx) => {
    calls.push({ task, ctx });
    return { ok: true, task };
  });
  try {
    const result = await routeToSubsystem("agent_loop", "do a thing", { foo: 1 });
    assert.deepEqual(result, { ok: true, task: "do a thing" });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].ctx, { foo: 1 });
  } finally {
    resetSubsystems();
  }
});

test("routeToSubsystem: throws on unknown strategy", async () => {
  await assert.rejects(
    () => routeToSubsystem("nope", "task"),
    /Unknown strategy/,
  );
});

test("routeToSubsystem: direct default returns text echo when no model fn", async () => {
  const result = await routeToSubsystem("direct", "hello world", {});
  assert.equal(result.strategy, "direct");
  assert.equal(result.text, "hello world");
});

test("routeToSubsystem: direct default uses context.model when provided", async () => {
  let seen = null;
  const result = await routeToSubsystem("direct", "ping", {
    model: (text, opts) => {
      seen = { text, opts };
      return { echoed: text };
    },
  });
  assert.deepEqual(result, { echoed: "ping" });
  assert.deepEqual(seen, { text: "ping", opts: { strategy: "direct" } });
});

test("routeToSubsystem: can mock every strategy", async () => {
  for (const id of Object.keys(STRATEGIES)) {
    setSubsystem(id, async () => ({ via: id }));
  }
  try {
    for (const id of Object.keys(STRATEGIES)) {
      const result = await routeToSubsystem(id, "task", {});
      assert.deepEqual(result, { via: id });
    }
  } finally {
    resetSubsystems();
  }
});

test("setSubsystem: rejects unknown strategy and non-function", () => {
  assert.throws(() => setSubsystem("nope", async () => {}), /Unknown strategy/);
  assert.throws(() => setSubsystem("direct", null), /must be a function/);
});

// ---------------------------------------------------------------------------
// Outcome tracking and stats
// ---------------------------------------------------------------------------

test("recordStrategyOutcome + getStrategyStats: aggregates per strategy", async () => {
  await recordStrategyOutcome("agent_loop", "complexity:moderate", {
    success: true,
    cost: 0.5,
    latencyMs: 2000,
  });
  await recordStrategyOutcome("agent_loop", "complexity:moderate", {
    success: false,
    cost: 0.3,
    latencyMs: 1500,
  });
  await recordStrategyOutcome("agent_loop", "complexity:complex", {
    success: true,
    cost: 1.0,
    latencyMs: 4000,
  });

  const stats = await getStrategyStats("agent_loop");
  assert.equal(stats.uses, 3);
  assert.ok(Math.abs(stats.successRate - 2 / 3) < 1e-9);
  assert.ok(Math.abs(stats.avgCost - (0.5 + 0.3 + 1.0) / 3) < 1e-9);
  assert.ok(
    Math.abs(stats.avgLatency - (2000 + 1500 + 4000) / 3) < 1e-9,
  );
  assert.ok(stats.byTaskType["complexity:moderate"]);
  assert.equal(stats.byTaskType["complexity:moderate"].uses, 2);
  assert.equal(stats.byTaskType["complexity:complex"].uses, 1);
});

test("getStrategyStats: empty stats for unused strategy", async () => {
  const stats = await getStrategyStats("reflection");
  assert.equal(stats.uses, 0);
  assert.equal(stats.successRate, 0);
  assert.deepEqual(stats.byTaskType, {});
});

test("recordStrategyOutcome: throws on unknown strategy", async () => {
  await assert.rejects(
    () => recordStrategyOutcome("nope", "any", { success: true }),
    /Unknown strategy/,
  );
});

// ---------------------------------------------------------------------------
// Adaptive routing
// ---------------------------------------------------------------------------

test("getAdaptiveStrategy: uses in-memory history when provided", async () => {
  const history = [
    { strategy: "swarm", taskType: "complexity:complex", success: true },
    { strategy: "swarm", taskType: "complexity:complex", success: true },
    { strategy: "swarm", taskType: "complexity:complex", success: true },
    { strategy: "agent_loop", taskType: "complexity:complex", success: false },
    { strategy: "agent_loop", taskType: "complexity:complex", success: false },
    { strategy: "agent_loop", taskType: "complexity:complex", success: false },
  ];
  const analysis = {
    task: "Design a complex end-to-end architecture with many moving parts",
    taskType: "complexity:complex",
  };
  const result = await getAdaptiveStrategy(analysis, { history, minSamples: 3 });
  assert.equal(result.source, "adaptive");
  assert.equal(result.strategy, "swarm");
  assert.equal(result.samples, 3);
  assert.equal(result.successRate, 1);
});

test("getAdaptiveStrategy: falls back to static when history is insufficient", async () => {
  const analysis = {
    task: "What is the capital of France?",
    taskType: "complexity:simple",
  };
  const result = await getAdaptiveStrategy(analysis, {
    history: [],
    minSamples: 3,
  });
  assert.equal(result.source, "static");
  assert.equal(result.reason, "insufficient-history");
  // Static fallback should land on direct for a simple question.
  assert.equal(result.strategy, "direct");
});

test("getAdaptiveStrategy: tie-breaks by static score", async () => {
  const history = [
    { strategy: "direct", taskType: "complexity:simple", success: true },
    { strategy: "direct", taskType: "complexity:simple", success: true },
    { strategy: "direct", taskType: "complexity:simple", success: true },
    { strategy: "mission", taskType: "complexity:simple", success: true },
    { strategy: "mission", taskType: "complexity:simple", success: true },
    { strategy: "mission", taskType: "complexity:simple", success: true },
  ];
  const analysis = {
    task: "What is 2+2?",
    taskType: "complexity:simple",
  };
  const result = await getAdaptiveStrategy(analysis, { history, minSamples: 3 });
  // Both have 100% success so tie-break prefers direct (better static score
  // on a simple question).
  assert.equal(result.strategy, "direct");
});

test("getAdaptiveStrategy: accepts a bare history array", async () => {
  const history = [
    { strategy: "reflection", taskType: "complexity:moderate", success: true },
    { strategy: "reflection", taskType: "complexity:moderate", success: true },
    { strategy: "reflection", taskType: "complexity:moderate", success: true },
  ];
  const analysis = {
    task: "Refactor this function and improve readability",
    taskType: "complexity:moderate",
  };
  const result = await getAdaptiveStrategy(analysis, history);
  assert.equal(result.source, "adaptive");
  assert.equal(result.strategy, "reflection");
});
