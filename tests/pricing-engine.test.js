/**
 * Phase 71.1: Pricing engine tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "siskel-pricing-engine-"));
process.env.STORAGE_PATH = TMP;

const {
  createPricingRule,
  listPricingRules,
  getPricingRule,
  deletePricingRule,
  computeCost,
  PRICING_UNITS,
  _reset,
} = await import("../lib/pricing-engine.js");

test.after(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

test("PRICING_UNITS includes all five unit types plus flat", () => {
  for (const u of ["input_token", "output_token", "call", "outcome", "minute", "flat"]) {
    assert.ok(PRICING_UNITS.includes(u), `missing ${u}`);
  }
});

test("createPricingRule persists and returns a rule with id", async () => {
  await _reset();
  const rule = await createPricingRule({
    workspaceId: "ws-1",
    unit: "input_token",
    rate: 0.00001,
    modelId: "gpt-4",
  });
  assert.ok(rule.ruleId);
  assert.equal(rule.unit, "input_token");
  assert.equal(rule.modelId, "gpt-4");
  assert.equal(rule.currency, "USD");
});

test("createPricingRule rejects invalid unit", async () => {
  await _reset();
  await assert.rejects(
    () => createPricingRule({ workspaceId: "ws", unit: "foo", rate: 1 }),
    /unit must be one of/,
  );
});

test("createPricingRule rejects negative rate", async () => {
  await _reset();
  await assert.rejects(
    () => createPricingRule({ workspaceId: "ws", unit: "call", rate: -1 }),
    /non-negative/,
  );
});

test("listPricingRules returns only workspace rules", async () => {
  await _reset();
  await createPricingRule({ workspaceId: "alpha", unit: "call", rate: 0.01 });
  await createPricingRule({ workspaceId: "alpha", unit: "minute", rate: 0.5 });
  await createPricingRule({ workspaceId: "beta", unit: "flat", rate: 10 });
  const alpha = await listPricingRules("alpha");
  assert.equal(alpha.length, 2);
  const beta = await listPricingRules("beta");
  assert.equal(beta.length, 1);
});

test("getPricingRule returns rule by id, deletePricingRule removes it", async () => {
  await _reset();
  const r = await createPricingRule({ workspaceId: "ws", unit: "call", rate: 0.02 });
  const fetched = await getPricingRule(r.ruleId);
  assert.ok(fetched);
  assert.equal(fetched.ruleId, r.ruleId);
  const removed = await deletePricingRule(r.ruleId);
  assert.equal(removed, true);
  const again = await getPricingRule(r.ruleId);
  assert.equal(again, null);
});

test("computeCost sums matching rules with breakdown", async () => {
  await _reset();
  // per input token: $0.00001
  await createPricingRule({ workspaceId: "ws", unit: "input_token", rate: 0.00001 });
  // per output token: $0.00003
  await createPricingRule({ workspaceId: "ws", unit: "output_token", rate: 0.00003 });
  // per call: $0.01
  await createPricingRule({ workspaceId: "ws", unit: "call", rate: 0.01 });

  const result = await computeCost({
    workspaceId: "ws",
    usage: { inputTokens: 1000, outputTokens: 500, calls: 2 },
  });
  // 1000 * 0.00001 = 0.01 ; 500 * 0.00003 = 0.015 ; 2 * 0.01 = 0.02
  // total = 0.045
  assert.equal(result.currency, "USD");
  assert.ok(Math.abs(result.total - 0.045) < 1e-6, `got ${result.total}`);
  assert.equal(result.breakdown.length, 3);
});

test("computeCost filters rules by modelId", async () => {
  await _reset();
  await createPricingRule({ workspaceId: "ws", unit: "call", rate: 0.10, modelId: "premium" });
  await createPricingRule({ workspaceId: "ws", unit: "call", rate: 0.01, modelId: "cheap" });
  // Rule with no modelId matches all.
  await createPricingRule({ workspaceId: "ws", unit: "input_token", rate: 0.00001 });

  const premium = await computeCost({ workspaceId: "ws", usage: { modelId: "premium", calls: 1, inputTokens: 1000 } });
  // premium call 0.10 + shared per-token 0.01 = 0.11
  assert.ok(Math.abs(premium.total - 0.11) < 1e-6, `got ${premium.total}`);
  // Rules should include premium rule (0.10) + shared rule (0.01). Not the cheap rule.
  assert.equal(premium.breakdown.length, 2);
  const cheap = await computeCost({ workspaceId: "ws", usage: { modelId: "cheap", calls: 1 } });
  assert.ok(Math.abs(cheap.total - 0.01) < 1e-6, `got ${cheap.total}`);
});

test("computeCost flat rule always charges once", async () => {
  await _reset();
  await createPricingRule({ workspaceId: "ws", unit: "flat", rate: 5.00 });
  const result = await computeCost({ workspaceId: "ws", usage: {} });
  assert.ok(Math.abs(result.total - 5.00) < 1e-6);
  assert.equal(result.breakdown[0].quantity, 1);
});

test("computeCost zero usage returns zero and no breakdown entries", async () => {
  await _reset();
  await createPricingRule({ workspaceId: "ws", unit: "input_token", rate: 0.00001 });
  const result = await computeCost({ workspaceId: "ws", usage: { inputTokens: 0 } });
  assert.equal(result.total, 0);
  assert.equal(result.breakdown.length, 0);
});

test("createPricingRule with explicit ruleId upserts", async () => {
  await _reset();
  const r1 = await createPricingRule({ workspaceId: "ws", ruleId: "my-rule", unit: "call", rate: 0.01 });
  const r2 = await createPricingRule({ workspaceId: "ws", ruleId: "my-rule", unit: "call", rate: 0.05 });
  assert.equal(r1.ruleId, r2.ruleId);
  const list = await listPricingRules("ws");
  assert.equal(list.length, 1);
  assert.equal(list[0].rate, 0.05);
});
