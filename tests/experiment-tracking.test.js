/**
 * Phase 64.4: Experiment tracking tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "siskel-exp-tracking-"));
process.env.STORAGE_PATH = TMP;

const {
  createExperiment,
  startRun,
  logParam,
  logMetric,
  endRun,
  listRuns,
  getRun,
  listExperiments,
  compareRuns,
} = await import("../lib/experiment-tracking.js");

test.after(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

test("createExperiment persists and is idempotent by name", async () => {
  const a = await createExperiment("my-exp");
  const b = await createExperiment("my-exp");
  assert.equal(a.id, b.id);
  assert.equal(a.name, "my-exp");
});

test("createExperiment rejects empty name", async () => {
  await assert.rejects(() => createExperiment(""));
});

test("startRun creates a run record", async () => {
  const exp = await createExperiment("run-test");
  const run = await startRun(exp.id);
  assert.equal(run.experimentId, exp.id);
  assert.equal(run.status, "running");
  assert.ok(run.id);
});

test("startRun rejects unknown experiment", async () => {
  await assert.rejects(() => startRun("unknown_exp"));
});

test("logParam stores params on a run", async () => {
  const exp = await createExperiment("params-test");
  const run = await startRun(exp.id);
  await logParam(run.id, "lr", 0.01);
  await logParam(run.id, "batch_size", 32);
  const fetched = await getRun(run.id);
  assert.equal(fetched.params.lr, 0.01);
  assert.equal(fetched.params.batch_size, 32);
});

test("logParam rejects missing runId/key", async () => {
  await assert.rejects(() => logParam("", "k", 1));
  await assert.rejects(() => logParam("runX", "", 1));
});

test("logMetric appends to a series", async () => {
  const exp = await createExperiment("metric-test");
  const run = await startRun(exp.id);
  await logMetric(run.id, "loss", 1.5, 0);
  await logMetric(run.id, "loss", 1.0, 1);
  await logMetric(run.id, "loss", 0.5, 2);
  const fetched = await getRun(run.id);
  assert.equal(fetched.metrics.loss.length, 3);
  assert.equal(fetched.metrics.loss[2].value, 0.5);
});

test("logMetric rejects non-number value", async () => {
  const exp = await createExperiment("bad-metric");
  const run = await startRun(exp.id);
  await assert.rejects(() => logMetric(run.id, "x", NaN));
  await assert.rejects(() => logMetric(run.id, "x", "not-a-number"));
});

test("endRun marks a run as finished", async () => {
  const exp = await createExperiment("end-test");
  const run = await startRun(exp.id);
  const ended = await endRun(run.id);
  assert.equal(ended.status, "finished");
  assert.ok(ended.endedAt);
});

test("listRuns filters by experiment", async () => {
  const exp1 = await createExperiment("list1");
  const exp2 = await createExperiment("list2");
  await startRun(exp1.id);
  await startRun(exp1.id);
  await startRun(exp2.id);
  const r1 = await listRuns(exp1.id);
  const r2 = await listRuns(exp2.id);
  assert.ok(r1.length >= 2);
  assert.ok(r2.length >= 1);
  assert.ok(r1.every((r) => r.experimentId === exp1.id));
});

test("listExperiments returns all created", async () => {
  const list = await listExperiments();
  assert.ok(list.length >= 5);
});

test("compareRuns returns latest value per run", async () => {
  const exp = await createExperiment("compare-test");
  const a = await startRun(exp.id);
  const b = await startRun(exp.id);
  await logMetric(a.id, "accuracy", 0.85);
  await logMetric(a.id, "accuracy", 0.90);
  await logMetric(b.id, "accuracy", 0.75);
  const out = await compareRuns([a.id, b.id], "accuracy");
  assert.equal(out.length, 2);
  const aResult = out.find((r) => r.runId === a.id);
  assert.equal(aResult.value, 0.90);
  assert.equal(aResult.count, 2);
});

test("compareRuns handles missing run", async () => {
  const out = await compareRuns(["nonexistent"], "x");
  assert.equal(out[0].value, null);
  assert.equal(out[0].count, 0);
});

test("getRun returns null for unknown", async () => {
  assert.equal(await getRun("nope"), null);
  assert.equal(await getRun(""), null);
});
