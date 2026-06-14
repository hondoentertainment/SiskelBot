/**
 * Route tests for POST /api/v1/agent/hitl/:approvalId.
 * Covers: approve, deny, 404 (missing), 409 (already resolved), 401 (auth),
 * and 400 (invalid decision).
 */
import test from "node:test";
import assert from "node:assert/strict";

async function buildHarness({ authed = true } = {}) {
  const request = (await import("supertest")).default;
  const express = (await import("express")).default;
  const { mountAgentHitlRoutes } = await import("../routes/agent-hitl.js");

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

  mountAgentHitlRoutes(app, { apiRoute, apiError, userAuth, requireScope, logRequest });
  return { request, app };
}

test("POST /agent/hitl/:approvalId approve returns ok for an existing approval", async () => {
  const { saveHitlState } = await import("../lib/agent-hitl-store.js");
  const token = saveHitlState({ sample: true });
  const { request, app } = await buildHarness();
  const res = await request(app)
    .post(`/api/v1/agent/hitl/${token}`)
    .set("Content-Type", "application/json")
    .send({ decision: "approve" });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.approvalId, token);
  assert.equal(res.body.decision, "approve");
});

test("POST /agent/hitl/:approvalId deny returns ok for an existing approval", async () => {
  const { saveHitlState } = await import("../lib/agent-hitl-store.js");
  const token = saveHitlState({ sample: true });
  const { request, app } = await buildHarness();
  const res = await request(app)
    .post(`/api/v1/agent/hitl/${token}`)
    .set("Content-Type", "application/json")
    .send({ decision: "deny" });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.decision, "deny");
});

test("POST /agent/hitl/:approvalId returns 404 when no approval matches the id", async () => {
  const { request, app } = await buildHarness();
  const res = await request(app)
    .post(`/api/v1/agent/hitl/does-not-exist`)
    .set("Content-Type", "application/json")
    .send({ decision: "approve" });
  assert.equal(res.status, 404);
  assert.equal(res.body.code, "NOT_FOUND");
});

test("POST /agent/hitl/:approvalId second request for the same id returns 409 (already consumed)", async () => {
  const { saveHitlState } = await import("../lib/agent-hitl-store.js");
  const token = saveHitlState({ sample: true });
  const { request, app } = await buildHarness();
  const first = await request(app)
    .post(`/api/v1/agent/hitl/${token}`)
    .set("Content-Type", "application/json")
    .send({ decision: "approve" });
  assert.equal(first.status, 200);
  const second = await request(app)
    .post(`/api/v1/agent/hitl/${token}`)
    .set("Content-Type", "application/json")
    .send({ decision: "approve" });
  assert.equal(second.status, 409);
  assert.equal(second.body.code, "CONFLICT");
});

test("POST /agent/hitl/:approvalId returns 401 when auth is missing", async () => {
  const { saveHitlState } = await import("../lib/agent-hitl-store.js");
  const token = saveHitlState({ sample: true });
  const { request, app } = await buildHarness({ authed: false });
  const res = await request(app)
    .post(`/api/v1/agent/hitl/${token}`)
    .set("Content-Type", "application/json")
    .send({ decision: "approve" });
  assert.equal(res.status, 401);
  assert.equal(res.body.code, "AUTH_REQUIRED");
});

test("POST /agent/hitl/:approvalId returns 400 for an invalid decision", async () => {
  const { saveHitlState } = await import("../lib/agent-hitl-store.js");
  const token = saveHitlState({ sample: true });
  const { request, app } = await buildHarness();
  const res = await request(app)
    .post(`/api/v1/agent/hitl/${token}`)
    .set("Content-Type", "application/json")
    .send({ decision: "maybe" });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "INVALID_DECISION");
});

test("POST /agent/hitl/:approvalId returns 400 when the body has no decision", async () => {
  const { saveHitlState } = await import("../lib/agent-hitl-store.js");
  const token = saveHitlState({ sample: true });
  const { request, app } = await buildHarness();
  const res = await request(app)
    .post(`/api/v1/agent/hitl/${token}`)
    .set("Content-Type", "application/json")
    .send({});
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "INVALID_DECISION");
});
