import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const dir = mkdtempSync(join(tmpdir(), "replay-route-"));
const prevStorage = process.env.STORAGE_PATH;
const prevSecret = process.env.REPLAY_TOKEN_SECRET;
process.env.STORAGE_PATH = dir;
process.env.REPLAY_TOKEN_SECRET = "replay-route-test-secret";

test.after(() => {
  if (prevStorage === undefined) delete process.env.STORAGE_PATH;
  else process.env.STORAGE_PATH = prevStorage;
  if (prevSecret === undefined) delete process.env.REPLAY_TOKEN_SECRET;
  else process.env.REPLAY_TOKEN_SECRET = prevSecret;
  rmSync(dir, { recursive: true, force: true });
});

async function buildHarness({ authed = true } = {}) {
  const request = (await import("supertest")).default;
  const express = (await import("express")).default;
  const { mountReplayRoutes } = await import("../routes/replay.js");
  const { createAgentSession, linkRunToAgentSession } = await import(
    "../lib/agent-session.js"
  );
  const { saveTrajectory } = await import("../lib/agent-trajectory.js");

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
    if (!authed) {
      req.userId = null;
      return next();
    }
    req.userId = "anonymous";
    req.authenticatedViaDeploymentKey = true;
    req.apiKeyScopes = ["read", "write"];
    next();
  };
  const requireScope = () => (_req, _res, next) => next();

  mountReplayRoutes(app, { apiRoute, apiError, userAuth, requireScope, logRequest });

  return { request, app, createAgentSession, linkRunToAgentSession, saveTrajectory };
}

test("POST /agent/sessions/:id/share mints a token for the owner", async () => {
  const { request, app, createAgentSession, linkRunToAgentSession, saveTrajectory } =
    await buildHarness();
  const session = await createAgentSession({
    workspace: "default",
    ownerStorageUserId: "anonymous",
    title: "share-run",
  });
  await linkRunToAgentSession(session.id, "run-share-1");
  await saveTrajectory("run-share-1", {
    runId: "run-share-1",
    workspace: "default",
    stepCount: 2,
    steps: [
      { type: "tool_call", name: "search", argsPreview: "{\"q\":\"x\"}" },
      { type: "message", summary: "done" },
    ],
  });

  const res = await request(app).post(`/api/v1/agent/sessions/${session.id}/share`).send({});
  assert.equal(res.status, 201);
  assert.ok(res.body.token);
  assert.equal(res.body.url, `/r/${res.body.token}`);
  assert.ok(res.body.expiresAt);
  assert.equal(res.body.runId, "run-share-1");
});

test("POST /agent/sessions/:id/share returns 404 when session is missing", async () => {
  const { request, app } = await buildHarness();
  const res = await request(app)
    .post(`/api/v1/agent/sessions/does-not-exist/share`)
    .send({});
  assert.equal(res.status, 404);
  assert.equal(res.body.code, "NOT_FOUND");
});

test("GET /r/:token returns 200 HTML for a valid token", async () => {
  const { request, app, createAgentSession, linkRunToAgentSession, saveTrajectory } =
    await buildHarness();
  const session = await createAgentSession({
    workspace: "default",
    ownerStorageUserId: "anonymous",
    title: "html-run",
  });
  await linkRunToAgentSession(session.id, "run-html-1");
  await saveTrajectory("run-html-1", {
    runId: "run-html-1",
    workspace: "default",
    stepCount: 0,
    steps: [],
  });
  const mintRes = await request(app).post(`/api/v1/agent/sessions/${session.id}/share`).send({});
  assert.equal(mintRes.status, 201);
  const token = mintRes.body.token;

  const htmlRes = await request(app).get(`/r/${token}`);
  assert.equal(htmlRes.status, 200);
  assert.match(htmlRes.headers["content-type"] || "", /text\/html/);
  assert.match(htmlRes.text, /Read-only replay|replay-root/);
  assert.match(htmlRes.text, /\/src\/views\/replay\.js/);
});

test("GET /r/:token returns 403 when revoked", async () => {
  const { request, app, createAgentSession, linkRunToAgentSession, saveTrajectory } =
    await buildHarness();
  const session = await createAgentSession({
    workspace: "default",
    ownerStorageUserId: "anonymous",
    title: "revoke-run",
  });
  await linkRunToAgentSession(session.id, "run-revoke-1");
  await saveTrajectory("run-revoke-1", {
    runId: "run-revoke-1",
    workspace: "default",
    stepCount: 0,
    steps: [],
  });
  const mintRes = await request(app).post(`/api/v1/agent/sessions/${session.id}/share`).send({});
  assert.equal(mintRes.status, 201);
  const token = mintRes.body.token;

  const delRes = await request(app).delete(`/api/v1/agent/sessions/${session.id}/share/${token}`);
  assert.equal(delRes.status, 200);
  assert.equal(delRes.body.ok, true);

  const htmlRes = await request(app).get(`/r/${token}`);
  assert.equal(htmlRes.status, 403);
  assert.match(htmlRes.text, /REVOKED/);
});

