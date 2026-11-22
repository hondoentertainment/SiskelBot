import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import { buildCorsOptions } from "../lib/cors-policy.js";
import { billingReturnUrl } from "../lib/billing.js";
import { mountScheduledAgentRoutes } from "../routes/scheduled-agents.js";
import { mountSecretsRoutes } from "../routes/secrets.js";
import { mountOfflineModelsRoutes } from "../routes/offline-models.js";

test("CORS does not reflect an arbitrary origin unless CORS_ORIGINS is set", () => {
  assert.deepEqual(buildCorsOptions({}), { origin: false });
  const allowed = buildCorsOptions({ CORS_ORIGINS: "https://app.example.com", CORS_ALLOW_CREDENTIALS: "0" });
  assert.deepEqual(allowed.origin, ["https://app.example.com"]);
  assert.equal(allowed.credentials, false);
});

test("billing return URLs stay on the app origin", () => {
  const base = "https://app.example.com";
  assert.equal(billingReturnUrl("https://app.example.com/billing/success", base), "https://app.example.com/billing/success");
  assert.equal(billingReturnUrl("/billing/success", base), "https://app.example.com/billing/success");
  assert.equal(billingReturnUrl("https://evil.example/steal", base), null);
  assert.equal(billingReturnUrl("https://app.example.com.evil/steal", base), null);
});

test("scheduled agents and offline model writes require a caller", async () => {
  const app = express();
  app.use(express.json());
  const apiError = (res, status, code, msg) => res.status(status).json({ error: msg, code });
  const apiRoute = (method, path, ...handlers) => app[method](`/api/v1${path}`, ...handlers);
  mountScheduledAgentRoutes(app, {
    apiRoute,
    apiError,
    userAuth: (_req, res) => res.status(401).json({ error: "Authentication required", code: "AUTH_REQUIRED" }),
  });
  mountOfflineModelsRoutes(app, { apiRoute, apiError });
  const created = await request(app).post("/api/v1/scheduled-agents").send({ prompt: "run", cron: "* * * * *" });
  assert.equal(created.status, 401);
  const downloaded = await request(app).post("/api/v1/models/offline/missing/download");
  assert.equal(downloaded.status, 401);
});

test("an authenticated user cannot write secrets in another workspace", async () => {
  const app = express();
  app.use(express.json());
  mountSecretsRoutes(app, {
    apiRoute: (method, path, ...handlers) => app[method](`/api/v1${path}`, ...handlers),
    apiError: (res, status, code, msg) => res.status(status).json({ error: code, message: msg }),
    logRequest: (_req, _res, next) => next(),
    userAuth: (req, _res, next) => {
      req.userId = "ada";
      next();
    },
    isAuthConfigured: () => true,
  });
  const res = await request(app).post("/api/v1/secrets").send({
    scopeType: "workspace",
    scopeId: "not-ada-workspace",
    name: "byok_openai",
    value: "sk-secret-value",
  });
  assert.equal(res.status, 403);
});
