/**
 * Tests for AGENT_REASONING_TOOLS gating and handlers.
 *
 * Verifies that tree_of_thought_plan, verify_output, and self_consistency
 * are only registered when AGENT_REASONING_TOOLS=1, that each handler
 * returns a valid result for simple input, and that each returns an
 * error object (not a thrown exception) for bad input.
 */
import test from "node:test";
import assert from "node:assert/strict";

const REASONING_NAMES = ["tree_of_thought_plan", "verify_output", "self_consistency"];

const initialFlag = process.env.AGENT_REASONING_TOOLS;
const initialAllow = process.env.AGENT_TOOLS_ALLOWLIST;

function restoreEnv() {
  if (initialFlag === undefined) delete process.env.AGENT_REASONING_TOOLS;
  else process.env.AGENT_REASONING_TOOLS = initialFlag;
  if (initialAllow === undefined) delete process.env.AGENT_TOOLS_ALLOWLIST;
  else process.env.AGENT_TOOLS_ALLOWLIST = initialAllow;
}

test.afterEach(() => {
  restoreEnv();
});

async function importFresh(tag) {
  return import(`../lib/agent-tools.js?t=${Date.now()}-${tag}`);
}

test("reasoning tools are NOT registered when AGENT_REASONING_TOOLS is unset", async () => {
  delete process.env.AGENT_REASONING_TOOLS;
  delete process.env.AGENT_TOOLS_ALLOWLIST;
  const mod = await importFresh("unset");
  const names = mod.getRegisteredToolNames();
  for (const n of REASONING_NAMES) {
    assert.ok(!names.includes(n), `expected ${n} NOT in tool list when AGENT_REASONING_TOOLS unset`);
  }
  const schemaNames = mod.getToolsSchema().map((t) => t.function?.name);
  for (const n of REASONING_NAMES) {
    assert.ok(!schemaNames.includes(n), `expected ${n} NOT in schema when flag unset`);
  }
});

test("reasoning tools ARE registered with proper schemas when AGENT_REASONING_TOOLS=1", async () => {
  process.env.AGENT_REASONING_TOOLS = "1";
  delete process.env.AGENT_TOOLS_ALLOWLIST;
  const mod = await importFresh("set");
  const schema = mod.getToolsSchema();
  const byName = new Map(schema.map((t) => [t.function?.name, t]));
  for (const n of REASONING_NAMES) {
    const tool = byName.get(n);
    assert.ok(tool, `expected ${n} in schema`);
    assert.equal(tool.type, "function");
    assert.equal(typeof tool.function.description, "string");
    assert.ok(tool.function.description.length > 10);
    assert.ok(tool.function.parameters && typeof tool.function.parameters === "object");
    assert.equal(tool.function.parameters.type, "object");
    assert.ok(Array.isArray(tool.function.parameters.required));
    assert.ok(tool.function.parameters.required.includes("task"));
  }
});

test("reasoning tools are disabled at execution time when flag unset, even if called directly", async () => {
  delete process.env.AGENT_REASONING_TOOLS;
  delete process.env.AGENT_TOOLS_ALLOWLIST;
  const mod = await importFresh("exec-unset");
  // Registry-level check: runTool should still reach switch() — but we also verify the handler refuses.
  const r = await mod.runTool("tree_of_thought_plan", { task: "hi" }, {});
  const payload = JSON.parse(r.content);
  assert.equal(payload.ok, false);
  assert.match(String(payload.error), /AGENT_REASONING_TOOLS/i);
});

// --- tree_of_thought_plan ---

test("tree_of_thought_plan returns best path and answer on a simple task", async () => {
  process.env.AGENT_REASONING_TOOLS = "1";
  delete process.env.AGENT_TOOLS_ALLOWLIST;
  const mod = await importFresh("tot-ok");
  const r = await mod.runTool(
    "tree_of_thought_plan",
    { task: "Should I deploy on Friday?", depth: 2, beamWidth: 2, k: 2 },
    {},
  );
  const out = JSON.parse(r.content);
  assert.equal(out.ok, true);
  assert.ok(Array.isArray(out.bestPath));
  assert.ok(out.bestPath.length >= 1);
  assert.equal(typeof out.answer, "string");
  assert.ok(out.stats && typeof out.stats === "object");
});

test("tree_of_thought_plan returns error string on missing task", async () => {
  process.env.AGENT_REASONING_TOOLS = "1";
  delete process.env.AGENT_TOOLS_ALLOWLIST;
  const mod = await importFresh("tot-bad");
  const r = await mod.runTool("tree_of_thought_plan", {}, {});
  const out = JSON.parse(r.content);
  assert.equal(out.ok, false);
  assert.match(String(out.error), /task is required/i);
});

