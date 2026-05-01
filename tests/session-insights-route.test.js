import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import { mountSessionInsightsRoutes } from "../routes/session-insights.js";

function buildApp() {
  const app = express();
  app.use(express.json());

  const apiError = (res, status, code, msg) => res.status(status).json({ error: code, message: msg });
  const deps = {
    dualRegister: (method, path, handler) => app[method](`/api/v1${path}`, handler),
    apiError,
  };

  mountSessionInsightsRoutes(app, deps);
  return app;
}

const ws = () => `test-ws-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const run = () => `run-${Date.now()}-${Math.random().toString(36).slice(2)}`;

test("GET /workspaces/:id/session-insights returns empty list", async () => {
  const app = buildApp();
  const workspaceId = ws();
  const res = await request(app).get(`/api/v1/workspaces/${workspaceId}/session-insights`);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.ok(Array.isArray(res.body.insights));
});

test("POST .../session-insights/:runId/generate creates an insight", async () => {
  const app = buildApp();
  const workspaceId = ws();
  const runId = run();
  const res = await request(app)
    .post(`/api/v1/workspaces/${workspaceId}/session-insights/${runId}/generate`)
    .send({
      trajectoryPayload: {
        steps: [{ type: "tool_call", name: "readFile", at: 1000, success: true }],
        iterationCount: 1,
      },
    });
  assert.equal(res.status, 201);
  assert.equal(res.body.ok, true);
  assert.ok(res.body.insight);
  assert.equal(res.body.insight.runId, runId);
});

test("POST .../generate returns 400 if trajectoryPayload missing", async () => {
  const app = buildApp();
  const workspaceId = ws();
  const runId = run();
  const res = await request(app)
    .post(`/api/v1/workspaces/${workspaceId}/session-insights/${runId}/generate`)
    .send({});
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "INVALID_INPUT");
});

test("GET .../session-insights/:runId returns 404 for missing insight", async () => {
  const app = buildApp();
  const workspaceId = ws();
  const res = await request(app).get(`/api/v1/workspaces/${workspaceId}/session-insights/missing-run`);
  assert.equal(res.status, 404);
});

test("GET .../session-insights/:runId returns insight after generation", async () => {
  const app = buildApp();
  const workspaceId = ws();
  const runId = run();
  await request(app)
    .post(`/api/v1/workspaces/${workspaceId}/session-insights/${runId}/generate`)
    .send({ trajectoryPayload: { steps: [] } });

  const res = await request(app).get(`/api/v1/workspaces/${workspaceId}/session-insights/${runId}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.insight.runId, runId);
});

test("GET .../session-insights/:runId/timeline returns SSE stream", async () => {
  const app = buildApp();
  const workspaceId = ws();
  const runId = run();
  // Generate insight with steps first
  await request(app)
    .post(`/api/v1/workspaces/${workspaceId}/session-insights/${runId}/generate`)
    .send({
      trajectoryPayload: {
        steps: [{ type: "tool_call", name: "search", at: 1000, success: true }],
      },
    });

  const res = await request(app).get(`/api/v1/workspaces/${workspaceId}/session-insights/${runId}/timeline`);
  assert.equal(res.status, 200);
  assert.ok(res.headers["content-type"].includes("text/event-stream"));
});

test("GET .../timeline returns 404 for missing insight", async () => {
  const app = buildApp();
  const workspaceId = ws();
  const res = await request(app).get(`/api/v1/workspaces/${workspaceId}/session-insights/no-such-run/timeline`);
  assert.equal(res.status, 404);
});
