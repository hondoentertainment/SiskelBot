/**
 * Tests for routes/cost-estimate.js — HTTP endpoint for agent cost prediction.
 *
 * Covers: response shape, heuristic fallback, data-driven prediction,
 * missing model validation, profile passthrough, auth enforcement.
 */
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import { mountCostEstimateRoutes } from "../routes/cost-estimate.js";
import { recordRunCost, __resetPredictorForTests } from "../lib/cost-predictor.js";
import { parseCostConfig } from "../lib/smart-router.js";

test.afterEach(() => {
  __resetPredictorForTests();
  parseCostConfig("");
});

test.after(() => {
  __resetPredictorForTests();
  parseCostConfig("");
});

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
    sanitizeWorkspace: (ws) =>
      String(ws || "default")
        .replace(/[^a-zA-Z0-9_-]/g, "")
        .slice(0, 64) || "default",
  };

  mountCostEstimateRoutes(app, deps);
  return app;
}

// ── Response shape ─────────────────────────────────────────────────────────

test("POST /agent/cost-estimate returns correct shape", async () => {
  const app = buildApp();
  parseCostConfig("gpt-4:0.06");

  const res = await request(app)
    .post("/api/v1/agent/cost-estimate")
    .send({ model: "gpt-4", goal: "Summarize the document" });

  assert.equal(res.status, 200);
  assert.ok("estimatedUsd" in res.body);
  assert.ok("confidence" in res.body);
  assert.ok("basedOnRuns" in res.body);
  assert.ok("p50Usd" in res.body);
  assert.ok("p90Usd" in res.body);
  assert.equal(typeof res.body.estimatedUsd, "number");
  assert.equal(typeof res.body.confidence, "number");
  assert.equal(typeof res.body.basedOnRuns, "number");
});

// ── Heuristic fallback via route ───────────────────────────────────────────

test("returns heuristic estimate when no history exists", async () => {
  const app = buildApp();
  parseCostConfig("gpt-4:0.06");

  const goal = "A".repeat(200); // goalLength = 200
  const res = await request(app)
    .post("/api/v1/agent/cost-estimate")
    .send({ model: "gpt-4", goal });

  assert.equal(res.status, 200);
  assert.equal(res.body.basedOnRuns, 0);
  assert.equal(res.body.confidence, 0);
  // 200/100 * 0.06 * 15 = 1.8
  assert.ok(Math.abs(res.body.estimatedUsd - 1.8) < 1e-9);
});

// ── Data-driven prediction via route ───────────────────────────────────────

test("returns data-driven estimate when sufficient history exists", async () => {
  const app = buildApp();
  parseCostConfig("m1:0.01");

  for (let i = 1; i <= 10; i++) {
    recordRunCost({
      workspace: "default",
      model: "m1",
      costUsd: i * 0.1,
      iterations: i,
      tokens: i * 100,
    });
  }

  const res = await request(app)
    .post("/api/v1/agent/cost-estimate")
    .send({ model: "m1", goal: "test goal" });

  assert.equal(res.status, 200);
  assert.equal(res.body.basedOnRuns, 10);
  assert.ok(res.body.confidence > 0);
  // Should be data-driven p50, not heuristic
  assert.ok(res.body.p50Usd > 0);
  assert.ok(res.body.p90Usd >= res.body.p50Usd);
});

// ── Validation ─────────────────────────────────────────────────────────────

test("returns 400 when model is missing", async () => {
  const app = buildApp();

  const res = await request(app)
    .post("/api/v1/agent/cost-estimate")
    .send({ goal: "no model here" });

  assert.equal(res.status, 400);
  assert.equal(res.body.code, "INVALID_INPUT");
});

test("returns 400 when model is not a string", async () => {
  const app = buildApp();

  const res = await request(app)
    .post("/api/v1/agent/cost-estimate")
    .send({ model: 123, goal: "bad model type" });

  assert.equal(res.status, 400);
  assert.equal(res.body.code, "INVALID_INPUT");
});

// ── Profile passthrough ────────────────────────────────────────────────────

test("profile is passed through to predictor for filtering", async () => {
  const app = buildApp();

  for (let i = 0; i < 10; i++) {
    recordRunCost({
      workspace: "default",
      profile: "researcher",
      model: "m2",
      costUsd: 0.1,
      iterations: 5,
      tokens: 500,
    });
    recordRunCost({
      workspace: "default",
      profile: "executor",
      model: "m2",
      costUsd: 0.9,
      iterations: 20,
      tokens: 2000,
    });
  }

  const researcherRes = await request(app)
    .post("/api/v1/agent/cost-estimate")
    .send({ model: "m2", profile: "researcher", goal: "search" });

  const executorRes = await request(app)
    .post("/api/v1/agent/cost-estimate")
    .send({ model: "m2", profile: "executor", goal: "execute" });

  assert.equal(researcherRes.status, 200);
  assert.equal(executorRes.status, 200);
  assert.ok(researcherRes.body.p50Usd < executorRes.body.p50Usd);
});

// ── Workspace from body/query ──────────────────────────────────────────────

test("workspace can be provided in the body", async () => {
  const app = buildApp();

  for (let i = 0; i < 10; i++) {
    recordRunCost({ workspace: "ws-body", model: "m3", costUsd: 0.2, iterations: 3, tokens: 300 });
  }

  const res = await request(app)
    .post("/api/v1/agent/cost-estimate")
    .send({ model: "m3", goal: "test", workspace: "ws-body" });

  assert.equal(res.status, 200);
  assert.equal(res.body.basedOnRuns, 10);
});

test("workspace can be provided as query parameter", async () => {
  const app = buildApp();

  for (let i = 0; i < 10; i++) {
    recordRunCost({ workspace: "ws-query", model: "m4", costUsd: 0.3, iterations: 4, tokens: 400 });
  }

  const res = await request(app)
    .post("/api/v1/agent/cost-estimate?workspace=ws-query")
    .send({ model: "m4", goal: "test" });

  assert.equal(res.status, 200);
  assert.equal(res.body.basedOnRuns, 10);
});

// ── Auth enforcement ───────────────────────────────────────────────────────

test("returns 401 when not authenticated", async () => {
  const app = buildApp({ authenticated: false });

  const res = await request(app)
    .post("/api/v1/agent/cost-estimate")
    .send({ model: "gpt-4", goal: "test" });

  assert.equal(res.status, 401);
});

// ── Goal not provided ──────────────────────────────────────────────────────

test("works when goal is not provided (heuristic uses default goalLength=100)", async () => {
  const app = buildApp();
  parseCostConfig("m5:0.01");

  const res = await request(app)
    .post("/api/v1/agent/cost-estimate")
    .send({ model: "m5" });

  assert.equal(res.status, 200);
  // goalLength defaults to 0 from typeof goal !== "string"
  // then predictCost uses goalLength=100 default
  assert.equal(typeof res.body.estimatedUsd, "number");
});