test("GET /r/:token returns 403 when the token is expired", async () => {
  const { request, app, createAgentSession, linkRunToAgentSession, saveTrajectory } =
    await buildHarness();
  const session = await createAgentSession({
    workspace: "default",
    ownerStorageUserId: "anonymous",
    title: "expiry-run",
  });
  await linkRunToAgentSession(session.id, "run-exp-1");
  await saveTrajectory("run-exp-1", {
    runId: "run-exp-1",
    workspace: "default",
    stepCount: 0,
    steps: [],
  });
  // Craft an expired token directly using the tokens module.
  const { mintReplayToken } = await import("../lib/replay-tokens.js");
  const original = mintReplayToken({
    runId: "run-exp-1",
    workspaceId: "default",
    userId: "anonymous",
    ttlMs: 60_000,
  });
  const [h, p] = original.split(".");
  const decoded = JSON.parse(
    Buffer.from(
      p.replace(/-/g, "+").replace(/_/g, "/") +
        "=".repeat((4 - (p.length % 4)) % 4),
      "base64",
    ).toString("utf8"),
  );
  decoded.exp = 1;
  const newPayload64 = Buffer.from(JSON.stringify(decoded), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  const { createHmac } = await import("crypto");
  const sig = createHmac("sha256", process.env.REPLAY_TOKEN_SECRET)
    .update(`${h}.${newPayload64}`)
    .digest();
  const newSig64 = sig
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  const expired = `${h}.${newPayload64}.${newSig64}`;

  const htmlRes = await request(app).get(`/r/${expired}`);
  assert.equal(htmlRes.status, 403);
  assert.match(htmlRes.text, /EXPIRED/);
});

test("GET /api/v1/replay/:token/events returns 200 JSON for valid token", async () => {
  const { request, app, createAgentSession, linkRunToAgentSession, saveTrajectory } =
    await buildHarness();
  const session = await createAgentSession({
    workspace: "default",
    ownerStorageUserId: "anonymous",
    title: "events-run",
    planSummary: "step 1; step 2",
  });
  await linkRunToAgentSession(session.id, "run-events-1");
  await saveTrajectory("run-events-1", {
    runId: "run-events-1",
    workspace: "default",
    stepCount: 2,
    steps: [
      { type: "tool_call", name: "search", argsPreview: "{\"q\":\"ok\"}", resultPreview: "[]" },
      { type: "message", summary: "finished" },
    ],
  });
  const mintRes = await request(app).post(`/api/v1/agent/sessions/${session.id}/share`).send({});
  assert.equal(mintRes.status, 201);
  const token = mintRes.body.token;

  const res = await request(app).get(`/api/v1/replay/${token}/events`);
  assert.equal(res.status, 200);
  assert.equal(res.headers["content-type"]?.includes("application/json"), true);
  assert.equal(res.body.runId, "run-events-1");
  assert.equal(res.body.workspaceId, "default");
  assert.ok(Array.isArray(res.body.events));
  assert.equal(res.body.events.length, 2);
  assert.equal(res.body.events[0].name, "search");
  assert.equal(res.body.events[0].type, "tool_call");
  assert.ok(res.body.plan);
  assert.equal(res.body.plan.planSummary, "step 1; step 2");
});

test("GET /api/v1/replay/:token/events returns 403 for an invalid token", async () => {
  const { request, app } = await buildHarness();
  const res = await request(app).get(`/api/v1/replay/not-a-real-token/events`);
  assert.equal(res.status, 403);
  assert.ok(res.body.code);
});

test("POST /agent/sessions/:id/share requires auth (rejects when userId missing)", async () => {
  // Rebuild harness with userAuth that flags unauthenticated requests.
  const request = (await import("supertest")).default;
  const express = (await import("express")).default;
  const { mountReplayRoutes } = await import("../routes/replay.js");
  const { createAgentSession } = await import("../lib/agent-session.js");

  const app = express();
  app.use(express.json());
  const apiRoute = (method, path, ...handlers) => {
    app[method](`/api/v1${path}`, ...handlers);
  };
  const apiError = (res, status, code, message, hint) => {
    res.status(status).json({ error: message, code, hint: hint || null });
  };
  const logRequest = (_req, _res, next) => next();
  const userAuth = (_req, res) => {
    res.status(401).json({ error: "Unauthorized", code: "AUTH_REQUIRED" });
  };
  const requireScope = () => (_req, _res, next) => next();
  mountReplayRoutes(app, { apiRoute, apiError, userAuth, requireScope, logRequest });

  const session = await createAgentSession({
    workspace: "default",
    ownerStorageUserId: "anonymous",
    title: "auth-run",
  });
  const res = await request(app).post(`/api/v1/agent/sessions/${session.id}/share`).send({});
  assert.equal(res.status, 401);
  assert.equal(res.body.code, "AUTH_REQUIRED");
});
