/**
 * Phase 58.4: Distillation tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-distill-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  createDistillationJob,
  recordTeacherTrace,
  exportTrainingSet,
  jobStatus,
  listJobs,
  setJobStatus,
} = await import("../lib/distillation.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

test("createDistillationJob persists initial state", async () => {
  const job = await createDistillationJob({
    teacher: "gpt-4",
    student: "mini-student",
    taskType: "summarization",
    targetTraces: 10,
  });
  assert.ok(job.id.startsWith("distill-"));
  assert.equal(job.status, "pending");
  assert.equal(job.teacher, "gpt-4");
  assert.equal(job.student, "mini-student");
  assert.equal(job.traceCount, 0);
  assert.equal(job.targetTraces, 10);
  assert.ok(job.createdAt);
});

test("createDistillationJob rejects invalid input", async () => {
  await assert.rejects(() => createDistillationJob(null));
  await assert.rejects(() => createDistillationJob({ teacher: "t" }));
  await assert.rejects(() => createDistillationJob({ student: "s" }));
});

test("recordTeacherTrace appends traces and advances status", async () => {
  const job = await createDistillationJob({
    teacher: "t1",
    student: "s1",
    targetTraces: 3,
  });
  const j1 = await recordTeacherTrace(job.id, { input: "q1", output: "a1" });
  assert.equal(j1.traceCount, 1);
  assert.equal(j1.status, "collecting");
  await recordTeacherTrace(job.id, { input: "q2", output: "a2" });
  const j3 = await recordTeacherTrace(job.id, { input: "q3", output: "a3" });
  assert.equal(j3.traceCount, 3);
  assert.equal(j3.status, "ready");
});

test("recordTeacherTrace rejects invalid trace objects", async () => {
  const job = await createDistillationJob({ teacher: "t", student: "s" });
  await assert.rejects(() => recordTeacherTrace(job.id, null));
  await assert.rejects(() => recordTeacherTrace(job.id, { input: "only input" }));
  await assert.rejects(() => recordTeacherTrace("no-such-job", { input: "a", output: "b" }));
});

test("exportTrainingSet returns JSONL format by default", async () => {
  const job = await createDistillationJob({ teacher: "t", student: "s" });
  await recordTeacherTrace(job.id, {
    input: "Q: capital of France?",
    output: "Paris",
    metadata: { latencyMs: 42 },
  });
  await recordTeacherTrace(job.id, {
    input: "Q: 2+2?",
    output: "4",
  });
  const out = await exportTrainingSet(job.id);
  assert.equal(out.format, "jsonl");
  assert.equal(out.count, 2);
  assert.ok(out.examples[0].prompt.includes("France"));
  assert.equal(out.examples[0].completion, "Paris");
  assert.equal(out.examples[0].meta.latencyMs, 42);
});

test("exportTrainingSet supports messages format and markExported", async () => {
  const job = await createDistillationJob({ teacher: "t", student: "s" });
  await recordTeacherTrace(job.id, { input: "hi", output: "hello" });
  const out = await exportTrainingSet(job.id, { format: "messages", markExported: true });
  assert.equal(out.format, "messages");
  assert.equal(out.examples[0].messages.length, 2);
  assert.equal(out.examples[0].messages[0].role, "user");
  assert.equal(out.examples[0].messages[1].role, "assistant");
  const status = await jobStatus(job.id);
  assert.equal(status.status, "exported");
  assert.ok(status.exportedAt);
});

test("jobStatus returns null for unknown jobs", async () => {
  const none = await jobStatus("nope");
  assert.equal(none, null);
  assert.equal(await jobStatus(""), null);
});

test("listJobs returns all created jobs", async () => {
  const jobs = await listJobs();
  assert.ok(jobs.length >= 3);
  assert.ok(jobs.every((j) => j.id && j.teacher && j.student));
});

test("setJobStatus transitions states", async () => {
  const job = await createDistillationJob({ teacher: "t", student: "s" });
  const archived = await setJobStatus(job.id, "archived");
  assert.equal(archived.status, "archived");
  await assert.rejects(() => setJobStatus(job.id, "bogus"));
  // Recording on archived job should fail.
  await assert.rejects(() => recordTeacherTrace(job.id, { input: "x", output: "y" }));
});

test("exportTrainingSet serializes non-string input/output via JSON", async () => {
  const job = await createDistillationJob({ teacher: "t", student: "s" });
  await recordTeacherTrace(job.id, {
    input: { messages: [{ role: "user", content: "hey" }] },
    output: { tool_calls: [{ name: "x" }] },
  });
  const out = await exportTrainingSet(job.id);
  assert.equal(out.count, 1);
  assert.ok(out.examples[0].prompt.startsWith("{"));
  assert.ok(out.examples[0].completion.startsWith("{"));
});
