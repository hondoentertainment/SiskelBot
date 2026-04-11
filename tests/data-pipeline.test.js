/**
 * Phase 57.1: DAG pipeline engine tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-pipeline-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  createPipeline,
  runPipeline,
  getPipelineStatus,
  cancelRun,
  listRuns,
  listPipelines,
  registerHandler,
} = await import("../lib/data-pipeline.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

/* -------------------------------------------------------------------------- */

test("createPipeline persists tasks and computes defaults", async () => {
  const p = await createPipeline({
    name: "simple",
    tasks: [
      { id: "a", type: "noop" },
      { id: "b", type: "noop", deps: ["a"] },
    ],
  });
  assert.ok(p.id.startsWith("pl_"));
  assert.equal(p.tasks.length, 2);
  const list = await listPipelines();
  assert.ok(list.some((x) => x.id === p.id));
});

test("createPipeline rejects duplicate ids", async () => {
  await assert.rejects(() => createPipeline({
    tasks: [{ id: "dup" }, { id: "dup" }],
  }), /duplicate/);
});

test("createPipeline rejects cycles", async () => {
  await assert.rejects(() => createPipeline({
    tasks: [
      { id: "a", deps: ["b"] },
      { id: "b", deps: ["a"] },
    ],
  }), /cycle/);
});

test("createPipeline rejects unknown deps", async () => {
  await assert.rejects(() => createPipeline({
    tasks: [{ id: "a", deps: ["missing"] }],
  }), /unknown dep/);
});

test("runPipeline executes tasks in topological order", async () => {
  const order = [];
  registerHandler("record", async (input, ctx) => {
    order.push(input.params.id);
    return input.params.id;
  });
  const p = await createPipeline({
    tasks: [
      { id: "c", type: "record", params: { id: "c" }, deps: ["a", "b"] },
      { id: "a", type: "record", params: { id: "a" } },
      { id: "b", type: "record", params: { id: "b" }, deps: ["a"] },
    ],
  });
  const run = await runPipeline(p.id);
  assert.equal(run.status, "success");
  // a must run first, c must run last; b between a and c
  assert.equal(order[0], "a");
  assert.equal(order[order.length - 1], "c");
  assert.ok(order.indexOf("b") > order.indexOf("a"));
  assert.ok(order.indexOf("c") > order.indexOf("b"));
});

test("runPipeline passes upstream results to downstream tasks", async () => {
  const p = await createPipeline({
    tasks: [
      { id: "x", type: "noop", params: { value: 5 } },
      { id: "y", type: "noop", params: { value: 7 } },
      { id: "total", type: "sum", deps: ["x", "y"] },
    ],
  });
  // Need deterministic identity: override noop with a function that returns params.value
  registerHandler("noop", async (input) => input.params?.value ?? null);
  const run = await runPipeline(p.id);
  assert.equal(run.status, "success");
  assert.equal(run.results.total, 12);
});

test("runPipeline marks failed on handler error and stops", async () => {
  const p = await createPipeline({
    tasks: [
      { id: "ok", type: "identity", params: { value: "hi" } },
      { id: "boom", type: "fail", deps: ["ok"] },
      { id: "unreached", type: "identity", deps: ["boom"] },
    ],
  });
  const run = await runPipeline(p.id);
  assert.equal(run.status, "failed");
  const failed = run.taskRuns.find((t) => t.id === "boom");
  assert.ok(failed);
  assert.equal(failed.status, "failed");
  const unreached = run.taskRuns.find((t) => t.id === "unreached");
  assert.equal(unreached, undefined);
  assert.match(run.error, /fail/);
});

test("retries kick in before a task is marked failed", async () => {
  let attempts = 0;
  registerHandler("flaky", async () => {
    attempts += 1;
    if (attempts < 3) throw new Error("not yet");
    return "ok";
  });
  const p = await createPipeline({
    tasks: [{ id: "r", type: "flaky", retries: 3 }],
  });
  const run = await runPipeline(p.id);
  assert.equal(run.status, "success");
  assert.equal(attempts, 3);
  const tr = run.taskRuns.find((t) => t.id === "r");
  assert.equal(tr.attempt, 2);
});

test("task timeouts are enforced", async () => {
  registerHandler("slow", () => new Promise((res) => setTimeout(() => res("late"), 500)));
  const p = await createPipeline({
    tasks: [{ id: "s", type: "slow", timeoutMs: 50 }],
  });
  const run = await runPipeline(p.id);
  assert.equal(run.status, "failed");
  assert.match(run.error, /timed out/);
});

test("getPipelineStatus fetches persisted runs", async () => {
  const p = await createPipeline({
    tasks: [{ id: "q", type: "identity" }],
  });
  const run = await runPipeline(p.id);
  const fetched = await getPipelineStatus(run.id);
  assert.equal(fetched.id, run.id);
  assert.equal(fetched.status, "success");
  assert.equal(await getPipelineStatus("missing"), null);
});

test("listRuns supports pipeline filtering", async () => {
  const all = await listRuns();
  assert.ok(all.length >= 1);
  const p = await createPipeline({ tasks: [{ id: "t", type: "identity" }] });
  await runPipeline(p.id);
  const filtered = await listRuns(p.id);
  assert.ok(filtered.every((r) => r.pipelineId === p.id));
  assert.ok(filtered.length >= 1);
});

test("cancelRun marks run as cancelling", async () => {
  const p = await createPipeline({ tasks: [{ id: "x", type: "identity" }] });
  const run = await runPipeline(p.id);
  // After it finished we still get a record back (no-op cancel)
  const cancelled = await cancelRun(run.id);
  assert.ok(cancelled);
  // cancelling a non-existent run returns null
  const none = await cancelRun("nope");
  assert.equal(none, null);
});
