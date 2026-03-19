/**
 * Phase 33: Real-Time Sync & Presence tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  createToken,
  consumeToken,
  broadcastNotification,
  getOnlineUsers,
} from "../lib/realtime.js";

test("createToken returns token and url", () => {
  const { token, url } = createToken("user1", "default");
  assert.ok(typeof token === "string");
  assert.ok(token.length > 10);
  assert.ok(typeof url === "string");
  assert.match(url, /\/ws\?token=/);
  assert.match(url, /workspace=default/);
});

test("consumeToken validates token and returns userId/workspaceId", () => {
  const { token } = createToken("user2", "my-ws");
  const result = consumeToken(token);
  assert.ok(result);
  assert.equal(result.userId, "user2");
  assert.equal(result.workspaceId, "my-ws");
});

test("consumeToken returns null for invalid token", () => {
  const result = consumeToken("invalid-token");
  assert.equal(result, null);
});

test("consumeToken is one-time use", () => {
  const { token } = createToken("user3", "default");
  const r1 = consumeToken(token);
  const r2 = consumeToken(token);
  assert.ok(r1);
  assert.equal(r2, null);
});

test("getOnlineUsers returns empty array when no presence", () => {
  const online = getOnlineUsers("default");
  assert.ok(Array.isArray(online));
  assert.equal(online.length, 0);
});

test("broadcastNotification does not throw", () => {
  assert.doesNotThrow(() => {
    broadcastNotification("anonymous", "default", {
      id: "test-1",
      type: "generic",
      title: "Test",
      body: "Body",
      createdAt: new Date().toISOString(),
      read: false,
    });
  });
});
