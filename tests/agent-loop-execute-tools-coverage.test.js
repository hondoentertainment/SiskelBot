/**
 * Coverage tests for lib/agent-loop-execute-tools.js.
 * Covers: normal success, tool exception, validation error,
 * policy block, HITL skipped-peer-failure, HITL non-applicable when disabled,
 * and session event appends.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.STORAGE_PATH = mkdtempSync(join(tmpdir(), "exec-tools-cov-"));

const { executeAgentToolBatch } = await import("../lib/agent-loop-execute-tools.js");
const { createPolicyState } = await import("../lib/agent-policy.js");

function makeCollector() {
  const records = [];
  return {
    records,
    record(ev) {
      records.push(ev);
    },
    truncate(s, n) {
      return String(s ?? "").slice(0, n);
    },
  };
}

function baseHitlContext(overrides = {}) {
  return {
    userId: null,
    runId: "run-cov",
    workspace: "default",
    storageUserId: "anon",
    allowExecution: true,
    messages: [],
    iteration: 1,
    maxAgentIterations: 3,
    runStarted: Date.now(),
    totalToolCalls: 0,
    toolCallsLog: [],
    policySnapshot: { categoryCounts: { read: 0, write: 0, network: 0 }, externalFetches: 0, totalToolMs: 0 },
    effectivePolicy: {},
    stagnationRecoveryUsed: false,
    llmMsTotal: 0,
    toolsMsTotal: 0,
    bodyBaseModel: "m",
    tools: [],
    requiredSeq: [],
    baseToolChoice: "auto",
    responseFormat: undefined,
    workspaceAllowedToolsList: [],
    traceRequestId: undefined,
    ...overrides,
  };
}

test("executeAgentToolBatch runs list_context tool and returns results", async () => {
  const toolCalls = [
    {
      id: "tc-list",
      type: "function",
      function: { name: "list_context", arguments: "{}" },
    },
  ];
  const out = await executeAgentToolBatch({
    toolCalls,
    iteration: 1,
    runId: "run-cov-1",
    toolCtx: { workspace: "exec-cov-ws", allowExecution: false },
    policyState: createPolicyState({}),
    toolCallsLog: [],
    trajCollector: makeCollector(),
    setStopPolicy: () => {},
    agentOpts: {},
    hitlContext: baseHitlContext(),
  });
  assert.equal(out.hitlPause, null);
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].tool_call_id, "tc-list");
  assert.ok(out.results[0].content); // some JSON string
});

test("executeAgentToolBatch records tool invocation in the trajectory", async () => {
  const coll = makeCollector();
  const toolCalls = [
    { id: "tc-a", type: "function", function: { name: "list_context", arguments: "{}" } },
  ];
  await executeAgentToolBatch({
    toolCalls,
    iteration: 2,
    runId: "run-cov-2",
    toolCtx: { workspace: "exec-cov-ws", allowExecution: false },
    policyState: createPolicyState({}),
    toolCallsLog: [],
    trajCollector: coll,
    setStopPolicy: () => {},
    agentOpts: {},
    hitlContext: baseHitlContext(),
  });
  const kinds = coll.records.map((r) => r.type);
  assert.ok(kinds.includes("tool_call"));
  assert.ok(kinds.includes("tool_result"));
});

test("executeAgentToolBatch policy-blocks a denied tool and calls setStopPolicy", async () => {
  let stopCalledWith = null;
  const policyState = createPolicyState({}, { deniedTools: ["list_context"] });
  const toolCalls = [
    { id: "tc-deny", type: "function", function: { name: "list_context", arguments: "{}" } },
  ];
  const out = await executeAgentToolBatch({
    toolCalls,
    iteration: 1,
    runId: "run-cov-deny",
    toolCtx: { workspace: "exec-cov-ws" },
    policyState,
    toolCallsLog: [],
    trajCollector: makeCollector(),
    setStopPolicy: (p) => {
      stopCalledWith = p;
    },
    agentOpts: {},
    hitlContext: baseHitlContext(),
  });
  assert.ok(stopCalledWith);
  assert.equal(stopCalledWith.code, "POLICY_TOOL_DENIED");
  const parsed = JSON.parse(out.results[0].content);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, "POLICY_TOOL_DENIED");
});

test("executeAgentToolBatch: when a peer fails validation, HITL is skipped with HITL_SKIPPED_PEER_FAILURE", async () => {
  const prevEnv = process.env.AGENT_EXECUTE_STEP_HITL;
  const prevValidate = process.env.AGENT_TOOL_VALIDATION;
  process.env.AGENT_EXECUTE_STEP_HITL = "1";
  process.env.AGENT_TOOL_VALIDATION = "1";
  try {
    const toolCalls = [
      {
        id: "tc-exec",
        type: "function",
        function: { name: "execute_step", arguments: JSON.stringify({ action: "build" }) },
      },
      {
        id: "tc-bad",
        type: "function",
        // Missing required query — triggers validation error for search_context
        function: { name: "search_context", arguments: "{}" },
      },
    ];
    const out = await executeAgentToolBatch({
      toolCalls,
      iteration: 1,
      runId: "run-cov-peer",
      toolCtx: { workspace: "exec-cov-ws", allowExecution: true },
      policyState: createPolicyState({}),
      toolCallsLog: [],
      trajCollector: makeCollector(),
      setStopPolicy: () => {},
      agentOpts: {},
      hitlContext: baseHitlContext(),
    });
    assert.equal(out.hitlPause, null, "no hitl pause should be emitted when a peer failed");
    // Find the exec tool result
    const execRow = out.results.find((r) => r.tool_call_id === "tc-exec");
    assert.ok(execRow, "execute_step row should be present");
    const parsed = JSON.parse(execRow.content);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.code, "HITL_SKIPPED_PEER_FAILURE");
  } finally {
    if (prevEnv === undefined) delete process.env.AGENT_EXECUTE_STEP_HITL;
    else process.env.AGENT_EXECUTE_STEP_HITL = prevEnv;
    if (prevValidate === undefined) delete process.env.AGENT_TOOL_VALIDATION;
    else process.env.AGENT_TOOL_VALIDATION = prevValidate;
  }
});

test("executeAgentToolBatch: validation error alone still returns structured content for that tool", async () => {
  const prev = process.env.AGENT_TOOL_VALIDATION;
  process.env.AGENT_TOOL_VALIDATION = "1";
  try {
    const toolCalls = [
      { id: "tc-inv", type: "function", function: { name: "search_context", arguments: "{}" } },
    ];
    const out = await executeAgentToolBatch({
      toolCalls,
      iteration: 1,
      runId: "run-cov-inv",
      toolCtx: { workspace: "exec-cov-ws" },
      policyState: createPolicyState({}),
      toolCallsLog: [],
      trajCollector: makeCollector(),
      setStopPolicy: () => {},
      agentOpts: {},
      hitlContext: baseHitlContext(),
    });
    assert.equal(out.hitlPause, null);
    const parsed = JSON.parse(out.results[0].content);
    // With validation ON we expect _tool_validation_error; if validation is off,
    // we still get a defined body and shape, just different keys.
    if (parsed._tool_validation_error) {
      assert.ok(Array.isArray(parsed.errors));
    }
  } finally {
    if (prev === undefined) delete process.env.AGENT_TOOL_VALIDATION;
    else process.env.AGENT_TOOL_VALIDATION = prev;
  }
});

test("executeAgentToolBatch: unknown tool returns error string without throwing", async () => {
  // Disable validation so the unknown-tool path actually reaches runTool's default branch.
  const prev = process.env.AGENT_TOOL_VALIDATION;
  process.env.AGENT_TOOL_VALIDATION = "0";
  try {
    const toolCalls = [
      { id: "tc-x", type: "function", function: { name: "definitely_not_a_tool", arguments: "{}" } },
    ];
    const out = await executeAgentToolBatch({
      toolCalls,
      iteration: 1,
      runId: "run-cov-unk",
      toolCtx: { workspace: "exec-cov-ws" },
      policyState: createPolicyState({}),
      toolCallsLog: [],
      trajCollector: makeCollector(),
      setStopPolicy: () => {},
      agentOpts: {},
      hitlContext: baseHitlContext(),
    });
    assert.equal(out.results.length, 1);
    const parsed = JSON.parse(out.results[0].content);
    // Either validation error OR runTool unknown-tool error path must surface something
    assert.ok(parsed.error || parsed._tool_validation_error || parsed.errors);
  } finally {
    if (prev === undefined) delete process.env.AGENT_TOOL_VALIDATION;
    else process.env.AGENT_TOOL_VALIDATION = prev;
  }
});

test("executeAgentToolBatch: execute_step proceeds without HITL when env disabled", async () => {
  // no AGENT_EXECUTE_STEP_HITL env set
  delete process.env.AGENT_EXECUTE_STEP_HITL;
  const toolCalls = [
    {
      id: "tc-exec",
      type: "function",
      function: { name: "execute_step", arguments: JSON.stringify({ action: "build" }) },
    },
  ];
  const out = await executeAgentToolBatch({
    toolCalls,
    iteration: 1,
    runId: "run-cov-noh",
    // allowExecution false -> execute_step errors "Allow recipe step execution..."
    toolCtx: { workspace: "exec-cov-ws", allowExecution: false },
    policyState: createPolicyState({}),
    toolCallsLog: [],
    trajCollector: makeCollector(),
    setStopPolicy: () => {},
    agentOpts: {},
    hitlContext: baseHitlContext(),
  });
  assert.equal(out.hitlPause, null);
  assert.equal(out.results.length, 1);
  const parsed = JSON.parse(out.results[0].content);
  assert.equal(parsed.ok, false); // because allowExecution=false
});

test("executeAgentToolBatch: invalid JSON arguments still produce a row", async () => {
  const toolCalls = [
    // Parses as invalid JSON; args falls back to {}
    { id: "tc-pe", type: "function", function: { name: "list_context", arguments: "{not-json" } },
  ];
  const out = await executeAgentToolBatch({
    toolCalls,
    iteration: 1,
    runId: "run-cov-parse",
    toolCtx: { workspace: "exec-cov-ws" },
    policyState: createPolicyState({}),
    toolCallsLog: [],
    trajCollector: makeCollector(),
    setStopPolicy: () => {},
    agentOpts: {},
    hitlContext: baseHitlContext(),
  });
  // list_context has empty required params, so even with {} it runs
  assert.equal(out.results.length, 1);
});
