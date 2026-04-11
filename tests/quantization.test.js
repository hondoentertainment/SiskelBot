/**
 * Phase 58.5: Quantization management tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-quant-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  registerVariant,
  listVariants,
  recordQualityScore,
  canPromote,
  promoteVariant,
} = await import("../lib/quantization.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

test("registerVariant persists a new variant with defaults", async () => {
  const v = await registerVariant({
    variantId: "llama-70b-int4-v1",
    modelId: "llama-70b",
    precision: "int4",
    qualityFloor: 0.8,
  });
  assert.equal(v.variantId, "llama-70b-int4-v1");
  assert.equal(v.status, "candidate");
  assert.equal(v.precision, "int4");
  assert.equal(v.qualityFloor, 0.8);
  assert.equal(v.maxScoreWindow, 20);
});

test("registerVariant rejects invalid precision", async () => {
  await assert.rejects(() =>
    registerVariant({ variantId: "x", modelId: "m", precision: "int2" }),
  );
  await assert.rejects(() => registerVariant({ modelId: "m", precision: "int8" }));
  await assert.rejects(() => registerVariant({ variantId: "x", precision: "int8" }));
});

test("recordQualityScore appends and clamps to [0,1]", async () => {
  await registerVariant({
    variantId: "score-test",
    modelId: "base",
    precision: "int8",
    qualityFloor: 0.6,
  });
  const a = await recordQualityScore("score-test", 0.9);
  assert.equal(a.scoreCount, 1);
  assert.ok(a.averageQuality >= 0.89 && a.averageQuality <= 0.91);
  const b = await recordQualityScore("score-test", 1.5); // clamped to 1
  assert.ok(b.averageQuality > 0.9);
  await assert.rejects(() => recordQualityScore("no-such", 0.5));
  await assert.rejects(() => recordQualityScore("score-test", NaN));
});

test("recordQualityScore enforces maxScoreWindow", async () => {
  await registerVariant({
    variantId: "window-test",
    modelId: "m",
    precision: "int8",
    maxScoreWindow: 3,
  });
  for (let i = 0; i < 6; i += 1) await recordQualityScore("window-test", 0.5);
  const list = await listVariants({ modelId: "m" });
  const v = list.find((x) => x.variantId === "window-test");
  assert.equal(v.scoreCount, 3);
});

test("canPromote requires minimum score count", async () => {
  await registerVariant({
    variantId: "promo-test",
    modelId: "promo-base",
    precision: "int4",
    qualityFloor: 0.7,
  });
  const g1 = await canPromote("promo-test");
  assert.equal(g1.ok, false);
  await recordQualityScore("promo-test", 0.75);
  await recordQualityScore("promo-test", 0.8);
  const g2 = await canPromote("promo-test");
  assert.equal(g2.ok, false); // still need 3
  await recordQualityScore("promo-test", 0.85);
  const g3 = await canPromote("promo-test");
  assert.equal(g3.ok, true);
  assert.ok(g3.average >= 0.7);
});

test("canPromote returns reason for average below floor", async () => {
  await registerVariant({
    variantId: "low-quality",
    modelId: "q-base",
    precision: "fp16",
    qualityFloor: 0.9,
  });
  for (let i = 0; i < 3; i += 1) await recordQualityScore("low-quality", 0.5);
  const g = await canPromote("low-quality");
  assert.equal(g.ok, false);
  assert.ok(/below floor/.test(g.reason));
});

test("canPromote rejects unknown variant and empty id", async () => {
  const g1 = await canPromote("nope");
  assert.equal(g1.ok, false);
  assert.equal(g1.reason, "unknown variant");
  const g2 = await canPromote("");
  assert.equal(g2.ok, false);
});

test("promoteVariant activates and demotes siblings", async () => {
  await registerVariant({
    variantId: "old-active",
    modelId: "shared-base",
    precision: "fp16",
    qualityFloor: 0.7,
  });
  for (let i = 0; i < 3; i += 1) await recordQualityScore("old-active", 0.85);
  await promoteVariant("old-active");

  await registerVariant({
    variantId: "new-candidate",
    modelId: "shared-base",
    precision: "int8",
    qualityFloor: 0.7,
  });
  for (let i = 0; i < 3; i += 1) await recordQualityScore("new-candidate", 0.9);
  const promoted = await promoteVariant("new-candidate");
  assert.equal(promoted.status, "active");
  assert.ok(promoted.promotedAt);
  const list = await listVariants({ modelId: "shared-base" });
  const old = list.find((v) => v.variantId === "old-active");
  assert.equal(old.status, "deprecated");
});

test("promoteVariant throws when gate fails", async () => {
  await registerVariant({
    variantId: "fail-promo",
    modelId: "f",
    precision: "int4",
    qualityFloor: 0.95,
  });
  await assert.rejects(() => promoteVariant("fail-promo"));
});

test("listVariants supports filters and computes averages", async () => {
  const all = await listVariants();
  assert.ok(all.length >= 4);
  const actives = await listVariants({ status: "active" });
  assert.ok(actives.every((v) => v.status === "active"));
  const byModel = await listVariants({ modelId: "promo-base" });
  assert.ok(byModel.length >= 1);
  assert.ok(byModel[0].averageQuality >= 0);
});
