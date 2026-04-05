import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createPolicyState } from "../lib/agent-policy.js";
import { executeAgentToolBatch } from "../lib/agent-loop-execute-tools.js";

const dir = mkdtempSync(join(tmpdir(), "upd-plan-"));
const prevS = process.env.STORAGE_PATH;
const prevApi = process.env.AGENT_SESSION_API;
process.env.STORAGE_PATH = dir;
process.env.AGENT_SESSION_API = "1";

const { createAgentSession, getAgentSession } = await import("../lib/agent-session.js");
const { runTool, getRegisteredToolNames } = await import("../lib/agent-tools.js");

test.after(() => {
  if (prevS === undefined) delete process.env.STORAGE_PATH;
  else process.env.STORAGE_PATH = prevS;
  if (prevApi === undefined) delete process.env.AGENT_SESSION_API;
  else process.env.AGENT_SESSION_API = prevApi;
  rmSync(dir, { recursive: true, force: true });
});

test("getRegisteredToolNames includes update_agent_session_plan when session API on", () => {
  assert.ok(getRegisteredToolNames().includes("update_agent_session_plan"));
});

test("runTool update_agent_session_plan persists plan", async () => {
  const session = await createAgentSession({
    workspace: "default",
    ownerStorageUserId: "anonymous",
    title: "p",
  });
  const baseCtx = {
    allowExecution: false,
    projectDir: process.cwd(),
    workspace: "default",
    workspaceUserId: "anonymous",
    agentSessionId: session.id,
  };
  const out = await runTool(
    "update_agent_session_plan",
    { planSummary: "Step 1", planDag: { steps: ["a", "b"] } },
    baseCtx,
  );
  const data = JSON.parse(out.content);
  assert.equal(data.ok, true);
  const row = await getAgentSession(session.id);
  assert.equal(row.planSummary, "Step 1");
  assert.deepEqual(row.planDag, { steps: ["a", "b"] });
});

test("runTool update_agent_session_plan without session id fails", async () => {
  const out = await runTool(
    "update_agent_session_plan",
    { planSummary: "x" },
    {
      allowExecution: false,
      projectDir: process.cwd(),
      workspace: "default",
      workspaceUserId: "anonymous",
    },
  );
  const data = JSON.parse(out.content);
  assert.equal(data.ok, false);
  assert.equal(data.code, "NO_ACTIVE_SESSION");
});

test("executeAgentToolBatch appends tool_failed session event when tool returns ok false", async () => {
  const wsRoot = join(dir, "wsroot");
  mkdirSync(wsRoot, { recursive: true });
  const prevF = process.env.WORKSPACE_FILE_TOOLS;
  const prevR = process.env.WORKSPACE_ROOT;
  process.env.WORKSPACE_FILE_TOOLS = "1";
  process.env.WORKSPACE_ROOT = wsRoot;
  try {
    const session = await createAgentSession({
      workspace: "default",
      ownerStorageUserId: "anonymous",
    });
    const toolCalls = [
      {
        id: "tc1",
        type: "function",
        function: {
          name: "workspace_read_file",
          arguments: JSON.stringify({ path: "does-not-exist.txt" }),
        },
      },
    ];
    const trajCollector = {
      record() {},
      truncate(s, n) {
        return String(s).slice(0, n);
      },
    };
    const policyState = createPolicyState({
      toolCategoryCaps: { read: 20, write: 20, network: 20 },
    });
    const toolCallsLog = [];
    const out = await executeAgentToolBatch({
      toolCalls,
      iteration: 2,
      runId: "run-tf",
      toolCtx: {
        allowExecution: false,
        workspace: "default",
        workspaceUserId: "anonymous",
        workspaceFilesystemRoot: wsRoot,
      },
      policyState,
      toolCallsLog,
      trajCollector,
      traceRequestId: undefined,
      setStopPolicy: () => {},
      agentOpts: {},
      sessionId: session.id,
      hitlContext: {
        userId: null,
        runId: "run-tf",
        workspace: "default",
        storageUserId: "anonymous",
        allowExecution: false,
        messages: [],
        iteration: 2,
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
    assert.equal(out.hitlPause, null);
    assert.equal(out.hadToolExecutionFailure, true);
    const row = await getAgentSession(session.id);
    const fails = (row.events || []).filter((e) => e.type === "tool_failed");
    assert.ok(fails.length >= 1);
    assert.equal(fails[fails.length - 1].toolName, "workspace_read_file");
  } finally {
    if (prevF === undefined) delete process.env.WORKSPACE_FILE_TOOLS;
    else process.env.WORKSPACE_FILE_TOOLS = prevF;
    if (prevR === undefined) delete process.env.WORKSPACE_ROOT;
    else process.env.WORKSPACE_ROOT = prevR;
  }
});
