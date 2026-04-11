/**
 * Tests for lib/gbrain-meta-learning.js and lib/gbrain-integration.js
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  recordDecisionOutcome,
  updateStrategyWeights,
  getStrategyWeights,
  learnFromBatch,
  updateModelPerformance,
  getBestModelForTask,
  updateToolPerformance,
  getToolRanking,
  analyzeFailures,
  recommendImprovements,
  bayesianUpdate,
  shouldExplore,
  getLearningCurve,
  resetLearning,
  updateBelief,
  getBelief,
  _getStore,
  _resetStore,
} from "../lib/gbrain-meta-learning.js";
import {
  integrateWithAgentLoop,
  integrateWithSwarm,
  integrateWithHierarchy,
  integrateWithConsensus,
} from "../lib/gbrain-integration.js";

function freshStore() {
  _resetStore();
}

// ─── decision outcome recording ─────────────────────────────────────────

test("recordDecisionOutcome stores a decision and its outcome", async () => {
  freshStore();
  await recordDecisionOutcome("dec-1", {
    decision: {
      taskType: "research",
      strategy: "single_agent",
      model: "gpt-4",
      tools: ["search_context"],
      workspaceId: "w1",
    },
    outcome: { success: true, duration: 500, cost: 0.01, userRating: 5 },
  });

  const store = _getStore();
  assert.ok(store.decisions["dec-1"], "decision should be stored");
  assert.equal(store.decisions["dec-1"].outcome.success, true);
  assert.equal(store.outcomesLog.length, 1);
});

test("recordDecisionOutcome rejects missing params", async () => {
  freshStore();
  await assert.rejects(() => recordDecisionOutcome("", { outcome: { success: true } }));
  await assert.rejects(() => recordDecisionOutcome("id", null));
});

// ─── strategy weight reinforcement ──────────────────────────────────────

test("updateStrategyWeights reinforces successful strategies", async () => {
  freshStore();
  // 5 successes for strategy "A"
  for (let i = 0; i < 5; i++) {
    await updateStrategyWeights("coding", "A", { success: true });
  }
  // 5 failures for strategy "B"
  for (let i = 0; i < 5; i++) {
    await updateStrategyWeights("coding", "B", { success: false });
  }
  const weights = await getStrategyWeights("coding");
  assert.ok(weights.A > weights.B, `A (${weights.A}) should outweigh B (${weights.B})`);
  assert.ok(weights.A > 1, "A should be above baseline");
  assert.ok(weights.B < 1, "B should be below baseline");
});

test("updateStrategyWeights gives extra boost for high user ratings", async () => {
  freshStore();
  await updateStrategyWeights("task", "S", { success: true, userRating: 5 });
  const high = (await getStrategyWeights("task")).S;
  freshStore();
  await updateStrategyWeights("task", "S", { success: true, userRating: 3 });
  const neutral = (await getStrategyWeights("task")).S;
  assert.ok(high > neutral, "rating 5 should beat rating 3");
});

test("getStrategyWeights returns empty object for unknown task", async () => {
  freshStore();
  const weights = await getStrategyWeights("unknown");
  assert.deepEqual(weights, {});
});

// ─── batch learning ─────────────────────────────────────────────────────

test("learnFromBatch processes multiple outcomes", async () => {
  freshStore();
  const result = await learnFromBatch([
    { decisionId: "b1", decision: { taskType: "t", strategy: "x" }, outcome: { success: true } },
    { decisionId: "b2", decision: { taskType: "t", strategy: "x" }, outcome: { success: false } },
    { decisionId: "b3", decision: { taskType: "t", strategy: "y" }, outcome: { success: true } },
  ]);
  assert.equal(result.processed, 3);
  assert.equal(result.successes, 2);
  assert.equal(result.failures, 1);

  const weights = await getStrategyWeights("t");
  assert.ok(weights.x != null);
  assert.ok(weights.y != null);
});

test("learnFromBatch rejects non-array input", async () => {
  freshStore();
  await assert.rejects(() => learnFromBatch("not-an-array"));
});

// ─── model performance tracking ────────────────────────────────────────

test("updateModelPerformance tracks per-task success rate", async () => {
  freshStore();
  for (let i = 0; i < 10; i++) {
    await updateModelPerformance("gpt-4", "coding", {
      success: i < 8,
      duration: 500,
      userRating: i < 8 ? 5 : 2,
    });
    await updateModelPerformance("tiny", "coding", {
      success: i < 4,
      duration: 3000,
      userRating: i < 4 ? 4 : 2,
    });
  }
  const ranking = await getBestModelForTask("coding");
  assert.ok(ranking.length >= 2);
  assert.equal(ranking[0].model, "gpt-4", "gpt-4 should be first");
  assert.ok(ranking[0].successRate > ranking[1].successRate);
});

test("getBestModelForTask returns empty array for unknown task", async () => {
  freshStore();
  const ranking = await getBestModelForTask("nope");
  assert.deepEqual(ranking, []);
});

// ─── tool performance ─────────────────────────────────────────────────

test("updateToolPerformance and getToolRanking rank tools", async () => {
  freshStore();
  for (let i = 0; i < 10; i++) {
    await updateToolPerformance("search_context", { taskType: "research" }, { success: true });
  }
  for (let i = 0; i < 10; i++) {
    await updateToolPerformance("flaky_tool", { taskType: "research" }, { success: i < 3 });
  }
  const ranking = await getToolRanking();
  assert.equal(ranking[0].tool, "search_context");
  assert.equal(ranking[0].successRate, 1);
  assert.ok(ranking[1].successRate < 1);
});

// ─── failure analysis ───────────────────────────────────────────────

test("analyzeFailures groups failures by category, model and strategy", async () => {
  freshStore();
  for (let i = 0; i < 5; i++) {
    await recordDecisionOutcome(`fail-${i}`, {
      decision: { taskType: "t", strategy: "bad", model: "bad-model", workspaceId: "w" },
      outcome: { success: false, errorType: "timeout" },
    });
  }
  for (let i = 0; i < 3; i++) {
    await recordDecisionOutcome(`fail-t-${i}`, {
      decision: { taskType: "t", strategy: "bad", model: "bad-model", workspaceId: "w" },
      outcome: { success: false, errorType: "tool_error" },
    });
  }
  await recordDecisionOutcome("ok-1", {
    decision: { taskType: "t", strategy: "good", model: "good-model" },
    outcome: { success: true },
  });

  const analysis = await analyzeFailures({ sinceMs: 86_400_000 });
  assert.equal(analysis.totalFailures, 8);
  assert.equal(analysis.byCategory.timeout, 5);
  assert.equal(analysis.byCategory.tool_error, 3);
  assert.equal(analysis.byStrategy.bad, 8);
  assert.equal(analysis.byModel["bad-model"], 8);
  assert.ok(analysis.recommendations.length > 0);
  assert.ok(analysis.recommendations.some((r) => r.type === "failure_category"));
});

test("analyzeFailures returns zero when no failures in range", async () => {
  freshStore();
  await recordDecisionOutcome("ok-1", {
    decision: { taskType: "t", strategy: "good" },
    outcome: { success: true },
  });
  const analysis = await analyzeFailures({ sinceMs: 86_400_000 });
  assert.equal(analysis.totalFailures, 0);
  assert.equal(analysis.failureRate, 0);
  assert.equal(analysis.recommendations.length, 0);
});

// ─── Bayesian updates ────────────────────────────────────────────────

test("bayesianUpdate shifts posterior mean toward observations", () => {
  const prior = { mean: 0.5, variance: 1, count: 0 };
  const result = bayesianUpdate(prior, [0.9, 0.85, 0.95, 0.88, 0.92]);
  assert.ok(result.posteriorMean > 0.5, "posterior should shift up toward high observations");
  assert.ok(result.posteriorVariance < prior.variance, "variance should decrease");
  assert.equal(result.sampleCount, 5);
});

test("bayesianUpdate with empty observations returns prior unchanged", () => {
  const prior = { mean: 0.7, variance: 0.5, count: 10 };
  const result = bayesianUpdate(prior, []);
  assert.equal(result.posteriorMean, 0.7);
  assert.equal(result.posteriorVariance, 0.5);
  assert.equal(result.sampleCount, 10);
});

test("bayesianUpdate handles zero-variance observations safely", () => {
  const prior = { mean: 0.5, variance: 1, count: 0 };
  const result = bayesianUpdate(prior, [0.8, 0.8, 0.8, 0.8]);
  assert.ok(Number.isFinite(result.posteriorMean));
  assert.ok(result.posteriorMean > 0.5);
  assert.ok(result.posteriorVariance > 0);
});

test("bayesianUpdate rejects invalid priors", () => {
  assert.throws(() => bayesianUpdate(null, [1, 2]));
  assert.throws(() => bayesianUpdate({}, [1, 2]));
});

test("updateBelief and getBelief persist across calls", async () => {
  freshStore();
  await updateBelief("strategy_success", [0.9, 0.8, 0.95]);
  const belief = await getBelief("strategy_success");
  assert.ok(belief);
  assert.ok(belief.mean > 0.5);
  assert.equal(belief.count, 3);
});

// ─── exploration vs exploitation ────────────────────────────────────

test("shouldExplore returns exploit when rng > epsilon", () => {
  const result = shouldExplore(
    "task",
    { key: "A", score: 0.8 },
    [{ key: "B", score: 0.6 }],
    { epsilon: 0.1, rng: () => 0.5 }
  );
  assert.equal(result.explore, false);
  assert.equal(result.choice, "A");
});

test("shouldExplore returns explore when rng < epsilon", () => {
  const result = shouldExplore(
    "task",
    { key: "A", score: 0.8 },
    [{ key: "B", score: 0.6 }, { key: "C", score: 0.7 }],
    { epsilon: 0.9, rng: () => 0.01 }
  );
  assert.equal(result.explore, true);
  assert.ok(["B", "C"].includes(result.choice));
});

test("shouldExplore prefers UCB arm when total pulls high and arm under-tried", () => {
  const result = shouldExplore(
    "task",
    { key: "A", score: 0.7, sampleCount: 100 },
    [{ key: "B", score: 0.6, sampleCount: 1 }],
    { totalPulls: 200, rng: () => 0.5 }
  );
  assert.equal(result.explore, true);
  assert.equal(result.reason, "ucb_preferred");
  assert.equal(result.choice, "B");
});

test("shouldExplore returns fallback choice when no current best", () => {
  const result = shouldExplore("task", null, [{ key: "A" }, { key: "B" }]);
  assert.equal(result.explore, true);
  assert.equal(result.choice, "A");
});

test("shouldExplore with no alternatives returns current best", () => {
  const result = shouldExplore("task", { key: "A" }, []);
  assert.equal(result.explore, false);
  assert.equal(result.choice, "A");
});

// ─── learning curve ────────────────────────────────────────────────

test("getLearningCurve computes buckets and trend", async () => {
  freshStore();
  const now = Date.now();
  const store = _getStore();
  // Simulate improving success rate over 10 buckets
  for (let i = 0; i < 100; i++) {
    const ts = now - (100 - i) * 60_000; // 100 minutes span
    store.outcomesLog.push({
      ts,
      success: Math.random() < i / 100, // rising trend
      taskType: "t",
    });
  }
  const curve = await getLearningCurve("success_rate", {
    sinceMs: 120 * 60_000,
    buckets: 10,
  });
  assert.equal(curve.dataPoints.length, 10);
  assert.ok(["up", "flat", "down"].includes(curve.trend));
  assert.ok(typeof curve.improvementRate === "number");
});

test("getLearningCurve handles empty history", async () => {
  freshStore();
  const curve = await getLearningCurve("success_rate", { sinceMs: 86_400_000, buckets: 5 });
  assert.equal(curve.dataPoints.length, 5);
  assert.equal(curve.trend, "flat");
  assert.equal(curve.improvementRate, 0);
});

// ─── recommendations ─────────────────────────────────────────────

test("recommendImprovements returns insufficient data when empty", async () => {
  freshStore();
  const recs = await recommendImprovements("w1");
  assert.equal(recs.length, 1);
  assert.equal(recs[0].type, "insufficient_data");
});

test("recommendImprovements surfaces strategy and model suggestions", async () => {
  freshStore();
  // Seed a strategy imbalance for "coding"
  for (let i = 0; i < 15; i++) {
    await recordDecisionOutcome(`good-${i}`, {
      decision: {
        taskType: "coding",
        strategy: "strong",
        model: "gpt-4",
        workspaceId: "w1",
      },
      outcome: { success: true, duration: 300, userRating: 5 },
    });
  }
  for (let i = 0; i < 15; i++) {
    await recordDecisionOutcome(`bad-${i}`, {
      decision: {
        taskType: "coding",
        strategy: "weak",
        model: "tiny",
        workspaceId: "w1",
      },
      outcome: {
        success: false,
        duration: 5000,
        userRating: 1,
        errorType: "reasoning_error",
      },
    });
  }
  const recs = await recommendImprovements("w1");
  assert.ok(recs.length > 0);
  const types = recs.map((r) => r.type);
  assert.ok(
    types.some((t) => ["strategy_change", "model_upgrade", "failure_category", "system_prompt"].includes(t)),
    `expected actionable recommendations, got ${JSON.stringify(types)}`
  );
});

// ─── reset ─────────────────────────────────────────────────

test("resetLearning clears all data when no workspaceId", async () => {
  freshStore();
  await recordDecisionOutcome("d1", {
    decision: { taskType: "t", strategy: "s", workspaceId: "w1" },
    outcome: { success: true },
  });
  await resetLearning();
  const store = _getStore();
  assert.equal(Object.keys(store.decisions).length, 0);
  assert.equal(store.outcomesLog.length, 0);
});

test("resetLearning scoped to workspace only clears that workspace", async () => {
  freshStore();
  await recordDecisionOutcome("d1", {
    decision: { taskType: "t", strategy: "s", workspaceId: "w1" },
    outcome: { success: true },
  });
  await recordDecisionOutcome("d2", {
    decision: { taskType: "t", strategy: "s", workspaceId: "w2" },
    outcome: { success: true },
  });
  await resetLearning("w1");
  const store = _getStore();
  assert.ok(!store.decisions.d1);
  assert.ok(store.decisions.d2);
  assert.equal(store.outcomesLog.filter((o) => o.workspaceId === "w1").length, 0);
  assert.equal(store.outcomesLog.filter((o) => o.workspaceId === "w2").length, 1);
});

// ─── integration wrappers ─────────────────────────────────────────

test("integrateWithAgentLoop records outcomes for a successful run", async () => {
  freshStore();
  const fakeLoop = {
    async runAgentLoop(opts) {
      return { result: "ok", cost: 0.02 };
    },
  };
  const wrapped = integrateWithAgentLoop(fakeLoop);
  const res = await wrapped.runAgentLoop({
    taskType: "research",
    model: "gpt-4",
    tools: ["search_context"],
    workspaceId: "w1",
  });
  assert.equal(res.result, "ok");
  const store = _getStore();
  assert.equal(Object.keys(store.decisions).length, 1);
  const decision = Object.values(store.decisions)[0];
  assert.equal(decision.outcome.success, true);
  assert.equal(decision.decision.taskType, "research");
});

test("integrateWithAgentLoop records failure on thrown error", async () => {
  freshStore();
  const fakeLoop = {
    async runAgentLoop() {
      throw new Error("timeout while calling tool");
    },
  };
  const wrapped = integrateWithAgentLoop(fakeLoop);
  await assert.rejects(() => wrapped.runAgentLoop({ model: "m" }));
  const store = _getStore();
  const decision = Object.values(store.decisions)[0];
  assert.equal(decision.outcome.success, false);
  assert.equal(decision.outcome.errorType, "timeout");
});

test("integrateWithSwarm records specialists and strategy weight", async () => {
  freshStore();
  const fakeSwarm = {
    async runSwarmDirect(specialists, query, opts) {
      return { ok: true };
    },
  };
  const wrapped = integrateWithSwarm(fakeSwarm);
  await wrapped.runSwarmDirect(["researcher", "executor"], "hi", {
    taskType: "research",
  });
  const store = _getStore();
  const decision = Object.values(store.decisions)[0];
  assert.deepEqual(decision.decision.specialists, ["researcher", "executor"]);
  const weights = await getStrategyWeights("research");
  assert.ok(weights.swarm != null);
});

test("integrateWithHierarchy records model performance", async () => {
  freshStore();
  const fakeHierarchy = {
    async executeHierarchy(task, opts) {
      return { ok: true };
    },
  };
  const wrapped = integrateWithHierarchy(fakeHierarchy);
  await wrapped.executeHierarchy("root", {
    taskType: "planning",
    model: "gpt-4",
  });
  const ranking = await getBestModelForTask("planning");
  assert.ok(ranking.length >= 1);
  assert.equal(ranking[0].model, "gpt-4");
});

test("integrateWithConsensus records outcomes", async () => {
  freshStore();
  const fakeConsensus = {
    async executeConsensus(prompt, opts) {
      return { ok: true };
    },
  };
  const wrapped = integrateWithConsensus(fakeConsensus);
  await wrapped.executeConsensus("p", {
    taskType: "factcheck",
    voting: "weighted",
  });
  const store = _getStore();
  const decision = Object.values(store.decisions)[0];
  assert.equal(decision.decision.strategy, "weighted");
});

test("integration wrappers reject invalid input", () => {
  assert.throws(() => integrateWithAgentLoop(null));
  assert.throws(() => integrateWithSwarm(null));
  assert.throws(() => integrateWithHierarchy(null));
  assert.throws(() => integrateWithConsensus(null));
});

test("integration wrappers leave unrelated exports untouched", () => {
  const original = {
    runAgentLoop: async () => ({ ok: true }),
    helper: () => 42,
  };
  const wrapped = integrateWithAgentLoop(original);
  assert.equal(wrapped.helper(), 42);
  assert.notEqual(wrapped.runAgentLoop, original.runAgentLoop);
});
