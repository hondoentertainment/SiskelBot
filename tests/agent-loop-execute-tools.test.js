import test from "node:test";
import assert from "node:assert/strict";
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
