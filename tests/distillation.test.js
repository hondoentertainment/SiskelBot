/**
 * Phase 58.4: Model distillation tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "siskel-distill-"));
process.env.STORAGE_PATH = TMP;

const {
  RUN_STATUS,
  startDistillation,
  recordPair,
  finalizeDataset,
  promoteStudent,
  cancelRun,
  getRun,
  getDataset,
  listRuns,
  _reset,
} = await import("../lib/distillation.js");

test.after(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

test("RUN_STATUS exposes expected states", () => {
  for (const s of ["collecting", "finalizing", "ready_to_promote", "promoted", "rejected", "canceled"]) {
    assert.ok(Object.values(RUN_STATUS).includes(s));
  }
});

test("startDistillation validates required fields", async () => {
  await _reset();
  await assert.rejects(() => startDistillation({}), /teacherModel is required/);
  await assert.rejects(() => startDistillation({ teacherModel: "t" }), /studentModel is required/);
});

test("startDistillation creates a run in COLLECTING state", async () => {
  await _reset();
  const run = await startDistillation({ teacherModel: "gpt-4", studentModel: "mini-1" });
  assert.ok(run.runId);
  assert.equal(run.status, RUN_STATUS.COLLECTING);
  assert.equal(run.pairCount, 0);
});

test("recordPair requires input and teacherOutput", async () => {
  await _reset();
  const run = await startDistillation({ teacherModel: "t", studentModel: "s" });
  await assert.rejects(() => recordPair(run.runId, {}), /requires input/);
});

test("recordPair appends to dataset and bumps pairCount", async () => {
  await _reset();
  const run = await startDistillation({ teacherModel: "t", studentModel: "s" });
  await recordPair(run.runId, { input: "hello", teacherOutput: "world" });
  await recordPair(run.runId, { input: "foo", teacherOutput: "bar" });
  const updated = await getRun(run.runId);
  assert.equal(updated.pairCount, 2);
  const ds = await getDataset(run.runId);
  assert.equal(ds.pairs.length, 2);
  assert.equal(ds.pairs[0].teacherOutput, "world");
});

test("recordPair rejects after finalization", async () => {
  await _reset();
  const run = await startDistillation({ teacherModel: "t", studentModel: "s" });
  await recordPair(run.runId, { input: "a", teacherOutput: "b" });
  await finalizeDataset(run.runId);
  await assert.rejects(
    () => recordPair(run.runId, { input: "c", teacherOutput: "d" }),
    /cannot record pair/,
  );
});

test("finalizeDataset without eval leaves run in FINALIZING", async () => {
  await _reset();
  const run = await startDistillation({ teacherModel: "t", studentModel: "s" });
  const fin = await finalizeDataset(run.runId);
  assert.equal(fin.status, RUN_STATUS.FINALIZING);
});

test("finalizeDataset with passing eval emits a promotion event", async () => {
  await _reset();
  const run = await startDistillation({
    teacherModel: "t",
    studentModel: "s",
    evalThresholds: { minAccuracy: 0.8 },
  });
  const fin = await finalizeDataset(run.runId, { accuracy: 0.9 });
  assert.equal(fin.status, RUN_STATUS.READY_TO_PROMOTE);
  assert.ok(fin.history.some((h) => h.type === "promotion_event"));
});

test("finalizeDataset rejects when eval fails", async () => {
  await _reset();
  const run = await startDistillation({
    teacherModel: "t",
    studentModel: "s",
    evalThresholds: { minAccuracy: 0.8 },
  });
  const fin = await finalizeDataset(run.runId, { accuracy: 0.5 });
  assert.equal(fin.status, RUN_STATUS.REJECTED);
});

test("promoteStudent transitions READY_TO_PROMOTE → PROMOTED", async () => {
  await _reset();
  const run = await startDistillation({
    teacherModel: "t",
    studentModel: "s",
    evalThresholds: { minAccuracy: 0.8 },
  });
  await finalizeDataset(run.runId, { accuracy: 0.9 });
  const promoted = await promoteStudent(run.runId);
  assert.equal(promoted.status, RUN_STATUS.PROMOTED);
  assert.ok(promoted.promotedAt);
});

test("promoteStudent rejects from COLLECTING state", async () => {
  await _reset();
  const run = await startDistillation({ teacherModel: "t", studentModel: "s" });
  await assert.rejects(() => promoteStudent(run.runId), /cannot promote/);
});

test("cancelRun transitions to CANCELED unless promoted", async () => {
  await _reset();
  const run = await startDistillation({ teacherModel: "t", studentModel: "s" });
  const cancelled = await cancelRun(run.runId);
  assert.equal(cancelled.status, RUN_STATUS.CANCELED);
});

test("listRuns returns all runs", async () => {
  await _reset();
  await startDistillation({ teacherModel: "t", studentModel: "s" });
  await startDistillation({ teacherModel: "u", studentModel: "v" });
  const runs = await listRuns();
  assert.ok(runs.length >= 2);
});
