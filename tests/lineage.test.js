/**
 * Phase 57.4: Lineage tracking tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "siskel-lineage-"));
process.env.STORAGE_PATH = TMP;

const {
  EVENT_TYPES,
  emitLineage,
  queryLineage,
  getGraph,
  _reset,
} = await import("../lib/lineage.js");

test.after(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

test("EVENT_TYPES includes standard OpenLineage states", () => {
  for (const t of ["START", "COMPLETE", "FAIL", "ABORT"]) {
    assert.ok(EVENT_TYPES.includes(t));
  }
});

test("emitLineage validates required fields", async () => {
  await _reset();
  await assert.rejects(() => emitLineage({}), /job is required/);
  await assert.rejects(() => emitLineage({ job: "j" }), /run is required/);
});

test("emitLineage stores a normalized event", async () => {
  await _reset();
  const rec = await emitLineage({
    eventType: "START",
    job: { namespace: "analytics", name: "daily-rollup" },
    run: { runId: "r-1" },
    inputs: [{ namespace: "raw", name: "events" }],
    outputs: ["daily_aggregate"],
  });
  assert.equal(rec.job.name, "daily-rollup");
  assert.equal(rec.run.runId, "r-1");
  assert.equal(rec.inputs[0].name, "events");
  assert.equal(rec.outputs[0].name, "daily_aggregate");
  assert.equal(rec.eventType, "START");
});

test("queryLineage filters by jobName and runId", async () => {
  await _reset();
  await emitLineage({ job: "a", run: "r1", inputs: ["in1"], outputs: ["out1"] });
  await emitLineage({ job: "b", run: "r2", inputs: ["in2"], outputs: ["out2"] });
  await emitLineage({ job: "a", run: "r3" });
  const byJob = await queryLineage({ jobName: "a" });
  assert.equal(byJob.total, 2);
  const byRun = await queryLineage({ runId: "r2" });
  assert.equal(byRun.total, 1);
});

test("queryLineage filters by datasetName", async () => {
  await _reset();
  await emitLineage({ job: "t", run: "r", inputs: ["foo"], outputs: ["bar"] });
  await emitLineage({ job: "t", run: "r2", inputs: ["baz"], outputs: ["foo"] });
  const foo = await queryLineage({ datasetName: "foo" });
  assert.equal(foo.total, 2);
});

test("queryLineage respects time window", async () => {
  await _reset();
  await emitLineage({ job: "t", run: "r", eventTime: "2020-01-01T00:00:00Z" });
  await emitLineage({ job: "t", run: "r", eventTime: "2021-01-01T00:00:00Z" });
  await emitLineage({ job: "t", run: "r", eventTime: "2022-01-01T00:00:00Z" });
  const mid = await queryLineage({ since: "2020-06-01T00:00:00Z", until: "2021-06-01T00:00:00Z" });
  assert.equal(mid.total, 1);
});

test("emitLineage normalizes unknown eventType to RUNNING", async () => {
  await _reset();
  const rec = await emitLineage({ eventType: "BOGUS", job: "a", run: "b" });
  assert.equal(rec.eventType, "RUNNING");
});

test("getGraph produces nodes + edges from events", async () => {
  await _reset();
  await emitLineage({ job: { name: "clean" }, run: "r1", inputs: ["raw"], outputs: ["clean_data"] });
  await emitLineage({ job: { name: "aggregate" }, run: "r2", inputs: ["clean_data"], outputs: ["report"] });
  const g = await getGraph();
  const jobNodes = g.nodes.filter((n) => n.type === "job");
  const dsNodes = g.nodes.filter((n) => n.type === "dataset");
  assert.ok(jobNodes.some((n) => n.name === "clean"));
  assert.ok(jobNodes.some((n) => n.name === "aggregate"));
  assert.ok(dsNodes.some((n) => n.name === "raw"));
  assert.ok(dsNodes.some((n) => n.name === "clean_data"));
  assert.ok(dsNodes.some((n) => n.name === "report"));
  assert.ok(g.edges.some((e) => e.kind === "input"));
  assert.ok(g.edges.some((e) => e.kind === "output"));
});

test("getGraph with rootDataset filters to upstream ancestry", async () => {
  await _reset();
  await emitLineage({ job: { name: "clean" }, run: "r1", inputs: ["raw"], outputs: ["clean_data"] });
  await emitLineage({ job: { name: "aggregate" }, run: "r2", inputs: ["clean_data"], outputs: ["report"] });
  await emitLineage({ job: { name: "unrelated" }, run: "r3", inputs: ["a"], outputs: ["b"] });
  const g = await getGraph({ rootDataset: "report" });
  const names = g.nodes.map((n) => n.name);
  assert.ok(names.includes("report"));
  assert.ok(names.includes("clean_data"));
  assert.ok(names.includes("raw"));
  assert.ok(!names.includes("a"));
  assert.ok(!names.includes("b"));
});

test("lineage ring-buffer trims old events", async () => {
  await _reset();
  process.env.LINEAGE_MAX_EVENTS = "3";
  for (let i = 0; i < 10; i += 1) {
    await emitLineage({ job: "j", run: `r-${i}` });
  }
  delete process.env.LINEAGE_MAX_EVENTS;
  const q = await queryLineage({});
  assert.equal(q.total, 3);
});
