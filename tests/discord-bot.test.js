import test from "node:test";
import assert from "node:assert/strict";
import { verifyDiscordSignature, handleDiscordInteraction, isDiscordConfigured } from "../lib/discord-bot.js";

test("verifyDiscordSignature rejects when public key is empty", () => {
  const result = verifyDiscordSignature("", "timestamp", "body", "sig");
  assert.equal(result.valid, false);
  assert.ok(result.reason.includes("not configured"));
});

test("verifyDiscordSignature rejects missing headers", () => {
  const result = verifyDiscordSignature("abcd1234", null, "body", null);
  assert.equal(result.valid, false);
  assert.ok(result.reason.includes("Missing"));
});

test("verifyDiscordSignature rejects invalid signature gracefully", () => {
  // Use a fake but hex-formatted public key (32 bytes = 64 hex chars)
  const fakeKey = "a".repeat(64);
  const fakeSig = "b".repeat(128);
  const result = verifyDiscordSignature(fakeKey, "1234567890", '{"type":1}', fakeSig);
  assert.equal(result.valid, false);
  // Should not throw, just return invalid
  assert.ok(typeof result.reason === "string");
});

test("handleDiscordInteraction handles PING (type 1)", async () => {
  const result = await handleDiscordInteraction({ type: 1 });
  assert.equal(result.status, 200);
  assert.equal(result.body.type, 1); // PONG
});

test("handleDiscordInteraction handles APPLICATION_COMMAND ask without message", async () => {
  const result = await handleDiscordInteraction({
    type: 2,
    data: { name: "ask", options: [] },
    token: "interaction_token",
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.type, 4); // RESPONSE_CHANNEL_MESSAGE
  assert.ok(result.body.data.content.includes("provide a message"));
});

test("handleDiscordInteraction handles APPLICATION_COMMAND ask with message (deferred)", async () => {
  const result = await handleDiscordInteraction({
    type: 2,
    data: {
      name: "ask",
      options: [{ name: "message", value: "hello bot" }],
    },
    token: "interaction_token",
    member: { user: { id: "user123" } },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.type, 5); // RESPONSE_DEFERRED_CHANNEL_MESSAGE
});

test("handleDiscordInteraction handles APPLICATION_COMMAND recipe without name", async () => {
  const result = await handleDiscordInteraction({
    type: 2,
    data: { name: "recipe", options: [] },
    token: "interaction_token",
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.type, 4);
  assert.ok(result.body.data.content.includes("recipe name"));
});

test("handleDiscordInteraction handles unknown command", async () => {
  const result = await handleDiscordInteraction({
    type: 2,
    data: { name: "nonexistent" },
    token: "token",
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.type, 4);
  assert.ok(result.body.data.content.includes("Unknown command"));
});

test("handleDiscordInteraction handles MESSAGE_COMPONENT (type 3)", async () => {
  const result = await handleDiscordInteraction({
    type: 3,
    data: { custom_id: "btn_test" },
  });
  assert.equal(result.status, 200);
  assert.ok(result.body.data.content.includes("btn_test"));
});

test("handleDiscordInteraction returns 400 for invalid payload", async () => {
  const result = await handleDiscordInteraction(null);
  assert.equal(result.status, 400);
});

test("isDiscordConfigured returns false when env not set", () => {
  assert.equal(isDiscordConfigured(), false);
});
