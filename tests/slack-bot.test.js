import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "crypto";
import { verifySlackSignature, handleSlackEvent, isSlackConfigured } from "../lib/slack-bot.js";

const TEST_SECRET = "test_signing_secret_abc123";

function makeValidSignature(secret, timestamp, body) {
  const baseString = `v0:${timestamp}:${body}`;
  return "v0=" + createHmac("sha256", secret).update(baseString).digest("hex");
}

test("verifySlackSignature with valid signature returns valid", () => {
  const ts = Math.floor(Date.now() / 1000).toString();
  const body = '{"type":"url_verification"}';
  const sig = makeValidSignature(TEST_SECRET, ts, body);

  const result = verifySlackSignature(TEST_SECRET, ts, body, sig);
  assert.equal(result.valid, true);
});

test("verifySlackSignature rejects invalid signature", () => {
  const ts = Math.floor(Date.now() / 1000).toString();
  const body = '{"type":"url_verification"}';
  const sig = "v0=0000000000000000000000000000000000000000000000000000000000000000";

  const result = verifySlackSignature(TEST_SECRET, ts, body, sig);
  assert.equal(result.valid, false);
  assert.equal(result.reason, "Invalid signature");
});

test("verifySlackSignature rejects expired timestamp", () => {
  const ts = Math.floor(Date.now() / 1000 - 600).toString(); // 10 minutes ago
  const body = '{"type":"test"}';
  const sig = makeValidSignature(TEST_SECRET, ts, body);

  const result = verifySlackSignature(TEST_SECRET, ts, body, sig);
  assert.equal(result.valid, false);
  assert.equal(result.reason, "Request too old");
});

test("verifySlackSignature rejects missing signing secret", () => {
  const result = verifySlackSignature("", "12345", "body", "v0=abc");
  assert.equal(result.valid, false);
  assert.ok(result.reason.includes("not configured"));
});

test("verifySlackSignature rejects missing headers", () => {
  const result = verifySlackSignature(TEST_SECRET, null, "body", null);
  assert.equal(result.valid, false);
  assert.ok(result.reason.includes("Missing"));
});

test("handleSlackEvent handles url_verification challenge", async () => {
  const result = await handleSlackEvent({
    type: "url_verification",
    challenge: "test_challenge_token",
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.challenge, "test_challenge_token");
});

test("handleSlackEvent handles app_mention event", async () => {
  const result = await handleSlackEvent({
    type: "event_callback",
    event: {
      type: "app_mention",
      text: "<@U123> hello bot",
      user: "U456",
      channel: "C789",
      ts: "1234567890.123456",
    },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
});

test("handleSlackEvent returns 200 for event_callback without event", async () => {
  const result = await handleSlackEvent({
    type: "event_callback",
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
});

test("handleSlackEvent returns 400 for invalid payload", async () => {
  const result = await handleSlackEvent(null);
  assert.equal(result.status, 400);
  assert.ok(result.body.error);
});

test("handleSlackEvent returns 200 for unknown event type", async () => {
  const result = await handleSlackEvent({ type: "unknown_type" });
  assert.equal(result.status, 200);
});

test("isSlackConfigured returns false when env not set", () => {
  // The module reads env at import time; since we have not set
  // SLACK_BOT_TOKEN or SLACK_WEBHOOK_URL, it should be false.
  assert.equal(isSlackConfigured(), false);
});
