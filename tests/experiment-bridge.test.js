/**
 * Phase 64.4: Experiment bridge tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "siskel-experiment-bridge-"));
process.env.STORAGE_PATH = TMP;

const {
  createExperiment,
  logMetric,
  logParams,
  logArtifact,
  getExperiment,
  listExperiments,
  compareExperiments,
  _reset,
} = await import("../lib/experiment-bridge.js");

test.after(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

test("createExperiment requires name", async () => {
  await assert.rejects(() => createExperiment({}), /name is required/);
  await assert.rejects(() => createExperiment({ name: "" }), /name is required/);
});

test("createExperiment stores experiment and getExperiment retrieves it", async () => {
  await _reset("ws-e1");
  const exp = await createExperiment({ workspaceId: "ws-e1", name: "test-run", config: { lr: 0.01 }, tags: ["t1", "t2"] });
  assert.ok(exp.id);
  assert.equal(exp.name, "test-run");
  assert.equal(exp.config.lr, 0.01);
  assert.deepEqual(exp.tags, ["t1", "t2"]);
  assert.equal(exp.status, "running");
  const got = await getExperiment(exp.id);
  assert.ok(got);
  assert.equal(got.id, exp.id);
});

test("logMetric appends a time-series point", async () => {
  await _reset();
  const exp = await createExperiment({ workspaceId: "ws-m", name: "metrics-test" });
  const r1 = await logMetric({ experimentId: exp.id, metric: "loss", value: 1.5 });
  assert.equal(r1.point.step, 0);
  const r2 = await logMetric({ experimentId: exp.id, metric: "loss", value: 1.2 });
  assert.equal(r2.point.step, 1);
  const r3 = await logMetric({ experimentId: exp.id, metric: "loss", value: 1.0, step: 42 });
  assert.equal(r3.point.step, 42);
  const got = await getExperiment(exp.id);
  assert.equal(got.metrics.loss.length, 3);
  assert.equal(got.metrics.loss[2].value, 1.0);
});

test("logMetric rejects invalid inputs", async () => {
  await _reset();
  const exp = await createExperiment({ workspaceId: "ws-m2", name: "bad" });
  await assert.rejects(() => logMetric({ experimentId: exp.id, metric: "loss", value: "nope" }), /finite number/);
  await assert.rejects(() => logMetric({ experimentId: exp.id, metric: "", value: 1 }), /metric is required/);
  await assert.rejects(() => logMetric({ experimentId: "missing", metric: "x", value: 1 }), /not found/);
});

test("logParams merges parameters", async () => {
  await _reset();
  const exp = await createExperiment({ workspaceId: "ws-p", name: "params-test" });
  await logParams({ experimentId: exp.id, params: { lr: 0.01, epochs: 10 } });
  await logParams({ experimentId: exp.id, params: { batch_size: 32, lr: 0.02 } });
  const got = await getExperiment(exp.id);
  assert.equal(got.params.lr, 0.02);
  assert.equal(got.params.epochs, 10);
  assert.equal(got.params.batch_size, 32);
});

test("logArtifact appends an artifact entry", async () => {
  await _reset();
  const exp = await createExperiment({ workspaceId: "ws-a", name: "artifacts" });
  const art = await logArtifact({ experimentId: exp.id, name: "model.pt", description: "trained weights", sizeBytes: 1024 });
  assert.ok(art.id);
  assert.equal(art.name, "model.pt");
  assert.equal(art.sizeBytes, 1024);
  const got = await getExperiment(exp.id);
  assert.equal(got.artifacts.length, 1);
});

test("listExperiments returns newest first scoped to workspace", async () => {
  await _reset("ws-list");
  const a = await createExperiment({ workspaceId: "ws-list", name: "first" });
  await new Promise((r) => setTimeout(r, 2));
  const b = await createExperiment({ workspaceId: "ws-list", name: "second" });
  const list = await listExperiments("ws-list");
  assert.equal(list.length, 2);
  assert.equal(list[0].id, b.id);
  assert.equal(list[1].id, a.id);
});

test("compareExperiments builds a metric-indexed table", async () => {
  await _reset();
  const a = await createExperiment({ workspaceId: "ws-cmp", name: "A" });
  const b = await createExperiment({ workspaceId: "ws-cmp", name: "B" });
  await logMetric({ experimentId: a.id, metric: "loss", value: 1.5 });
  await logMetric({ experimentId: a.id, metric: "loss", value: 0.9 });
  await logMetric({ experimentId: a.id, metric: "accuracy", value: 0.75 });
  await logMetric({ experimentId: b.id, metric: "loss", value: 0.8 });

  const result = await compareExperiments([a.id, b.id]);
  assert.equal(result.experiments.length, 2);
  assert.deepEqual(result.metrics.sort(), ["accuracy", "loss"]);
  assert.equal(result.table.loss[a.id], 0.9);
  assert.equal(result.table.loss[b.id], 0.8);
  assert.equal(result.table.accuracy[a.id], 0.75);
  assert.equal(result.table.accuracy[b.id], null);
});

test("compareExperiments handles empty and unknown ids", async () => {
  const empty = await compareExperiments([]);
  assert.deepEqual(empty, { experiments: [], metrics: [], table: {} });
  const unknown = await compareExperiments(["no-such-experiment"]);
  assert.equal(unknown.experiments.length, 0);
});

test("getExperiment returns null for unknown id", async () => {
  const got = await getExperiment("does-not-exist");
  assert.equal(got, null);
});
