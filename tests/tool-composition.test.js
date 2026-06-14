/**
 * Phase 53.4: Tool composition tests.
 *
 * Covers the ToolComposer registry, schema-driven pipeline inference,
 * sequential / parallel / conditional composers, retry wrapper, validation,
 * and persistent save/load of macros via json-path-store.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Use an isolated STORAGE_PATH so persisted macros do not pollute the project
// data directory and do not leak between suites.
const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-tool-composition-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  ToolComposer,
  composeTools,
  inferPipeline,
  createMacroTool,
  executeMacro,
  parallelCompose,
  sequentialCompose,
  conditionalCompose,
  withRetry,
  validateComposition,
  saveMacro,
  loadMacro,
  listSavedMacros,
  deleteMacro,
} = await import("../lib/tool-composition.js");

process.on("exit", () => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ---------------------------------------------------------------------------
// Sample tool definitions used throughout the suite.
// ---------------------------------------------------------------------------

const textToJson = {
  name: "text_to_json",
  description: "parse text into json",
  inputSchema: { type: "string" },
  outputSchema: { type: "object" },
};
const jsonToTable = {
  name: "json_to_table",
  description: "tabulate an object",
  inputSchema: { type: "object" },
  outputSchema: { type: "table" },
};
const tableToCsv = {
  name: "table_to_csv",
  description: "render a table as csv",
  inputSchema: { type: "table" },
  outputSchema: { type: "string" },
};
const sampleTools = [textToJson, jsonToTable, tableToCsv];

// ---------------------------------------------------------------------------
// Registry tests
// ---------------------------------------------------------------------------

test("ToolComposer.registerTool stores and lists tools", () => {
  const composer = new ToolComposer();
  composer.registerTool(textToJson);
  composer.registerTool(jsonToTable);
  const list = composer.listTools();
  assert.equal(list.length, 2);
  const names = list.map((t) => t.name).sort();
  assert.deepEqual(names, ["json_to_table", "text_to_json"]);
});

test("ToolComposer.registerTool rejects invalid input", () => {
  const composer = new ToolComposer();
  assert.throws(() => composer.registerTool(null), /toolDef must be an object/);
  assert.throws(() => composer.registerTool({}), /toolDef.name is required/);
});

test("ToolComposer.getComposition and listMacros", () => {
  const composer = new ToolComposer();
  composer.addComposition({ name: "m1", steps: ["a", "b"] });
  assert.equal(composer.getComposition("m1").name, "m1");
  assert.equal(composer.getComposition("missing"), null);
  const macros = composer.listMacros();
  assert.equal(macros.length, 1);
  assert.equal(macros[0].name, "m1");
});

// ---------------------------------------------------------------------------
// composeTools / inferPipeline
// ---------------------------------------------------------------------------

test("composeTools finds a valid composition from input to goal", () => {
  const results = composeTools(sampleTools, {
    inputSchema: { type: "string" },
    goal: { type: "string" },
    maxDepth: 5,
  });
  assert.ok(results.length >= 1);
  // At least one multi-step pipeline should exist: text_to_json -> json_to_table -> table_to_csv
  const multi = results.find((r) => r.steps.length === 3);
  assert.ok(multi, "expected a multi-step pipeline");
  assert.deepEqual(multi.steps, ["text_to_json", "json_to_table", "table_to_csv"]);
});

test("composeTools still returns single-tool direct matches", () => {
  const results = composeTools(sampleTools, {
    inputSchema: { type: "string" },
    goal: { type: "object" },
  });
  assert.ok(results.some((r) => r.steps.length === 1 && r.steps[0] === "text_to_json"));
});

test("inferPipeline returns BFS result that matches types", () => {
  const pipeline = inferPipeline({ type: "string" }, { type: "table" }, sampleTools);
  assert.ok(pipeline);
  assert.deepEqual(pipeline, ["text_to_json", "json_to_table"]);
});

test("inferPipeline returns empty array when input already matches target", () => {
  const pipeline = inferPipeline({ type: "string" }, { type: "string" }, sampleTools);
  assert.deepEqual(pipeline, []);
});

test("inferPipeline returns null when no path exists", () => {
  const pipeline = inferPipeline({ type: "image" }, { type: "csv" }, sampleTools);
  assert.equal(pipeline, null);
});

// ---------------------------------------------------------------------------
// createMacroTool / executeMacro
// ---------------------------------------------------------------------------

test("createMacroTool produces a valid definition from a pipeline", () => {
  const macro = createMacroTool("my_macro", ["text_to_json", "json_to_table"], sampleTools);
  assert.equal(macro.name, "my_macro");
  assert.deepEqual(macro.steps, ["text_to_json", "json_to_table"]);
  assert.equal(macro.inputSchema.type, "string");
  assert.equal(macro.outputSchema.type, "table");
});

test("createMacroTool rejects unknown tools and type mismatches", () => {
  assert.throws(
    () => createMacroTool("bad", ["text_to_json", "nope"], sampleTools),
    /unknown tool/,
  );
  assert.throws(
    () => createMacroTool("bad", ["text_to_json", "table_to_csv"], sampleTools),
    /type mismatch/,
  );
});

test("executeMacro runs sequential steps and threads output", async () => {
  const macro = createMacroTool("demo", ["text_to_json", "json_to_table"], sampleTools);
  const calls = [];
  const executor = async (name, input) => {
    calls.push({ name, input });
    if (name === "text_to_json") return { parsed: true, src: input };
    if (name === "json_to_table") return { table: true, rows: [input] };
    return input;
  };
  const result = await executeMacro(macro, "hello", executor);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].name, "text_to_json");
  assert.equal(calls[0].input, "hello");
  assert.equal(calls[1].name, "json_to_table");
  assert.ok(calls[1].input.parsed);
  assert.ok(result.output.table);
  assert.equal(result.steps.length, 2);
  for (const s of result.steps) assert.ok(typeof s.durationMs === "number");
});

// ---------------------------------------------------------------------------
// parallelCompose / sequentialCompose / conditionalCompose / withRetry
// ---------------------------------------------------------------------------

test("parallelCompose runs multiple tools on shared input and merges outputs", async () => {
  const executor = async (name, input) => `${name}(${input})`;
  const result = await parallelCompose(["a", "b", "c"], "x", executor);
  assert.equal(result.results.length, 3);
  assert.equal(result.merged.a, "a(x)");
  assert.equal(result.merged.b, "b(x)");
  assert.equal(result.merged.c, "c(x)");
});

test("sequentialCompose chains outputs through mappers", async () => {
  const executor = async (name, input) => ({ step: name, value: input });
  const composed = sequentialCompose(["s1", "s2"], {
    mappers: [(val) => val, (val) => ({ ...val, extra: 42 })],
  });
  const result = await composed.run({ initial: true }, executor);
  assert.equal(result.steps.length, 2);
  assert.equal(result.steps[0].name, "s1");
  // second step's input should be mapped (include extra: 42)
  assert.equal(result.steps[1].input.extra, 42);
});

test("conditionalCompose branches on predicate", async () => {
  const executor = async (name, input) => `${name}:${input}`;
  const composite = conditionalCompose((v) => v > 5, "big", "small");
  const lo = await composite.run(1, executor);
  assert.equal(lo.branch, "else");
  assert.equal(lo.output, "small:1");
  const hi = await composite.run(10, executor);
  assert.equal(hi.branch, "if");
  assert.equal(hi.output, "big:10");
});

test("withRetry retries on failure and eventually succeeds", async () => {
  let attempts = 0;
  const executor = async () => {
    attempts += 1;
    if (attempts < 3) throw new Error("transient");
    return "ok";
  };
  const wrapped = withRetry("flaky_tool", { maxRetries: 3, backoffMs: 1 });
  const result = await wrapped.run("input", executor);
  assert.equal(result.output, "ok");
  assert.equal(result.attempts, 3);
  assert.equal(attempts, 3);
});

test("withRetry gives up after maxRetries", async () => {
  let attempts = 0;
  const executor = async () => {
    attempts += 1;
    throw new Error("boom");
  };
  const wrapped = withRetry("always_fails", { maxRetries: 2, backoffMs: 1 });
  await assert.rejects(() => wrapped.run("input", executor), /boom/);
  assert.equal(attempts, 3);
});

// ---------------------------------------------------------------------------
// validateComposition
// ---------------------------------------------------------------------------

test("validateComposition passes for a valid pipeline", () => {
  const composition = { steps: ["text_to_json", "json_to_table"] };
  const verdict = validateComposition(composition, sampleTools);
  assert.ok(verdict.ok);
  assert.deepEqual(verdict.errors, []);
});

test("validateComposition detects missing tools", () => {
  const composition = { steps: ["text_to_json", "not_a_tool"] };
  const verdict = validateComposition(composition, sampleTools);
  assert.ok(!verdict.ok);
  assert.ok(verdict.errors.some((e) => /missing tool/.test(e)));
});

test("validateComposition detects type mismatches", () => {
  const composition = { steps: ["text_to_json", "table_to_csv"] };
  const verdict = validateComposition(composition, sampleTools);
  assert.ok(!verdict.ok);
  assert.ok(verdict.errors.some((e) => /type mismatch/.test(e)));
});

test("validateComposition rejects cycles (tool reused)", () => {
  const composition = { steps: ["text_to_json", "json_to_table", "text_to_json"] };
  const verdict = validateComposition(composition, sampleTools);
  assert.ok(!verdict.ok);
  assert.ok(verdict.errors.some((e) => /cycle detected/.test(e)));
});

test("validateComposition handles empty steps", () => {
  const verdict = validateComposition({ steps: [] }, sampleTools);
  assert.ok(verdict.ok);
});

test("executeMacro handles empty composition (no steps)", async () => {
  const executor = async () => {
    throw new Error("should not be called");
  };
  const result = await executeMacro({ steps: [] }, "input", executor);
  assert.equal(result.output, "input");
  assert.equal(result.steps.length, 0);
});

// ---------------------------------------------------------------------------
// Persistence: saveMacro / loadMacro / listSavedMacros
// ---------------------------------------------------------------------------

test("saveMacro and loadMacro roundtrip", async () => {
  const macro = createMacroTool("persisted", ["text_to_json", "json_to_table"], sampleTools);
  const saved = await saveMacro("persisted", macro);
  assert.equal(saved.name, "persisted");
  assert.ok(saved.createdAt);
  assert.ok(saved.updatedAt);

  const loaded = await loadMacro("persisted");
  assert.ok(loaded);
  assert.equal(loaded.name, "persisted");
  assert.deepEqual(loaded.steps, ["text_to_json", "json_to_table"]);
  assert.equal(loaded.inputSchema.type, "string");
  assert.equal(loaded.outputSchema.type, "table");
});

test("listSavedMacros returns all persisted macros", async () => {
  await saveMacro("m_alpha", { steps: ["text_to_json"] });
  await saveMacro("m_beta", { steps: ["json_to_table"] });
  const all = await listSavedMacros();
  const names = all.map((m) => m.name).sort();
  assert.ok(names.includes("m_alpha"));
  assert.ok(names.includes("m_beta"));
});

test("deleteMacro removes a persisted macro", async () => {
  await saveMacro("to_remove", { steps: ["text_to_json"] });
  const existed = await deleteMacro("to_remove");
  assert.equal(existed, true);
  const loaded = await loadMacro("to_remove");
  assert.equal(loaded, null);
});

test("loadMacro returns null for unknown name", async () => {
  const loaded = await loadMacro("no_such_macro_xyz");
  assert.equal(loaded, null);
});
