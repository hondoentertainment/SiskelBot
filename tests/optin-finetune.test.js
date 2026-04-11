/**
 * Phase 69.5: Opt-in fine-tune tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-ft-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  recordConsent,
  startFineTuneJob,
  getJobStatus,
  listJobs,
  revokeConsent,
  advanceJob,
} = await import("../lib/optin-finetune.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

test("recordConsent persists a consent record", async () => {
  const rec = await recordConsent("u1", { terms: "I agree", scope: ["train"] });
  assert.equal(rec.userId, "u1");
  assert.equal(rec.granted, true);
  assert.ok(rec.grantedAt);
});

test("recordConsent rejects invalid input", async () => {
  await assert.rejects(() => recordConsent("", { terms: "x" }));
  await assert.rejects(() => recordConsent("u", null));
  await assert.rejects(() => recordConsent("u", { terms: 0 }));
});

test("startFineTuneJob requires valid consent", async () => {
  await assert.rejects(() => startFineTuneJob("no-consent", { baseModel: "m", datasetId: "d" }));
});

test("startFineTuneJob queues a job when consented", async () => {
  await recordConsent("u2", { terms: "yes" });
  const job = await startFineTuneJob("u2", { baseModel: "llama-7b", datasetId: "ds1" });
  assert.equal(job.status, "queued");
  assert.equal(job.userId, "u2");
  assert.equal(job.baseModel, "llama-7b");
});

test("startFineTuneJob validates input", async () => {
  await recordConsent("u3", { terms: "yes" });
  await assert.rejects(() => startFineTuneJob("", { baseModel: "a", datasetId: "b" }));
  await assert.rejects(() => startFineTuneJob("u3", null));
  await assert.rejects(() => startFineTuneJob("u3", { baseModel: "", datasetId: "b" }));
  await assert.rejects(() => startFineTuneJob("u3", { baseModel: "a", datasetId: "" }));
});

test("getJobStatus retrieves a job", async () => {
  await recordConsent("u4", { terms: "ok" });
  const job = await startFineTuneJob("u4", { baseModel: "m", datasetId: "d" });
  const status = await getJobStatus(job.id);
  assert.ok(status);
  assert.equal(status.id, job.id);
  assert.equal(await getJobStatus("nope"), null);
});

test("listJobs filters by user and status", async () => {
  await recordConsent("ua", { terms: "ok" });
  await recordConsent("ub", { terms: "ok" });
  await startFineTuneJob("ua", { baseModel: "m", datasetId: "d" });
  await startFineTuneJob("ub", { baseModel: "m", datasetId: "d" });
  const aJobs = await listJobs({ userId: "ua" });
  assert.ok(aJobs.every((j) => j.userId === "ua"));
  const queued = await listJobs({ status: "queued" });
  assert.ok(queued.every((j) => j.status === "queued"));
});

test("revokeConsent cancels queued jobs", async () => {
  await recordConsent("u5", { terms: "ok" });
  const job = await startFineTuneJob("u5", { baseModel: "m", datasetId: "d" });
  const r = await revokeConsent("u5");
  assert.equal(r.granted, false);
  assert.ok(r.cancelled >= 1);
  const status = await getJobStatus(job.id);
  assert.equal(status.status, "cancelled");
});

test("revokeConsent on fresh user still produces a record", async () => {
  const r = await revokeConsent("fresh-user");
  assert.equal(r.granted, false);
});

test("advanceJob transitions status", async () => {
  await recordConsent("u6", { terms: "ok" });
  const job = await startFineTuneJob("u6", { baseModel: "m", datasetId: "d" });
  const running = await advanceJob(job.id, "running", { progress: 0.5 });
  assert.equal(running.status, "running");
  assert.equal(running.progress, 0.5);
  const done = await advanceJob(job.id, "completed", { progress: 1 });
  assert.equal(done.status, "completed");
});

test("advanceJob rejects invalid state", async () => {
  await assert.rejects(() => advanceJob("nope", "running"));
  await recordConsent("u7", { terms: "ok" });
  const job = await startFineTuneJob("u7", { baseModel: "m", datasetId: "d" });
  await assert.rejects(() => advanceJob(job.id, "bogus"));
});
