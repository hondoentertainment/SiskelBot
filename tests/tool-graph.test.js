/**
 * Phase 53.2: Tool dependency graph tests.
 *
 * Isolates STORAGE_PATH so cached pipelines do not leak between suites.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-tool-graph-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  ToolGraph,
  inferTypeCompatibility,
  buildPipeline,
  validatePipeline,
  executePipeline,
  extractIoTypes,
  typeMatches,
  coerceTypes,
  graphToMermaid,
  savePipeline,
  getPipeline,
  listPipelines,
} = await import("../lib/tool-graph.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

// ---------- ToolGraph basics ----------

test("ToolGraph.addTool registers a tool", () => {
  const g = new ToolGraph();
  g.addTool({
    name: "search",
    inputs: { query: { type: "string" } },
    outputs: { type: "array", items: { type: "string" } },
  });
  assert.equal(g.size(), 1);
  assert.ok(g.tools.has("search"));
});

test("ToolGraph.addTool throws without name", () => {
  const g = new ToolGraph();
  assert.throws(() => g.addTool({}), /must have a name/);
});

test("ToolGraph.removeTool drops tool and touching edges", () => {
  const g = new ToolGraph();
  g.addTool({ name: "a", inputs: {}, outputs: { type: "string" } });
  g.addTool({ name: "b", inputs: { x: { type: "string" } }, outputs: { type: "number" } });
  g.autoConnect();
  assert.ok(g.hasEdge("a", "b"));
  g.removeTool("a");
  assert.equal(g.size(), 1);
  assert.equal(g.hasEdge("a", "b"), false);
});

// ---------- autoConnect ----------

test("autoConnect creates edges for matching types", () => {
  const g = new ToolGraph();
  g.addTool({ name: "fetch_id", inputs: {}, outputs: { type: "string" } });
  g.addTool({
    name: "load_doc",
    inputs: { id: { type: "string" } },
    outputs: { type: "object" },
  });
  g.addTool({
    name: "summarize",
    inputs: { doc: { type: "object" } },
    outputs: { type: "string" },
  });
  const added = g.autoConnect();
  assert.ok(added >= 2);
  assert.ok(g.hasEdge("fetch_id", "load_doc"));
  assert.ok(g.hasEdge("load_doc", "summarize"));
});

test("hasEdge / getDependencies / getDependents work", () => {
  // Use distinct object formats so cross-type coercion does not introduce
  // unintended edges.
  const g = new ToolGraph();
  g.addTool({ name: "a", inputs: {}, outputs: { type: "object", format: "query" } });
  g.addTool({
    name: "b",
    inputs: { q: { type: "object", format: "query" } },
    outputs: { type: "object", format: "result" },
  });
  g.addTool({
    name: "c",
    inputs: { r: { type: "object", format: "result" } },
    outputs: { type: "object", format: "report" },
  });
  g.autoConnect();
  assert.ok(g.hasEdge("a", "b"));
  assert.ok(g.hasEdge("b", "c"));
  assert.deepEqual(g.getDependencies("c"), ["b"]);
  assert.deepEqual(g.getDependents("a"), ["b"]);
});

// ---------- topoSort ----------

test("topoSort returns a valid ordering", () => {
  const g = new ToolGraph();
  g.addTool({ name: "a", inputs: {}, outputs: { type: "object", format: "query" } });
  g.addTool({
    name: "b",
    inputs: { q: { type: "object", format: "query" } },
    outputs: { type: "object", format: "result" },
  });
  g.addTool({
    name: "c",
    inputs: { r: { type: "object", format: "result" } },
    outputs: { type: "object", format: "report" },
  });
  g.autoConnect();
  const order = g.topoSort();
  assert.equal(order.length, 3);
  assert.ok(order.indexOf("a") < order.indexOf("b"));
  assert.ok(order.indexOf("b") < order.indexOf("c"));
});

test("hasCycle detects a cycle", () => {
  const g = new ToolGraph();
  g.addTool({ name: "x", inputs: { v: { type: "string" } }, outputs: { type: "string" } });
  g.addTool({ name: "y", inputs: { v: { type: "string" } }, outputs: { type: "string" } });
  // Manually force a cycle
  g.addEdge("x", "y");
  g.addEdge("y", "x");
  assert.equal(g.hasCycle(), true);
  assert.throws(() => g.topoSort(), /cycle/);
});

test("hasCycle is false for a DAG", () => {
  const g = new ToolGraph();
  g.addTool({ name: "a", inputs: {}, outputs: { type: "string" } });
  g.addTool({ name: "b", inputs: { q: { type: "string" } }, outputs: { type: "number" } });
  g.autoConnect();
  assert.equal(g.hasCycle(), false);
});

// ---------- inferTypeCompatibility ----------

test("inferTypeCompatibility exact match", () => {
  const c = inferTypeCompatibility({ type: "string" }, { type: "string" });
  assert.equal(c.compatible, true);
  assert.equal(c.conversion, undefined);
});

test("inferTypeCompatibility with string->number coercion", () => {
  const c = inferTypeCompatibility({ type: "string" }, { type: "number" });
  assert.equal(c.compatible, true);
  assert.equal(c.conversion, "string->number");
});

test("inferTypeCompatibility with number->string coercion", () => {
  const c = inferTypeCompatibility({ type: "number" }, { type: "string" });
  assert.equal(c.compatible, true);
  assert.equal(c.conversion, "number->string");
});

test("inferTypeCompatibility array to item", () => {
  const c = inferTypeCompatibility(
    { type: "array", items: { type: "string" } },
    { type: "string" },
  );
  assert.equal(c.compatible, true);
  assert.match(c.conversion, /array-first/);
});

test("inferTypeCompatibility rejects object->number", () => {
  const c = inferTypeCompatibility({ type: "object" }, { type: "number" });
  assert.equal(c.compatible, false);
});

test("typeMatches respects formats", () => {
  assert.equal(
    typeMatches({ type: "string", format: "uuid" }, { type: "string", format: "uuid" }),
    true,
  );
  assert.equal(
    typeMatches({ type: "string", format: "uuid" }, { type: "string", format: "email" }),
    false,
  );
});

test("coerceTypes converts values per conversion", () => {
  assert.equal(coerceTypes("42", { type: "string" }, { type: "number" }), 42);
  assert.equal(coerceTypes(3.14, { type: "number" }, { type: "string" }), "3.14");
  assert.equal(coerceTypes(["a", "b"], { type: "array", items: { type: "string" } }, { type: "string" }), "a");
});

// ---------- buildPipeline ----------

test("buildPipeline finds the shortest chain", () => {
  // Use distinct object formats so each step can only feed the next,
  // forcing the BFS to take the long path.
  const tools = [
    { name: "start", inputs: {}, outputs: { type: "object", format: "query" } },
    {
      name: "to_mid",
      inputs: { q: { type: "object", format: "query" } },
      outputs: { type: "object", format: "mid" },
    },
    {
      name: "to_final",
      inputs: { m: { type: "object", format: "mid" } },
      outputs: { type: "object", format: "final" },
    },
  ];
  const chain = buildPipeline({ type: "object", format: "final" }, tools);
  assert.ok(chain);
  assert.deepEqual(chain, ["start", "to_mid", "to_final"]);
});

test("buildPipeline returns null when goal is unreachable", () => {
  const tools = [
    { name: "a", inputs: {}, outputs: { type: "string" } },
    { name: "b", inputs: { s: { type: "string" } }, outputs: { type: "number" } },
  ];
  const chain = buildPipeline({ type: "object", format: "dataset" }, tools);
  // number cannot be coerced into an object
  assert.equal(chain, null);
});

test("buildPipeline with single tool satisfying goal", () => {
  const tools = [{ name: "only", inputs: {}, outputs: { type: "string" } }];
  const chain = buildPipeline({ type: "string" }, tools);
  assert.deepEqual(chain, ["only"]);
});

// ---------- validatePipeline ----------

test("validatePipeline accepts a valid chain", () => {
  const g = new ToolGraph();
  g.addTool({ name: "a", inputs: {}, outputs: { type: "string" } });
  g.addTool({ name: "b", inputs: { s: { type: "string" } }, outputs: { type: "number" } });
  g.autoConnect();
  const result = validatePipeline(["a", "b"], g);
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test("validatePipeline rejects an incompatible chain", () => {
  const g = new ToolGraph();
  g.addTool({ name: "a", inputs: {}, outputs: { type: "object", format: "dataset" } });
  g.addTool({ name: "b", inputs: { n: { type: "number" } }, outputs: { type: "boolean" } });
  const result = validatePipeline(["a", "b"], g);
  assert.equal(result.valid, false);
  assert.ok(result.errors.length > 0);
});

test("validatePipeline detects duplicate tool usage", () => {
  const g = new ToolGraph();
  g.addTool({ name: "a", inputs: { s: { type: "string" } }, outputs: { type: "string" } });
  const result = validatePipeline(["a", "a"], g);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /cycle/.test(e)));
});

// ---------- executePipeline ----------

test("executePipeline runs all steps in order", async () => {
  const pipeline = ["upper", "length"];
  const executor = async (tool, input) => {
    if (tool === "upper") return String(input).toUpperCase();
    if (tool === "length") return String(input).length;
    throw new Error("unknown tool");
  };
  const { output, steps } = await executePipeline(pipeline, "hello", executor);
  assert.equal(output, 5);
  assert.equal(steps.length, 2);
  assert.equal(steps[0].tool, "upper");
  assert.equal(steps[0].output, "HELLO");
  assert.equal(steps[1].output, 5);
});

test("executePipeline records durations", async () => {
  const executor = async (_tool, input) => {
    await new Promise((r) => setTimeout(r, 5));
    return input;
  };
  const { steps } = await executePipeline(["a", "b"], "x", executor);
  assert.equal(steps.length, 2);
  for (const s of steps) {
    assert.ok(typeof s.durationMs === "number");
    assert.ok(s.durationMs >= 0);
  }
});

test("executePipeline handles empty pipeline", async () => {
  const result = await executePipeline([], "hello", async () => "x");
  assert.equal(result.output, "hello");
  assert.deepEqual(result.steps, []);
});

// ---------- extractIoTypes ----------

test("extractIoTypes parses OpenAI-style schema", () => {
  const schema = {
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer" },
      },
    },
    returns: { type: "array", items: { type: "string" } },
  };
  const { inputs, outputs } = extractIoTypes(schema);
  assert.deepEqual(inputs.query, { type: "string" });
  assert.deepEqual(inputs.limit, { type: "integer" });
  assert.equal(outputs.type, "array");
  assert.deepEqual(outputs.items, { type: "string" });
});

test("extractIoTypes handles normalized schema", () => {
  const schema = {
    inputs: { a: { type: "number" } },
    outputs: { type: "boolean" },
  };
  const { inputs, outputs } = extractIoTypes(schema);
  assert.deepEqual(inputs.a, { type: "number" });
  assert.deepEqual(outputs, { type: "boolean" });
});

// ---------- persistence ----------

test("savePipeline / getPipeline / listPipelines roundtrip", async () => {
  const g = new ToolGraph();
  g.addTool({ name: "a", inputs: {}, outputs: { type: "string" } });
  g.addTool({ name: "b", inputs: { s: { type: "string" } }, outputs: { type: "number" } });
  g.autoConnect();

  await savePipeline("my-pipe", ["a", "b"], g);
  const fetched = await getPipeline("my-pipe");
  assert.ok(fetched);
  assert.equal(fetched.name, "my-pipe");
  assert.deepEqual(fetched.pipeline, ["a", "b"]);
  assert.ok(fetched.graph);
  assert.equal(fetched.graph.tools.length, 2);

  const all = await listPipelines();
  assert.ok(all.some((p) => p.name === "my-pipe"));
});

// ---------- edge cases ----------

test("empty graph handled by topoSort", () => {
  const g = new ToolGraph();
  assert.deepEqual(g.topoSort(), []);
  assert.equal(g.hasCycle(), false);
});

test("circular deps rejected by addEdge type check", () => {
  const g = new ToolGraph();
  g.addTool({ name: "a", inputs: {}, outputs: { type: "string" } });
  g.addTool({ name: "b", inputs: { s: { type: "string" } }, outputs: { type: "number" } });
  // add an incompatible edge: number -> object without coercion
  g.addTool({ name: "c", inputs: { o: { type: "object", format: "dataset" } }, outputs: { type: "string" } });
  assert.throws(() => g.addEdge("b", "c"), /no compatible input|incompatible/);
});

test("graphToMermaid emits flowchart syntax", () => {
  const g = new ToolGraph();
  g.addTool({ name: "one", inputs: {}, outputs: { type: "string" } });
  g.addTool({ name: "two", inputs: { s: { type: "string" } }, outputs: { type: "number" } });
  g.autoConnect();
  const mermaid = graphToMermaid(g);
  assert.match(mermaid, /graph LR/);
  assert.match(mermaid, /one/);
  assert.match(mermaid, /two/);
  assert.match(mermaid, /-->/);
});
