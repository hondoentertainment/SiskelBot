/**
 * Phase 58.1: Cost-aware router tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "siskel-cost-router-"));
process.env.STORAGE_PATH = TMP;

const {
  pickModel,
  recordCost,
  getCostReport,
  saveCostConfig,
  loadCostConfig,
  _reset,
} = await import("../lib/cost-aware-router.js");
const { parseCostConfig } = await import("../lib/smart-router.js");

test.after(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

test("pickModel returns null for empty candidates", () => {
  const r = pickModel([]);
  assert.equal(r.model, null);
  assert.equal(r.reason, "no_candidates");
});

test("pickModel chooses cheapest under 'cost' strategy", async () => {
  await _reset();
  parseCostConfig("gpt-4:0.03,gpt-3.5:0.002,claude-haiku:0.001");
  const r = pickModel(["gpt-4", "gpt-3.5", "claude-haiku"], { strategy: "cost" });
  assert.equal(r.model, "claude-haiku");
  assert.equal(r.reason, "cheapest_within_floor");
});

test("pickModel defaults to cost-quality strategy (best $/quality)", async () => {
  await _reset();
  parseCostConfig("gpt-4:0.03,gpt-3.5:0.002");
  const r = pickModel(["gpt-4", "gpt-3.5"]);
  // With neutral quality=1 for both, gpt-3.5 wins (lower cost).
  assert.equal(r.model, "gpt-3.5");
});

test("pickModel respects maxCostPerKTokens ceiling", async () => {
  await _reset();
  parseCostConfig("expensive:0.1,cheap:0.001");
  const r = pickModel(["expensive", "cheap"], { maxCostPerKTokens: 0.01 });
  assert.equal(r.model, "cheap");
});

test("pickModel falls back to cheapest when nothing is eligible", async () => {
  await _reset();
  parseCostConfig("a:0.5,b:0.3");
  const r = pickModel(["a", "b"], { maxCostPerKTokens: 0.001 });
  assert.equal(r.model, "b");
  assert.equal(r.reason, "no_eligible_fallback_cheapest");
});

test("pickModel 'pareto' returns a Pareto-efficient candidate", async () => {
  await _reset();
  parseCostConfig("a:0.01,b:0.02,c:0.03");
  const r = pickModel(["a", "b", "c"], { strategy: "pareto" });
  assert.ok(["a", "b", "c"].includes(r.model));
});

test("recordCost persists a usage entry and computes USD from cost table", async () => {
  await _reset();
  parseCostConfig("gpt-4:0.03,gpt-3.5:0.002");
  const rec = await recordCost({ model: "gpt-3.5", inputTokens: 1000, outputTokens: 500 });
  assert.equal(rec.model, "gpt-3.5");
  assert.equal(rec.totalTokens, 1500);
  // 1500/1000 * 0.002 = 0.003
  assert.ok(Math.abs(rec.costUsd - 0.003) < 1e-9);
});

test("recordCost validates model", async () => {
  await _reset();
  await assert.rejects(() => recordCost({}), /model is required/);
});

test("getCostReport aggregates usage by model", async () => {
  await _reset();
  parseCostConfig("m1:0.01,m2:0.02");
  await recordCost({ model: "m1", inputTokens: 1000, outputTokens: 1000 });
  await recordCost({ model: "m1", inputTokens: 500, outputTokens: 500 });
  await recordCost({ model: "m2", inputTokens: 1000, outputTokens: 0 });
  const report = await getCostReport({});
  assert.equal(report.totalCallCount, 3);
  const m1 = report.byModel.find((b) => b.model === "m1");
  assert.equal(m1.calls, 2);
  assert.equal(m1.totalTokens, 3000);
});

test("getCostReport filters by time and model", async () => {
  await _reset();
  parseCostConfig("m:0.01");
  await recordCost({ model: "m", inputTokens: 100, outputTokens: 0, timestamp: 1000 });
  await recordCost({ model: "m", inputTokens: 100, outputTokens: 0, timestamp: 2000 });
  await recordCost({ model: "m", inputTokens: 100, outputTokens: 0, timestamp: 3000 });
  const mid = await getCostReport({ since: 1500, until: 2500 });
  assert.equal(mid.totalCallCount, 1);
});

test("saveCostConfig + loadCostConfig round-trip", async () => {
  await _reset();
  await saveCostConfig("alpha:0.05,beta:0.01");
  const loaded = await loadCostConfig();
  assert.equal(loaded, "alpha:0.05,beta:0.01");
});

test("recordCost honors explicit costUsd override", async () => {
  await _reset();
  const rec = await recordCost({ model: "custom", costUsd: 1.25, inputTokens: 10, outputTokens: 10 });
  assert.equal(rec.costUsd, 1.25);
});
