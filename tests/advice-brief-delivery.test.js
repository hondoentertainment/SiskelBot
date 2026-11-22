import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { createScheduledAgent, runScheduledAgent } from "../lib/scheduled-agents.js";
import { MORNING_BRIEF_AGENT_NAME } from "../lib/advice-brief.js";
import {
  saveBriefDeliveryPrefs,
  getBriefDeliveryPrefs,
  deliverFinishedBrief,
  latestMorningBriefRun,
} from "../lib/advice-brief-delivery.js";
import { mountAdviceRoutes } from "../routes/advice.js";

function isolate(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "brief-del-"));
    const prev = process.env.STORAGE_PATH;
    process.env.STORAGE_PATH = dir;
    try {
      await fn();
    } finally {
      if (prev === undefined) delete process.env.STORAGE_PATH;
      else process.env.STORAGE_PATH = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test("delivery channels default off and ignore a configured sender", isolate(async () => {
  const prefs = await getBriefDeliveryPrefs("ada");
  assert.deepEqual(prefs, { email: false, push: false, slack: false, emailTo: "" });
  let calls = 0;
  const result = await deliverFinishedBrief(
    { workspaceId: "default", userId: "ada", response: "Walk before the meeting." },
    { sendEmail: async () => { calls += 1; }, emailConfigured: true, prefs },
  );
  assert.equal(calls, 0);
  assert.deepEqual(result.delivered, { email: false, push: false, slack: false });
}));

test("opted-in email, push, and slack receive the recommendation", isolate(async () => {
  const prefs = await saveBriefDeliveryPrefs("ada", {
    email: true,
    emailTo: "ada@example.com",
    push: true,
    slack: true,
  });
  const sent = [];
  const result = await deliverFinishedBrief(
    { workspaceId: "ws", userId: "ada", response: "Ship the brief.", runId: "r1" },
    {
      prefs,
      emailConfigured: true,
      slackConfigured: true,
      sendEmail: async (to, subject, body) => sent.push({ to, subject, body }),
      notifyUser: async (userId, title, body) => {
        sent.push({ userId, title, body });
        return { sent: 1, failed: 0, results: [] };
      },
      notifySlack: async (event, data) => sent.push({ event, summary: data.summary }),
    },
  );
  assert.deepEqual(result.delivered, { email: true, push: true, slack: true });
  assert.equal(sent[0].to, "ada@example.com");
  assert.match(sent[0].body, /Ship the brief/);
  assert.equal(sent[1].title, "Morning brief");
  assert.equal(sent[2].event, "schedule_completed");
  assert.match(sent[2].summary, /Ship the brief/);
}));

test("email opt-in without an address is rejected", isolate(async () => {
  await assert.rejects(
    () => saveBriefDeliveryPrefs("ada", { email: true, emailTo: "not-an-email" }),
    /emailTo/,
  );
}));

test("a finished scheduled run is visible only to its owner", isolate(async () => {
  const agent = await createScheduledAgent({
    workspaceId: "ws",
    name: MORNING_BRIEF_AGENT_NAME,
    cron: "0 8 * * *",
    prompt: "Deliver a brief.",
    ownerUserId: "ada",
  });
  let mailed = 0;
  await saveBriefDeliveryPrefs("ada", { email: true, emailTo: "ada@example.com", push: false, slack: false });
  const run = await runScheduledAgent("ws", agent.id, {
    briefDeliveryDeps: {
      emailConfigured: true,
      sendEmail: async () => { mailed += 1; },
    },
  });
  assert.equal(run.status, "completed");
  assert.equal(mailed, 1);
  const mine = await latestMorningBriefRun("ws", "ada");
  assert.match(mine.run.response, /Deliver a brief|honest advice|dry-run/i);
  const other = await latestMorningBriefRun("ws", "grace");
  assert.equal(other.run, null);
}));

test("delivery routes save prefs and hide other owners", isolate(async () => {
  const app = express();
  app.use(express.json());
  const apiError = (res, status, code, msg) => res.status(status).json({ error: msg, code });
  mountAdviceRoutes(app, {
    apiRoute: (method, path, ...handlers) => app[method](`/api/v1${path}`, ...handlers),
    apiError,
    logRequest: (_q, _s, n) => n(),
    userAuth: (req, _res, next) => {
      req.userId = "ada";
      next();
    },
    sanitizeWorkspace: (w) => (typeof w === "string" && w.trim() ? w.trim() : "default"),
  });
  const bad = await request(app).put("/api/v1/advice/brief/delivery").send({ email: true, emailTo: "nope" });
  assert.equal(bad.status, 400);
  const saved = await request(app).put("/api/v1/advice/brief/delivery").send({
    email: true,
    emailTo: "ada@example.com",
    push: false,
    slack: false,
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.email, true);
  const latest = await request(app).get("/api/v1/advice/brief/latest").query({ workspace: "empty-ws" });
  assert.equal(latest.status, 200);
  assert.equal(latest.body.run, null);
}));
