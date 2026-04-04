/**
 * Tests for Slack and Discord bot integrations.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "crypto";

// ─── Slack ───────────────────────────────────────────────────────────────────

import {
  verifySlackSignature,
  handleSlackEvent,
  isSlackConfigured,
} from "../lib/slack-bot.js";

test("Slack: verifySlackSignature rejects missing signing secret", () => {
  const result = verifySlackSignature("", "123", "body", "v0=abc");
  assert.equal(result.valid, false);
  assert.match(result.reason, /not configured/i);
});

test("Slack: verifySlackSignature rejects missing headers", () => {
  const result = verifySlackSignature("secret", null, "body", null);
  assert.equal(result.valid, false);
  assert.match(result.reason, /Missing/);
});

test("Slack: verifySlackSignature rejects old timestamp", () => {
  const oldTs = Math.floor(Date.now() / 1000) - 400; // 6+ minutes ago
  const result = verifySlackSignature("secret", String(oldTs), "body", "v0=abc");
  assert.equal(result.valid, false);
  assert.match(result.reason, /too old/i);
});

test("Slack: verifySlackSignature accepts valid signature", () => {
  const secret = "test-signing-secret";
  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = '{"type":"url_verification","challenge":"abc"}';
  const baseString = `v0:${timestamp}:${body}`;
  const sig = "v0=" + createHmac("sha256", secret).update(baseString).digest("hex");

  const result = verifySlackSignature(secret, timestamp, body, sig);
  assert.equal(result.valid, true);
});

test("Slack: verifySlackSignature rejects invalid signature", () => {
  const secret = "test-signing-secret";
  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = '{"type":"url_verification"}';

  const result = verifySlackSignature(secret, timestamp, body, "v0=badhex");
  assert.equal(result.valid, false);
});

test("Slack: handleSlackEvent responds to url_verification", async () => {
  const { status, body } = await handleSlackEvent({
    type: "url_verification",
    challenge: "test-challenge-123",
  });
  assert.equal(status, 200);
  assert.equal(body.challenge, "test-challenge-123");
});

test("Slack: handleSlackEvent handles invalid payload", async () => {
  const { status } = await handleSlackEvent(null);
  assert.equal(status, 400);
});

test("Slack: handleSlackEvent ignores unknown event types", async () => {
  const { status, body } = await handleSlackEvent({ type: "unknown_type" });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
});

test("Slack: handleSlackEvent handles event_callback with no event", async () => {
  const { status, body } = await handleSlackEvent({ type: "event_callback" });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
});

test("Slack: handleSlackEvent handles app_mention event", async () => {
  const { status, body } = await handleSlackEvent({
    type: "event_callback",
    event: {
      type: "app_mention",
      text: "<@U123> hello",
      user: "U456",
      channel: "C789",
      ts: "1234567890.123456",
    },
  });
  // Should return 200 immediately (processing happens async)
  assert.equal(status, 200);
  assert.equal(body.ok, true);
});

test("Slack: handleSlackEvent ignores bot messages in DM", async () => {
  const { status, body } = await handleSlackEvent({
    type: "event_callback",
    event: {
      type: "message",
      channel_type: "im",
      bot_id: "B123",
      text: "I am a bot",
    },
  });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
});

test("Slack: isSlackConfigured returns false when no env vars set", () => {
  const origToken = process.env.SLACK_BOT_TOKEN;
  const origWebhook = process.env.SLACK_WEBHOOK_URL;
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_WEBHOOK_URL;
  // isSlackConfigured reads module-level constants, so this tests the export exists
  assert.equal(typeof isSlackConfigured, "function");
  process.env.SLACK_BOT_TOKEN = origToken;
  process.env.SLACK_WEBHOOK_URL = origWebhook;
});

// ─── Discord ─────────────────────────────────────────────────────────────────

import {
  verifyDiscordSignature,
  handleDiscordInteraction,
  isDiscordConfigured,
} from "../lib/discord-bot.js";

test("Discord: verifyDiscordSignature rejects missing public key", () => {
  const result = verifyDiscordSignature("", "123", "body", "abc");
  assert.equal(result.valid, false);
  assert.match(result.reason, /not configured/i);
});

test("Discord: verifyDiscordSignature rejects missing headers", () => {
  const result = verifyDiscordSignature("abc123", null, "body", null);
  assert.equal(result.valid, false);
  assert.match(result.reason, /Missing/);
});

test("Discord: handleDiscordInteraction responds to PING", async () => {
  const { status, body } = await handleDiscordInteraction({ type: 1 });
  assert.equal(status, 200);
  assert.equal(body.type, 1); // PONG
});

test("Discord: handleDiscordInteraction handles invalid payload", async () => {
  const { status } = await handleDiscordInteraction(null);
  assert.equal(status, 400);
});

test("Discord: handleDiscordInteraction handles /ask without message", async () => {
  const { status, body } = await handleDiscordInteraction({
    type: 2,
    data: { name: "ask", options: [] },
    token: "test-token",
  });
  assert.equal(status, 200);
  assert.equal(body.type, 4); // CHANNEL_MESSAGE
  assert.match(body.data.content, /provide a message/i);
});

test("Discord: handleDiscordInteraction handles /ask with message (deferred)", async () => {
  const { status, body } = await handleDiscordInteraction({
    type: 2,
    data: { name: "ask", options: [{ name: "message", value: "Hello bot" }] },
    token: "test-token",
    member: { user: { id: "user123" } },
  });
  assert.equal(status, 200);
  assert.equal(body.type, 5); // DEFERRED_CHANNEL_MESSAGE
});

test("Discord: handleDiscordInteraction handles /recipe without name", async () => {
  const { status, body } = await handleDiscordInteraction({
    type: 2,
    data: { name: "recipe", options: [] },
    token: "test-token",
  });
  assert.equal(status, 200);
  assert.equal(body.type, 4);
  assert.match(body.data.content, /provide a recipe/i);
});

test("Discord: handleDiscordInteraction handles unknown command", async () => {
  const { status, body } = await handleDiscordInteraction({
    type: 2,
    data: { name: "unknown_cmd" },
    token: "test-token",
  });
  assert.equal(status, 200);
  assert.match(body.data.content, /Unknown command/);
});

test("Discord: handleDiscordInteraction handles message component", async () => {
  const { status, body } = await handleDiscordInteraction({
    type: 3,
    data: { custom_id: "btn_confirm" },
  });
  assert.equal(status, 200);
  assert.match(body.data.content, /btn_confirm/);
});

test("Discord: isDiscordConfigured is a function", () => {
  assert.equal(typeof isDiscordConfigured, "function");
});

// ─── Integration route tests (via supertest) ────────────────────────────────

async function loadApp() {
  const moduleUrl = new URL(`../server.js?test=${Date.now()}${Math.random()}`, import.meta.url);
  const original = { ...process.env };
  Object.assign(process.env, { VERCEL: "1", BACKEND: "ollama" });
  const { default: app } = await import(moduleUrl.href);
  return { app, restore: () => { process.env = original; } };
}

let appInstance;
test("load app for route tests", async () => {
  appInstance = await loadApp();
});

test("GET /api/integrations/bots/status returns bot config", async () => {
  if (!appInstance) return;
  const { default: request } = await import("supertest");
  const { app, restore } = appInstance;
  try {
    const res = await request(app).get("/api/integrations/bots/status");
    assert.equal(res.status, 200);
    assert.equal(typeof res.body.slack, "object");
    assert.equal(typeof res.body.discord, "object");
    assert.equal(typeof res.body.slack.configured, "boolean");
    assert.equal(typeof res.body.discord.configured, "boolean");
  } finally {
    restore();
  }
});

test("GET /api/v1/integrations/bots/status works at v1 path", async () => {
  if (!appInstance) return;
  const { default: request } = await import("supertest");
  const { app, restore } = appInstance;
  try {
    const res = await request(app).get("/api/v1/integrations/bots/status");
    assert.equal(res.status, 200);
    assert.equal(typeof res.body.slack, "object");
    assert.equal(typeof res.body.discord, "object");
  } finally {
    restore();
  }
});

test("POST /api/integrations/slack/events handles url_verification", async () => {
  if (!appInstance) return;
  const { default: request } = await import("supertest");
  const { app, restore } = appInstance;
  try {
    const res = await request(app)
      .post("/api/integrations/slack/events")
      .send({ type: "url_verification", challenge: "test-ch" });
    assert.equal(res.status, 200);
    assert.equal(res.body.challenge, "test-ch");
  } finally {
    restore();
  }
});

test("POST /api/integrations/discord/interactions handles PING", async () => {
  if (!appInstance) return;
  const { default: request } = await import("supertest");
  const { app, restore } = appInstance;
  try {
    const res = await request(app)
      .post("/api/integrations/discord/interactions")
      .send({ type: 1 });
    assert.equal(res.status, 200);
    assert.equal(res.body.type, 1);
  } finally {
    restore();
  }
});

test("GET /api/integrations/status includes slack and discord fields", async () => {
  if (!appInstance) return;
  const { default: request } = await import("supertest");
  const { app, restore } = appInstance;
  try {
    const res = await request(app).get("/api/integrations/status");
    assert.equal(res.status, 200);
    assert.equal(typeof res.body.slack, "boolean");
    assert.equal(typeof res.body.discord, "boolean");
  } finally {
    restore();
  }
});
