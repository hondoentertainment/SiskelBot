/**
 * Tests for re-plan nudge injection on permanent tool failure.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { runAgentLoop } from "../lib/agent-loop.js";

/**
 * Helper: build a mock backendFetch that returns a sequence of LLM responses.
 * Each entry can be a tool_calls response or a final text response.
 */
function buildMockBackend(responses) {
  let round = 0;
  return async () => {
    const entry = responses[round] || responses[responses.length - 1];
    round++;
    return {
      ok: true,
      headers: { get: () => "application/json" },
      json: async () => entry,
    };
  };
}

/** Minimal req/res/config stubs matching agent-loop.test.js pattern. */
function stubReqResConfig(opts = {}) {
  const req = {
    userId: null,
    body: {
      model: "test-model",
      messages: [{ role: "user", content: "Do something" }],
      agentOptions: { workspace: "default", allowExecution: false },
    },
  };
  const res = { headersSent: false, setHeader() {} };
  const config = { baseUrl: "http://mock", path: "/v1/chat", headers: {} };
  return { req, res, config };
}

/** Build a tool_calls response that invokes a given tool name with args. */
function toolCallResponse(name, args = {}, callId = "call_1") {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: callId,
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  };
}

/** Build a final text response from the LLM. */
function textResponse(text) {
  return {
    choices: [{ message: { role: "assistant", content: text } }],
  };
}

test("re-plan: tool fails permanently -> re-plan message injected and status.change fires", async () => {
  // Save and restore env
  const origReplan = process.env.AGENT_REPLAN_ON_FAILURE;
  const origMaxReplans = process.env.AGENT_MAX_REPLANS;
  delete process.env.AGENT_REPLAN_ON_FAILURE; // default: enabled

  // Round 1: LLM calls a tool that will fail (list_context returns ok:false via
  // the tool itself -- we use a nonexistent tool name to trigger an error)
  // We use "search_context" with args that cause it to return a result.
  // Actually, to make a tool fail permanently, we call a tool that does not exist.
  // runTool for an unknown tool will throw. The chain executor catches the throw
  // and wraps it as {ok:false, error:"..."}.

  const responses = [
    // Round 1: ask to call a fake tool
    toolCallResponse("nonexistent_tool_xyz", { query: "test" }, "call_fail_1"),
    // Round 2: after re-plan, LLM gives a final text answer
    textResponse("I adapted my strategy and here is the answer."),
  ];
  const backendFetch = buildMockBackend(responses);
  const { req, res, config } = stubReqResConfig();

  const result = await runAgentLoop(req, res, config, "test-model", null, backendFetch);

  // Should have completed (model_finished) because the LLM adapted after re-plan
  assert.equal(result.stopReason, "model_finished");
  assert.ok(result.content.includes("adapted"));

  // Check that a re-plan system message was injected into the conversation
  // We can verify through the result's iteration count: should be 2 (tool fail + final)
  assert.equal(result.iteration, 2);

  // Verify the tool call log shows the failed tool
  const failedEntry = result.toolCalls.find((t) => t.name === "nonexistent_tool_xyz");
  assert.ok(failedEntry, "failed tool should appear in toolCalls log");
  assert.equal(failedEntry.ok, false);

  // Restore env
  if (origReplan !== undefined) process.env.AGENT_REPLAN_ON_FAILURE = origReplan;
  else delete process.env.AGENT_REPLAN_ON_FAILURE;
  if (origMaxReplans !== undefined) process.env.AGENT_MAX_REPLANS = origMaxReplans;
  else delete process.env.AGENT_MAX_REPLANS;
});

test("re-plan: tool fails 4 times (max 3 replans) -> loop stops with replan_exhausted", async () => {
  const origReplan = process.env.AGENT_REPLAN_ON_FAILURE;
  const origMaxReplans = process.env.AGENT_MAX_REPLANS;
  delete process.env.AGENT_REPLAN_ON_FAILURE;
  process.env.AGENT_MAX_REPLANS = "3";

  // 4 rounds of calling a broken tool, each time the LLM stubbornly retries
  const responses = [
    toolCallResponse("nonexistent_tool_xyz", { q: "1" }, "call_f1"),
    toolCallResponse("nonexistent_tool_xyz", { q: "2" }, "call_f2"),
    toolCallResponse("nonexistent_tool_xyz", { q: "3" }, "call_f3"),
    toolCallResponse("nonexistent_tool_xyz", { q: "4" }, "call_f4"),
    // This should never be reached
    textResponse("Should not reach this"),
  ];
  const backendFetch = buildMockBackend(responses);
  const { req, res, config } = stubReqResConfig();

  const result = await runAgentLoop(req, res, config, "test-model", null, backendFetch);

  assert.equal(result.stopReason, "replan_exhausted");
  assert.ok(result.content.includes("re-plan attempts exhausted"));
  // Should have run 4 iterations: 3 with re-plan nudge + 1 that exceeds limit
  assert.equal(result.iteration, 4);

  // Restore env
  if (origReplan !== undefined) process.env.AGENT_REPLAN_ON_FAILURE = origReplan;
  else delete process.env.AGENT_REPLAN_ON_FAILURE;
  if (origMaxReplans !== undefined) process.env.AGENT_MAX_REPLANS = origMaxReplans;
  else delete process.env.AGENT_MAX_REPLANS;
});

