/**
 * Phase 57.4: Data lineage tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-lineage-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  recordLineage,
  getLineage,
  findUpstream,
  findDownstream,
  exportGraph,
  clearGraph,
} = await import("../lib/data-lineage.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

/* -------------------------------------------------------------------------- */

test("recordLineage creates nodes and edges", async () => {
  await clearGraph();
  const evt = await recordLineage({
    job: "etl.ingest",
    inputs: ["raw.events"],
    outputs: ["clean.events"],
  });
  assert.ok(evt.id.startsWith("lin_"));
  const g = await exportGraph();
  assert.equal(g.nodeCount, 2);
  assert.equal(g.edgeCount, 1);
});

test("recordLineage rejects invalid input", async () => {
  await assert.rejects(() => recordLineage({}), /job required/);
  await assert.rejects(() => recordLineage({ job: "x" }), /input or output/);
  await assert.rejects(() => recordLineage(null), /required/);
});

test("recordLineage supports multi-input multi-output", async () => {
  await recordLineage({
    job: "etl.join",
    inputs: ["clean.events", "users.dim"],
    outputs: ["enriched.events"],
  });
  const g = await exportGraph();
  // 4 nodes now (raw.events, clean.events, users.dim, enriched.events)
  assert.ok(g.nodeCount >= 4);
  // 2 edges added (clean -> enriched, users -> enriched)
  assert.ok(g.edgeCount >= 3);
});

test("findDownstream returns transitive successors", async () => {
  await recordLineage({
    job: "etl.aggregate",
    inputs: ["enriched.events"],
    outputs: ["daily.metrics"],
  });
  const down = await findDownstream("raw.events");
  const names = down.map((d) => d.node);
  assert.ok(names.includes("clean.events"));
  assert.ok(names.includes("enriched.events"));
  assert.ok(names.includes("daily.metrics"));
});

test("findUpstream returns transitive predecessors", async () => {
  const up = await findUpstream("daily.metrics");
  const names = up.map((d) => d.node);
  assert.ok(names.includes("enriched.events"));
  assert.ok(names.includes("clean.events"));
  assert.ok(names.includes("raw.events"));
});

test("findUpstream / findDownstream return empty for unknown nodes", async () => {
  assert.deepEqual(await findUpstream("missing"), []);
  assert.deepEqual(await findDownstream("missing"), []);
});

test("getLineage returns both directions and node metadata", async () => {
  const l = await getLineage("clean.events");
  assert.ok(l);
  assert.equal(l.node.id, "clean.events");
  assert.ok(l.upstream.some((u) => u.node === "raw.events"));
  assert.ok(l.downstream.some((d) => d.node === "daily.metrics"));
  assert.equal(await getLineage("missing"), null);
});

test("exportGraph returns cytoscape-shaped data", async () => {
  const g = await exportGraph();
  assert.ok(Array.isArray(g.nodes));
  assert.ok(Array.isArray(g.edges));
  assert.ok(g.nodes.every((n) => n.data && typeof n.data.id === "string"));
  assert.ok(g.edges.every((e) => e.data && typeof e.data.source === "string"));
});

test("recordLineage handles a cycle without infinite loops on traversal", async () => {
  // Strictly, data lineage should be acyclic, but defensively we should
  // still terminate if someone records a cycle.
  await recordLineage({
    job: "fake.cycle",
    inputs: ["daily.metrics"],
    outputs: ["raw.events"],
  });
  const down = await findDownstream("raw.events");
  // Traversal should terminate.
  assert.ok(Array.isArray(down));
});

test("recordLineage persists job list on each node", async () => {
  await clearGraph();
  await recordLineage({ job: "job1", inputs: ["a"], outputs: ["b"] });
  await recordLineage({ job: "job2", inputs: ["b"], outputs: ["c"] });
  const g = await exportGraph();
  const bNode = g.nodes.find((n) => n.data.id === "b");
  assert.ok(bNode.data.jobs.includes("job1"));
  assert.ok(bNode.data.jobs.includes("job2"));
});

test("clearGraph empties nodes and edges", async () => {
  await clearGraph();
  const g = await exportGraph();
  assert.equal(g.nodeCount, 0);
  assert.equal(g.edgeCount, 0);
});
