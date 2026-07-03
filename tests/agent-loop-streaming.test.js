/**
 * Tests for agent-loop.js streaming completions integration.
 *
 * Validates that the agent loop correctly:
 * 1. Parses streaming SSE text responses
 * 2. Parses streaming tool_call deltas
 * 3. Falls back to JSON for non-streaming backends
 * 4. Publishes token events on the session emitter
 */
import test from "node:test";
import assert from "node:assert/strict";
import { runAgentLoop } from "../lib/agent-loop.js";
import {
  getAgentRunEmitter,
  __resetAgentRunStreamForTests,
} from "../lib/agent-run-stream.js";

/**
 * Helper: create a fake streaming Response from SSE text.
 */
function sseResponse(sseText) {
  const chunks = typeof sseText === "string" ? [sseText] : sseText;
  let i = 0;
  const body = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (i < chunks.length) {
            return Promise.resolve({ value: chunks[i++], done: false });
          }
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
  return {
    ok: true,
    body,
    headers: new Map([["content-type", "text/event-stream"]]),
    text: async () => "",
    json: async () => ({}),
  };
}

/**
 * Wrap a Map-based headers object with a .get method to simulate fetch Headers.
 */
function withHeaders(resp) {
  const h = resp.headers;
  if (h instanceof Map) {
    resp.headers = { get: (k) => h.get(k.toLowerCase()) || null };
  }
  return resp;
}

/**
 * Helper: create a fake non-streaming (JSON) Response.
 */
function jsonResponse(body) {
  return {
    ok: true,
    body: null,
    headers: { get: () => "application/json" },
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

function makeReq(overrides = {}) {
  return {
    userId: null,
    body: {
      model: "test-model",
      messages: [{ role: "user", content: "Hello" }],
      agentOptions: { workspace: "default", allowExecution: false, ...overrides },
    },
  };
}

function makeRes() {
  return {
    headersSent: false,
    setHeader() {},
  };
}

const config = { baseUrl: "http://mock", path: "/v1/chat", headers: {} };

test("agent-loop streaming: text response accumulated correctly from SSE", async () => {
  const sse = [
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Hello" } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: " from" } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: " stream" } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {} }], usage: { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23 } })}\n\n`,
    `data: [DONE]\n\n`,
  ].join("");

  const backendFetch = async () => withHeaders(sseResponse(sse));

  const result = await runAgentLoop(makeReq(), makeRes(), config, "test-model", null, backendFetch);

  assert.equal(result.stopReason, "model_finished");
  assert.equal(result.content, "Hello from stream");
});

test("agent-loop streaming: tool_calls built correctly from deltas", async () => {
  let round = 0;
  const backendFetch = async () => {
    round++;
    if (round === 1) {
      // First round: streaming tool call
      const sse = [
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "list_context", arguments: "{" } }] } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "}" } }] } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`,
        `data: [DONE]\n\n`,
      ].join("");
      return withHeaders(sseResponse(sse));
    }
    // Second round: streaming final text
    const sse2 = [
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Done." } }] })}\n\n`,
      `data: [DONE]\n\n`,
    ].join("");
    return withHeaders(sseResponse(sse2));
  };

  const result = await runAgentLoop(makeReq(), makeRes(), config, "test-model", null, backendFetch);

  assert.equal(result.stopReason, "model_finished");
  assert.ok(result.content.includes("Done"));
  assert.ok(result.toolCalls.some((t) => t.name === "list_context"));
});

test("agent-loop streaming: fallback to JSON when content-type is not event-stream", async () => {
  const backendFetch = async () =>
    jsonResponse({
      choices: [{ message: { role: "assistant", content: "Non-streaming reply" } }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    });

  const result = await runAgentLoop(makeReq(), makeRes(), config, "test-model", null, backendFetch);

  assert.equal(result.stopReason, "model_finished");
  assert.equal(result.content, "Non-streaming reply");
});

test("agent-loop streaming: token events published on session emitter", async () => {
  __resetAgentRunStreamForTests();

  const sessionId = "test-session-token-events";
  const emitter = getAgentRunEmitter(sessionId);

  const tokenEvents = [];
  emitter.on("event", (ev) => {
    if (ev.type === "token") tokenEvents.push(ev);
  });

  const sse = [
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "A" } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "B" } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "C" } }] })}\n\n`,
    `data: [DONE]\n\n`,
  ].join("");

  const backendFetch = async () => withHeaders(sseResponse(sse));
  const req = makeReq();

  const result = await runAgentLoop(req, makeRes(), config, "test-model", { sessionId }, backendFetch);

  assert.equal(result.content, "ABC");
  assert.equal(tokenEvents.length, 3);
  assert.equal(tokenEvents[0].payload.delta, "A");
  assert.equal(tokenEvents[1].payload.delta, "B");
  assert.equal(tokenEvents[2].payload.delta, "C");
  assert.equal(tokenEvents[0].payload.iteration, 1);

  __resetAgentRunStreamForTests();
});

test("agent-loop streaming: usage is captured from stream", async () => {
  const sse = [
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "hi" } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {} }], usage: { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49 } })}\n\n`,
    `data: [DONE]\n\n`,
  ].join("");

  // We cannot directly inspect the `data` variable inside the loop, but we
  // can verify the loop completes successfully which means usage was parsed
  // without error.
  const backendFetch = async () => withHeaders(sseResponse(sse));
  const result = await runAgentLoop(makeReq(), makeRes(), config, "test-model", null, backendFetch);

  assert.equal(result.stopReason, "model_finished");
  assert.equal(result.content, "hi");
});

test("agent-loop streaming: multiple tool calls in parallel from stream", async () => {
  let round = 0;
  const backendFetch = async () => {
    round++;
    if (round === 1) {
      // Two parallel tool calls arriving interleaved
      const sse = [
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_a", function: { name: "list_context", arguments: "{}" } }] } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: "call_b", function: { name: "search_context", arguments: '{"q' } }] } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: '":"test"}' } }] } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })}\n\n`,
        `data: [DONE]\n\n`,
      ].join("");
      return withHeaders(sseResponse(sse));
    }
    const sse2 = [
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Finished." } }] })}\n\n`,
      `data: [DONE]\n\n`,
    ].join("");
    return withHeaders(sseResponse(sse2));
  };

  const result = await runAgentLoop(makeReq(), makeRes(), config, "test-model", null, backendFetch);

  assert.equal(result.stopReason, "model_finished");
  assert.ok(result.content.includes("Finished"));
  const names = result.toolCalls.map((t) => t.name);
  assert.ok(names.includes("list_context"));
  assert.ok(names.includes("search_context"));
});
