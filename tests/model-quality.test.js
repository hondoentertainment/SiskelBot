/**
 * Tests for lib/model-quality.js and lib/smart-router.js
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  recordModelResponse,
  getModelQuality,
  getModelRanking,
  getBestModel,
  getQualityHistory,
  resetModelStats,
  checkAutoPromotion,
} from "../lib/model-quality.js";
import {
  selectSmartBackend,
  parseCostConfig,
  getModelCost,
  checkAndLogPromotion,
  getRoutingSummary,
  resetRoundRobin,
} from "../lib/smart-router.js";

// ─── model-quality: recording and scoring ───────────────────────────────────

test("getModelQuality returns zeros for unknown model", () => {
  resetModelStats();
  const q = getModelQuality("nonexistent");
  assert.equal(q.score, 0);
  assert.equal(q.sampleCount, 0);
  assert.equal(q.latencyP50, 0);
  assert.equal(q.errorRate, 0);
});

test("recordModelResponse tracks latency and tokens", () => {
  resetModelStats();
  recordModelResponse("test-model", { latencyMs: 100, tokens: 50, error: false });
  recordModelResponse("test-model", { latencyMs: 200, tokens: 100, error: false });

  const q = getModelQuality("test-model");
  assert.equal(q.sampleCount, 2);
  assert.ok(q.latencyP50 > 0, "latencyP50 should be positive");
  assert.ok(q.latencyP95 > 0, "latencyP95 should be positive");
  assert.equal(q.errorRate, 0);
  assert.ok(q.throughput > 0, "throughput should be positive");
  assert.ok(q.score > 0, "score should be positive");
});

test("error rate affects quality score", () => {
  resetModelStats();

  // Model with no errors
  for (let i = 0; i < 10; i++) {
    recordModelResponse("good-model", { latencyMs: 100, tokens: 50, error: false });
  }

  // Model with 50% errors
  for (let i = 0; i < 10; i++) {
    recordModelResponse("bad-model", { latencyMs: 100, tokens: 50, error: i < 5 });
  }

  const good = getModelQuality("good-model");
  const bad = getModelQuality("bad-model");

  assert.ok(good.score > bad.score, `good model (${good.score}) should score higher than bad model (${bad.score})`);
  assert.equal(good.errorRate, 0);
  assert.ok(bad.errorRate > 0.4);
});

test("latency affects quality score", () => {
  resetModelStats();

  for (let i = 0; i < 10; i++) {
    recordModelResponse("fast-model", { latencyMs: 50, tokens: 100, error: false });
  }
  for (let i = 0; i < 10; i++) {
    recordModelResponse("slow-model", { latencyMs: 20000, tokens: 100, error: false });
  }

  const fast = getModelQuality("fast-model");
  const slow = getModelQuality("slow-model");
  assert.ok(fast.score > slow.score, `fast (${fast.score}) should beat slow (${slow.score})`);
});

test("user rating affects quality score", () => {
  resetModelStats();

  for (let i = 0; i < 10; i++) {
    recordModelResponse("liked-model", { latencyMs: 100, tokens: 50, error: false, rating: 5 });
  }
  for (let i = 0; i < 10; i++) {
    recordModelResponse("disliked-model", { latencyMs: 100, tokens: 50, error: false, rating: 1 });
  }

  const liked = getModelQuality("liked-model");
  const disliked = getModelQuality("disliked-model");
  assert.ok(liked.score > disliked.score, `liked (${liked.score}) should beat disliked (${disliked.score})`);
});

test("recordModelResponse ignores invalid model names", () => {
  resetModelStats();
  recordModelResponse(null, { latencyMs: 100, tokens: 50, error: false });
  recordModelResponse("", { latencyMs: 100, tokens: 50, error: false });
  assert.equal(getModelRanking().length, 0);
});

// ─── model-quality: ranking ─────────────────────────────────────────────────

test("getModelRanking returns sorted list", () => {
  resetModelStats();

  for (let i = 0; i < 10; i++) {
    recordModelResponse("best", { latencyMs: 50, tokens: 100, error: false, rating: 5 });
    recordModelResponse("mid", { latencyMs: 500, tokens: 50, error: false, rating: 3 });
    recordModelResponse("worst", { latencyMs: 5000, tokens: 10, error: i < 3, rating: 1 });
  }

  const ranking = getModelRanking();
  assert.equal(ranking.length, 3);
  assert.equal(ranking[0].model, "best");
  assert.equal(ranking[2].model, "worst");
  assert.ok(ranking[0].score >= ranking[1].score);
  assert.ok(ranking[1].score >= ranking[2].score);
});

// ─── model-quality: quality history ─────────────────────────────────────────

test("getQualityHistory returns entries for recorded model", () => {
  resetModelStats();
  recordModelResponse("hist-model", { latencyMs: 100, tokens: 50, error: false });

  const history = getQualityHistory("hist-model", "7d");
  assert.ok(history.length > 0, "should have at least one history entry");
  assert.ok(history[0].ts > 0);
  assert.ok(history[0].score > 0);
});

test("getQualityHistory returns empty for unknown model", () => {
  resetModelStats();
  const history = getQualityHistory("unknown", "7d");
  assert.equal(history.length, 0);
});

test("getQualityHistory respects period parameter", () => {
  resetModelStats();
  recordModelResponse("period-model", { latencyMs: 100, tokens: 50, error: false });

  const h7d = getQualityHistory("period-model", "7d");
  const h30d = getQualityHistory("period-model", "30d");
  assert.ok(h7d.length > 0);
  assert.ok(h30d.length >= h7d.length);
});

// ─── model-quality: best model selection ────────────────────────────────────

test("getBestModel returns best by score", () => {
  resetModelStats();
  for (let i = 0; i < 10; i++) {
    recordModelResponse("alpha", { latencyMs: 50, tokens: 100, error: false });
    recordModelResponse("beta", { latencyMs: 5000, tokens: 10, error: true });
  }

  const best = getBestModel(["alpha", "beta"]);
  assert.equal(best, "alpha");
});

test("getBestModel falls back to first candidate when no data", () => {
  resetModelStats();
  const best = getBestModel(["x", "y", "z"]);
  assert.equal(best, "x");
});

test("getBestModel handles single candidate", () => {
  resetModelStats();
  assert.equal(getBestModel(["solo"]), "solo");
});

test("getBestModel returns null for empty array", () => {
  assert.equal(getBestModel([]), null);
  assert.equal(getBestModel(null), null);
});

// ─── model-quality: auto-promotion detection ────────────────────────────────

test("checkAutoPromotion returns null when no model exceeds threshold", () => {
  resetModelStats();
  for (let i = 0; i < 10; i++) {
    recordModelResponse("default", { latencyMs: 100, tokens: 50, error: false });
    recordModelResponse("challenger", { latencyMs: 100, tokens: 50, error: false });
  }
  const result = checkAutoPromotion("default");
  assert.equal(result, null);
});

test("checkAutoPromotion returns recommendation when challenger is significantly better", () => {
  resetModelStats();

  // Record 100+ samples for challenger with much better quality
  for (let i = 0; i < 110; i++) {
    recordModelResponse("default-m", { latencyMs: 10000, tokens: 10, error: i < 50, rating: 1 });
    recordModelResponse("challenger-m", { latencyMs: 50, tokens: 200, error: false, rating: 5 });
  }

  const result = checkAutoPromotion("default-m");
  assert.ok(result !== null, "should detect promotion opportunity");
  assert.equal(result.recommended, "challenger-m");
  assert.ok(result.recommendedScore > result.currentScore + 10);
  assert.ok(result.sampleCount >= 100);
});

test("checkAutoPromotion requires 100+ samples", () => {
  resetModelStats();

  // Challenger is much better but only 50 samples
  for (let i = 0; i < 50; i++) {
    recordModelResponse("default-q", { latencyMs: 10000, tokens: 10, error: true, rating: 1 });
    recordModelResponse("challenger-q", { latencyMs: 50, tokens: 200, error: false, rating: 5 });
  }

  const result = checkAutoPromotion("default-q");
  assert.equal(result, null, "should not promote with <100 samples");
});

// ─── model-quality: resetModelStats ─────────────────────────────────────────

test("resetModelStats clears specific model", () => {
  resetModelStats();
  recordModelResponse("a", { latencyMs: 100, tokens: 50, error: false });
  recordModelResponse("b", { latencyMs: 100, tokens: 50, error: false });
  resetModelStats("a");
  assert.equal(getModelQuality("a").sampleCount, 0);
  assert.equal(getModelQuality("b").sampleCount, 1);
});

test("resetModelStats clears all when no model specified", () => {
  resetModelStats();
  recordModelResponse("x", { latencyMs: 100, tokens: 50, error: false });
  recordModelResponse("y", { latencyMs: 100, tokens: 50, error: false });
  resetModelStats();
  assert.equal(getModelRanking().length, 0);
});

// ─── smart-router: selectSmartBackend ───────────────────────────────────────

test("selectSmartBackend quality strategy picks best model", () => {
  resetModelStats();
  for (let i = 0; i < 10; i++) {
    recordModelResponse("fast", { latencyMs: 50, tokens: 100, error: false });
    recordModelResponse("slow", { latencyMs: 5000, tokens: 10, error: true });
  }

  const result = selectSmartBackend(["fast", "slow"], "quality");
  assert.equal(result.model, "fast");
  assert.ok(result.reason.includes("quality"));
});

test("selectSmartBackend latency strategy picks lowest p50", () => {
  resetModelStats();
  for (let i = 0; i < 10; i++) {
    recordModelResponse("low-lat", { latencyMs: 30, tokens: 50, error: false });
    recordModelResponse("high-lat", { latencyMs: 3000, tokens: 50, error: false });
  }

  const result = selectSmartBackend(["low-lat", "high-lat"], "latency");
  assert.equal(result.model, "low-lat");
});

test("selectSmartBackend cost strategy picks cheapest", () => {
  resetModelStats();
  parseCostConfig("cheap:0.001,expensive:0.06");

  const result = selectSmartBackend(["cheap", "expensive"], "cost");
  assert.equal(result.model, "cheap");
});

test("selectSmartBackend round-robin cycles through candidates", () => {
  resetRoundRobin();
  const models = ["a", "b", "c"];
  const results = [];
  for (let i = 0; i < 6; i++) {
    results.push(selectSmartBackend(models, "round-robin").model);
  }
  assert.deepEqual(results, ["a", "b", "c", "a", "b", "c"]);
});

test("selectSmartBackend weighted strategy uses weights", () => {
  const counts = { a: 0, b: 0 };
  for (let i = 0; i < 1000; i++) {
    const result = selectSmartBackend(["a", "b"], "weighted", { weights: { a: 0.9, b: 0.1 } });
    counts[result.model]++;
  }
  // With 90/10 weights, "a" should get significantly more selections
  assert.ok(counts.a > counts.b * 3, `expected a (${counts.a}) >> b (${counts.b})`);
});

test("selectSmartBackend handles empty candidates", () => {
  const result = selectSmartBackend([], "quality");
  assert.equal(result.model, null);
});

test("selectSmartBackend handles single candidate", () => {
  const result = selectSmartBackend(["only"], "quality");
  assert.equal(result.model, "only");
});

test("selectSmartBackend defaults to quality strategy", () => {
  resetModelStats();
  for (let i = 0; i < 10; i++) {
    recordModelResponse("m1", { latencyMs: 50, tokens: 100, error: false });
    recordModelResponse("m2", { latencyMs: 5000, tokens: 10, error: true });
  }
  const result = selectSmartBackend(["m1", "m2"]);
  assert.equal(result.model, "m1");
});

// ─── smart-router: cost config ──────────────────────────────────────────────

test("parseCostConfig parses valid config", () => {
  parseCostConfig("gpt-4:0.06,gpt-3.5:0.002");
  assert.equal(getModelCost("gpt-4"), 0.06);
  assert.equal(getModelCost("gpt-3.5"), 0.002);
});

test("getModelCost returns 0 for unknown model", () => {
  parseCostConfig("");
  assert.equal(getModelCost("unknown"), 0);
});

// ─── smart-router: promotion ────────────────────────────────────────────────

test("checkAndLogPromotion logs when promotion detected", () => {
  resetModelStats();
  for (let i = 0; i < 110; i++) {
    recordModelResponse("old-default", { latencyMs: 10000, tokens: 10, error: i < 50, rating: 1 });
    recordModelResponse("new-model", { latencyMs: 50, tokens: 200, error: false, rating: 5 });
  }

  const result = checkAndLogPromotion("old-default");
  assert.ok(result !== null);
  assert.equal(result.recommended, "new-model");
});

test("checkAndLogPromotion returns null when no promotion", () => {
  resetModelStats();
  recordModelResponse("stable", { latencyMs: 100, tokens: 50, error: false });
  const result = checkAndLogPromotion("stable");
  assert.equal(result, null);
});

// ─── smart-router: routing summary ──────────────────────────────────────────

test("getRoutingSummary includes all tracked models", () => {
  resetModelStats();
  recordModelResponse("s1", { latencyMs: 100, tokens: 50, error: false });
  recordModelResponse("s2", { latencyMs: 200, tokens: 100, error: false });
  parseCostConfig("s1:0.01,s2:0.05");

  const summary = getRoutingSummary();
  assert.equal(summary.length, 2);
  const s1 = summary.find((s) => s.model === "s1");
  assert.ok(s1);
  assert.equal(s1.cost, 0.01);
  assert.ok(s1.score > 0);
});
