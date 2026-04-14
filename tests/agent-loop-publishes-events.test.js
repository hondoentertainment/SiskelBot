/**
 * Asserts that lib/agent-loop-execute-tools.js publishes tool.call + tool.result
 * events on the Agent Run per-session emitter when a sessionId is provided.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const dir = mkdtempSync(join(tmpdir(), "agent-loop-pub-"));
const prevStorage = process.env.STORAGE_PATH;
process.env.STORAGE_PATH = dir;

test.after(() => {
  if (prevStorage === undefined) delete process.env.STORAGE_PATH;
  else process.env.STORAGE_PATH = prevStorage;
  rmSync(dir, { recursive: true, force: true });
});

const { executeAgentToolBatch } = await import("../lib/agent-loop-execute-tools.js");
const { createPolicyState } = await import("../lib/agent-policy.js");
const {
  getAgentRunEmitter,
  disposeAgentRunEmitter,
  __resetAgentRunStreamForTests,
} = await import("../lib/agent-run-stream.js");

test("executeAgentToolBatch emits tool.call + tool.result on the per-session emitter", async () => {
  __resetAgentRunStreamForTests();
  const sessionId = "sess-test-publish";
  const emitter = getAgentRunEmitter(sessionId);

  /** @type {{ type: string, payload: any }[]} */
  const seen = [];
  emitter.on("event", (ev) => seen.push(ev));

  // Make a tool call that is guaranteed to succeed — list_workspace_memory
  // with no memory returns ok:true. If that isn't registered, fall back to a
  // tool that simply errors out (both emit tool.call and tool.result).
  const toolCalls = [
    {
      id: "tc-pub-1",
      type: "function",
      function: {
        name: "list_workspace_memory",
        arguments: JSON.stringify({}),
      },
    },
  ];

  const trajCollector = {
    record() {},
    truncate(s, n) {
      return String(s).slice(0, n);
    },
  };
  const policyState = createPolicyState({});
  const toolCallsLog = [];

  await executeAgentToolBatch({
    toolCalls,
    iteration: 1,
    runId: "run-pub-test",
    toolCtx: {
      allowExecution: false,
      workspace: "default",
      workspaceUserId: "anonymous",
      projectDir: process.cwd(),
    },
    policyState,
    toolCallsLog,
    trajCollector,
    traceRequestId: undefined,
    setStopPolicy: () => {},
    agentOpts: {},
    sessionId,
    hitlContext: {
      userId: null,
      runId: "run-pub-test",
      workspace: "default",
      storageUserId: "anonymous",
      allowExecution: false,
      messages: [],
      iteration: 1,
      maxAgentIterations: 5,
      runStarted: Date.now(),
      totalToolCalls: 0,
      toolCallsLog: [],
      policySnapshot: {
        categoryCounts: { read: 0, write: 0, network: 0 },
        externalFetches: 0,
        totalToolMs: 0,
      },
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
    },
  });

  const calls = seen.filter((e) => e.type === "tool.call");
  const results = seen.filter((e) => e.type === "tool.result");
  assert.ok(calls.length >= 1, `expected a tool.call event, got: ${JSON.stringify(seen)}`);
  assert.ok(results.length >= 1, `expected a tool.result event, got: ${JSON.stringify(seen)}`);
  assert.equal(calls[0].payload.tool, "list_workspace_memory");
  assert.equal(calls[0].payload.runId, "run-pub-test");
  assert.equal(results[0].payload.tool, "list_workspace_memory");
  assert.equal(results[0].payload.runId, "run-pub-test");

  disposeAgentRunEmitter(sessionId);
});

test("executeAgentToolBatch emits nothing when sessionId is absent", async () => {
  __resetAgentRunStreamForTests();
  const sessionId = "sess-no-publish";
  const emitter = getAgentRunEmitter(sessionId);
  const seen = [];
  emitter.on("event", (ev) => seen.push(ev));

  const toolCalls = [
    {
      id: "tc-nop-1",
      type: "function",
      function: {
        name: "list_workspace_memory",
        arguments: JSON.stringify({}),
      },
    },
  ];
  const trajCollector = {
    record() {},
    truncate(s, n) { return String(s).slice(0, n); },
  };
  const policyState = createPolicyState({});

  await executeAgentToolBatch({
    toolCalls,
    iteration: 1,
    runId: "run-nop",
    toolCtx: {
      allowExecution: false,
      workspace: "default",
      workspaceUserId: "anonymous",
      projectDir: process.cwd(),
    },
    policyState,
    toolCallsLog: [],
    trajCollector,
    traceRequestId: undefined,
    setStopPolicy: () => {},
    agentOpts: {},
    // sessionId intentionally omitted
    hitlContext: {
      userId: null,
      runId: "run-nop",
      workspace: "default",
      storageUserId: "anonymous",
      allowExecution: false,
      messages: [],
      iteration: 1,
      maxAgentIterations: 5,
      runStarted: Date.now(),
      totalToolCalls: 0,
      toolCallsLog: [],
      policySnapshot: {
        categoryCounts: { read: 0, write: 0, network: 0 },
        externalFetches: 0,
        totalToolMs: 0,
      },
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
    },
  });

  const calls = seen.filter((e) => e.type === "tool.call");
  const results = seen.filter((e) => e.type === "tool.result");
  assert.equal(calls.length, 0);
  assert.equal(results.length, 0);

  disposeAgentRunEmitter(sessionId);
});
