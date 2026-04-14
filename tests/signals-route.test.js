/**
 * Tests for routes/signals.js — the /api/v1/signals/composer aggregator.
 *
 * Mounts the route on a minimal Express app using the standard deps contract
 * (apiRoute / apiError / logRequest) and asserts 200 responses include the
 * fields the client signal strip relies on.
 */

import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";

import { mountSignalsRoutes } from "../routes/signals.js";

function buildApp(extraDeps = {}) {
  const app = express();
  app.use(express.json());
  const deps = {
    apiRoute(method, path, ...handlers) {
      app[method](`/api/v1${path}`, ...handlers);
    },
    apiError(res, status, code, message, hint) {
      return res.status(status).json({ error: message, code, hint });
    },
    logRequest: (req, res, next) => next(),
    BACKEND: "openai",
    MODEL_PRESETS: {
      openai: ["gpt-4o-mini", "gpt-4o"],
      ollama: ["llama3.2"],
      vllm: ["meta-llama/Llama-3-8B-Instruct"],
    },
    ...extraDeps,
  };
  mountSignalsRoutes(app, deps);
  return app;
}

test("GET /api/v1/signals/composer returns 200 with the required shape", async () => {
  const app = buildApp();
  const res = await request(app).get("/api/v1/signals/composer");
  assert.equal(res.status, 200);

  const body = res.body;
  assert.ok(body && typeof body === "object", "expected an object payload");

  for (const field of [
    "backend",
    "model",
    "estCostUsd",
    "p50LatencyMs",
    "qualityScore",
    "breakerState",
    "updatedAt",
  ]) {
    assert.ok(Object.prototype.hasOwnProperty.call(body, field), `missing field: ${field}`);
  }

  assert.equal(typeof body.backend, "string");
  assert.equal(typeof body.model, "string");
  assert.equal(typeof body.estCostUsd, "number");
  assert.equal(typeof body.p50LatencyMs, "number");
  assert.equal(typeof body.qualityScore, "number");
  assert.equal(typeof body.breakerState, "string");
  assert.equal(typeof body.updatedAt, "string");

  assert.ok(
    ["ollama", "vllm", "openai"].includes(body.backend),
    `unexpected backend: ${body.backend}`,
  );
  assert.ok(
    ["closed", "open", "half_open"].includes(body.breakerState),
    `unexpected breakerState: ${body.breakerState}`,
  );
  assert.ok(body.qualityScore >= 0 && body.qualityScore <= 1, "qualityScore out of [0,1]");
  assert.ok(body.p50LatencyMs >= 0, "p50LatencyMs must be non-negative");
  assert.ok(body.estCostUsd >= 0, "estCostUsd must be non-negative");
  assert.ok(!Number.isNaN(Date.parse(body.updatedAt)), "updatedAt must parse as ISO date");
});

test("GET /api/v1/signals/composer resolves the model from MODEL_PRESETS for the configured backend", async () => {
  const app = buildApp({
    BACKEND: "openai",
    MODEL_PRESETS: { openai: ["gpt-4o-mini"] },
  });
  const res = await request(app).get("/api/v1/signals/composer");
  assert.equal(res.status, 200);
  assert.equal(res.body.backend, "openai");
  assert.equal(res.body.model, "gpt-4o-mini");
});

test("GET /api/v1/signals/composer honours a getDefaultModel dep when provided", async () => {
  const app = buildApp({
    BACKEND: "ollama",
    getDefaultModel: () => "custom-model-v2",
  });
  const res = await request(app).get("/api/v1/signals/composer");
  assert.equal(res.status, 200);
  assert.equal(res.body.model, "custom-model-v2");
});
