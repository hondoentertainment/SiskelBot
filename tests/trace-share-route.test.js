/**
 * Route tests for /api/admin/trace-share* and /api/trace-share/:token.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const tmpRoot = mkdtempSync(join(tmpdir(), "siskel-trace-share-route-"));
process.env.STORAGE_PATH = tmpRoot;
process.env.AGENT_TRAJECTORY_TTL_MS = "3600000";
process.env.TRACE_SHARE_SECRET = "route-test-" + "x".repeat(40);

test.after(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
});

async function buildHarness() {
  const request = (await import("supertest")).default;
  const express = (await import("express")).default;
  const { default: mountTraceShareRoutes } = await import("../routes/trace-share.js");
  const store = await import("../lib/trace-share-store.js");
  store._resetForTests();

  const app = express();
  app.set("trust proxy", true);
  app.use(express.json());

  const apiError = (res, status, code, message) => res.status(status).json({ error: message, code });
  const logRequest = (_req, _res, next) => next();
  const adminAuth = (_req, _res, next) => next();
  const requireScope = () => (_req, _res, next) => next();

  mountTraceShareRoutes(app, { apiError, logRequest, adminAuth, requireScope });
  return { request, app };
}

async function seedTrajectory(runId, workspace) {
  const { saveTrajectory } = await import("../lib/agent-trajectory.js");
  const now = Date.now();
  const at = (o) => new Date(now + o).toISOString();
  await saveTrajectory(runId, {
    runId,
    workspace,
    recordedAt: at(100),
    stepCount: 4,
    steps: [
      { type: "start", at: at(0) },
      { type: "iteration", iteration: 1, at: at(5) },
      {
        type: "tool_call",
        iteration: 1,
        name: "web_search",
        argsPreview: JSON.stringify({ q: "foo", email: "hidden@example.com" }),
        at: at(10),
      },
      {
        type: "tool_result",
        iteration: 1,
        name: "web_search",
        ok: true,
        preview: "answer",
        at: at(50),
      },
      { type: "stop", iteration: 1, reason: "model_finished", at: at(60) },
    ],
  });
}

test("POST /api/admin/trace-share creates a token + shareUrl", async () => {
  const { request, app } = await buildHarness();
  const runId = "route-create-" + Date.now();
  const workspace = "ws-create-" + Date.now();
  await seedTrajectory(runId, workspace);

  const r = await request(app)
    .post("/api/admin/trace-share")
    .send({ runId, workspace, ttlSec: 3600 });

  assert.equal(r.status, 200);
  assert.equal(typeof r.body.token, "string");
  assert.ok(r.body.token.length > 10);
  assert.ok(r.body.shareUrl.startsWith("/trace-share.html?t="));
  assert.ok(Number.isFinite(r.body.expiresAt));
  assert.ok(r.body.expiresAt > Date.now());
});

test("POST /api/admin/trace-share rejects ttlSec > 30 days", async () => {
  const { request, app } = await buildHarness();
  const r = await request(app)
    .post("/api/admin/trace-share")
    .send({ runId: "r", workspace: "w", ttlSec: 31 * 24 * 60 * 60 });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, "TTL_TOO_LARGE");
});

test("POST /api/admin/trace-share rejects missing runId", async () => {
  const { request, app } = await buildHarness();
  const r = await request(app).post("/api/admin/trace-share").send({ workspace: "w" });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, "INVALID_RUN_ID");
});

test("GET /api/trace-share/:token returns anonymized body", async () => {
  const { request, app } = await buildHarness();
  const runId = "route-get-" + Date.now();
  const workspace = "ws-get-" + Date.now();
  await seedTrajectory(runId, workspace);

  const create = await request(app)
    .post("/api/admin/trace-share")
    .send({ runId, workspace, ttlSec: 3600 });
  assert.equal(create.status, 200);
  const token = create.body.token;

  const r = await request(app).get("/api/trace-share/" + encodeURIComponent(token));
  assert.equal(r.status, 200);
  assert.equal(r.body.runId, runId);
  assert.equal(r.body.workspace, "<redacted>");
  assert.ok(Array.isArray(r.body.iterations));
  assert.ok(r.body.iterations.length >= 1);
  // The email arg must have been scrubbed
  const serialized = JSON.stringify(r.body);
  assert.ok(!/hidden@example\.com/.test(serialized), "email should have been scrubbed");
});

test("GET /api/trace-share/:token returns 404 for invalid token", async () => {
  const { request, app } = await buildHarness();
  const r = await request(app).get("/api/trace-share/not-a-real-token");
  assert.equal(r.status, 404);
  assert.equal(r.body.code, "NOT_FOUND");
});

test("POST revoke + subsequent GET returns 404", async () => {
  const { request, app } = await buildHarness();
  const runId = "route-rev-" + Date.now();
  const workspace = "ws-rev-" + Date.now();
  await seedTrajectory(runId, workspace);

  const create = await request(app)
    .post("/api/admin/trace-share")
    .send({ runId, workspace, ttlSec: 3600 });
  const token = create.body.token;

  // Verify it works first.
  let r = await request(app).get("/api/trace-share/" + encodeURIComponent(token));
  assert.equal(r.status, 200);

  const rev = await request(app).post(
    "/api/admin/trace-share/" + encodeURIComponent(token) + "/revoke",
  );
  assert.equal(rev.status, 200);
  assert.equal(rev.body.ok, true);

  r = await request(app).get("/api/trace-share/" + encodeURIComponent(token));
  assert.equal(r.status, 404);
});

test("GET rate limiting: 61 requests from same IP -> 429", async () => {
  const { request, app } = await buildHarness();
  const runId = "route-rl-" + Date.now();
  const workspace = "ws-rl-" + Date.now();
  await seedTrajectory(runId, workspace);

  const create = await request(app)
    .post("/api/admin/trace-share")
    .send({ runId, workspace, ttlSec: 3600 });
  const token = create.body.token;

  // First 60 should be allowed.
  for (let i = 0; i < 60; i++) {
    const r = await request(app)
      .get("/api/trace-share/" + encodeURIComponent(token))
      .set("X-Forwarded-For", "198.51.100.77");
    assert.notEqual(r.status, 429, `request #${i + 1} unexpectedly rate-limited`);
  }
  // 61st should be throttled.
  const r = await request(app)
    .get("/api/trace-share/" + encodeURIComponent(token))
    .set("X-Forwarded-For", "198.51.100.77");
  assert.equal(r.status, 429);
  assert.equal(r.body.code, "RATE_LIMITED");
});

test("GET /api/admin/trace-share/mine lists active tokens for creator", async () => {
  const { request, app } = await buildHarness();
  const runId = "route-mine-" + Date.now();
  const workspace = "ws-mine-" + Date.now();
  await seedTrajectory(runId, workspace);

  const create = await request(app)
    .post("/api/admin/trace-share")
    .send({ runId, workspace, ttlSec: 3600, createdBy: "admin-mine" });
  assert.equal(create.status, 200);

  const r = await request(app).get("/api/admin/trace-share/mine?createdBy=admin-mine");
  assert.equal(r.status, 200);
  assert.equal(r.body.createdBy, "admin-mine");
  assert.ok(Array.isArray(r.body.tokens));
  assert.ok(r.body.tokens.some((t) => t.runId === runId));
});
