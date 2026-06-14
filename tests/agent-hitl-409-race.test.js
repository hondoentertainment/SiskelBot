/**
 * Concurrent-approval race tests for POST /api/v1/agent/hitl/:approvalId.
 *
 * The route uses a single atomic `takeHitlState` call (no peek+take gap).
 * When the token is already consumed, `takeHitlState` returns null and the
 * route returns 409 CONFLICT. This means both concurrent and sequential
 * duplicate requests correctly receive 409.
 *
 *   Test A — two concurrent POSTs with the same id resolve to {200, 409}.
 *   Test B — a forced race with an async gap also produces {200, 409}.
 *   Test C — sequential resolution returns 200 then 409.
 */
import test from "node:test";
import assert from "node:assert/strict";

async function buildRealRouteHarness() {
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
  const userAuth = (req, _res, next) => {
    req.userId = "anonymous";
    req.authenticatedViaDeploymentKey = true;
    req.apiKeyScopes = ["read", "write"];
    next();
  };
  const requireScope = () => (_req, _res, next) => next();

  mountAgentHitlRoutes(app, { apiRoute, apiError, userAuth, requireScope, logRequest });
  return { request, app };
}

test("POST /agent/hitl/:approvalId — concurrent approvals: winner gets 200, loser gets 409", async () => {
  const { saveHitlState } = await import("../lib/agent-hitl-store.js");
  const token = saveHitlState({ sample: true });
  const { request, app } = await buildRealRouteHarness();

  const send = (decision) =>
    request(app)
      .post(`/api/v1/agent/hitl/${token}`)
      .set("Content-Type", "application/json")
      .send({ decision });

  const [a, b] = await Promise.all([send("approve"), send("deny")]);
  const statuses = [a.status, b.status].sort();

  // After fix: the route uses atomic takeHitlState only (no peek+take gap).
  // The winner gets 200, the loser gets 409 CONFLICT.
  assert.deepEqual(
    statuses,
    [200, 409],
    `expected [200, 409] with atomic take semantics; got ${JSON.stringify(statuses)}`,
  );

  const ok = a.status === 200 ? a : b;
  const loser = a.status === 200 ? b : a;
  assert.equal(ok.body.ok, true);
  assert.equal(ok.body.approvalId, token);
  assert.ok(["approve", "deny"].includes(ok.body.decision));
  assert.equal(loser.body.code, "CONFLICT");
});

/**
 * Build a route harness that uses the same peek/take store bindings as the
 * real handler, but inserts an awaited delay between them. This forces the
 * `peek returned truthy, take returned null` window to open and exercises
 * the same 409 JSON shape the real route would return if it ever saw that
 * race.
 *
 * This is a test-only wrapper; production routes/agent-hitl.js is not
 * modified.
 */
async function buildRaceableRouteHarness() {
  const request = (await import("supertest")).default;
  const express = (await import("express")).default;
  const { peekHitlState, takeHitlState } = await import(
    "../lib/agent-hitl-store.js"
  );

  const app = express();
  app.use(express.json());

  app.post("/api/v1/agent/hitl/:approvalId", async (req, res) => {
    const approvalId = String(req.params?.approvalId || "").trim();
    const decision =
      typeof req.body?.decision === "string" ? req.body.decision.trim() : "";

    const snapshot = peekHitlState(approvalId);
    if (!snapshot) {
      return res
        .status(404)
        .json({ error: "Approval not found", code: "NOT_FOUND", hint: null });
    }

    // Forced async gap: yield for a microtask+ to let a concurrent request
    // consume the token between our peek and our take. Mirrors a future
    // handler that performs async work (DB write, audit log, etc.) between
    // those calls.
    await new Promise((r) => setTimeout(r, 10));

    const taken = takeHitlState(approvalId, { decision });
    if (!taken) {
      return res.status(409).json({
        error: "Approval already resolved",
        code: "CONFLICT",
        hint: "Another request consumed this approval id.",
      });
    }
    return res.status(200).json({ ok: true, approvalId, decision });
  });

  return { request, app };
}

test("POST /agent/hitl/:approvalId — when peek+take straddle an async gap, concurrent requests produce a 409 (documents the target shape)", async () => {
  const { saveHitlState } = await import("../lib/agent-hitl-store.js");
  const token = saveHitlState({ sample: true });
  const { request, app } = await buildRaceableRouteHarness();

  const send = (decision) =>
    request(app)
      .post(`/api/v1/agent/hitl/${token}`)
      .set("Content-Type", "application/json")
      .send({ decision });

  const [a, b] = await Promise.all([send("approve"), send("deny")]);
  const statuses = [a.status, b.status].sort();

  // One request wins with 200; the loser sees the token vanish between its
  // own peek and take → 409 CONFLICT (not 404).
  assert.deepEqual(
    statuses,
    [200, 409],
    `expected [200, 409] under a real race, got ${JSON.stringify(statuses)}`,
  );

  const ok = a.status === 200 ? a : b;
  const loser = a.status === 409 ? a : b;
  assert.equal(ok.body.ok, true);
  assert.equal(ok.body.approvalId, token);
  assert.equal(loser.body.code, "CONFLICT");
  assert.match(
    String(loser.body.error || ""),
    /already resolved/i,
    `expected 'already resolved' message, got ${JSON.stringify(loser.body)}`,
  );
});

test("POST /agent/hitl/:approvalId — sequential resolution returns 200 then 409", async () => {
  const { saveHitlState } = await import("../lib/agent-hitl-store.js");
  const token = saveHitlState({ sample: true });
  const { request, app } = await buildRealRouteHarness();

  const first = await request(app)
    .post(`/api/v1/agent/hitl/${token}`)
    .set("Content-Type", "application/json")
    .send({ decision: "approve" });
  assert.equal(first.status, 200);

  const second = await request(app)
    .post(`/api/v1/agent/hitl/${token}`)
    .set("Content-Type", "application/json")
    .send({ decision: "deny" });
  // After fix: the route uses takeHitlState atomically. A consumed token
  // returns null from take, which the route interprets as 409 CONFLICT.
  assert.equal(second.status, 409);
  assert.equal(second.body.code, "CONFLICT");
});
