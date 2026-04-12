/**
 * Phase 58.5: Quantization management tests.
 *
 * Covers: QUANT_METHODS catalog, variant registration and lookup, filtering,
 * size and memory estimation, quality-loss estimation with calibration,
 * quality gates (set/get/check), benchmarking (pass/fail paths), deployment
 * lifecycle (promote/deprecate/status), recommendations, and comparisons.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolated STORAGE_PATH so JSON-on-disk writes don't collide with other tests.
const TMP = mkdtempSync(join(tmpdir(), "siskel-quantization-"));
process.env.STORAGE_PATH = TMP;

const {
  QUANT_METHODS,
  registerVariant,
  getVariant,
  listVariants,
  removeVariant,
  estimateSize,
  estimateMemoryUsage,
  estimateQualityLoss,
  setQualityGate,
  getQualityGate,
  checkQualityGate,
  runQuantizationBenchmark,
  recordBenchmarkResult,
  getBenchmarkHistory,
  promoteVariant,
  deprecateVariant,
  getVariantStatus,
  recommendVariant,
  compareVariants,
  _resetQuantStoreForTest,
} = await import("../lib/quantization.js");

test.beforeEach(async () => {
  await _resetQuantStoreForTest();
});

test.after(() => {
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ────────────── QUANT_METHODS catalog ──────────────

test("QUANT_METHODS has at least 8 entries", () => {
  const keys = Object.keys(QUANT_METHODS);
  assert.ok(keys.length >= 8, `expected >=8 methods, got ${keys.length}`);
  assert.ok(QUANT_METHODS.int8);
  assert.ok(QUANT_METHODS.int4);
  assert.ok(QUANT_METHODS.gptq_int4);
  assert.ok(QUANT_METHODS.awq_int4);
  assert.ok(QUANT_METHODS.gguf_q4_k_m);
  assert.ok(QUANT_METHODS.gguf_q5_k_m);
  assert.ok(QUANT_METHODS.gguf_q8_0);
  assert.ok(QUANT_METHODS.bf16);
  for (const key of keys) {
    const spec = QUANT_METHODS[key];
    assert.ok(Number.isFinite(spec.bitsPerWeight));
    assert.ok(Number.isFinite(spec.sizeReduction));
    assert.ok(Number.isFinite(spec.qualityLoss));
  }
});

// ────────────── variant registration ──────────────

test("registerVariant validates required fields", async () => {
  await assert.rejects(
    () => registerVariant({}),
    /baseModel is required/i
  );
  await assert.rejects(
    () => registerVariant({ baseModel: "llama3" }),
    /method is required/i
  );
  await assert.rejects(
    () => registerVariant({ baseModel: "llama3", method: "nope" }),
    /method must be one of/i
  );
});

test("registerVariant persists a record", async () => {
  const res = await registerVariant({
    baseModel: "llama3-7b",
    method: "gptq_int4",
    sizeMb: 3800,
    url: "https://example.com/model.bin",
    metadata: { calibration: "c4" },
  });
  assert.ok(res.id.startsWith("qvar_"));
  assert.ok(res.registeredAt);
  const fetched = await getVariant(res.id);
  assert.ok(fetched);
  assert.equal(fetched.baseModel, "llama3-7b");
  assert.equal(fetched.method, "gptq_int4");
  assert.equal(fetched.sizeMb, 3800);
  assert.equal(fetched.url, "https://example.com/model.bin");
  assert.deepEqual(fetched.metadata, { calibration: "c4" });
  assert.equal(fetched.status, "registered");
});

test("getVariant returns null for missing id", async () => {
  assert.equal(await getVariant("qvar_missing"), null);
  assert.equal(await getVariant(null), null);
});

test("listVariants filters by baseModel/method/status", async () => {
  const v1 = await registerVariant({ baseModel: "llama3-7b", method: "int4" });
  const v2 = await registerVariant({ baseModel: "llama3-7b", method: "int8" });
  const v3 = await registerVariant({ baseModel: "llama3-13b", method: "int4" });
  const all = await listVariants();
  assert.equal(all.length, 3);
  const sevenB = await listVariants({ baseModel: "llama3-7b" });
  assert.equal(sevenB.length, 2);
  const int4 = await listVariants({ method: "int4" });
  assert.equal(int4.length, 2);
  assert.ok(int4.some((v) => v.id === v1.id));
  assert.ok(int4.some((v) => v.id === v3.id));
  const registered = await listVariants({ status: "registered" });
  assert.equal(registered.length, 3);
  // after promoting v2, status filters change
  await promoteVariant(v2.id, "prod");
  const promoted = await listVariants({ status: "promoted" });
  assert.equal(promoted.length, 1);
  assert.equal(promoted[0].id, v2.id);
});

test("removeVariant deletes record, gate, benchmarks, deployment", async () => {
  const { id } = await registerVariant({ baseModel: "llama3-7b", method: "int8" });
  await setQualityGate(id, 0.7);
  await recordBenchmarkResult(id, { name: "baseline", avgScore: 0.85, ranAt: new Date().toISOString() });
  await promoteVariant(id, "staging");
  const res = await removeVariant(id);
  assert.equal(res.ok, true);
  assert.equal(await getVariant(id), null);
  assert.equal(await getQualityGate(id), null);
  assert.deepEqual(await getBenchmarkHistory(id), []);
  assert.equal(await getVariantStatus(id), null);
  const missing = await removeVariant("qvar_not_real");
  assert.equal(missing.ok, false);
});

// ────────────── estimation ──────────────

test("estimateSize scales with method", () => {
  // 7B param model baselines
  const int4Size = estimateSize(7, "int4");
  const int8Size = estimateSize(7, "int8");
  const bf16Size = estimateSize(7, "bf16");
  assert.ok(int4Size < int8Size, "int4 should be smaller than int8");
  assert.ok(int8Size < bf16Size, "int8 should be smaller than bf16");
  assert.throws(() => estimateSize(7, "unknown"), /unknown method/);
  assert.throws(() => estimateSize(0, "int4"), /positive number/);
  assert.throws(() => estimateSize(-1, "int4"), /positive number/);
});

test("estimateMemoryUsage includes batch overhead", () => {
  const bs1 = estimateMemoryUsage(7, "int4", 1);
  const bs4 = estimateMemoryUsage(7, "int4", 4);
  assert.ok(bs4 > bs1, "larger batch should need more memory");
  const weights = estimateSize(7, "int4");
  assert.ok(bs1 >= weights, "memory usage is at least weights size");
});

test("estimateQualityLoss factors in calibration", () => {
  const base = estimateQualityLoss("gptq_int4");
  assert.ok(base > 0);
  const withCal = estimateQualityLoss("gptq_int4", 1.0);
  assert.ok(withCal < base, "perfect calibration lowers reported loss");
  const noCal = estimateQualityLoss("gptq_int4", 0);
  assert.equal(noCal, base, "zero calibration matches nominal");
  assert.throws(() => estimateQualityLoss("unknown"), /unknown method/);
});

// ────────────── quality gates ──────────────

test("setQualityGate + getQualityGate round-trip", async () => {
  const { id } = await registerVariant({ baseModel: "llama3-7b", method: "int4" });
  const res = await setQualityGate(id, 0.75);
  assert.equal(res.minScore, 0.75);
  const gate = await getQualityGate(id);
  assert.ok(gate);
  assert.equal(gate.minScore, 0.75);
  assert.ok(gate.updatedAt);
  await assert.rejects(() => setQualityGate("qvar_missing", 0.5), /variant not found/);
  await assert.rejects(() => setQualityGate(id, "high"), /must be a number/);
});

test("checkQualityGate allows scores at or above threshold", async () => {
  const { id } = await registerVariant({ baseModel: "llama3-7b", method: "int4" });
  await setQualityGate(id, 0.7);
  const res = await checkQualityGate(id, 0.75);
  assert.equal(res.passed, true);
  assert.equal(res.minScore, 0.7);
  assert.equal(res.testScore, 0.75);
  const exact = await checkQualityGate(id, 0.7);
  assert.equal(exact.passed, true);
});

test("checkQualityGate denies scores below threshold", async () => {
  const { id } = await registerVariant({ baseModel: "llama3-7b", method: "int4" });
  await setQualityGate(id, 0.8);
  const res = await checkQualityGate(id, 0.5);
  assert.equal(res.passed, false);
  assert.match(res.reason, /below gate/);
});

test("checkQualityGate passes when no gate configured", async () => {
  const { id } = await registerVariant({ baseModel: "llama3-7b", method: "int4" });
  const res = await checkQualityGate(id, 0.1);
  assert.equal(res.passed, true);
  assert.equal(res.minScore, null);
});

// ────────────── benchmarking ──────────────

test("runQuantizationBenchmark invokes targetFn and records results", async () => {
  const { id } = await registerVariant({ baseModel: "llama3-7b", method: "int4" });
  let calls = 0;
  const targetFn = async (input) => {
    calls += 1;
    return { score: 0.9 - calls * 0.1, output: `echo:${input}` };
  };
  const bench = {
    name: "smoke",
    items: [{ input: "a" }, { input: "b" }, { input: "c" }],
  };
  const res = await runQuantizationBenchmark(id, targetFn, bench);
  assert.equal(calls, 3);
  assert.equal(res.items, 3);
  assert.equal(res.errors, 0);
  assert.ok(res.avgScore > 0);
  assert.ok(Array.isArray(res.perItem));
  assert.equal(res.perItem.length, 3);
  assert.ok(res.gate);
  // History should now hold exactly one entry.
  const hist = await getBenchmarkHistory(id);
  assert.equal(hist.length, 1);
  assert.equal(hist[0].name, "smoke");
});

test("runQuantizationBenchmark counts errors from targetFn", async () => {
  const { id } = await registerVariant({ baseModel: "llama3-7b", method: "int4" });
  const targetFn = async (input) => {
    if (input === "bad") throw new Error("nope");
    return { score: 0.5 };
  };
  const res = await runQuantizationBenchmark(id, targetFn, {
    items: [{ input: "ok" }, { input: "bad" }, { input: "ok" }],
  });
  assert.equal(res.items, 3);
  assert.equal(res.errors, 1);
});

test("runQuantizationBenchmark rejects invalid input", async () => {
  await assert.rejects(
    () => runQuantizationBenchmark("qvar_missing", () => {}, { items: [{}] }),
    /variant not found/
  );
  const { id } = await registerVariant({ baseModel: "llama3-7b", method: "int4" });
  await assert.rejects(
    () => runQuantizationBenchmark(id, "not-fn", { items: [{}] }),
    /targetFn must be a function/
  );
  await assert.rejects(
    () => runQuantizationBenchmark(id, async () => ({ score: 1 }), { items: [] }),
    /non-empty array/
  );
});

test("recordBenchmarkResult appends to history", async () => {
  const { id } = await registerVariant({ baseModel: "llama3-7b", method: "int4" });
  await recordBenchmarkResult(id, { name: "r1", avgScore: 0.8 });
  await recordBenchmarkResult(id, { name: "r2", avgScore: 0.85 });
  const hist = await getBenchmarkHistory(id);
  assert.equal(hist.length, 2);
  assert.equal(hist[0].name, "r1");
  assert.equal(hist[1].name, "r2");
  await assert.rejects(
    () => recordBenchmarkResult("qvar_missing", { avgScore: 0 }),
    /variant not found/
  );
});

test("getBenchmarkHistory returns empty array for missing/unused variants", async () => {
  assert.deepEqual(await getBenchmarkHistory("qvar_missing"), []);
  const { id } = await registerVariant({ baseModel: "llama3-7b", method: "int4" });
  assert.deepEqual(await getBenchmarkHistory(id), []);
});

// ────────────── deployment lifecycle ──────────────

test("promoteVariant marks variant promoted and records environment", async () => {
  const { id } = await registerVariant({ baseModel: "llama3-7b", method: "int4" });
  const res = await promoteVariant(id, "prod");
  assert.equal(res.status, "promoted");
  assert.equal(res.environment, "prod");
  const v = await getVariant(id);
  assert.equal(v.status, "promoted");
  await assert.rejects(() => promoteVariant(id, "nope"), /environment must be one of/);
  await assert.rejects(() => promoteVariant("qvar_missing", "prod"), /variant not found/);
});

test("deprecateVariant blocks further promotion", async () => {
  const { id } = await registerVariant({ baseModel: "llama3-7b", method: "int4" });
  const res = await deprecateVariant(id, "quality regression");
  assert.equal(res.status, "deprecated");
  assert.equal(res.reason, "quality regression");
  const v = await getVariant(id);
  assert.equal(v.status, "deprecated");
  await assert.rejects(() => promoteVariant(id, "prod"), /cannot promote a deprecated/);
});

test("getVariantStatus returns aggregate info", async () => {
  const { id } = await registerVariant({ baseModel: "llama3-7b", method: "int4" });
  await setQualityGate(id, 0.6);
  await promoteVariant(id, "canary");
  await recordBenchmarkResult(id, { name: "r1", avgScore: 0.7 });
  const status = await getVariantStatus(id);
  assert.ok(status);
  assert.equal(status.variant.id, id);
  assert.ok(status.deployment);
  assert.equal(status.deployment.environment, "canary");
  assert.equal(status.gate.minScore, 0.6);
  assert.equal(status.benchmarkCount, 1);
  assert.equal(await getVariantStatus("qvar_missing"), null);
});

// ────────────── recommendations ──────────────

test("recommendVariant meets constraints and filters deprecated", async () => {
  const a = await registerVariant({
    baseModel: "llama3-7b",
    method: "gptq_int4",
    sizeMb: 4000,
  });
  const b = await registerVariant({
    baseModel: "llama3-7b",
    method: "awq_int4",
    sizeMb: 4200,
  });
  const c = await registerVariant({
    baseModel: "llama3-7b",
    method: "int4",
    sizeMb: 3500,
  });
  await deprecateVariant(c.id, "old");
  const variants = await listVariants({ baseModel: "llama3-7b" });
  const recs = recommendVariant({
    variants,
    targetSizeMb: 4500,
    minQuality: 0.95,
    preferredMethods: ["awq_int4"],
  });
  assert.ok(recs.length >= 2);
  // Deprecated variant excluded.
  assert.ok(!recs.some((r) => r.variant.id === c.id));
  // Top-ranked exists and has numeric score.
  assert.ok(Number.isFinite(recs[0].score));
  // AWQ preferred gets bias; both non-deprecated variants fit within constraints.
  const hasAwq = recs.some((r) => r.variant.id === b.id);
  const hasGptq = recs.some((r) => r.variant.id === a.id);
  assert.ok(hasAwq);
  assert.ok(hasGptq);
});

test("recommendVariant requires preloaded variants", () => {
  assert.throws(
    () => recommendVariant({ targetSizeMb: 1000 }),
    /requires constraints.variants/
  );
});

test("compareVariants returns ranked side-by-side rows", async () => {
  const a = await registerVariant({
    baseModel: "llama3-7b",
    method: "gptq_int4",
    sizeMb: 4000,
  });
  const b = await registerVariant({
    baseModel: "llama3-7b",
    method: "int4",
    sizeMb: 3500,
  });
  await recordBenchmarkResult(a.id, { name: "r", avgScore: 0.9, avgLatencyMs: 120 });
  await recordBenchmarkResult(b.id, { name: "r", avgScore: 0.7, avgLatencyMs: 90 });
  const rows = await compareVariants([a.id, b.id, "qvar_missing"]);
  assert.equal(rows.length, 3);
  // Ranked by avgScore desc: a (0.9), b (0.7), missing (error row)
  assert.equal(rows[0].id, a.id);
  assert.equal(rows[0].avgScore, 0.9);
  assert.equal(rows[0].avgLatencyMs, 120);
  assert.equal(rows[1].id, b.id);
  const missing = rows.find((r) => r.id === "qvar_missing");
  assert.ok(missing);
  assert.equal(missing.error, "not found");
});

test("compareVariants rejects empty input", () => {
  assert.throws(() => compareVariants([]), /non-empty array/);
  assert.throws(() => compareVariants(null), /non-empty array/);
});
