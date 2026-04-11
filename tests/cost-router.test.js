/**
 * Phase 58.1: Cost-aware router tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-cost-router-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  registerModelPrice,
  routeByCost,
  estimateRequestCost,
  listPrices,
  recordSpend,
  listSpend,
} = await import("../lib/cost-router.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

test("registerModelPrice persists a model entry", async () => {
  const rec = await registerModelPrice("gpt-x-mini", {
    inputPer1k: 0.15,
    outputPer1k: 0.6,
    quality: 0.7,
    provider: "openai",
  });
  assert.equal(rec.id, "gpt-x-mini");
  assert.equal(rec.inputPer1k, 0.15);
  assert.equal(rec.quality, 0.7);
  assert.ok(rec.createdAt);
  assert.ok(rec.updatedAt);
});

test("registerModelPrice rejects invalid input", async () => {
  await assert.rejects(() => registerModelPrice("", { inputPer1k: 1, outputPer1k: 1 }));
  await assert.rejects(() => registerModelPrice("m", null));
  await assert.rejects(() => registerModelPrice("m", { inputPer1k: -1, outputPer1k: 1 }));
  await assert.rejects(() => registerModelPrice("m", { inputPer1k: 1, outputPer1k: "bad" }));
});

test("registerModelPrice merges on re-register and clamps quality", async () => {
  await registerModelPrice("merge-model", {
    inputPer1k: 1,
    outputPer1k: 2,
    quality: 5,
  });
  const rec = await registerModelPrice("merge-model", {
    inputPer1k: 1.5,
    outputPer1k: 2,
  });
  assert.equal(rec.inputPer1k, 1.5);
  // Quality clamped to 1 on first call, unchanged on second.
  assert.equal(rec.quality, 1);
});

test("estimateRequestCost computes per-1k cost correctly", async () => {
  const rec = await registerModelPrice("est-model", {
    inputPer1k: 1.0,
    outputPer1k: 2.0,
    quality: 0.5,
  });
  const cost = /** @type {number} */ (
    estimateRequestCost(rec, { inputTokens: 1000, outputTokens: 500 })
  );
  // 1*1 + 0.5*2 = 2.0
  assert.equal(cost, 2.0);
  // Lookup by id form:
  const cost2 = await estimateRequestCost("est-model", { inputTokens: 2000, outputTokens: 0 });
  assert.equal(cost2, 2.0);
  await assert.rejects(() => estimateRequestCost("nonexistent", { inputTokens: 100 }));
});

test("routeByCost picks cheapest model meeting quality floor", async () => {
  await registerModelPrice("cheap-low-q", {
    inputPer1k: 0.1,
    outputPer1k: 0.2,
    quality: 0.3,
  });
  await registerModelPrice("mid-price", {
    inputPer1k: 0.5,
    outputPer1k: 1.0,
    quality: 0.7,
  });
  await registerModelPrice("expensive-high-q", {
    inputPer1k: 2.0,
    outputPer1k: 4.0,
    quality: 0.95,
  });
  const result = await routeByCost(
    { inputTokens: 1000, outputTokens: 500 },
    {
      qualityFloor: 0.6,
      candidates: ["cheap-low-q", "mid-price", "expensive-high-q"],
    },
  );
  assert.ok(result);
  assert.equal(result.model, "mid-price");
  assert.ok(result.cost > 0);
  assert.ok(result.quality >= 0.6);
});

test("routeByCost returns null when no model meets floor", async () => {
  const result = await routeByCost(
    { inputTokens: 100, outputTokens: 100 },
    { qualityFloor: 0.99, candidates: ["cheap-low-q"] },
  );
  assert.equal(result, null);
});

test("routeByCost supports provider filter and override list", async () => {
  const override = [
    { id: "a", inputPer1k: 1, outputPer1k: 1, quality: 0.8, provider: "p1" },
    { id: "b", inputPer1k: 0.1, outputPer1k: 0.1, quality: 0.8, provider: "p2" },
  ];
  const r1 = await routeByCost(
    { inputTokens: 1000, outputTokens: 1000 },
    { modelsOverride: override, provider: "p1" },
  );
  assert.equal(r1.model, "a");
  const r2 = await routeByCost(
    { inputTokens: 1000, outputTokens: 1000 },
    { modelsOverride: override },
  );
  assert.equal(r2.model, "b");
});

test("listPrices returns all registered entries", async () => {
  const list = await listPrices();
  const ids = list.map((m) => m.id);
  assert.ok(ids.includes("gpt-x-mini"));
  assert.ok(ids.includes("mid-price"));
});

test("recordSpend accumulates cumulative totals", async () => {
  const a = await recordSpend("spend-a", 0.25);
  const b = await recordSpend("spend-a", 0.5);
  assert.equal(a.uses, 1);
  assert.equal(b.uses, 2);
  assert.equal(b.total, 0.75);
  await assert.rejects(() => recordSpend("", 1));
  await assert.rejects(() => recordSpend("m", -1));
  const all = await listSpend();
  assert.ok(all.some((s) => s.model === "spend-a"));
});
