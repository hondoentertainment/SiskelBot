/**
 * Phase 53.2: Tool dependency graph tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-tdg-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  buildGraphFromTools,
  topoSort,
  findCycles,
  matchTypes,
  suggestPipeline,
  validatePipeline,
  saveGraph,
  loadGraph,
  listGraphs,
} = await import("../lib/tool-dep-graph.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

/* -------------------------------------------------------------------------- */
/* matchTypes                                                                 */
/* -------------------------------------------------------------------------- */

test("matchTypes returns 1 for identical object schemas", () => {
  const s = {
    type: "object",
    properties: { id: { type: "string" }, count: { type: "integer" } },
    required: ["id", "count"],
  };
  const score = matchTypes(s, s);
  assert.ok(score >= 0.9);
});

test("matchTypes returns 0 for incompatible scalar types", () => {
  assert.equal(matchTypes({ type: "string" }, { type: "boolean" }), 0);
});

test("matchTypes allows integer <-> number interchange", () => {
  const score = matchTypes({ type: "integer" }, { type: "number" });
  assert.ok(score > 0);
});

test("matchTypes handles arrays structurally", () => {
  const src = { type: "array", items: { type: "string" } };
  const dst = { type: "array", items: { type: "string" } };
  assert.ok(matchTypes(src, dst) >= 0.5);
});

test("matchTypes handles missing schemas", () => {
  assert.equal(matchTypes(null, { type: "string" }), 0);
  assert.equal(matchTypes({ type: "string" }, null), 0);
});

/* -------------------------------------------------------------------------- */
/* buildGraphFromTools                                                        */
/* -------------------------------------------------------------------------- */

function sampleTools() {
  return [
    {
      name: "fetch_url",
      input: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
      output: { type: "object", properties: { body: { type: "string" } }, required: ["body"] },
    },
    {
      name: "extract_title",
      input: { type: "object", properties: { body: { type: "string" } }, required: ["body"] },
      output: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
    },
    {
      name: "summarize",
      input: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
      output: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] },
    },
    {
      name: "unrelated",
      input: { type: "object", properties: { n: { type: "integer" } }, required: ["n"] },
      output: { type: "object", properties: { double: { type: "integer" } }, required: ["double"] },
    },
  ];
}

test("buildGraphFromTools produces edges for matching schemas", () => {
  const g = buildGraphFromTools(sampleTools());
  assert.ok(g.nodes.fetch_url);
  assert.ok(g.edges.fetch_url.some((e) => e.to === "extract_title"));
  assert.ok(g.edges.extract_title.some((e) => e.to === "summarize"));
  // unrelated should have no incoming edges from fetch_url
  assert.ok(!g.edges.fetch_url.some((e) => e.to === "unrelated"));
});

test("buildGraphFromTools handles invalid input gracefully", () => {
  const g = buildGraphFromTools(null);
  assert.deepEqual(g.nodes, {});
});

/* -------------------------------------------------------------------------- */
/* topoSort                                                                   */
/* -------------------------------------------------------------------------- */

test("topoSort orders a linear graph correctly", () => {
  const g = buildGraphFromTools(sampleTools());
  const { order, cyclic } = topoSort(g);
  assert.deepEqual(cyclic, []);
  const i1 = order.indexOf("fetch_url");
  const i2 = order.indexOf("extract_title");
  const i3 = order.indexOf("summarize");
  assert.ok(i1 < i2);
  assert.ok(i2 < i3);
});

test("topoSort reports cyclic nodes", () => {
  /** @type {any} */
  const g = {
    nodes: {
      a: { name: "a" },
      b: { name: "b" },
    },
    edges: {
      a: [{ to: "b", score: 1, reason: "" }],
      b: [{ to: "a", score: 1, reason: "" }],
    },
  };
  const { order, cyclic } = topoSort(g);
  assert.deepEqual(order, []);
  assert.ok(cyclic.includes("a"));
  assert.ok(cyclic.includes("b"));
});

test("topoSort rejects missing graph", () => {
  assert.throws(() => topoSort(null));
});

/* -------------------------------------------------------------------------- */
/* findCycles                                                                 */
/* -------------------------------------------------------------------------- */

test("findCycles detects a simple 2-cycle", () => {
  /** @type {any} */
  const g = {
    nodes: { a: {}, b: {} },
    edges: {
      a: [{ to: "b", score: 1, reason: "" }],
      b: [{ to: "a", score: 1, reason: "" }],
    },
  };
  const cycles = findCycles(g);
  assert.ok(cycles.length >= 1);
});

test("findCycles returns empty on a DAG", () => {
  const g = buildGraphFromTools(sampleTools());
  const cycles = findCycles(g);
  assert.deepEqual(cycles, []);
});

/* -------------------------------------------------------------------------- */
/* suggestPipeline                                                            */
/* -------------------------------------------------------------------------- */

test("suggestPipeline finds a shortest path", () => {
  const g = buildGraphFromTools(sampleTools());
  const path = suggestPipeline(g, "fetch_url", "summarize");
  assert.deepEqual(path, ["fetch_url", "extract_title", "summarize"]);
});

test("suggestPipeline returns null when disconnected", () => {
  const g = buildGraphFromTools(sampleTools());
  const path = suggestPipeline(g, "fetch_url", "unrelated");
  assert.equal(path, null);
});

test("suggestPipeline returns single-node path for from===to", () => {
  const g = buildGraphFromTools(sampleTools());
  assert.deepEqual(suggestPipeline(g, "fetch_url", "fetch_url"), ["fetch_url"]);
});

test("suggestPipeline rejects unknown tools", () => {
  const g = buildGraphFromTools(sampleTools());
  assert.equal(suggestPipeline(g, "missing", "summarize"), null);
});

/* -------------------------------------------------------------------------- */
/* validatePipeline                                                           */
/* -------------------------------------------------------------------------- */

test("validatePipeline accepts a well-formed pipeline", () => {
  const g = buildGraphFromTools(sampleTools());
  const v = validatePipeline(g, ["fetch_url", "extract_title", "summarize"]);
  assert.equal(v.ok, true);
  assert.equal(v.issues.length, 0);
  assert.ok(v.score > 0);
});

test("validatePipeline rejects bad edges", () => {
  const g = buildGraphFromTools(sampleTools());
  const v = validatePipeline(g, ["fetch_url", "unrelated"]);
  assert.equal(v.ok, false);
  assert.ok(v.issues.some((i) => i.includes("no edge")));
});

test("validatePipeline rejects empty input", () => {
  const g = buildGraphFromTools(sampleTools());
  const v = validatePipeline(g, []);
  assert.equal(v.ok, false);
});

/* -------------------------------------------------------------------------- */
/* Persistence                                                                */
/* -------------------------------------------------------------------------- */

test("saveGraph / loadGraph round-trip", async () => {
  const g = buildGraphFromTools(sampleTools());
  await saveGraph("main", g);
  const loaded = await loadGraph("main");
  assert.ok(loaded);
  assert.deepEqual(Object.keys(loaded.nodes).sort(), Object.keys(g.nodes).sort());
  const names = await listGraphs();
  assert.ok(names.includes("main"));
});

test("saveGraph rejects missing arguments", async () => {
  await assert.rejects(() => saveGraph("", {}));
  await assert.rejects(() => saveGraph("x", null));
});
