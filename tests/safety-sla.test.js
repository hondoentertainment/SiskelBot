/**
 * Phase 72.5: Safety SLA dashboard tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "siskel-safety-sla-"));
process.env.STORAGE_PATH = TMP;

const {
  recordClassification,
  setSlaTarget,
  getSlaTarget,
  computeMetrics,
  getSlaStatus,
  listClassifiers,
  seedFromEvalHistory,
  _reset,
} = await import("../lib/safety-sla.js");

test.after(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

test("recordClassification requires classifierId and booleans", async () => {
  await _reset();
  await assert.rejects(() => recordClassification({ prediction: true, actual: true }), /classifierId/);
  await assert.rejects(() => recordClassification({ classifierId: "c", prediction: "maybe", actual: true }), /prediction/);
  await assert.rejects(() => recordClassification({ classifierId: "c", prediction: true, actual: "x" }), /actual/);
});

test("setSlaTarget and getSlaTarget roundtrip", async () => {
  await _reset();
  await setSlaTarget({ classifierId: "c1", precisionTarget: 0.9, recallTarget: 0.8 });
  const t = await getSlaTarget("c1");
  assert.equal(t.precisionTarget, 0.9);
  assert.equal(t.recallTarget, 0.8);
});

test("setSlaTarget clamps out-of-range values", async () => {
  await _reset();
  await setSlaTarget({ classifierId: "c1", precisionTarget: 1.5, recallTarget: -0.3 });
  const t = await getSlaTarget("c1");
  assert.equal(t.precisionTarget, 1);
  assert.equal(t.recallTarget, 0);
});

test("computeMetrics returns precision/recall/f1", async () => {
  await _reset();
  // tp=3, fp=1 → precision=0.75; fn=1 → recall=0.75 → f1=0.75
  const now = Date.now();
  await recordClassification({ classifierId: "m", prediction: true, actual: true, timestamp: now });
  await recordClassification({ classifierId: "m", prediction: true, actual: true, timestamp: now });
  await recordClassification({ classifierId: "m", prediction: true, actual: true, timestamp: now });
  await recordClassification({ classifierId: "m", prediction: true, actual: false, timestamp: now });
  await recordClassification({ classifierId: "m", prediction: false, actual: true, timestamp: now });
  await recordClassification({ classifierId: "m", prediction: false, actual: false, timestamp: now });
  const metrics = await computeMetrics({ classifierId: "m" });
  assert.equal(metrics.tp, 3);
  assert.equal(metrics.fp, 1);
  assert.equal(metrics.fn, 1);
  assert.equal(metrics.tn, 1);
  assert.ok(Math.abs(metrics.precision - 0.75) < 0.001);
  assert.ok(Math.abs(metrics.recall - 0.75) < 0.001);
  assert.ok(Math.abs(metrics.f1 - 0.75) < 0.001);
});

test("computeMetrics filters by time window", async () => {
  await _reset();
  await recordClassification({ classifierId: "w", prediction: true, actual: true, timestamp: 1000 });
  await recordClassification({ classifierId: "w", prediction: true, actual: true, timestamp: 5000 });
  await recordClassification({ classifierId: "w", prediction: true, actual: false, timestamp: 9000 });
  const windowed = await computeMetrics({ classifierId: "w", since: 3000, until: 7000 });
  assert.equal(windowed.total, 1);
});

test("computeMetrics produces daily time series buckets", async () => {
  await _reset();
  const day1 = Date.UTC(2024, 0, 1, 10);
  const day2 = Date.UTC(2024, 0, 2, 10);
  await recordClassification({ classifierId: "ts", prediction: true, actual: true, timestamp: day1 });
  await recordClassification({ classifierId: "ts", prediction: true, actual: true, timestamp: day2 });
  const metrics = await computeMetrics({ classifierId: "ts", since: 0, until: day2 + 1000 });
  assert.equal(metrics.timeSeries.length, 2);
});

test("getSlaStatus reports meeting vs not meeting targets", async () => {
  await _reset();
  await setSlaTarget({ classifierId: "ok", precisionTarget: 0.5, recallTarget: 0.5 });
  const now = Date.now();
  // precision=1, recall=1
  await recordClassification({ classifierId: "ok", prediction: true, actual: true, timestamp: now });
  await recordClassification({ classifierId: "ok", prediction: false, actual: false, timestamp: now });
  const statusOk = await getSlaStatus("ok");
  assert.equal(statusOk.meeting, true);

  await setSlaTarget({ classifierId: "bad", precisionTarget: 0.95, recallTarget: 0.95 });
  await recordClassification({ classifierId: "bad", prediction: true, actual: false, timestamp: now });
  await recordClassification({ classifierId: "bad", prediction: true, actual: false, timestamp: now });
  const statusBad = await getSlaStatus("bad");
  assert.equal(statusBad.meeting, false);
});

test("listClassifiers enumerates tracked classifiers", async () => {
  await _reset();
  await recordClassification({ classifierId: "a", prediction: true, actual: true });
  await setSlaTarget({ classifierId: "b", precisionTarget: 0.9 });
  const list = await listClassifiers();
  const ids = list.map((c) => c.classifierId).sort();
  assert.deepEqual(ids, ["a", "b"]);
});

test("getSlaStatus returns null for unknown classifier", async () => {
  await _reset();
  const status = await getSlaStatus("missing");
  assert.equal(status, null);
});

test("seedFromEvalHistory imports safety eval samples", async () => {
  await _reset();
  const { recordSample } = await import("../lib/eval-history-store.js");
  const ws = "seed-ws";
  const base = Date.UTC(2024, 5, 1);
  await recordSample(ws, { ts: base, kind: "safety", suite: "mini", metrics: { passRate: 0.95 } });
  await recordSample(ws, { ts: base + 1000, kind: "safety", suite: "mini", metrics: { passRate: 0.4 } });
  await recordSample(ws, { ts: base + 2000, kind: "custom", suite: "other", metrics: { passRate: 1 } });

  const out = await seedFromEvalHistory({ workspaceId: ws, classifierId: "eval-seed" });
  assert.equal(out.imported, 2);
  assert.equal(out.skipped, 0);
  assert.equal(out.classifierId, "eval-seed");

  const metrics = await computeMetrics({ classifierId: "eval-seed" });
  assert.equal(metrics.total, 2);
  assert.equal(metrics.tp, 1);
  assert.equal(metrics.fp, 0);
  assert.equal(metrics.fn, 0);
  assert.equal(metrics.tn, 1);
});

test("seedFromEvalHistory requires workspaceId", async () => {
  await assert.rejects(() => seedFromEvalHistory({}), /workspaceId/);
});
