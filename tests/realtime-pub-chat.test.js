/**
 * Verifies streaming chat deltas are additively published to the unified
 * realtime channel registry (`chat:<conversationId>`) in addition to the
 * existing SSE write path.
 *
 * The publication is a side-effect of `pipeLlmChatStreamToSse` when the
 * optional `conversationId` opt is provided. When it isn't, nothing is
 * published (legacy behavior preserved).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { pipeLlmChatStreamToSse } from "../lib/llm-stream-sse.js";
import { defaultChannelRegistry } from "../lib/realtime-channels.js";

function mockRes() {
  const chunks = [];
  return {
    write(data) { chunks.push(data); },
    get chunks() { return chunks; },
    get text() { return chunks.join(""); },
  };
}

function mockStreamingBackend(parts) {
  const encoder = new TextEncoder();
  const sseData = parts
    .map((p) => `data: ${JSON.stringify({ choices: [{ delta: { content: p }, index: 0 }] })}\n\n`)
    .join("") + "data: [DONE]\n\n";
  const payload = [encoder.encode(sseData)];
  let idx = 0;
  return async () => ({
    ok: true,
    body: {
      getReader: () => ({
        read: async () => {
          if (idx < payload.length) return { done: false, value: payload[idx++] };
          return { done: true, value: undefined };
        },
      }),
    },
  });
}

test("publishes chat deltas to chat:<conversationId> when conversationId is provided", async () => {
  const convoId = `test-chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const channel = `chat:${convoId}`;

  const received = [];
  defaultChannelRegistry.subscribe(channel, "test-sub-1", (ev) => received.push(ev));

  const res = mockRes();
  const fetch = mockStreamingBackend(["Hello", " ", "world"]);
  const result = await pipeLlmChatStreamToSse(
    res,
    fetch,
    "http://test/v1/chat",
    {},
    {},
    { conversationId: convoId }
  );

  assert.equal(result.fullText, "Hello world");
  // Existing SSE emission must still produce output.
  assert.ok(res.text.includes("Hello"), "SSE writes still happen");

  assert.equal(received.length, 3, "three deltas published");
  for (let i = 0; i < received.length; i++) {
    assert.equal(received[i].channel, channel);
    assert.equal(received[i].payload.role, "assistant");
    assert.equal(received[i].payload.index, i, "indexes are sequential starting at 0");
    assert.equal(typeof received[i].payload.delta, "string");
  }
  assert.deepEqual(
    received.map((ev) => ev.payload.delta),
    ["Hello", " ", "world"]
  );

  defaultChannelRegistry.unsubscribe(channel, "test-sub-1");
});

test("does NOT publish when conversationId is absent (zero behavior change)", async () => {
  // Subscribe to a wildcard-ish channel to ensure nothing new appears.
  // We simply count publishes on every channel that starts with "chat:"
  // by snapshotting stats before/after.
  const before = defaultChannelRegistry.stats().channels;

  const res = mockRes();
  const fetch = mockStreamingBackend(["x", "y"]);
  // No opts arg at all — signature still works.
  const result = await pipeLlmChatStreamToSse(res, fetch, "http://test/v1/chat", {}, {});
  assert.equal(result.fullText, "xy");
  assert.ok(res.text.includes("x"));

  const after = defaultChannelRegistry.stats().channels;
  assert.equal(after, before, "no new channels created when conversationId missing");
});

test("handles non-streaming backend path (emitFullStop) and still publishes", async () => {
  const convoId = `test-chat-fullstop-${Date.now()}`;
  const channel = `chat:${convoId}`;

  const received = [];
  defaultChannelRegistry.subscribe(channel, "test-sub-2", (ev) => received.push(ev));

  const res = mockRes();
  const backendFetch = async () => ({
    ok: true,
    body: null,
    json: async () => ({ choices: [{ message: { content: "final-text" } }] }),
  });

  const result = await pipeLlmChatStreamToSse(
    res,
    backendFetch,
    "http://test/v1/chat",
    {},
    {},
    { conversationId: convoId }
  );
  assert.equal(result.fullText, "final-text");
  assert.equal(received.length, 1);
  assert.equal(received[0].payload.delta, "final-text");
  assert.equal(received[0].payload.role, "assistant");
  assert.equal(received[0].payload.index, 0);

  defaultChannelRegistry.unsubscribe(channel, "test-sub-2");
});

test("publish failures do not break the SSE response", async () => {
  const convoId = `test-chat-fail-${Date.now()}`;
  const channel = `chat:${convoId}`;

  // Subscriber throws — registry's fanOut swallows but the test also ensures
  // the pipe still returns fullText correctly regardless.
  defaultChannelRegistry.subscribe(channel, "noisy-sub", () => {
    throw new Error("boom");
  });

  const res = mockRes();
  const fetch = mockStreamingBackend(["ok"]);
  const result = await pipeLlmChatStreamToSse(
    res,
    fetch,
    "http://test/v1/chat",
    {},
    {},
    { conversationId: convoId }
  );
  assert.equal(result.fullText, "ok");
  assert.ok(res.text.includes("ok"));

  defaultChannelRegistry.unsubscribe(channel, "noisy-sub");
});
