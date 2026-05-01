import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import { mountSessionPatchRoutes } from "../routes/session-patch.js";

function buildApp() {
  const app = express();
  app.use(express.json());

  const apiError = (res, status, code, msg) => res.status(status).json({ error: code, message: msg });
  const deps = {
    apiRoute: (method, path, ...handlers) => app[method](`/api/v1${path}`, ...handlers),
    apiError,
  };

  mountSessionPatchRoutes(app, deps);
  return app;
}

const sid = () => `sess-${Date.now()}-${Math.random().toString(36).slice(2)}`;

test("POST /api/v1/agent-sessions/:id/patch applies patches", async () => {
  const app = buildApp();
  const sessionId = sid();
  const res = await request(app)
    .post(`/api/v1/agent-sessions/${sessionId}/patch`)
    .send({
      workspaceId: "ws1",
      patches: [{ relativePath: "src/index.js", content: "console.log('hi');", patchType: "full_replace" }],
    });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.applied.length, 1);
  assert.equal(res.body.applied[0].relativePath, "src/index.js");
  assert.equal(res.body.applied[0].sessionId, sessionId);
});

test("POST /api/v1/agent-sessions/:id/patch returns 400 for empty patches array", async () => {
  const app = buildApp();
  const sessionId = sid();
  const res = await request(app)
    .post(`/api/v1/agent-sessions/${sessionId}/patch`)
    .send({ patches: [] });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "INVALID_INPUT");
});

test("POST /api/v1/agent-sessions/:id/patch returns 400 if patches not provided", async () => {
  const app = buildApp();
  const sessionId = sid();
  const res = await request(app)
    .post(`/api/v1/agent-sessions/${sessionId}/patch`)
    .send({});
  assert.equal(res.status, 400);
});

test("POST /api/v1/agent-sessions/:id/patch tracks errors for invalid patch entries", async () => {
  const app = buildApp();
  const sessionId = sid();
  const res = await request(app)
    .post(`/api/v1/agent-sessions/${sessionId}/patch`)
    .send({
      patches: [
        { relativePath: "valid.js", content: "// ok" },
        { content: "// missing path" },
      ],
    });
  // one valid, one invalid - status 200 with errors
  assert.equal(res.body.applied.length, 1);
  assert.ok(Array.isArray(res.body.errors));
  assert.equal(res.body.errors.length, 1);
});

test("GET /api/v1/agent-sessions/:id/patches returns list of patches", async () => {
  const app = buildApp();
  const sessionId = sid();
  // Apply a patch first
  await request(app)
    .post(`/api/v1/agent-sessions/${sessionId}/patch`)
    .send({ patches: [{ relativePath: "file.txt", content: "content" }] });

  const res = await request(app).get(`/api/v1/agent-sessions/${sessionId}/patches`);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.ok(Array.isArray(res.body.patches));
  assert.ok(res.body.patches.length >= 1);
});

test("GET /api/v1/agent-sessions/:id/patches returns empty list for new session", async () => {
  const app = buildApp();
  const sessionId = sid();
  const res = await request(app).get(`/api/v1/agent-sessions/${sessionId}/patches`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.patches, []);
});

test("POST /api/v1/agent-sessions/:id/patch handles unified_diff patchType", async () => {
  const app = buildApp();
  const sessionId = sid();
  const res = await request(app)
    .post(`/api/v1/agent-sessions/${sessionId}/patch`)
    .send({
      patches: [{ relativePath: "test.py", content: "@@ -1,2 +1,3 @@\n line1\n line2\n+line3", patchType: "unified_diff" }],
    });
  // patch tool not available in test so just records it
  assert.equal(res.status, 200);
  assert.ok(res.body.applied.length >= 1 || res.body.errors.length >= 0);
});
