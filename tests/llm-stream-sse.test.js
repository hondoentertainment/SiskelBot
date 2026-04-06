import test from "node:test";
import assert from "node:assert/strict";
import { pipeLlmChatStreamToSse } from "../lib/llm-stream-sse.js";

function mockRes() {
  const chunks = [];
  return {
    write(data) { chunks.push(data); },
    get chunks() { return chunks; },
    get text() { return chunks.join(""); },
  };
}

test("pipeLlmChatStreamToSse handles non-streaming response (no getReader)", async () => {
  const res = mockRes();
  const backendFetch = async () => ({
    ok: true,
    body: null, // no getReader
    json: async () => ({
      choices: [{ message: { content: "Hello from backend" } }],
    }),
  });

  const result = await pipeLlmChatStreamToSse(res, backendFetch, "http://test/v1/chat", {}, {});
  assert.equal(result.fullText, "Hello from backend");
  assert.ok(res.text.includes("Hello from backend"));
});

test("pipeLlmChatStreamToSse handles HTTP error", async () => {
  const res = mockRes();
  const backendFetch = async () => ({
    ok: false,
    status: 500,
    text: async () => "Internal Server Error",
  });

  const result = await pipeLlmChatStreamToSse(res, backendFetch, "http://test/v1/chat", {}, {});
  assert.equal(result.fullText, "");
  assert.ok(result.error);
  assert.ok(result.error.includes("Internal Server Error"));
});

test("pipeLlmChatStreamToSse handles fetch exception", async () => {
  const res = mockRes();
  const backendFetch = async () => {
    throw new Error("Network failure");
  };

  const result = await pipeLlmChatStreamToSse(res, backendFetch, "http://test/v1/chat", {}, {});
  assert.equal(result.fullText, "");
  assert.ok(result.error.includes("Network failure"));
});

test("pipeLlmChatStreamToSse streams SSE chunks from reader", async () => {
  const res = mockRes();
  const encoder = new TextEncoder();
  const sseData = [
    'data: {"choices":[{"delta":{"content":"Hi"},"index":0}]}\n\n',
    'data: {"choices":[{"delta":{"content":" there"},"index":0}]}\n\n',
    'data: {"choices":[{"delta":{},"index":0,"finish_reason":"stop"}]}\n\n',
    "data: [DONE]\n\n",
  ].join("");

  let readCount = 0;
  const chunks = [encoder.encode(sseData)];

  const backendFetch = async () => ({
    ok: true,
    body: {
      getReader: () => ({
        read: async () => {
          if (readCount < chunks.length) {
            return { done: false, value: chunks[readCount++] };
          }
          return { done: true, value: undefined };
        },
      }),
    },
  });

  const result = await pipeLlmChatStreamToSse(res, backendFetch, "http://test/v1/chat", {}, {});
  assert.equal(result.fullText, "Hi there");
  assert.ok(res.text.includes("Hi"));
  assert.ok(res.text.includes("there"));
});

test("pipeLlmChatStreamToSse handles empty non-streaming response", async () => {
  const res = mockRes();
  const backendFetch = async () => ({
    ok: true,
    body: null,
    json: async () => ({ choices: [{ message: { content: "" } }] }),
  });

  const result = await pipeLlmChatStreamToSse(res, backendFetch, "http://test/v1/chat", {}, {});
  assert.equal(result.fullText, "");
  assert.equal(res.chunks.length, 0);
});