test("tree_of_thought_plan accepts dfs and bfs strategies", async () => {
  process.env.AGENT_REASONING_TOOLS = "1";
  delete process.env.AGENT_TOOLS_ALLOWLIST;
  const mod = await importFresh("tot-dfs");
  const rDfs = await mod.runTool(
    "tree_of_thought_plan",
    { task: "pick a number", strategy: "dfs", depth: 2, k: 2 },
    {},
  );
  const dfs = JSON.parse(rDfs.content);
  assert.equal(dfs.ok, true);
  assert.equal(dfs.strategy, "dfs");

  const rBfs = await mod.runTool(
    "tree_of_thought_plan",
    { task: "pick a number", strategy: "bfs", depth: 2, k: 2 },
    {},
  );
  const bfs = JSON.parse(rBfs.content);
  assert.equal(bfs.ok, true);
  assert.equal(bfs.strategy, "bfs");
});

// --- verify_output ---

test("verify_output default strategy approves a coherent answer", async () => {
  process.env.AGENT_REASONING_TOOLS = "1";
  delete process.env.AGENT_TOOLS_ALLOWLIST;
  const mod = await importFresh("verify-ok");
  const r = await mod.runTool(
    "verify_output",
    {
      task: "Explain why the sky is blue.",
      answer:
        "The sky appears blue because molecules in the atmosphere scatter shorter wavelengths of sunlight more than longer ones. This process is called Rayleigh scattering.",
    },
    {},
  );
  const out = JSON.parse(r.content);
  assert.equal(out.ok, true);
  assert.equal(typeof out.approved, "boolean");
  assert.ok(out.score >= 0 && out.score <= 1);
  assert.equal(typeof out.critique, "string");
});

test("verify_output math strategy detects wrong arithmetic", async () => {
  process.env.AGENT_REASONING_TOOLS = "1";
  delete process.env.AGENT_TOOLS_ALLOWLIST;
  const mod = await importFresh("verify-math");
  const r = await mod.runTool(
    "verify_output",
    { task: "What is 2 + 2?", answer: "The answer is 5.", strategy: "math" },
    {},
  );
  const out = JSON.parse(r.content);
  assert.equal(out.ok, true);
  assert.equal(out.approved, false);
});

test("verify_output returns error string on missing answer", async () => {
  process.env.AGENT_REASONING_TOOLS = "1";
  delete process.env.AGENT_TOOLS_ALLOWLIST;
  const mod = await importFresh("verify-bad");
  const r = await mod.runTool("verify_output", { task: "something", answer: "" }, {});
  const out = JSON.parse(r.content);
  assert.equal(out.ok, false);
  assert.match(String(out.error), /answer is required/i);
});

test("verify_output rejects unknown strategy", async () => {
  process.env.AGENT_REASONING_TOOLS = "1";
  delete process.env.AGENT_TOOLS_ALLOWLIST;
  const mod = await importFresh("verify-unknown");
  const r = await mod.runTool(
    "verify_output",
    { task: "x", answer: "y", strategy: "bogus" },
    {},
  );
  const out = JSON.parse(r.content);
  assert.equal(out.ok, false);
  assert.match(String(out.error), /Unknown verifier strategy/i);
});

test("verify_output format strategy requires schema", async () => {
  process.env.AGENT_REASONING_TOOLS = "1";
  delete process.env.AGENT_TOOLS_ALLOWLIST;
  const mod = await importFresh("verify-format-missing");
  const r = await mod.runTool(
    "verify_output",
    { task: "x", answer: "{}", strategy: "format" },
    {},
  );
  const out = JSON.parse(r.content);
  assert.equal(out.ok, false);
  assert.match(String(out.error), /schema/i);
});

// --- self_consistency ---

test("self_consistency votes across provided samples and reports confidence", async () => {
  process.env.AGENT_REASONING_TOOLS = "1";
  delete process.env.AGENT_TOOLS_ALLOWLIST;
  const mod = await importFresh("sc-ok");
  const r = await mod.runTool(
    "self_consistency",
    {
      task: "What is 2 + 2?",
      format: "number",
      n: 5,
      samples: [
        { answer: 4 },
        { answer: 4 },
        { answer: 4 },
        { answer: 5 },
        { answer: 4 },
      ],
    },
    {},
  );
  const out = JSON.parse(r.content);
  assert.equal(out.ok, true);
  assert.equal(out.answer, 4);
  assert.ok(out.confidence > 0.5);
  assert.equal(typeof out.consensus, "boolean");
  assert.ok(out.voteBreakdown && typeof out.voteBreakdown === "object");
});

test("self_consistency uses default sampler when no samples supplied", async () => {
  process.env.AGENT_REASONING_TOOLS = "1";
  delete process.env.AGENT_TOOLS_ALLOWLIST;
  const mod = await importFresh("sc-default");
  const r = await mod.runTool(
    "self_consistency",
    { task: "pick a shape", n: 3 },
    {},
  );
  const out = JSON.parse(r.content);
  assert.equal(out.ok, true);
  assert.equal(out.sampleCount, 3);
});

test("self_consistency returns error string on missing task", async () => {
  process.env.AGENT_REASONING_TOOLS = "1";
  delete process.env.AGENT_TOOLS_ALLOWLIST;
  const mod = await importFresh("sc-bad");
  const r = await mod.runTool("self_consistency", { task: "   " }, {});
  const out = JSON.parse(r.content);
  assert.equal(out.ok, false);
  assert.match(String(out.error), /task is required/i);
});
