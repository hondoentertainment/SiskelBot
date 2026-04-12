/**
 * Phase 57.1: DAG pipeline tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "siskel-dag-"));
process.env.STORAGE_PATH = TMP;

const {
  NODE_STATUS,
  RUN_STATUS,
  registerTask,
  listTasks,
  createPipeline,
  getPipeline,
  listPipelines,
  deletePipeline,
  runPipeline,
  getRunStatus,
  _resetRegistry,
  _internals,
} = await import("../lib/dag-pipeline.js");

test.after(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

// ─── Task registry ─────────────────────────────────────────────────────────

test("registerTask stores a task and listTasks returns it", () => {
  _resetRegistry();
  registerTask("echo", async (ctx) => ctx.params);
  assert.ok(listTasks().includes("echo"));
});

test("registerTask rejects invalid input", () => {
  assert.throws(() => registerTask("", () => {}), /name required/);
  assert.throws(() => registerTask("x", null), /fn must be/);
});

// ─── Pipeline CRUD ─────────────────────────────────────────────────────────

test("createPipeline validates required fields", async () => {
  _resetRegistry();
  registerTask("noop", async () => null);
  await assert.rejects(() => createPipeline({}), /name is required/);
  await assert.rejects(() => createPipeline({ name: "p" }), /at least one node/);
});

test("createPipeline persists nodes and deps", async () => {
  _resetRegistry();
  registerTask("noop", async () => null);
  const p = await createPipeline({
    name: "test",
    nodes: [
      { id: "a", task: "noop" },
      { id: "b", task: "noop", deps: ["a"] },
    ],
  });
  assert.ok(p.id);
  const fetched = await getPipeline(p.id);
  assert.equal(fetched.nodes.length, 2);
  assert.deepEqual(fetched.nodes[1].deps, ["a"]);
});

test("createPipeline rejects unknown dep", async () => {
  _resetRegistry();
  registerTask("noop", async () => null);
  await assert.rejects(
    () => createPipeline({ name: "bad", nodes: [{ id: "a", task: "noop", deps: ["ghost"] }] }),
    /unknown node/,
  );
});

test("createPipeline rejects cycles", async () => {
  _resetRegistry();
  registerTask("noop", async () => null);
  await assert.rejects(
    () => createPipeline({
      name: "cycle",
      nodes: [
        { id: "a", task: "noop", deps: ["b"] },
        { id: "b", task: "noop", deps: ["a"] },
      ],
    }),
    /cycle detected/,
  );
});

test("topologicalLevels groups parallel-safe nodes", () => {
  const nodes = [
    { id: "a", task: "t", deps: [] },
    { id: "b", task: "t", deps: [] },
    { id: "c", task: "t", deps: ["a", "b"] },
  ];
  const levels = _internals.topologicalLevels(nodes);
  assert.equal(levels.length, 2);
  assert.deepEqual(levels[0].sort(), ["a", "b"]);
  assert.deepEqual(levels[1], ["c"]);
});

// ─── Runs ──────────────────────────────────────────────────────────────────

test("runPipeline executes nodes in dependency order", async () => {
  _resetRegistry();
  const order = [];
  registerTask("record", async (ctx) => { order.push(ctx.nodeId); return ctx.nodeId; });
  const p = await createPipeline({
    name: "order-test",
    nodes: [
      { id: "a", task: "record" },
      { id: "b", task: "record", deps: ["a"] },
      { id: "c", task: "record", deps: ["b"] },
    ],
  });
  const run = await runPipeline(p.id);
  assert.equal(run.status, RUN_STATUS.SUCCEEDED);
  assert.deepEqual(order, ["a", "b", "c"]);
});

test("runPipeline retries a failing node up to 'retries' times", async () => {
  _resetRegistry();
  let attempts = 0;
  registerTask("flaky", async () => {
    attempts += 1;
    if (attempts < 3) throw new Error("boom");
    return "ok";
  });
  const p = await createPipeline({
    name: "retry-test",
    nodes: [{ id: "x", task: "flaky", retries: 3 }],
  });
  const run = await runPipeline(p.id);
  assert.equal(run.status, RUN_STATUS.SUCCEEDED);
  assert.equal(run.nodes.x.attempts, 3);
  assert.equal(run.nodes.x.status, NODE_STATUS.SUCCEEDED);
});

test("runPipeline enforces per-node timeout", async () => {
  _resetRegistry();
  registerTask("slow", async () => new Promise((resolve) => setTimeout(resolve, 500)));
  const p = await createPipeline({
    name: "timeout-test",
    nodes: [{ id: "slow", task: "slow", timeoutMs: 30 }],
  });
  const run = await runPipeline(p.id);
  assert.equal(run.status, RUN_STATUS.FAILED);
  assert.equal(run.nodes.slow.status, NODE_STATUS.FAILED);
  assert.match(run.nodes.slow.error, /timed out/);
});

test("runPipeline marks downstream as SKIPPED when upstream fails", async () => {
  _resetRegistry();
  registerTask("fail", async () => { throw new Error("nope"); });
  registerTask("noop", async () => "ok");
  const p = await createPipeline({
    name: "skip-test",
    nodes: [
      { id: "a", task: "fail" },
      { id: "b", task: "noop", deps: ["a"] },
    ],
  });
  const run = await runPipeline(p.id);
  assert.equal(run.nodes.a.status, NODE_STATUS.FAILED);
  assert.equal(run.nodes.b.status, NODE_STATUS.SKIPPED);
  assert.equal(run.status, RUN_STATUS.FAILED);
});

test("getRunStatus returns stored run state", async () => {
  _resetRegistry();
  registerTask("noop", async () => "ok");
  const p = await createPipeline({ name: "get-run", nodes: [{ id: "a", task: "noop" }] });
  const run = await runPipeline(p.id);
  const fetched = await getRunStatus(run.runId);
  assert.equal(fetched.runId, run.runId);
  assert.equal(fetched.nodes.a.status, NODE_STATUS.SUCCEEDED);
});

test("listPipelines returns created pipelines", async () => {
  _resetRegistry();
  registerTask("noop", async () => "ok");
  await createPipeline({ name: "one", nodes: [{ id: "a", task: "noop" }] });
  await createPipeline({ name: "two", nodes: [{ id: "a", task: "noop" }] });
  const list = await listPipelines();
  assert.ok(list.length >= 2);
});

test("deletePipeline removes a pipeline", async () => {
  _resetRegistry();
  registerTask("noop", async () => "ok");
  const p = await createPipeline({ name: "delete-me", nodes: [{ id: "a", task: "noop" }] });
  const r = await deletePipeline(p.id);
  assert.equal(r.ok, true);
  const fetched = await getPipeline(p.id);
  assert.equal(fetched, null);
});
