/**
 * Tests for lib/agent-stream-parser.js — SSE completion stream parser.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parseCompletionStream } from "../lib/agent-stream-parser.js";

/**
 * Helper: create a fake Response whose body is an async iterable yielding the
 * given string in one or more chunks.
 */
function fakeResponse(sseText, { contentType = "text/event-stream" } = {}) {
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
    body,
    headers: {
      get(name) {
        if (name.toLowerCase() === "content-type") return contentType;
        return null;
      },
    },
  };
}

test("parseCompletionStream: 3 text deltas + 1 tool_call_delta + usage + [DONE]", async () => {
  const sse = [
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Hello" } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: " world" } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "!" } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "list_context", arguments: '{"q":' } }] } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`,
    `data: [DONE]\n\n`,
  ].join("");

  const response = fakeResponse(sse);
  const chunks = [];
  for await (const chunk of parseCompletionStream(response)) {
    chunks.push(chunk);
  }

  // 3 deltas
  const deltas = chunks.filter((c) => c.type === "delta");
  assert.equal(deltas.length, 3);
  assert.equal(deltas[0].content, "Hello");
  assert.equal(deltas[1].content, " world");
  assert.equal(deltas[2].content, "!");
  assert.equal(deltas[0].index, 0);

  // 1 tool_call_delta
  const tcDeltas = chunks.filter((c) => c.type === "tool_call_delta");
  assert.equal(tcDeltas.length, 1);
  assert.equal(tcDeltas[0].index, 0);
  assert.equal(tcDeltas[0].id, "call_1");
  assert.equal(tcDeltas[0].name, "list_context");
  assert.equal(tcDeltas[0].arguments_delta, '{"q":');

  // 1 usage
  const usages = chunks.filter((c) => c.type === "usage");
  assert.equal(usages.length, 1);
  assert.equal(usages[0].prompt_tokens, 10);
  assert.equal(usages[0].completion_tokens, 5);
  assert.equal(usages[0].total_tokens, 15);

  // done
  const dones = chunks.filter((c) => c.type === "done");
  assert.equal(dones.length, 1);
});

test("parseCompletionStream: malformed line (no data: prefix) is skipped", async () => {
  const sse = [
    `not-a-valid-sse-line\n`,
    `random garbage\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "ok" } }] })}\n\n`,
    `data: [DONE]\n\n`,
  ].join("");

  const response = fakeResponse(sse);
  const chunks = [];
  for await (const chunk of parseCompletionStream(response)) {
    chunks.push(chunk);
  }

  const deltas = chunks.filter((c) => c.type === "delta");
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].content, "ok");
});

test("parseCompletionStream: data: [DONE] yields done chunk", async () => {
  const sse = `data: [DONE]\n\n`;
  const response = fakeResponse(sse);
  const chunks = [];
  for await (const chunk of parseCompletionStream(response)) {
    chunks.push(chunk);
  }
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].type, "done");
});

test("parseCompletionStream: empty content delta is yielded (not skipped)", async () => {
  const sse = [
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "" } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "a" } }] })}\n\n`,
    `data: [DONE]\n\n`,
  ].join("");

  const response = fakeResponse(sse);
  const chunks = [];
  for await (const chunk of parseCompletionStream(response)) {
    chunks.push(chunk);
  }

  const deltas = chunks.filter((c) => c.type === "delta");
  assert.equal(deltas.length, 2);
  assert.equal(deltas[0].content, "");
  assert.equal(deltas[1].content, "a");
});

test("parseCompletionStream: malformed JSON in data line is skipped", async () => {
  const sse = [
    `data: {not valid json}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "ok" } }] })}\n\n`,
    `data: [DONE]\n\n`,
  ].join("");

  const response = fakeResponse(sse);
  const chunks = [];
  for await (const chunk of parseCompletionStream(response)) {
    chunks.push(chunk);
  }

  const deltas = chunks.filter((c) => c.type === "delta");
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].content, "ok");
});

test("parseCompletionStream: no body yields only done", async () => {
  const response = { body: null, headers: { get() { return "text/event-stream"; } } };
  const chunks = [];
  for await (const chunk of parseCompletionStream(response)) {
    chunks.push(chunk);
  }
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].type, "done");
});

test("parseCompletionStream: multi-chunk tool_call accumulation across SSE frames", async () => {
  const sse = [
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "search_context", arguments: '{"q' } }] } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '":"hello' } }] } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"}' } }] } }] })}\n\n`,
    `data: [DONE]\n\n`,
  ].join("");

  const response = fakeResponse(sse);
  const chunks = [];
  for await (const chunk of parseCompletionStream(response)) {
    chunks.push(chunk);
  }

  const tcDeltas = chunks.filter((c) => c.type === "tool_call_delta");
  assert.equal(tcDeltas.length, 3);
  assert.equal(tcDeltas[0].id, "call_1");
  assert.equal(tcDeltas[0].name, "search_context");
  assert.equal(tcDeltas[0].arguments_delta, '{"q');
  // Subsequent deltas should not have id/name since the backend only sends them once
  assert.equal(tcDeltas[1].id, undefined);
  assert.equal(tcDeltas[1].arguments_delta, '":"hello');
  assert.equal(tcDeltas[2].arguments_delta, '"}');
});

test("parseCompletionStream: stream ending without [DONE] still yields done", async () => {
  const sse = [
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "hi" } }] })}\n\n`,
  ].join("");

  const response = fakeResponse(sse);
  const chunks = [];
  for await (const chunk of parseCompletionStream(response)) {
    chunks.push(chunk);
  }

  const dones = chunks.filter((c) => c.type === "done");
  assert.equal(dones.length, 1, "should emit a done even without [DONE] terminal");
});

test("parseCompletionStream: data split across multiple chunks", async () => {
  // Simulate the SSE text arriving in two separate network chunks, splitting
  // a line mid-way.
  const full = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "split" } }] })}\n\ndata: [DONE]\n\n`;
  const mid = Math.floor(full.length / 2);
  const chunk1 = full.slice(0, mid);
  const chunk2 = full.slice(mid);

  const response = fakeResponse([chunk1, chunk2]);
  const chunks = [];
  for await (const chunk of parseCompletionStream(response)) {
    chunks.push(chunk);
  }

  const deltas = chunks.filter((c) => c.type === "delta");
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].content, "split");
});
