/**
 * Tests for routes/agent-resume.js — POST /api/v1/agent/sessions/:id/resume
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import express from "express";

// Isolate storage
const dir = mkdtempSync(join(tmpdir(), "agent-resume-rt-"));
const prev = process.env.STORAGE_PATH;
process.env.STORAGE_PATH = dir;

const { saveCheckpoint } = await import("../lib/agent-checkpoint.js");
const { createAgentSession } = await import("../lib/agent-session.js");
const { mountAgentResumeRoutes } = await import("../routes/agent-resume.js");

test.after(() => {
  if (prev === undefined) delete process.env.STORAGE_PATH;
  else process.env.STORAGE_PATH = prev;
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Build a minimal Express app with the resume route mounted, using fake auth
 * middleware so tests can set req.userId.
 */
function buildApp({ userId = "anonymous" } = {}) {
  const app = express();
  app.use(express.json());
  const deps = {
    apiRoute(method, path, ...handlers) {
      app[method](`/api/v1${path}`, ...handlers);
    },
    apiError(res, status, code, message, hint) {
      return res.status(status).json({ error: { code, message, hint } });
    },
    userAuth(req, _res, next) {
      req.userId = userId;
      next();
    },
    requireScope(_scope) {
      return (_req, _res, next) => next();
    },
    logRequest(_req, _res, next) {
      next();
    },
  };
  mountAgentResumeRoutes(app, deps);
  return app;
}

// Use dynamic import for supertest (available in the project)
const supertest = (await import("supertest")).default;

test("resume with checkpoint returns 200 and checkpoint data", async () => {
  const session = await createAgentSession({
    workspace: "default",
    ownerStorageUserId: "anonymous",
    title: "Resume test",
  });
  const msgs = [{ role: "user", content: "hello" }];
  await saveCheckpoint(session.id, {
    sessionId: session.id,
    iteration: 4,
    messages: msgs,
    runId: "run-resume-1",
    model: "gpt-4",
    timestamp: Date.now(),
    version: 1,
  });

  const app = buildApp({ userId: "anonymous" });
  const res = await supertest(app)
    .post(`/api/v1/agent/sessions/${session.id}/resume`)
    .send({})
    .expect(200);

  assert.equal(res.body.ok, true);
  assert.equal(res.body.resumedFromIteration, 4);
  assert.equal(res.body.sessionId, session.id);
  assert.ok(res.body.checkpoint);
  assert.equal(res.body.checkpoint.iteration, 4);
});

test("resume without checkpoint returns 404", async () => {
  const session = await createAgentSession({
    workspace: "default",
    ownerStorageUserId: "anonymous",
    title: "No checkpoint test",
  });

  const app = buildApp({ userId: "anonymous" });
  const res = await supertest(app)
    .post(`/api/v1/agent/sessions/${session.id}/resume`)
    .send({})
    .expect(404);

  assert.equal(res.body.error.code, "CHECKPOINT_NOT_FOUND");
});

test("resume with nonexistent session returns 404", async () => {
  const app = buildApp({ userId: "anonymous" });
  const res = await supertest(app)
    .post("/api/v1/agent/sessions/nonexistent-session-id/resume")
    .send({})
    .expect(404);

  assert.equal(res.body.error.code, "NOT_FOUND");
});

test("resume with wrong user returns 403", async () => {
  const session = await createAgentSession({
    workspace: "default",
    ownerStorageUserId: "anonymous",
    title: "Auth test",
  });
  await saveCheckpoint(session.id, {
    sessionId: session.id,
    iteration: 2,
    messages: [{ role: "user", content: "test" }],
    runId: "run-auth-1",
    model: "gpt-4",
    timestamp: Date.now(),
    version: 1,
  });

  // Use a different userId so access check fails
  const app = buildApp({ userId: "other-user" });
  const res = await supertest(app)
    .post(`/api/v1/agent/sessions/${session.id}/resume`)
    .send({})
    .expect(403);

  assert.equal(res.body.error.code, "FORBIDDEN");
});
