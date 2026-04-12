/**
 * Phase 57.2: Data quality tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "siskel-data-quality-"));
process.env.STORAGE_PATH = TMP;

const {
  MONITOR_TYPES,
  createMonitor,
  recordSample,
  setReference,
  checkDrift,
  listMonitors,
  summarizeNumeric,
  summarizeCategorical,
  _internals,
  _reset,
} = await import("../lib/data-quality.js");

test.after(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

test("MONITOR_TYPES exposes numeric and categorical", () => {
  assert.deepEqual([...MONITOR_TYPES], ["numeric", "categorical"]);
});

test("createMonitor persists a monitor record", async () => {
  await _reset();
  const rec = await createMonitor("latency", "numeric");
  assert.equal(rec.name, "latency");
  assert.equal(rec.type, "numeric");
  assert.deepEqual(rec.recent, []);
  assert.deepEqual(rec.reference, []);
});

test("recordSample adds to recent buffer and auto-creates monitor", async () => {
  await _reset();
  await recordSample("auto", 1);
  await recordSample("auto", 2);
  await recordSample("auto", 3);
  const list = await listMonitors();
  const rec = list.find((m) => m.name === "auto");
  assert.ok(rec);
  assert.deepEqual(rec.recent, [1, 2, 3]);
});

test("recordSample with asReference pins baseline", async () => {
  await _reset();
  for (let i = 0; i < 10; i += 1) {
    await recordSample("ref", i, { asReference: true });
  }
  const list = await listMonitors();
  const rec = list.find((m) => m.name === "ref");
  assert.equal(rec.reference.length, 10);
});

test("setReference snapshots current recent buffer", async () => {
  await _reset();
  for (let i = 0; i < 5; i += 1) await recordSample("snap", i);
  const rec = await setReference("snap");
  assert.equal(rec.reference.length, 5);
});

test("summarizeNumeric computes count/mean/stdDev", () => {
  const s = summarizeNumeric([1, 2, 3, 4, 5]);
  assert.equal(s.count, 5);
  assert.equal(s.mean, 3);
  assert.equal(s.min, 1);
  assert.equal(s.max, 5);
});

test("summarizeCategorical counts by key", () => {
  const s = summarizeCategorical(["a", "a", "b"]);
  assert.equal(s.categories.a, 2);
  assert.equal(s.categories.b, 1);
});

test("ksTest returns D statistic and p-value", () => {
  const a = [1, 2, 3, 4, 5];
  const b = [1, 2, 3, 4, 5];
  const r = _internals.ksTest(a, b);
  assert.equal(r.D, 0);
  assert.ok(r.pValue >= 0 && r.pValue <= 1);
});

test("checkDrift returns not_enough_samples when under minimum", async () => {
  await _reset();
  for (let i = 0; i < 5; i += 1) await recordSample("tiny", i, { asReference: true });
  for (let i = 0; i < 5; i += 1) await recordSample("tiny", 100 + i);
  const drift = await checkDrift("tiny");
  assert.equal(drift.drifted, false);
  assert.equal(drift.reason, "not_enough_samples");
});

test("checkDrift flags numeric distribution shift", async () => {
  await _reset();
  // Reference: tight distribution around 10.
  for (let i = 0; i < 100; i += 1) {
    await recordSample("num-drift", 10 + (Math.random() - 0.5), { asReference: true });
  }
  await setReference("num-drift");
  // Recent: heavily shifted to 100.
  for (let i = 0; i < 100; i += 1) {
    await recordSample("num-drift", 100 + (Math.random() - 0.5));
  }
  const drift = await checkDrift("num-drift", { significance: 0.05 });
  assert.equal(drift.test, "ks");
  assert.equal(drift.drifted, true);
  assert.ok(drift.stat > 0.5);
});

test("checkDrift does not flag identical distributions", async () => {
  await _reset();
  for (let i = 0; i < 100; i += 1) {
    await recordSample("num-stable", i % 10, { asReference: true });
  }
  await setReference("num-stable");
  for (let i = 0; i < 100; i += 1) {
    await recordSample("num-stable", i % 10);
  }
  const drift = await checkDrift("num-stable", { significance: 0.01 });
  assert.equal(drift.drifted, false);
});

test("checkDrift flags categorical distribution shift", async () => {
  await _reset();
  // Reference: mostly 'cat-a'.
  for (let i = 0; i < 100; i += 1) {
    await recordSample("cat-drift", i % 10 < 9 ? "a" : "b", {
      type: "categorical",
      asReference: true,
    });
  }
  await setReference("cat-drift");
  // Recent: mostly 'cat-b'.
  for (let i = 0; i < 100; i += 1) {
    await recordSample("cat-drift", i % 10 < 9 ? "b" : "a");
  }
  const drift = await checkDrift("cat-drift", { significance: 0.05 });
  assert.equal(drift.test, "chi2");
  assert.equal(drift.drifted, true);
});
