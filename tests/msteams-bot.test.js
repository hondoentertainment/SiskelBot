/**
 * Microsoft Teams bot tests: config detection, mention stripping, token
 * pre-checks (no network), and activity handling with injected hooks.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  isTeamsConfigured,
  stripTeamsMentions,
  verifyTeamsToken,
  handleTeamsActivity,
} from "../lib/msteams-bot.js";

test("isTeamsConfigured is false without env", () => {
  delete process.env.TEAMS_APP_ID;
  delete process.env.TEAMS_APP_PASSWORD;
  assert.equal(isTeamsConfigured(), false);
});

test("stripTeamsMentions removes <at> tags", () => {
  assert.equal(stripTeamsMentions("<at>Siskel Bot</at> hello there"), "hello there");
  assert.equal(stripTeamsMentions("no mentions"), "no mentions");
  assert.equal(stripTeamsMentions(""), "");
  assert.equal(stripTeamsMentions("<at>a</at><at>b</at> hi"), "hi");
});

test("verifyTeamsToken rejects without config / header / malformed token", async () => {
  delete process.env.TEAMS_APP_ID;
  const noCfg = await verifyTeamsToken("Bearer abc");
  assert.equal(noCfg.valid, false);

  process.env.TEAMS_APP_ID = "app-123";
  const noHeader = await verifyTeamsToken(undefined);
  assert.equal(noHeader.valid, false);
  assert.match(noHeader.reason, /bearer/i);

  const malformed = await verifyTeamsToken("Bearer not-a-jwt");
  assert.equal(malformed.valid, false);

  // Well-formed JWT with wrong issuer fails before any network call.
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "k" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iss: "https://evil.example", aud: "app-123" })).toString("base64url");
  const badIss = await verifyTeamsToken(`Bearer ${header}.${payload}.sig`);
  assert.equal(badIss.valid, false);
  assert.match(badIss.reason, /issuer/i);

  // Wrong audience also fails locally.
  const payload2 = Buffer.from(JSON.stringify({ iss: "https://api.botframework.com", aud: "other-app" })).toString("base64url");
  const badAud = await verifyTeamsToken(`Bearer ${header}.${payload2}.sig`);
  assert.equal(badAud.valid, false);
  assert.match(badAud.reason, /audience/i);
  delete process.env.TEAMS_APP_ID;
});

test("handleTeamsActivity ignores non-message activities", async () => {
  const res = await handleTeamsActivity({ type: "conversationUpdate" });
  assert.equal(res.status, 200);
  assert.equal(res.body.ignored, "conversationUpdate");

  const bad = await handleTeamsActivity(null);
  assert.equal(bad.status, 400);
});

test("handleTeamsActivity forwards message text and replies", async () => {
  const calls = { forward: [], reply: [] };
  const activity = {
    type: "message",
    text: "<at>Bot</at> what is the status?",
    id: "act-1",
    serviceUrl: "https://smba.example",
    conversation: { id: "conv-1" },
    from: { id: "user-1" },
    recipient: { id: "bot-1" },
  };
  const res = await handleTeamsActivity(activity, {
    forward: async (text, userId) => {
      calls.forward.push({ text, userId });
      return "All systems green.";
    },
    reply: async (act, text) => {
      calls.reply.push({ conv: act.conversation.id, text });
    },
  });
  assert.equal(res.status, 200);

  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(calls.forward.length, 1);
  assert.equal(calls.forward[0].text, "what is the status?");
  assert.equal(calls.forward[0].userId, "user-1");
  assert.equal(calls.reply.length, 1);
  assert.equal(calls.reply[0].conv, "conv-1");
  assert.equal(calls.reply[0].text, "All systems green.");
});

test("handleTeamsActivity replies with an error message when forward fails", async () => {
  const replies = [];
  await handleTeamsActivity(
    { type: "message", text: "hi", conversation: { id: "c" }, from: {}, recipient: {} },
    {
      forward: async () => { throw new Error("backend down"); },
      reply: async (_act, text) => { replies.push(text); },
    }
  );
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(replies.length, 1);
  assert.match(replies[0], /backend down/);
});
