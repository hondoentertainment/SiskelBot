/**
 * Route tests for /api/admin/prompt-canary/* endpoints.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const tmpRoot = mkdtempSync(join(tmpdir(), "siskel-canary-route-"));
process.env.STORAGE_PATH = tmpRoot;

test.after(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
});

async function buildHarness() {
  const request = (await import("supertest")).default;
  const express = (await import("express")).default;
  const { default: mountAdminPromptCanaryRoutes } = await import("../routes/admin-prompt-canary.js");

  const app = express();
  app.use(express.json());

  const apiError = (res, status, code, message) => res.status(status).json({ error: message, code });
  const logRequest = (_req, _res, next) => next();
  const adminAuth = (_req, _res, next) => next();
  const requireScope = () => (_req, _res, next) => next();
  const sanitizeWorkspace = (ws) => String(ws || "default").replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80);

  mountAdminPromptCanaryRoutes(app, { apiError, logRequest, adminAuth, requireScope, sanitizeWorkspace });
  return { request, app };
}

async function seedPendingPatch(ws, version) {
  const { savePatch } = await import("../lib/agent-prompt-tuner.js");
  await savePatch({
    workspace: ws,
    version,
    content: `patch ${version}`,
    generatedAt: Date.now(),
    basis: {
      failureCount: 0, genealogyCount: 0, conflictCount: 0,
      toolsFlagged: [], toolsPreferred: [],
    },
    status: "pending",
  });
}

test("GET /prompt-canary: empty workspace → active:null, history:[]", async () => {
  const { request, app } = await buildHarness();
  const r = await request(app).get("/api/admin/prompt-canary?workspace=wsEmpty");
  assert.equal(r.status, 200);
  assert.equal(r.body.active, null);
  assert.deepEqual(r.body.history, []);
  assert.equal(r.body.workspace, "wsEmpty");
});

test("POST /prompt-canary: starts canary and returns 200", async () => {
  const ws = `wsStart-${Date.now()}`;
  await seedPendingPatch(ws, "v-a");
  const { request, app } = await buildHarness();
  const r = await request(app)
    .post(`/api/admin/prompt-canary?workspace=${ws}`)
    .send({ candidateVersion: "v-a", trafficSplit: 0.2 });
  assert.equal(r.status, 200);
  assert.ok(r.body.canary);
  assert.equal(r.body.canary.status, "active");
  assert.equal(r.body.canary.candidateVersion, "v-a");
  assert.equal(r.body.canary.trafficSplit, 0.2);
});

test("POST /prompt-canary: missing candidateVersion → 400", async () => {
  const { request, app } = await buildHarness();
  const r = await request(app)
    .post("/api/admin/prompt-canary?workspace=wsBad")
    .send({});
  assert.equal(r.status, 400);
});

test("POST /prompt-canary: unknown version → 400", async () => {
  const { request, app } = await buildHarness();
  const r = await request(app)
    .post("/api/admin/prompt-canary?workspace=wsGhost")
    .send({ candidateVersion: "does-not-exist" });
  assert.equal(r.status, 400);
});

test("GET /prompt-canary: returns the active canary after starting", async () => {
  const ws = `wsGet-${Date.now()}`;
  await seedPendingPatch(ws, "v-get");
  const { request, app } = await buildHarness();
  await request(app)
    .post(`/api/admin/prompt-canary?workspace=${ws}`)
    .send({ candidateVersion: "v-get" });

  const r = await request(app).get(`/api/admin/prompt-canary?workspace=${ws}`);
  assert.equal(r.status, 200);
  assert.ok(r.body.active);
  assert.equal(r.body.active.candidateVersion, "v-get");
  assert.equal(r.body.active.status, "active");
});

test("POST /prompt-canary: cannot start a second canary while one active → 409", async () => {
  const ws = `wsConflict-${Date.now()}`;
  await seedPendingPatch(ws, "v-1");
  await seedPendingPatch(ws, "v-2");
  const { request, app } = await buildHarness();
  const first = await request(app)
    .post(`/api/admin/prompt-canary?workspace=${ws}`)
    .send({ candidateVersion: "v-1" });
  assert.equal(first.status, 200);
  const second = await request(app)
    .post(`/api/admin/prompt-canary?workspace=${ws}`)
    .send({ candidateVersion: "v-2" });
  assert.equal(second.status, 409);
});

test("POST /prompt-canary/promote: status → promoted", async () => {
  const ws = `wsProm-${Date.now()}`;
  await seedPendingPatch(ws, "v-p");
  const { request, app } = await buildHarness();
  await request(app)
    .post(`/api/admin/prompt-canary?workspace=${ws}`)
    .send({ candidateVersion: "v-p" });
  const r = await request(app).post(`/api/admin/prompt-canary/promote?workspace=${ws}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.canary.status, "promoted");

  const list = await request(app).get(`/api/admin/prompt-canary?workspace=${ws}`);
  assert.equal(list.body.active, null);
  assert.equal(list.body.history.length, 1);
  assert.equal(list.body.history[0].status, "promoted");
});

test("POST /prompt-canary/rollback: status → rolled_back", async () => {
  const ws = `wsRb-${Date.now()}`;
  await seedPendingPatch(ws, "v-rb");
  const { request, app } = await buildHarness();
  await request(app)
    .post(`/api/admin/prompt-canary?workspace=${ws}`)
    .send({ candidateVersion: "v-rb" });
  const r = await request(app)
    .post(`/api/admin/prompt-canary/rollback?workspace=${ws}`)
    .send({ reason: "manual operator rollback" });
  assert.equal(r.status, 200);
  assert.equal(r.body.canary.status, "rolled_back");
  assert.equal(r.body.canary.decisionReason, "manual operator rollback");
});

test("POST /prompt-canary/promote: no active → 404", async () => {
  const { request, app } = await buildHarness();
  const r = await request(app).post("/api/admin/prompt-canary/promote?workspace=wsNoActive");
  assert.equal(r.status, 404);
});

test("POST /prompt-canary/evaluate: returns continue on fresh canary", async () => {
  const ws = `wsEval-${Date.now()}`;
  await seedPendingPatch(ws, "v-e");
  const { request, app } = await buildHarness();
  await request(app)
    .post(`/api/admin/prompt-canary?workspace=${ws}`)
    .send({ candidateVersion: "v-e", metrics: ["feedbackUpRate"], minSamplesPerArm: 3 });
  const r = await request(app).post(`/api/admin/prompt-canary/evaluate?workspace=${ws}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.decision, "continue");
});
