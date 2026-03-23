import test from "node:test";
import assert from "node:assert/strict";
import { deriveTraceFromStagingRecord, evaluateStagingTraceCase } from "../lib/eval-staging-trace.js";

test("deriveTraceFromStagingRecord uses goldenTrace", () => {
  const { goldenTrace, agentActivity } = deriveTraceFromStagingRecord({
    goldenTrace: [{ name: "a", arguments: {} }],
  });
  assert.equal(goldenTrace.length, 1);
  assert.equal(goldenTrace[0].name, "a");
  assert.ok(!agentActivity);
});

test("evaluateStagingTraceCase passes on example-shaped record", () => {
  const record = {
    goldenTrace: [
      { name: "list_context", arguments: {} },
      { name: "search_context", arguments: { query: "docs" } },
    ],
    agentActivity: {
      type: "agent_activity",
      toolCalls: [{ name: "list_context" }, { name: "search_context", args: { query: "docs" } }],
      swarmSteps: [],
    },
  };
  const r = evaluateStagingTraceCase(
    {
      expectedToolSequence: ["list_context", "search_context"],
      expectedMinAgentActivityToolCalls: 2,
      expectedAgentActivityToolNames: ["search_context"],
    },
    record
  );
  assert.equal(r.pass, true);
});

test("evaluateStagingTraceCase fails wrong sequence", () => {
  const r = evaluateStagingTraceCase(
    { expectedToolSequence: ["search_context", "list_context"] },
    {
      goldenTrace: [
        { name: "list_context", arguments: {} },
        { name: "search_context", arguments: {} },
      ],
    }
  );
  assert.equal(r.pass, false);
});
