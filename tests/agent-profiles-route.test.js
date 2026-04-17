/**
 * Tests for routes/agent-profiles.js — HTTP CRUD for agent profiles.
 */
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import { mountAgentProfileRoutes } from "../routes/agent-profiles.js";

const TEST_WS = "route-test-ws-" + Date.now();

function buildApp({ authenticated = true } = {}) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  if (authenticated) {
    app.use((req, res, next) => {
      req.userId = "test-user";
      next();
    });
  }

  const deps = {
    apiRoute(method, path, ...handlers) {
      app[method](`/api/v1${path}`, ...handlers);
    },
    apiError(res, status, code, message, hint) {
      return res.status(status).json({ error: message, code, hint });
    },
    userAuth: authenticated
      ? (req, res, next) => next()
      : (req, res, next) => res.status(401).json({ error: "Unauthorized", code: "UNAUTHORIZED" }),
    requireScope: () => (req, res, next) => next(),
    logRequest: (req, res, next) => next(),
    sanitizeWorkspace: (ws) => String(ws || "default").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "default",
  };

  mountAgentProfileRoutes(app, deps);
  return app;
}

// ── GET /agent/profiles ─────────────────────────────────────────────────────

test("GET /agent/profiles returns built-in profiles for fresh workspace", async () => {
  const app = buildApp();
  const res = await request(app).get(`/api/v1/agent/profiles?workspace=${TEST_WS}`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.profiles));
  assert.equal(res.body.profiles.length, 5);
  const ids = res.body.profiles.map((p) => p.id).sort();
  assert.deepEqual(ids, ["code_writer", "executor", "researcher", "reviewer", "synthesizer"]);
});

// ── GET /agent/profiles/:id ─────────────────────────────────────────────────

test("GET /agent/profiles/:id returns a single built-in profile", async () => {
  const app = buildApp();
  const res = await request(app).get(`/api/v1/agent/profiles/researcher?workspace=${TEST_WS}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.id, "researcher");
  assert.equal(res.body.builtIn, true);
  assert.ok(res.body.systemPrompt);
});

test("GET /agent/profiles/:id returns 404 for unknown profile", async () => {
  const app = buildApp();
  const res = await request(app).get(`/api/v1/agent/profiles/unknown-id?workspace=${TEST_WS}`);
  assert.equal(res.status, 404);
  assert.equal(res.body.code, "NOT_FOUND");
});

// ── PUT /agent/profiles/:id ─────────────────────────────────────────────────

test("PUT /agent/profiles/:id creates a new profile", async () => {
  const app = buildApp();
  const res = await request(app)
    .put(`/api/v1/agent/profiles/custom-agent?workspace=${TEST_WS}`)
    .send({
      name: "Custom Agent",
      systemPrompt: "You are a custom agent.",
      toolAllowlist: ["search_context"],
      budgets: { maxIterations: 10 },
    });
  assert.equal(res.status, 200);
  assert.equal(res.body.id, "custom-agent");
  assert.equal(res.body.name, "Custom Agent");
  assert.equal(res.body.builtIn, false);
});

test("PUT /agent/profiles/:id updates an existing profile", async () => {
  const app = buildApp();
  // First create
  await request(app)
    .put(`/api/v1/agent/profiles/update-me?workspace=${TEST_WS}`)
    .send({ systemPrompt: "Original." });

  // Then update
  const res = await request(app)
    .put(`/api/v1/agent/profiles/update-me?workspace=${TEST_WS}`)
    .send({ systemPrompt: "Updated." });

  assert.equal(res.status, 200);
  assert.equal(res.body.systemPrompt, "Updated.");
});

test("PUT /agent/profiles/:id returns 400 for invalid input", async () => {
  const app = buildApp();
  const res = await request(app)
    .put(`/api/v1/agent/profiles/valid-id?workspace=${TEST_WS}`)
    .send({ systemPrompt: "" }); // empty systemPrompt

  assert.equal(res.status, 400);
  assert.equal(res.body.code, "VALIDATION_ERROR");
});

test("PUT /agent/profiles/:id returns 400 for invalid id", async () => {
  const app = buildApp();
  const res = await request(app)
    .put(`/api/v1/agent/profiles/X?workspace=${TEST_WS}`)
    .send({ systemPrompt: "Good prompt." });

  assert.equal(res.status, 400);
  assert.equal(res.body.code, "VALIDATION_ERROR");
});

// ── DELETE /agent/profiles/:id ──────────────────────────────────────────────

test("DELETE /agent/profiles/:id deletes a custom profile", async () => {
  const app = buildApp();
  // Create first
  await request(app)
    .put(`/api/v1/agent/profiles/to-delete?workspace=${TEST_WS}`)
    .send({ systemPrompt: "Will be deleted." });

  const res = await request(app).delete(`/api/v1/agent/profiles/to-delete?workspace=${TEST_WS}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);

  // Confirm gone
  const getRes = await request(app).get(`/api/v1/agent/profiles/to-delete?workspace=${TEST_WS}`);
  assert.equal(getRes.status, 404);
});

test("DELETE /agent/profiles/:id returns 400 for built-in without override", async () => {
  const app = buildApp();
  const freshWs = "delete-builtin-test-" + Date.now();
  const res = await request(app).delete(`/api/v1/agent/profiles/executor?workspace=${freshWs}`);
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "BUILTIN_DELETE");
});

test("DELETE /agent/profiles/:id returns 404 for unknown id", async () => {
  const app = buildApp();
  const res = await request(app).delete(`/api/v1/agent/profiles/no-such-thing?workspace=${TEST_WS}`);
  assert.equal(res.status, 404);
  assert.equal(res.body.code, "NOT_FOUND");
});

// ── Auth required ───────────────────────────────────────────────────────────

test("returns 401 when not authenticated", async () => {
  const app = buildApp({ authenticated: false });
  const res = await request(app).get(`/api/v1/agent/profiles?workspace=${TEST_WS}`);
  assert.equal(res.status, 401);
});

// ── Workspace isolation via routes ──────────────────────────────────────────

test("profiles are isolated between workspaces via routes", async () => {
  const app = buildApp();
  const ws1 = "route-iso-ws1-" + Date.now();
  const ws2 = "route-iso-ws2-" + Date.now();

  await request(app)
    .put(`/api/v1/agent/profiles/ws1-only?workspace=${ws1}`)
    .send({ systemPrompt: "Only in ws1." });

  const res1 = await request(app).get(`/api/v1/agent/profiles?workspace=${ws1}`);
  const res2 = await request(app).get(`/api/v1/agent/profiles?workspace=${ws2}`);

  assert.ok(res1.body.profiles.find((p) => p.id === "ws1-only"));
  assert.ok(!res2.body.profiles.find((p) => p.id === "ws1-only"));
});
