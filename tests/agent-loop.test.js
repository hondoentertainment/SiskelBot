/**
 * Integration-style test: mocked LLM backend, real tool execution (list_context).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { runAgentLoop } from "../lib/agent-loop.js";

test("runAgentLoop: mock backend returns tool_calls then final text", async () => {
  let round = 0;
  const backendFetch = async () => {
    round++;
    if (round === 1) {
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
                    id: "call_1",
                    type: "function",
                    function: { name: "list_context", arguments: "{}" },
                  },
                ],
              },
            },
          ],
        }),
      };
    }
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { role: "assistant", content: "All done." } }],
      }),
    };
  };

  const req = {
    userId: null,
    body: {
      model: "test-model",
      messages: [{ role: "user", content: "List context" }],
      agentOptions: { workspace: "default", allowExecution: false },
    },
  };
  const res = {
    headersSent: false,
    setHeader() {},
  };
  const config = { baseUrl: "http://mock", path: "/v1/chat", headers: {} };

  const result = await runAgentLoop(req, res, config, "test-model", null, backendFetch);
  assert.equal(result.stopReason, "model_finished");
  assert.ok(String(result.content).includes("done"));
  assert.ok(result.toolCalls.some((t) => t.name === "list_context"));
});
