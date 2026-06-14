import test from "node:test";
import assert from "node:assert/strict";
import {
  detectChain,
  executeChain,
  executeParallel,
  buildChainPlan,
  executePlan,
  executeChainToolsMeta,
} from "../lib/tool-chaining.js";

// ---------- detectChain ----------

test("detectChain returns empty for empty input", () => {
  const result = detectChain([]);
  assert.deepEqual(result, { chains: [], parallel: [] });
});

test("detectChain returns empty for null input", () => {
  const result = detectChain(null);
  assert.deepEqual(result, { chains: [], parallel: [] });
});

test("detectChain identifies all-parallel calls with no references", () => {
  const calls = [
    { name: "search_context", args: { query: "foo" } },
    { name: "list_context", args: {} },
    { name: "list_recipes", args: {} },
  ];
  const result = detectChain(calls);
  assert.equal(result.parallel.length, 3);
  assert.equal(result.chains.length, 0);
});

test("detectChain identifies sequential chain via {{tool.previous.output}}", () => {
  const calls = [
    { name: "search_context", args: { query: "deployment" } },
    { name: "get_context_document", args: { id: "{{tool.previous.output}}" } },
  ];
  const result = detectChain(calls);
  assert.equal(result.chains.length, 1);
  assert.equal(result.chains[0].length, 2);
  assert.equal(result.parallel.length, 0);
});

test("detectChain identifies chain via numeric index {{tool.0.output}}", () => {
  const calls = [
    { name: "search_context", args: { query: "test" } },
    { name: "list_recipes", args: {} },
    { name: "get_context_document", args: { id: "{{tool.0.output}}" } },
  ];
  const result = detectChain(calls);
  assert.equal(result.chains.length, 1);
  assert.equal(result.chains[0].length, 2);
  assert.equal(result.chains[0][0].name, "search_context");
  assert.equal(result.chains[0][1].name, "get_context_document");
  assert.equal(result.parallel.length, 1);
  assert.equal(result.parallel[0].name, "list_recipes");
});

test("detectChain handles nested references in args", () => {
  const calls = [
    { name: "search_context", args: { query: "docs" } },
    { name: "fetch_allowed_url", args: { url: "https://example.com/{{tool.previous.output}}" } },
  ];
  const result = detectChain(calls);
  assert.equal(result.chains.length, 1);
  assert.equal(result.chains[0].length, 2);
});

test("detectChain handles references in arrays", () => {
  const calls = [
    { name: "search_context", args: { query: "docs" } },
    { name: "execute_step", args: { action: "build", payload: { items: ["{{tool.0.output}}"] } } },
  ];
  const result = detectChain(calls);
  assert.equal(result.chains.length, 1);
});

// ---------- executeParallel ----------

test("executeParallel runs all calls concurrently", async () => {
  const order = [];
  const mockRunTool = async (name, args) => {
    order.push(name);
    return { content: JSON.stringify({ name, args }), ok: true };
  };

  const calls = [
    { index: 0, name: "tool_a", args: { x: 1 } },
    { index: 1, name: "tool_b", args: { y: 2 } },
    { index: 2, name: "tool_c", args: { z: 3 } },
  ];

  const results = await executeParallel(calls, {}, mockRunTool);
  assert.equal(results.length, 3);
  assert.ok(results.every((r) => r.ok));
  assert.ok(results.every((r) => r.durationMs >= 0));
});

test("executeParallel handles errors without stopping others", async () => {
  const mockRunTool = async (name) => {
    if (name === "tool_b") throw new Error("boom");
    return { content: "ok", ok: true };
  };

  const calls = [
    { index: 0, name: "tool_a", args: {} },
    { index: 1, name: "tool_b", args: {} },
    { index: 2, name: "tool_c", args: {} },
  ];

  const results = await executeParallel(calls, {}, mockRunTool);
  assert.equal(results.length, 3);
  assert.ok(results[0].ok);
  assert.ok(!results[1].ok);
  assert.ok(results[1].error);
  assert.ok(results[2].ok);
});

// ---------- executeChain ----------

test("executeChain runs tools sequentially and pipes output", async () => {
  const executionOrder = [];
  const mockRunTool = async (name, args) => {
    executionOrder.push(name);
    if (name === "search") {
      return { content: "doc-123", ok: true };
    }
    if (name === "get_doc") {
      return { content: `fetched: ${args.id}`, ok: true };
    }
    return { content: "unknown", ok: true };
  };

  const chain = [
    { index: 0, name: "search", args: { query: "test" } },
    { index: 1, name: "get_doc", args: { id: "{{tool.previous.output}}" } },
  ];

  const results = await executeChain(chain, {}, mockRunTool);
  assert.equal(results.length, 2);
  assert.equal(executionOrder[0], "search");
  assert.equal(executionOrder[1], "get_doc");
  assert.equal(results[0].result, "doc-123");
  assert.equal(results[1].result, "fetched: doc-123");
});

test("executeChain resolves numeric index references", async () => {
  const mockRunTool = async (name, args) => {
    if (name === "first") return { content: "FIRST_OUTPUT" };
    if (name === "second") return { content: "SECOND_OUTPUT" };
    if (name === "third") return { content: `got: ${args.data}` };
    return { content: "?" };
  };

  const chain = [
    { index: 0, name: "first", args: {} },
    { index: 1, name: "second", args: {} },
    { index: 2, name: "third", args: { data: "{{tool.0.output}}" } },
  ];

  const results = await executeChain(chain, {}, mockRunTool);
  assert.equal(results.length, 3);
  assert.equal(results[2].result, "got: FIRST_OUTPUT");
});

