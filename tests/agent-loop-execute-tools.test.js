import test from "node:test";
import assert from "node:assert/strict";
import { runAgentLoop } from "../lib/agent-loop.js";
import { executeAgentToolBatch } from "../lib/agent-loop-execute-tools.js";
import { createPolicyState } from "../lib/agent-policy.js";

test("executeAgentToolBatch returns hitlPause for execute_step when HITL env set", async () => {
  const prev = process.env.AGENT_EXECUTE_STEP_HITL;
  process.env.AGENT_EXECUTE_STEP_HITL = "1";
  try {
    const toolCalls = [
      {
        id: "tc1",
        type: "function",
        function: {
          name: "execute_step",
          arguments: JSON.stringify({ action: "build", payload: {} }),
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
    const out = await executeAgentToolBatch({
      toolCalls,
      iteration: 1,
      runId: "run-test",
      toolCtx: { allowExecution: true },
      policyState,
      toolCallsLog,
      trajCollector,
      traceRequestId: undefined,
      setStopPolicy: () => {},
      agentOpts: {},
      hitlContext: {
        userId: null,
        runId: "run-test",
        workspace: "default",
        storageUserId: "anon",
        allowExecution: true,
        messages: [{ role: "assistant", content: null, tool_calls: toolCalls }],
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
    assert.ok(out.hitlPause);
    assert.ok(out.hitlPause.token.length > 16);
    assert.equal(out.results.length, 0);
    assert.equal(out.hadToolExecutionFailure, false);
  } finally {
    if (prev === undefined) delete process.env.AGENT_EXECUTE_STEP_HITL;
    else process.env.AGENT_EXECUTE_STEP_HITL = prev;
  }
});

test("runAgentLoop pauses execute_step through shared batch executor when HITL is required", async () => {
  const prevHitl = process.env.AGENT_EXECUTE_STEP_HITL;
  const prevAllow = process.env.ALLOW_RECIPE_STEP_EXECUTION;
  process.env.AGENT_EXECUTE_STEP_HITL = "1";
  process.env.ALLOW_RECIPE_STEP_EXECUTION = "1";
  try {
    let rounds = 0;
    const progress = [];
    const backendFetch = async () => {
      rounds++;
      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "tc_agent_hitl",
                    type: "function",
                    function: {
                      name: "execute_step",
                      arguments: JSON.stringify({ action: "build", payload: {} }),
                    },
                  },
                ],
              },
            },
          ],
        }),
      };
    };
    const headers = {};
    const result = await runAgentLoop(
      {
        userId: null,
        body: {
          model: "m",
          messages: [{ role: "user", content: "build this" }],
          agentOptions: {
            workspace: "default",
            allowExecution: true,
            requireExecuteStepApproval: true,
            maxIterations: 3,
          },
        },
      },
      {
        headersSent: false,
        setHeader(name, value) {
          headers[name] = value;
        },
        write() {},
      },
      { baseUrl: "http://mock", path: "/v1/chat", headers: {} },
      "m",
      { onProgress: (evt) => progress.push(evt) },
      backendFetch
    );

    assert.equal(result.stopReason, "hitl_pending");
    assert.equal(headers["X-Agent-Pending-Execute-Step"], "1");
    assert.equal(rounds, 1, "agent should pause before asking the model for another round");
    const pending = progress.find((evt) => evt.type === "agent_pending_execution");
    assert.ok(pending?.resumeToken);
    assert.equal(pending.pendingSteps?.[0]?.action, "build");
  } finally {
    if (prevHitl === undefined) delete process.env.AGENT_EXECUTE_STEP_HITL;
    else process.env.AGENT_EXECUTE_STEP_HITL = prevHitl;
    if (prevAllow === undefined) delete process.env.ALLOW_RECIPE_STEP_EXECUTION;
    else process.env.ALLOW_RECIPE_STEP_EXECUTION = prevAllow;
  }
});