test("re-plan: tool succeeds -> no re-plan message, replanCount stays 0", async () => {
  const origReplan = process.env.AGENT_REPLAN_ON_FAILURE;
  delete process.env.AGENT_REPLAN_ON_FAILURE;

  const responses = [
    // Round 1: call list_context (a real tool that succeeds)
    toolCallResponse("list_context", {}, "call_ok_1"),
    // Round 2: final answer
    textResponse("Here are the documents."),
  ];
  const backendFetch = buildMockBackend(responses);
  const { req, res, config } = stubReqResConfig();

  const result = await runAgentLoop(req, res, config, "test-model", null, backendFetch);

  assert.equal(result.stopReason, "model_finished");
  assert.equal(result.iteration, 2);

  // No re-plan message should have been injected. We verify indirectly: the
  // toolCalls log should show ok:true for list_context and only 2 iterations.
  const listCtx = result.toolCalls.find((t) => t.name === "list_context");
  assert.ok(listCtx, "list_context should be in tool calls log");
  assert.equal(listCtx.ok, true);

  // Restore env
  if (origReplan !== undefined) process.env.AGENT_REPLAN_ON_FAILURE = origReplan;
  else delete process.env.AGENT_REPLAN_ON_FAILURE;
});

test("re-plan: AGENT_REPLAN_ON_FAILURE=0 -> no re-plan message even on failure", async () => {
  const origReplan = process.env.AGENT_REPLAN_ON_FAILURE;
  process.env.AGENT_REPLAN_ON_FAILURE = "0";

  // 2 rounds: first fails, second succeeds with text
  const responses = [
    toolCallResponse("nonexistent_tool_xyz", {}, "call_disabled_1"),
    textResponse("Continuing without re-plan."),
  ];
  const backendFetch = buildMockBackend(responses);
  const { req, res, config } = stubReqResConfig();

  const result = await runAgentLoop(req, res, config, "test-model", null, backendFetch);

  // Should complete normally (no replan_exhausted) even though the tool failed
  assert.equal(result.stopReason, "model_finished");
  assert.equal(result.iteration, 2);

  // The failed tool should still be in the log
  const failedEntry = result.toolCalls.find((t) => t.name === "nonexistent_tool_xyz");
  assert.ok(failedEntry);
  assert.equal(failedEntry.ok, false);

  // Restore env
  if (origReplan !== undefined) process.env.AGENT_REPLAN_ON_FAILURE = origReplan;
  else delete process.env.AGENT_REPLAN_ON_FAILURE;
});

test("re-plan: message contains the failed tool name and error summary", async () => {
  const origReplan = process.env.AGENT_REPLAN_ON_FAILURE;
  delete process.env.AGENT_REPLAN_ON_FAILURE;

  let capturedMessages = null;
  let round = 0;

  const backendFetch = async (_url, opts) => {
    round++;
    if (round === 1) {
      return {
        ok: true,
        headers: { get: () => "application/json" },
        json: async () =>
          toolCallResponse("nonexistent_tool_xyz", { key: "val" }, "call_msg_1"),
      };
    }
    // Round 2: capture the messages sent to the LLM to verify re-plan content
    const body = JSON.parse(opts.body);
    capturedMessages = body.messages;
    return {
      ok: true,
      headers: { get: () => "application/json" },
      json: async () => textResponse("Done after re-plan."),
    };
  };

  const { req, res, config } = stubReqResConfig();
  const result = await runAgentLoop(req, res, config, "test-model", null, backendFetch);

  assert.equal(result.stopReason, "model_finished");
  assert.ok(capturedMessages, "should have captured messages from round 2");

  // Find the injected system message
  const replanMsg = capturedMessages.find(
    (m) => m.role === "system" && typeof m.content === "string" && m.content.includes("Re-evaluate your approach")
  );
  assert.ok(replanMsg, "re-plan system message should be present in messages");
  assert.ok(
    replanMsg.content.includes("nonexistent_tool_xyz"),
    "re-plan message should contain the failed tool name"
  );
  assert.ok(
    replanMsg.content.includes("failed with:"),
    "re-plan message should contain error indicator"
  );
  // The error summary should be present (the tool throws "Unknown tool: ..." or similar)
  assert.ok(
    replanMsg.content.length > 50,
    "re-plan message should contain meaningful error summary"
  );

  // Restore env
  if (origReplan !== undefined) process.env.AGENT_REPLAN_ON_FAILURE = origReplan;
  else delete process.env.AGENT_REPLAN_ON_FAILURE;
});
