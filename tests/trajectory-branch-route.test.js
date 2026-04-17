/**
 * Route tests for trajectory branching endpoints:
 *   POST /api/v1/agent/sessions/:id/branch
 *   GET  /api/v1/agent/sessions/:id/branches
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const dir = mkdtempSync(join(tmpdir(), "traj-branch-rt-"));
const prev = process.env.STORAGE_PATH;
process.env.STORAGE_PATH = dir;

const { createAgentSession } = await import("../lib/agent-session.js");
const { saveCheckpoint } = await import("../lib/agent-checkpoint.js");

test.after(() => {
  if (prev === undefined) delete process.env.STORAGE_PATH;
  else process.env.STORAGE_PATH = prev;
  rmSync(dir, { recursive: true, force: true });
});

async function buildHarness({ authed = true } = {}) {
  const request = (await import("supertest")).default;
  const express = (await import("express")).default;
  const { mountTrajectoryBranchRoutes } = await import("../routes/trajectory-branch.js");

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
  const userAuth = authed
    ? (req, _res, next) => {
        req.userId = "anonymous";
        req.authenticatedViaDeploymentKey = true;
        req.apiKeyScopes = ["read", "write"];
        next();
      }
    : (_req, res) => {
        res.status(401).json({ error: "Unauthorized", code: "AUTH_REQUIRED" });
      };
  const requireScope = () => (_req, _res, next) => next();

  mountTrajectoryBranchRoutes(app, { apiRoute, apiError, userAuth, requireScope, logRequest });
  return { request, app };
}

test("POST /agent/sessions/:id/branch returns 201 with correct shape", async () => {
  const session = await createAgentSession({
    workspace: "default",
    ownerStorageUserId: "anonymous",
    title: "route test",
  });
  await saveCheckpoint(session.id, {
    sessionId: session.id,
    iteration: 4,
    messages: [{ role: "user", content: "hi" }],
    runId: "run-rt-1",
    model: "gpt-4",
    timestamp: Date.now(),
  });

  const { request, app } = await buildHarness();
  const res = await request(app)
    .post(`/api/v1/agent/sessions/${session.id}/branch`)
    .set("Content-Type", "application/json")
    .send({});

  assert.equal(res.status, 201);
  assert.ok(res.body.branchSessionId);
  assert.equal(res.body.iteration, 4);
  assert.equal(res.body.resumeUrl, `/api/v1/agent/sessions/${res.body.branchSessionId}/resume`);
});

test("POST /agent/sessions/:id/branch returns 404 when session has no checkpoint", async () => {
  const session = await createAgentSession({
    workspace: "default",
    ownerStorageUserId: "anonymous",
    title: "no checkpoint route",
  });

  const { request, app } = await buildHarness();
  const res = await request(app)
    .post(`/api/v1/agent/sessions/${session.id}/branch`)
    .set("Content-Type", "application/json")
    .send({});

  assert.equal(res.status, 404);
  assert.equal(res.body.code, "CHECKPOINT_NOT_FOUND");
});

test("POST /agent/sessions/:id/branch returns 404 for nonexistent session", async () => {
  const { request, app } = await buildHarness();
  const res = await request(app)
    .post("/api/v1/agent/sessions/nonexistent-id/branch")
    .set("Content-Type", "application/json")
    .send({});

  assert.equal(res.status, 404);
  assert.equal(res.body.code, "NOT_FOUND");
});

test("POST /agent/sessions/:id/branch returns 400 for iteration mismatch", async () => {
  const session = await createAgentSession({
    workspace: "default",
    ownerStorageUserId: "anonymous",
    title: "mismatch route",
  });
  await saveCheckpoint(session.id, {
    sessionId: session.id,
    iteration: 6,
    messages: [],
    runId: "run-rt-2",
    model: "gpt-4",
    timestamp: Date.now(),
  });

  const { request, app } = await buildHarness();
  const res = await request(app)
    .post(`/api/v1/agent/sessions/${session.id}/branch`)
    .set("Content-Type", "application/json")
    .send({ iteration: 2 });

  assert.equal(res.status, 400);
  assert.equal(res.body.code, "ITERATION_MISMATCH");
});

test("POST /agent/sessions/:id/branch returns 401 when auth is missing", async () => {
  const { request, app } = await buildHarness({ authed: false });
  const res = await request(app)
    .post("/api/v1/agent/sessions/some-id/branch")
    .set("Content-Type", "application/json")
    .send({});

  assert.equal(res.status, 401);
  assert.equal(res.body.code, "AUTH_REQUIRED");
});

test("GET /agent/sessions/:id/branches returns branches array", async () => {
  const session = await createAgentSession({
    workspace: "default",
    ownerStorageUserId: "anonymous",
    title: "list branches route",
  });
  await saveCheckpoint(session.id, {
    sessionId: session.id,
    iteration: 1,
    messages: [],
    runId: "run-rt-3",
    model: "gpt-4",
    timestamp: Date.now(),
  });

  // Create a branch first
  const { branchFromCheckpoint } = await import("../lib/trajectory-branch.js");
  await branchFromCheckpoint({
    sessionId: session.id,
    workspace: "default",
    userId: "anonymous",
  });

  const { request, app } = await buildHarness();
  const res = await request(app)
    .get(`/api/v1/agent/sessions/${session.id}/branches`);

  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.branches));
  assert.ok(res.body.branches.length >= 1);

  const b = res.body.branches[0];
  assert.ok(b.branchSessionId);
  assert.equal(b.branchedAtIteration, 1);
  assert.ok(b.createdAt);
  assert.equal(b.status, "running");
});

test("GET /agent/sessions/:id/branches returns 404 for nonexistent session", async () => {
  const { request, app } = await buildHarness();
  const res = await request(app)
    .get("/api/v1/agent/sessions/nonexistent-id/branches");

  assert.equal(res.status, 404);
  assert.equal(res.body.code, "NOT_FOUND");
});

test("GET /agent/sessions/:id/branches returns 401 when auth is missing", async () => {
  const { request, app } = await buildHarness({ authed: false });
  const res = await request(app)
    .get("/api/v1/agent/sessions/some-id/branches");

  assert.equal(res.status, 401);
  assert.equal(res.body.code, "AUTH_REQUIRED");
});
