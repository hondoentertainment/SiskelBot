/**
 * Phase 26: Tests for lib/cost-controls.js — cost estimation, limit checking, summaries.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { estimateRequestCost, checkCostLimit, getCostSummary, recordCost, resetModelCosts, getModelCosts } from "../lib/cost-controls.js";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Isolate storage to temp directory for each test run
const tempDir = mkdtempSync(join(tmpdir(), "cost-controls-test-"));
const origStoragePath = process.env.STORAGE_PATH;
const origCostLimit = process.env.COST_LIMIT_PER_WORKSPACE;
const origModelCosts = process.env.MODEL_COSTS;

test.before(() => {
  process.env.STORAGE_PATH = tempDir;
});

test.after(() => {
  if (origStoragePath === undefined) delete process.env.STORAGE_PATH;
  else process.env.STORAGE_PATH = origStoragePath;
  if (origCostLimit === undefined) delete process.env.COST_LIMIT_PER_WORKSPACE;
  else process.env.COST_LIMIT_PER_WORKSPACE = origCostLimit;
  if (origModelCosts === undefined) delete process.env.MODEL_COSTS;
  else process.env.MODEL_COSTS = origModelCosts;
  try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

test.beforeEach(() => {
  delete process.env.MODEL_COSTS;
  delete process.env.COST_LIMIT_PER_WORKSPACE;
  resetModelCosts();
});

// ── estimateRequestCost ──

test("estimateRequestCost: known model returns correct cost", () => {
  const result = estimateRequestCost("gpt-4o", 1000, 1000);
  assert.equal(result.currency, "USD");
  // gpt-4o: input=0.005/1K, output=0.015/1K => (1000/1000)*0.005 + (1000/1000)*0.015 = 0.02
  assert.equal(result.cost, 0.02);
  assert.equal(result.breakdown.input, 0.005);
  assert.equal(result.breakdown.output, 0.015);
});

test("estimateRequestCost: gpt-4o-mini pricing", () => {
  const result = estimateRequestCost("gpt-4o-mini", 10000, 5000);
  // input: (10000/1000)*0.00015 = 0.0015, output: (5000/1000)*0.0006 = 0.003
  assert.equal(result.cost, 0.0045);
});

test("estimateRequestCost: gpt-3.5-turbo pricing", () => {
  const result = estimateRequestCost("gpt-3.5-turbo", 2000, 1000);
  // input: (2000/1000)*0.0005 = 0.001, output: (1000/1000)*0.0015 = 0.0015
  assert.equal(result.cost, 0.0025);
});

test("estimateRequestCost: unknown model returns zero cost", () => {
  const result = estimateRequestCost("llama-3-70b", 1000, 1000);
  assert.equal(result.cost, 0);
  assert.equal(result.currency, "USD");
});

test("estimateRequestCost: zero tokens returns zero cost", () => {
  const result = estimateRequestCost("gpt-4o", 0, 0);
  assert.equal(result.cost, 0);
});

test("estimateRequestCost: negative tokens treated as zero", () => {
  const result = estimateRequestCost("gpt-4o", -100, -50);
  assert.equal(result.cost, 0);
});

test("estimateRequestCost: prefix matching for model variants", () => {
  const result = estimateRequestCost("gpt-4o-2024-01-01", 1000, 1000);
  // Should match "gpt-4o" via prefix
  assert.equal(result.cost, 0.02);
});

test("estimateRequestCost: custom MODEL_COSTS env var", () => {
  process.env.MODEL_COSTS = "custom-model:0.01:0.02";
  resetModelCosts();
  const result = estimateRequestCost("custom-model", 1000, 1000);
  assert.equal(result.cost, 0.03);
  delete process.env.MODEL_COSTS;
  resetModelCosts();
});

test("estimateRequestCost: MODEL_COSTS env merges with defaults", () => {
  process.env.MODEL_COSTS = "my-model:0.001:0.002";
  resetModelCosts();
  // Default model still works
  const gpt = estimateRequestCost("gpt-4o", 1000, 1000);
  assert.equal(gpt.cost, 0.02);
  // Custom model works too
  const custom = estimateRequestCost("my-model", 1000, 1000);
  assert.equal(custom.cost, 0.003);
  delete process.env.MODEL_COSTS;
  resetModelCosts();
});

// ── getModelCosts ──

test("getModelCosts: returns all configured model costs", () => {
  resetModelCosts();
  const costs = getModelCosts();
  assert.ok("gpt-4o" in costs);
  assert.ok("gpt-4o-mini" in costs);
  assert.ok("gpt-3.5-turbo" in costs);
  assert.equal(typeof costs["gpt-4o"].input, "number");
  assert.equal(typeof costs["gpt-4o"].output, "number");
});

// ── checkCostLimit ──

test("checkCostLimit: no limit configured allows everything", async () => {
  delete process.env.COST_LIMIT_PER_WORKSPACE;
  const result = await checkCostLimit("test-ws", 100);
  assert.equal(result.allowed, true);
  assert.equal(result.limit, 0);
});

test("checkCostLimit: under limit is allowed", async () => {
  process.env.COST_LIMIT_PER_WORKSPACE = "10.00";
  const result = await checkCostLimit("limit-test-ws-1", 0.50);
  assert.equal(result.allowed, true);
  assert.ok(result.remaining > 0);
  assert.equal(result.limit, 10);
});

test("checkCostLimit: over limit is denied", async () => {
  process.env.COST_LIMIT_PER_WORKSPACE = "1.00";
  // Record enough cost to exceed limit
  await recordCost("limit-test-ws-2", 0.80, { model: "gpt-4o" });
  const result = await checkCostLimit("limit-test-ws-2", 0.50);
  assert.equal(result.allowed, false);
  assert.ok(result.remaining < 0.50);
});

test("checkCostLimit: exactly at limit still allows zero-cost", async () => {
  process.env.COST_LIMIT_PER_WORKSPACE = "1.00";
  await recordCost("limit-test-ws-3", 1.00, { model: "gpt-4o" });
  const result = await checkCostLimit("limit-test-ws-3", 0);
  assert.equal(result.allowed, true);
  assert.equal(result.remaining, 0);
});

// ── recordCost ──

test("recordCost: records and accumulates costs", async () => {
  await recordCost("record-test-ws", 0.01, { model: "gpt-4o" });
  await recordCost("record-test-ws", 0.02, { model: "gpt-4o" });
  const summary = await getCostSummary("record-test-ws", "all");
  assert.equal(summary.totalCost, 0.03);
  assert.equal(summary.entries, 2);
});

test("recordCost: default workspace is 'default'", async () => {
  await recordCost(null, 0.005, { model: "gpt-4o" });
  const summary = await getCostSummary("default", "all");
  assert.ok(summary.totalCost >= 0.005);
});

// ── getCostSummary ──

test("getCostSummary: returns zero for unknown workspace", async () => {
  const summary = await getCostSummary("nonexistent-ws-12345", "all");
  assert.equal(summary.totalCost, 0);
  assert.equal(summary.entries, 0);
  assert.deepEqual(summary.byModel, {});
  assert.equal(summary.currency, "USD");
});

test("getCostSummary: groups by model", async () => {
  await recordCost("summary-model-ws", 0.01, { model: "gpt-4o" });
  await recordCost("summary-model-ws", 0.02, { model: "gpt-3.5-turbo" });
  await recordCost("summary-model-ws", 0.03, { model: "gpt-4o" });
  const summary = await getCostSummary("summary-model-ws", "all");
  assert.equal(summary.byModel["gpt-4o"], 0.04);
  assert.equal(summary.byModel["gpt-3.5-turbo"], 0.02);
});

test("getCostSummary: period filtering works for 'day'", async () => {
  // Record a cost now (should be in 'day' window)
  await recordCost("period-test-ws", 0.01, { model: "gpt-4o", timestamp: new Date().toISOString() });
  const summary = await getCostSummary("period-test-ws", "day");
  assert.ok(summary.totalCost >= 0.01);
  assert.equal(summary.period, "day");
});

test("getCostSummary: defaults to month period", async () => {
  const summary = await getCostSummary("any-ws");
  assert.equal(summary.period, "month");
});