test("executeChain stops on error", async () => {
  const mockRunTool = async (name) => {
    if (name === "step2") throw new Error("step2 failed");
    return { content: "ok" };
  };

  const chain = [
    { index: 0, name: "step1", args: {} },
    { index: 1, name: "step2", args: { input: "{{tool.previous.output}}" } },
    { index: 2, name: "step3", args: { input: "{{tool.previous.output}}" } },
  ];

  const results = await executeChain(chain, {}, mockRunTool);
  assert.equal(results.length, 2, "should stop after error, not execute step3");
  assert.ok(results[0].ok);
  assert.ok(!results[1].ok);
  assert.ok(results[1].error);
});

// ---------- buildChainPlan ----------

test("buildChainPlan groups parallel and sequential correctly", () => {
  const calls = [
    { name: "search_context", args: { query: "test" } },
    { name: "list_recipes", args: {} },
    { name: "get_context_document", args: { id: "{{tool.0.output}}" } },
  ];

  const plan = buildChainPlan(calls);
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].parallel.length, 1);
  assert.equal(plan.steps[0].parallel[0].name, "list_recipes");
  assert.equal(plan.steps[0].sequential.length, 1);
  assert.equal(plan.steps[0].sequential[0].length, 2);
});

test("buildChainPlan returns empty steps for empty input", () => {
  const plan = buildChainPlan([]);
  assert.deepEqual(plan, { steps: [] });
});

// ---------- executePlan ----------

test("executePlan runs mixed parallel and chains", async () => {
  const log = [];
  const mockRunTool = async (name, args) => {
    log.push(name);
    if (name === "search") return { content: "id-42" };
    if (name === "get_doc") return { content: `doc:${args.id}` };
    return { content: `${name}-done` };
  };

  const calls = [
    { name: "search", args: { query: "q" } },
    { name: "list", args: {} },
    { name: "get_doc", args: { id: "{{tool.0.output}}" } },
  ];

  const plan = buildChainPlan(calls);
  const results = await executePlan(plan, {}, mockRunTool);

  assert.equal(results.length, 3);
  // list should be parallel
  const listResult = results.find((r) => r.name === "list");
  assert.ok(listResult);
  assert.equal(listResult.result, "list-done");
  // get_doc should receive resolved output
  const getDocResult = results.find((r) => r.name === "get_doc");
  assert.ok(getDocResult);
  assert.equal(getDocResult.result, "doc:id-42");
});

test("executePlan handles all-parallel calls", async () => {
  const mockRunTool = async (name) => ({ content: `${name}-ok` });

  const calls = [
    { name: "a", args: {} },
    { name: "b", args: {} },
    { name: "c", args: {} },
  ];

  const plan = buildChainPlan(calls);
  const results = await executePlan(plan, {}, mockRunTool);
  assert.equal(results.length, 3);
  assert.ok(results.every((r) => r.ok));
});

// ---------- executeChainToolsMeta (chain_tools meta-tool) ----------

test("executeChainToolsMeta executes steps in order", async () => {
  const order = [];
  const mockRunTool = async (name, args) => {
    order.push(name);
    return { content: JSON.stringify({ tool: name, args }), ok: true };
  };

  const steps = [
    { tool: "search_context", args: { query: "deploy" } },
    { tool: "list_recipes" },
  ];

  const result = await executeChainToolsMeta(steps, {}, mockRunTool);
  assert.ok(result.ok);
  assert.equal(result.results.length, 2);
  assert.deepEqual(order, ["search_context", "list_recipes"]);
});

test("executeChainToolsMeta resolves {{tool.previous.output}} in args", async () => {
  const mockRunTool = async (name, args) => {
    if (name === "search") return { content: "doc-abc" };
    if (name === "get_doc") return { content: `content for ${args.id}` };
    return { content: "?" };
  };

  const steps = [
    { tool: "search", args: { query: "test" } },
    { tool: "get_doc", args: { id: "{{tool.previous.output}}" } },
  ];

  const result = await executeChainToolsMeta(steps, {}, mockRunTool);
  assert.ok(result.ok);
  assert.equal(result.results.length, 2);
  assert.equal(result.results[1].result, "content for doc-abc");
});

test("executeChainToolsMeta stops on error and returns partial results", async () => {
  const mockRunTool = async (name) => {
    if (name === "fail_tool") throw new Error("broken");
    return { content: "ok" };
  };

  const steps = [
    { tool: "good_tool", args: {} },
    { tool: "fail_tool", args: {} },
    { tool: "never_reached", args: {} },
  ];

  const result = await executeChainToolsMeta(steps, {}, mockRunTool);
  assert.ok(!result.ok);
  assert.equal(result.results.length, 2);
  assert.ok(result.results[0].ok);
  assert.ok(!result.results[1].ok);
});

test("executeChainToolsMeta returns not-ok for empty steps", async () => {
  const result = await executeChainToolsMeta([], {}, async () => ({ content: "x" }));
  assert.ok(!result.ok);
  assert.equal(result.results.length, 0);
});

test("executeChainToolsMeta tracks duration per step", async () => {
  const mockRunTool = async () => ({ content: "done", ok: true });

  const steps = [
    { tool: "a", args: {} },
    { tool: "b", args: {} },
  ];

  const result = await executeChainToolsMeta(steps, {}, mockRunTool);
  assert.ok(result.ok);
  for (const r of result.results) {
    assert.equal(typeof r.durationMs, "number");
    assert.ok(r.durationMs >= 0);
  }
});
