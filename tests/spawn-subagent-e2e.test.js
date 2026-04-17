/**
 * End-to-end integration test: parent agent spawns a child via the
 * spawn_subagent tool, flowing through executeAgentToolBatch.
 *
 * The full wiring added to agent-loop-execute-tools.js is exercised:
 * runAgentLoop (lazy import), backendFetch, buildProxyConfig, currentTools,
 * runId, agentSessionId, and depth all flow through toolCtx into the child
 * agent loop.
 *
 * The LLM backend is mocked at the HTTP fetch boundary so every other
 * layer (agent-loop, agent-tools, spawn-subagent, agent-session) runs
 * for real.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Isolated storage for agent sessions created during the test.
const dir = mkdtempSync(join(tmpdir(), "spawn-e2e-"));
const prevStorage = process.env.STORAGE_PATH;
const prevSessionApi = process.env.AGENT_SESSION_API;
const prevToolValidation = process.env.TOOL_VALIDATION_STRICT;
process.env.STORAGE_PATH = dir;
process.env.AGENT_SESSION_API = "1";
// Disable strict tool validation because the KNOWN_TOOLS set in
// tool-validation.js may not include spawn_subagent yet.
process.env.TOOL_VALIDATION_STRICT = "0";

// Dynamic imports after env vars are set so modules see the right config.
const { executeAgentToolBatch } = await import("../lib/agent-loop-execute-tools.js");
const { createAgentSession, getAgentSession } = await import("../lib/agent-session.js");
const { createPolicyState } = await import("../lib/agent-policy.js");
const {
  getAgentRunEmitter,
  __resetAgentRunStreamForTests,
} = await import("../lib/agent-run-stream.js");

test.after(() => {
  if (prevStorage === undefined) delete process.env.STORAGE_PATH;
  else process.env.STORAGE_PATH = prevStorage;
  if (prevSessionApi === undefined) delete process.env.AGENT_SESSION_API;
  else process.env.AGENT_SESSION_API = prevSessionApi;
  if (prevToolValidation === undefined) delete process.env.TOOL_VALIDATION_STRICT;
  else process.env.TOOL_VALIDATION_STRICT = prevToolValidation;
  rmSync(dir, { recursive: true, force: true });
  __resetAgentRunStreamForTests();
});

// ---------------------------------------------------------------------------
// Helper: minimal trajectory collector stub
// ---------------------------------------------------------------------------
function makeTrajCollector() {
  const steps = [];
  return {
    record(step) { steps.push(step); },
    truncate(s, n) { return String(s).slice(0, n); },
    steps,
  };
}

// ---------------------------------------------------------------------------
// Test: parent calls spawn_subagent via executeAgentToolBatch, child uses a
// tool (search_context), result flows back to parent.
// ---------------------------------------------------------------------------
test("spawn_subagent e2e: parent spawns child that uses a tool, result flows back", async () => {
  // Create a parent agent session so events can be published.
  const parentSession = await createAgentSession({
    workspace: "default",
    ownerStorageUserId: "anonymous",
    title: "e2e parent session",
  });
  const parentSessId = parentSession.id;

  // Subscribe to session events to verify subagent.spawned / subagent.done.
  const emitter = getAgentRunEmitter(parentSessId);
  const capturedEvents = [];
  emitter.on("event", (ev) => capturedEvents.push(ev));

  // Track calls so the mock can distinguish parent context vs child context.
  // The child agent loop (runAgentLoop) will call backendFetch for each LLM
  // round. Child round 1 → search_context tool_call, round 2 → final text.
  let childRound = 0;

  async function mockBackendFetch(_url, opts) {
    const body = JSON.parse(opts.body);
    childRound++;
    if (childRound === 1) {
      // Child round 1: call search_context
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "child_tc_1",
                    type: "function",
                    function: {
                      name: "search_context",
                      arguments: JSON.stringify({ query: "capital of France" }),
                    },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
        }),
      };
    }
    // Child round 2: return final text
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          { message: { role: "assistant", content: "Paris" } },
        ],
        usage: { prompt_tokens: 200, completion_tokens: 10, total_tokens: 210 },
      }),
    };
  }

  function mockBuildProxyConfig(_model) {
    return { baseUrl: "http://mock", path: "/v1/chat/completions", headers: {} };
  }

  // Build the spawn_subagent tool call as the LLM would produce it.
  const toolCalls = [
    {
      id: "parent_tc_1",
      type: "function",
      function: {
        name: "spawn_subagent",
        arguments: JSON.stringify({
          goal: "Find the capital of France",
          profile: "researcher",
        }),
      },
    },
  ];

  const parentRunId = "parent-run-e2e-123";
  const policyState = createPolicyState({});
  const toolCallsLog = [];
  const trajCollector = makeTrajCollector();

  const out = await executeAgentToolBatch({
    toolCalls,
    iteration: 1,
    runId: parentRunId,
    toolCtx: {
      allowExecution: false,
      workspace: "default",
      workspaceUserId: "anonymous",
    },
    policyState,
    toolCallsLog,
    trajCollector,
    traceRequestId: undefined,
    setStopPolicy: () => {},
    agentOpts: { sessionId: parentSessId, depth: 0 },
    hitlContext: {},
    sessionId: parentSessId,
    // spawn_subagent wiring fields:
    backendFetch: mockBackendFetch,
    buildProxyConfig: mockBuildProxyConfig,
    currentTools: [
      { type: "function", function: { name: "search_context", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } },
      { type: "function", function: { name: "list_context", parameters: { type: "object", properties: {} } } },
      { type: "function", function: { name: "spawn_subagent", parameters: { type: "object", properties: { goal: { type: "string" } }, required: ["goal"] } } },
    ],
    currentModel: "test-model",
    depth: 0,
  });

  // --- Assertions ---

  // 1. Batch completed without HITL pause.
  assert.equal(out.hitlPause, null, "No HITL pause expected");

  // 2. We got exactly one result back.
  assert.equal(out.results.length, 1, "Should have 1 result");
  const spawnResult = JSON.parse(out.results[0].content);

  // 3. The spawn_subagent result is ok:true with "Paris" in the result.
  assert.equal(spawnResult.ok, true, `spawn_subagent should succeed, got: ${JSON.stringify(spawnResult)}`);
  assert.ok(
    spawnResult.result.includes("Paris"),
    `Expected child result to include "Paris", got: ${spawnResult.result}`,
  );

  // 4. Child session was created.
  assert.ok(spawnResult.childSessionId, "childSessionId should be present");
  const childSession = await getAgentSession(spawnResult.childSessionId);
  assert.ok(childSession, "Child session should exist in storage");
  assert.equal(childSession.workspace, "default");

  // 5. subagent.spawned event fired on the parent session emitter.
  const spawnedEvents = capturedEvents.filter((e) => e.type === "subagent.spawned");
  assert.ok(spawnedEvents.length >= 1, "subagent.spawned event should fire");
  assert.equal(spawnedEvents[0].payload.goal, "Find the capital of France");
  assert.equal(spawnedEvents[0].payload.profile, "researcher");
  assert.equal(spawnedEvents[0].payload.childSessionId, spawnResult.childSessionId);

  // 6. subagent.done event fired with result containing "Paris".
  const doneEvents = capturedEvents.filter((e) => e.type === "subagent.done");
  assert.ok(doneEvents.length >= 1, "subagent.done event should fire");
  assert.ok(
    doneEvents[0].payload.result.includes("Paris"),
    "subagent.done result should include Paris",
  );
  assert.equal(doneEvents[0].payload.childSessionId, spawnResult.childSessionId);

  // 7. The child agent loop exercised the mock backend (search_context + final).
  assert.ok(childRound >= 2, `Child should have at least 2 LLM rounds, got ${childRound}`);

  // 8. toolCallsLog was populated.
  const spawnLog = toolCallsLog.find((t) => t.name === "spawn_subagent");
  assert.ok(spawnLog, "spawn_subagent should appear in toolCallsLog");
  assert.ok(spawnLog.durationMs >= 0, "durationMs should be non-negative");

  // 9. Child iterations and tool calls are tracked.
  assert.ok(spawnResult.iterations >= 1, "Child should report iterations");

  // Clean up listener
  emitter.removeAllListeners();
});
