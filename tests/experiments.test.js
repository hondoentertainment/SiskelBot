/**
 * Tests for lib/experiments.js — experiment tracking: runs, params, metrics,
 * artifacts, history, best run, comparison, search.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  createExperiment,
  getExperiment,
  listExperiments,
  deleteExperiment,
  startRun,
  getRun,
  listRuns,
  logParam,
  logParams,
  logMetric,
  logMetrics,
  logArtifact,
  setRunStatus,
  getMetricHistory,
  getBestRun,
  compareRuns,
  tagRun,
  searchRuns,
  _resetRuntime,
} from "../lib/experiments.js";
import { ExperimentTracker, withRun } from "../lib/experiment-sdk.js";

const TEST_WS = "test-experiments-ws-" + Date.now();

// ─── createExperiment / getExperiment / listExperiments ─────────────────────

test("createExperiment stores experiment and returns id", async () => {
  const exp = await createExperiment("hyperparam-sweep", TEST_WS, {
    description: "Sweep learning rates",
    tags: ["baseline", "lr-sweep"],
  });
  assert.ok(exp.id);
  assert.equal(exp.name, "hyperparam-sweep");
  assert.equal(exp.workspaceId, TEST_WS);
  assert.deepEqual(exp.tags, ["baseline", "lr-sweep"]);
  assert.ok(Array.isArray(exp.runs));
  assert.equal(exp.runs.length, 0);
});

test("createExperiment throws on missing name", async () => {
  await assert.rejects(
    () => createExperiment("", TEST_WS),
    { message: "name is required" }
  );
});

test("getExperiment returns the experiment by id", async () => {
  const created = await createExperiment("fetch-test", TEST_WS);
  const fetched = await getExperiment(created.id, TEST_WS);
  assert.equal(fetched.id, created.id);
  assert.equal(fetched.name, "fetch-test");
});

test("getExperiment returns null for unknown id", async () => {
  const res = await getExperiment("nonexistent-id", TEST_WS);
  assert.equal(res, null);
});

test("listExperiments returns all experiments for the workspace", async () => {
  const items = await listExperiments(TEST_WS);
  assert.ok(Array.isArray(items));
  assert.ok(items.length >= 2);
  assert.ok(items.some((e) => e.name === "hyperparam-sweep"));
});

// ─── startRun + getRun ─────────────────────────────────────────────────────

test("startRun creates a running run inside an experiment", async () => {
  const exp = await createExperiment("runs-basic", TEST_WS);
  const result = await startRun(exp.id, { workspaceId: TEST_WS, name: "baseline-run" });
  assert.ok(result.runId);
  assert.ok(result.startedAt);
  assert.equal(result.status, "running");

  const run = await getRun(result.runId);
  assert.equal(run.id, result.runId);
  assert.equal(run.experimentId, exp.id);
  assert.equal(run.name, "baseline-run");
  assert.equal(run.status, "running");
  assert.deepEqual(run.params, {});
  assert.deepEqual(run.metrics, {});
  assert.deepEqual(run.artifacts, []);
});

test("getRun returns null for unknown run", async () => {
  const run = await getRun("no-such-run-id");
  assert.equal(run, null);
});

// ─── logParam / logParams (immutability) ────────────────────────────────────

test("logParam and logParams store hyperparameters", async () => {
  const exp = await createExperiment("params-test", TEST_WS);
  const { runId } = await startRun(exp.id, { workspaceId: TEST_WS });
  await logParam(runId, "learning_rate", 0.01);
  await logParams(runId, { batch_size: 64, epochs: 10 });
  const run = await getRun(runId);
  assert.equal(run.params.learning_rate, 0.01);
  assert.equal(run.params.batch_size, 64);
  assert.equal(run.params.epochs, 10);
});

test("logParam is immutable once set", async () => {
  const exp = await createExperiment("params-immutable", TEST_WS);
  const { runId } = await startRun(exp.id, { workspaceId: TEST_WS });
  await logParam(runId, "lr", 0.01);
  await assert.rejects(
    () => logParam(runId, "lr", 0.02),
    /immutable/
  );
});

// ─── logMetric (time series) ────────────────────────────────────────────────

test("logMetric records a time series", async () => {
  const exp = await createExperiment("metrics-test", TEST_WS);
  const { runId } = await startRun(exp.id, { workspaceId: TEST_WS });
  await logMetric(runId, "loss", 1.5, 0);
  await logMetric(runId, "loss", 0.9, 1);
  await logMetric(runId, "loss", 0.5, 2);

  const history = await getMetricHistory(runId, "loss");
  assert.equal(history.length, 3);
  assert.equal(history[0].step, 0);
  assert.equal(history[0].value, 1.5);
  assert.equal(history[2].step, 2);
  assert.equal(history[2].value, 0.5);
  assert.ok(history[0].timestamp);
});

test("logMetric auto-assigns step when omitted", async () => {
  const exp = await createExperiment("metrics-autostep", TEST_WS);
  const { runId } = await startRun(exp.id, { workspaceId: TEST_WS });
  await logMetric(runId, "accuracy", 0.8);
  await logMetric(runId, "accuracy", 0.85);
  const history = await getMetricHistory(runId, "accuracy");
  assert.equal(history.length, 2);
  assert.equal(history[0].step, 0);
  assert.equal(history[1].step, 1);
});

test("logMetrics logs multiple keys at once", async () => {
  const exp = await createExperiment("metrics-multi", TEST_WS);
  const { runId } = await startRun(exp.id, { workspaceId: TEST_WS });
  await logMetrics(runId, { loss: 1.2, accuracy: 0.75 }, 0);
  const run = await getRun(runId);
  assert.equal(run.metrics.loss.length, 1);
  assert.equal(run.metrics.accuracy.length, 1);
  assert.equal(run.metrics.loss[0].value, 1.2);
  assert.equal(run.metrics.accuracy[0].value, 0.75);
});

test("logMetric throws on non-finite value", async () => {
  const exp = await createExperiment("metrics-nan", TEST_WS);
  const { runId } = await startRun(exp.id, { workspaceId: TEST_WS });
  await assert.rejects(
    () => logMetric(runId, "bad", "not-a-number"),
    /finite number/
  );
});

// ─── logArtifact ────────────────────────────────────────────────────────────

test("logArtifact registers an artifact", async () => {
  const exp = await createExperiment("artifacts-test", TEST_WS);
  const { runId } = await startRun(exp.id, { workspaceId: TEST_WS });
  await logArtifact(runId, "model.bin", "/tmp/model.bin", { size: 1024 });
  const run = await getRun(runId);
  assert.equal(run.artifacts.length, 1);
  assert.equal(run.artifacts[0].name, "model.bin");
  assert.equal(run.artifacts[0].path, "/tmp/model.bin");
  assert.equal(run.artifacts[0].metadata.size, 1024);
  assert.ok(run.artifacts[0].id);
  assert.ok(run.artifacts[0].loggedAt);
});

// ─── setRunStatus + duration ────────────────────────────────────────────────

test("setRunStatus to completed sets endedAt and duration", async () => {
  const exp = await createExperiment("status-test", TEST_WS);
  const { runId } = await startRun(exp.id, { workspaceId: TEST_WS });
  await new Promise((r) => setTimeout(r, 20));
  await setRunStatus(runId, "completed");
  const run = await getRun(runId);
  assert.equal(run.status, "completed");
  assert.ok(run.endedAt);
  assert.ok(run.duration >= 0);
});

test("setRunStatus throws on invalid status", async () => {
  const exp = await createExperiment("status-invalid", TEST_WS);
  const { runId } = await startRun(exp.id, { workspaceId: TEST_WS });
  await assert.rejects(
    () => setRunStatus(runId, "unknown-status"),
    /must be one of/
  );
});

// ─── listRuns with filtering and sorting ────────────────────────────────────

test("listRuns returns runs with filtering and sorting", async () => {
  const exp = await createExperiment("list-runs", TEST_WS);
  const r1 = await startRun(exp.id, { workspaceId: TEST_WS, name: "r1" });
  const r2 = await startRun(exp.id, { workspaceId: TEST_WS, name: "r2" });
  const r3 = await startRun(exp.id, { workspaceId: TEST_WS, name: "r3" });

  await logMetric(r1.runId, "acc", 0.7, 0);
  await logMetric(r2.runId, "acc", 0.85, 0);
  await logMetric(r3.runId, "acc", 0.9, 0);

  await setRunStatus(r1.runId, "completed");
  await setRunStatus(r2.runId, "failed");
  // r3 remains running

  const all = await listRuns(exp.id, { workspaceId: TEST_WS });
  assert.equal(all.length, 3);

  const completed = await listRuns(exp.id, { workspaceId: TEST_WS, status: "completed" });
  assert.equal(completed.length, 1);
  assert.equal(completed[0].id, r1.runId);

  const sortedByMetric = await listRuns(exp.id, {
    workspaceId: TEST_WS,
    sortBy: "metric.acc",
    sortOrder: "desc",
  });
  assert.equal(sortedByMetric[0].id, r3.runId);
  assert.equal(sortedByMetric[2].id, r1.runId);

  const limited = await listRuns(exp.id, { workspaceId: TEST_WS, limit: 2 });
  assert.equal(limited.length, 2);
});

// ─── getBestRun ─────────────────────────────────────────────────────────────

test("getBestRun returns the run with max metric value", async () => {
  const exp = await createExperiment("best-run-max", TEST_WS);
  const r1 = await startRun(exp.id, { workspaceId: TEST_WS });
  const r2 = await startRun(exp.id, { workspaceId: TEST_WS });
  const r3 = await startRun(exp.id, { workspaceId: TEST_WS });
  await logMetric(r1.runId, "accuracy", 0.82, 0);
  await logMetric(r2.runId, "accuracy", 0.91, 0);
  await logMetric(r3.runId, "accuracy", 0.88, 0);

  const best = await getBestRun(exp.id, "accuracy", "max", { workspaceId: TEST_WS });
  assert.equal(best.id, r2.runId);
  assert.equal(best.bestValue, 0.91);
});

test("getBestRun returns the run with min metric value", async () => {
  const exp = await createExperiment("best-run-min", TEST_WS);
  const r1 = await startRun(exp.id, { workspaceId: TEST_WS });
  const r2 = await startRun(exp.id, { workspaceId: TEST_WS });
  await logMetric(r1.runId, "loss", 0.5, 0);
  await logMetric(r2.runId, "loss", 0.3, 0);

  const best = await getBestRun(exp.id, "loss", "min", { workspaceId: TEST_WS });
  assert.equal(best.id, r2.runId);
  assert.equal(best.bestValue, 0.3);
});

test("getBestRun returns null when no runs have the metric", async () => {
  const exp = await createExperiment("best-run-empty", TEST_WS);
  await startRun(exp.id, { workspaceId: TEST_WS });
  const best = await getBestRun(exp.id, "missing-metric", "max", { workspaceId: TEST_WS });
  assert.equal(best, null);
});

// ─── compareRuns ────────────────────────────────────────────────────────────

test("compareRuns returns side-by-side params and metrics", async () => {
  const exp = await createExperiment("compare-test", TEST_WS);
  const r1 = await startRun(exp.id, { workspaceId: TEST_WS, name: "A" });
  const r2 = await startRun(exp.id, { workspaceId: TEST_WS, name: "B" });
  await logParams(r1.runId, { lr: 0.01, batch: 32 });
  await logParams(r2.runId, { lr: 0.001, batch: 64 });
  await logMetric(r1.runId, "accuracy", 0.85, 0);
  await logMetric(r2.runId, "accuracy", 0.92, 0);
  await logMetric(r1.runId, "loss", 0.3, 0);

  const comparison = await compareRuns([r1.runId, r2.runId]);
  assert.equal(comparison.runs.length, 2);
  assert.equal(comparison.params.lr[r1.runId], 0.01);
  assert.equal(comparison.params.lr[r2.runId], 0.001);
  assert.equal(comparison.metrics.accuracy[r1.runId], 0.85);
  assert.equal(comparison.metrics.accuracy[r2.runId], 0.92);
  // loss only on r1
  assert.equal(comparison.metrics.loss[r1.runId], 0.3);
  assert.equal(comparison.metrics.loss[r2.runId], undefined);
});

test("compareRuns handles empty input", async () => {
  const result = await compareRuns([]);
  assert.deepEqual(result.params, {});
  assert.deepEqual(result.metrics, {});
});

// ─── tagRun + searchRuns ────────────────────────────────────────────────────

test("tagRun adds a tag to a run", async () => {
  const exp = await createExperiment("tag-test", TEST_WS);
  const { runId } = await startRun(exp.id, { workspaceId: TEST_WS, tags: ["v1"] });
  await tagRun(runId, "production");
  await tagRun(runId, "production"); // duplicate ignored
  const run = await getRun(runId);
  assert.ok(run.tags.includes("v1"));
  assert.ok(run.tags.includes("production"));
  assert.equal(run.tags.filter((t) => t === "production").length, 1);
});

test("searchRuns filters by status, tag, and metric range", async () => {
  const exp = await createExperiment("search-test", TEST_WS);
  const r1 = await startRun(exp.id, { workspaceId: TEST_WS, name: "baseline", tags: ["v1"] });
  const r2 = await startRun(exp.id, { workspaceId: TEST_WS, name: "tuned", tags: ["v2"] });
  const r3 = await startRun(exp.id, { workspaceId: TEST_WS, name: "final", tags: ["v2"] });
  await logMetric(r1.runId, "f1", 0.6, 0);
  await logMetric(r2.runId, "f1", 0.78, 0);
  await logMetric(r3.runId, "f1", 0.92, 0);
  await setRunStatus(r1.runId, "completed");
  await setRunStatus(r2.runId, "completed");
  await setRunStatus(r3.runId, "completed");

  const v2Only = await searchRuns({ workspaceId: TEST_WS, experimentId: exp.id, tag: "v2" });
  assert.ok(v2Only.length >= 2);
  assert.ok(v2Only.every((r) => r.tags.includes("v2")));

  const byName = await searchRuns({ workspaceId: TEST_WS, experimentId: exp.id, name: "base" });
  assert.ok(byName.some((r) => r.id === r1.runId));

  const highF1 = await searchRuns({
    workspaceId: TEST_WS,
    experimentId: exp.id,
    metric: "f1",
    min: 0.75,
  });
  assert.ok(highF1.length >= 2);
  assert.ok(highF1.every((r) => r.id !== r1.runId));
});

// ─── deleteExperiment ───────────────────────────────────────────────────────

test("deleteExperiment removes the experiment", async () => {
  const exp = await createExperiment("delete-me", TEST_WS);
  await startRun(exp.id, { workspaceId: TEST_WS });
  const ok = await deleteExperiment(exp.id, TEST_WS);
  assert.equal(ok, true);
  const fetched = await getExperiment(exp.id, TEST_WS);
  assert.ok(!fetched || fetched._deleted);
  const list = await listExperiments(TEST_WS);
  assert.ok(!list.some((e) => e.id === exp.id));
});

test("deleteExperiment returns false for unknown id", async () => {
  const ok = await deleteExperiment("no-such-experiment", TEST_WS);
  assert.equal(ok, false);
});

// ─── SDK helpers ────────────────────────────────────────────────────────────

test("ExperimentTracker runs a full lifecycle", async () => {
  const tracker = new ExperimentTracker("sdk-tracker-test", {
    workspaceId: TEST_WS,
    runName: "sdk-run-1",
    tags: ["sdk"],
  });
  const { runId, experimentId } = await tracker.start();
  assert.ok(runId);
  assert.ok(experimentId);
  await tracker.logParam("lr", 0.01);
  await tracker.logMetric("loss", 0.9, 0);
  await tracker.logMetric("loss", 0.5, 1);
  await tracker.logArtifact("report", "small-inline-content");
  await tracker.end("completed");

  const run = await tracker.getRun();
  assert.equal(run.status, "completed");
  assert.equal(run.params.lr, 0.01);
  assert.equal(run.metrics.loss.length, 2);
  assert.equal(run.artifacts.length, 1);
});

test("withRun wraps a run and auto-ends on success", async () => {
  const { result, runId } = await withRun(
    "sdk-withrun-test",
    async (tracker) => {
      await tracker.logParam("model", "gpt-4");
      await tracker.logMetric("score", 0.88, 0);
      return 42;
    },
    { workspaceId: TEST_WS }
  );
  assert.equal(result, 42);
  const run = await getRun(runId);
  assert.equal(run.status, "completed");
  assert.equal(run.params.model, "gpt-4");
});

test("withRun marks run as failed on thrown error", async () => {
  let capturedRunId = null;
  await assert.rejects(
    () => withRun(
      "sdk-withrun-fail",
      async (tracker) => {
        capturedRunId = tracker.runId;
        throw new Error("boom");
      },
      { workspaceId: TEST_WS }
    ),
    /boom/
  );
  assert.ok(capturedRunId);
  const run = await getRun(capturedRunId);
  assert.equal(run.status, "failed");
});

// Reset runtime index at end so subsequent test files do not inherit state.
test("cleanup runtime index", () => {
  _resetRuntime();
  assert.ok(true);
});
