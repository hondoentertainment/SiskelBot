/**
 * Route tests for /agent/feedback and /admin/agent-feedback.
 * Follows the harness pattern of tests/agent-hitl-route.test.js.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "agent-feedback-route-"));
process.env.STORAGE_PATH = tmpRoot;

test.after(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
});

async function buildHarness({ userAuthed = true, adminAuthed = true } = {}) {
  const request = (await import("supertest")).default;
  const express = (await import("express")).default;
  const { mountAgentFeedbackRoutes } = await import("../routes/agent-feedback.js");

  const app = express();
  app.use(express.json());

  const apiRoute = (method, path, ...handlers) => {
    app[method](`/api/v1${path}`, ...handlers);
    app[method](`/api${path}`, ...handlers);
  };
  const apiError = (res, status, code, message, hint) => {
    res.status(status).json({ error: message, code, hint: hint || null });
  };
  const logRequest = (_req, _res, next) => next();

  const userAuth = userAuthed
    ? (req, _res, next) => {
        req.userId = "user-42";
        req.apiKeyScopes = ["read", "write"];
        next();
      }
    : (_req, res) => res.status(401).json({ error: "Unauthorized", code: "AUTH_REQUIRED" });

  const adminAuth = adminAuthed
    ? (req, _res, next) => {
        req.userId = "admin-1";
        req.apiKeyScopes = ["admin", "read", "write"];
        next();
      }
    : (_req, res) => res.status(401).json({ error: "Unauthorized", code: "AUTH_REQUIRED" });

  const requireScope = () => (_req, _res, next) => next();
  const sanitizeWorkspace = (s) =>
    typeof s === "string" && s ? s.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80) : "default";

  mountAgentFeedbackRoutes(app, {
    apiRoute,
    apiError,
    userAuth,
    adminAuth,
    requireScope,
    logRequest,
    sanitizeWorkspace,
  });
  return { request, app };
}

test("POST /agent/feedback with valid body returns 200 and an event id", async () => {
  const { request, app } = await buildHarness();
  const res = await request(app)
    .post("/api/v1/agent/feedback")
    .set("Content-Type", "application/json")
    .send({
      runId: "run-xyz",
      sessionId: "sess-1",
      workspace: "ws-route-ok",
      rating: "up",
      score: 5,
      tags: ["helpful"],
      comment: "nice",
      agentResponse: "hi",
    });
  assert.equal(res.status, 200);
  assert.ok(res.body.id, "id returned");
  assert.equal(res.body.runId, "run-xyz");
  assert.equal(res.body.rating, "up");
  assert.equal(res.body.userId, "user-42");
});

test("POST /agent/feedback with missing rating returns 400", async () => {
  const { request, app } = await buildHarness();
  const res = await request(app)
    .post("/api/v1/agent/feedback")
    .set("Content-Type", "application/json")
    .send({ runId: "run-1", workspace: "ws-route-missing" });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "INVALID_FEEDBACK");
});

test("POST /agent/feedback with bad rating value returns 400", async () => {
  const { request, app } = await buildHarness();
  const res = await request(app)
    .post("/api/v1/agent/feedback")
    .set("Content-Type", "application/json")
    .send({ runId: "run-1", rating: "maybe", workspace: "ws-route-badrating" });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "INVALID_FEEDBACK");
});

test("GET /agent/feedback?runId=X returns events for that run", async () => {
  const { request, app } = await buildHarness();
  const ws = "ws-route-getbyrun";
  await request(app)
    .post("/api/v1/agent/feedback")
    .send({ runId: "run-GET-1", rating: "up", workspace: ws });
  await request(app)
    .post("/api/v1/agent/feedback")
    .send({ runId: "run-GET-2", rating: "down", workspace: ws });
  await request(app)
    .post("/api/v1/agent/feedback")
    .send({ runId: "run-GET-1", rating: "up", workspace: ws });

  const res = await request(app)
    .get(`/api/v1/agent/feedback?runId=run-GET-1&workspace=${ws}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.runId, "run-GET-1");
  assert.equal(res.body.total, 2);
  assert.equal(res.body.events.length, 2);
  for (const e of res.body.events) assert.equal(e.runId, "run-GET-1");
});

test("GET /agent/feedback without runId returns 400", async () => {
  const { request, app } = await buildHarness();
  const res = await request(app).get("/api/v1/agent/feedback");
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "MISSING_RUN_ID");
});

test("GET /admin/agent-feedback returns full list for the workspace", async () => {
  const { request, app } = await buildHarness();
  const ws = "ws-route-adminlist";
  await request(app)
    .post("/api/v1/agent/feedback")
    .send({ runId: "ra", rating: "up", workspace: ws });
  await request(app)
    .post("/api/v1/agent/feedback")
    .send({ runId: "rb", rating: "down", workspace: ws });
  const res = await request(app).get(`/api/v1/admin/agent-feedback?workspace=${ws}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.total, 2);
  assert.equal(res.body.events.length, 2);
});

test("GET /admin/agent-feedback/aggregate returns aggregation shape", async () => {
  const { request, app } = await buildHarness();
  const ws = "ws-route-agg";
  await request(app)
    .post("/api/v1/agent/feedback")
    .send({ runId: "ra", rating: "up", score: 5, tags: ["helpful"], workspace: ws });
  await request(app)
    .post("/api/v1/agent/feedback")
    .send({ runId: "rb", rating: "down", score: 2, tags: ["hallucination"], workspace: ws });
  const res = await request(app).get(`/api/v1/admin/agent-feedback/aggregate?workspace=${ws}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.total, 2);
  assert.equal(res.body.upCount, 1);
  assert.equal(res.body.downCount, 1);
  assert.equal(res.body.upRate, 0.5);
  assert.equal(res.body.avgScore, 3.5);
  assert.ok(res.body.tagCounts);
  assert.equal(res.body.tagCounts.helpful, 1);
  assert.equal(res.body.tagCounts.hallucination, 1);
  assert.ok(Array.isArray(res.body.byDay));
});

test("DELETE /admin/agent-feedback resets the workspace log", async () => {
  const { request, app } = await buildHarness();
  const ws = "ws-route-delete";
  await request(app)
    .post("/api/v1/agent/feedback")
    .send({ runId: "ra", rating: "up", workspace: ws });
  let listRes = await request(app).get(`/api/v1/admin/agent-feedback?workspace=${ws}`);
  assert.equal(listRes.body.total, 1);
  const del = await request(app).delete(`/api/v1/admin/agent-feedback?workspace=${ws}`);
  assert.equal(del.status, 200);
  assert.equal(del.body.ok, true);
  listRes = await request(app).get(`/api/v1/admin/agent-feedback?workspace=${ws}`);
  assert.equal(listRes.body.total, 0);
});

test("POST /agent/feedback returns 401 when user is unauthed", async () => {
  const { request, app } = await buildHarness({ userAuthed: false });
  const res = await request(app)
    .post("/api/v1/agent/feedback")
    .send({ runId: "r1", rating: "up" });
  assert.equal(res.status, 401);
  assert.equal(res.body.code, "AUTH_REQUIRED");
});

test("GET /agent/feedback returns 401 when user is unauthed", async () => {
  const { request, app } = await buildHarness({ userAuthed: false });
  const res = await request(app).get("/api/v1/agent/feedback?runId=abc");
  assert.equal(res.status, 401);
  assert.equal(res.body.code, "AUTH_REQUIRED");
});

test("GET /admin/agent-feedback returns 401 when admin is unauthed", async () => {
  const { request, app } = await buildHarness({ adminAuthed: false });
  const res = await request(app).get("/api/v1/admin/agent-feedback?workspace=any");
  assert.equal(res.status, 401);
  assert.equal(res.body.code, "AUTH_REQUIRED");
});

test("GET /admin/agent-feedback/aggregate returns 401 when admin is unauthed", async () => {
  const { request, app } = await buildHarness({ adminAuthed: false });
  const res = await request(app).get("/api/v1/admin/agent-feedback/aggregate?workspace=any");
  assert.equal(res.status, 401);
  assert.equal(res.body.code, "AUTH_REQUIRED");
});

test("DELETE /admin/agent-feedback returns 401 when admin is unauthed", async () => {
  const { request, app } = await buildHarness({ adminAuthed: false });
  const res = await request(app).delete("/api/v1/admin/agent-feedback?workspace=any");
  assert.equal(res.status, 401);
  assert.equal(res.body.code, "AUTH_REQUIRED");
});
