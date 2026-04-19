/**
 * Route tests for /api/admin/health-score and /refresh.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const tmpRoot = mkdtempSync(join(tmpdir(), "siskel-admin-health-score-"));
process.env.STORAGE_PATH = tmpRoot;
process.env.ENABLE_METRICS = "1";

test.after(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
});

async function buildHarness({ auth = "ok" } = {}) {
  const request = (await import("supertest")).default;
  const express = (await import("express")).default;
  const { default: mountAdminHealthScoreRoutes } = await import("../routes/admin-health-score.js");

  const app = express();
  app.use(express.json());

  const apiError = (res, status, code, message) => res.status(status).json({ error: message, code });
  const logRequest = (_req, _res, next) => next();
  const adminAuth = (_req, res, next) => {
    if (auth === "ok") return next();
    return res.status(401).json({ error: "unauthorized" });
  };
  const requireScope = () => (_req, _res, next) => next();
  const sanitizeWorkspace = (ws) =>
    String(ws || "default").replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80);

  mountAdminHealthScoreRoutes(app, { apiError, logRequest, adminAuth, requireScope, sanitizeWorkspace });
  return { request, app };
}

test("GET /api/admin/health-score returns expected shape for empty workspace", async () => {
  const { request, app } = await buildHarness();
  const r = await request(app).get(`/api/admin/health-score?workspace=wsShape-${Date.now()}`);
  assert.equal(r.status, 200);
  assert.ok(typeof r.body.score === "number");
  assert.ok(typeof r.body.ts === "number");
  assert.ok(typeof r.body.workspace === "string");
  assert.ok(r.body.components);
  assert.ok(r.body.weights);
  assert.ok(["healthy", "warning", "critical"].includes(r.body.status));
  assert.ok(Array.isArray(r.body.alerts));
  // Empty workspace -> score 0, status critical.
  assert.equal(r.body.score, 0);
  assert.equal(r.body.status, "critical");
});

test("GET /api/admin/health-score reflects populated stores", async () => {
  const ws = `wsPop-${Date.now()}`;
  const { recordSample } = await import("../lib/eval-history-store.js");
  const { recordFeedback } = await import("../lib/agent-feedback-store.js");
  await recordSample(ws, { ts: Date.now(), kind: "benchmark", metrics: { passRate: 1 } });
  await recordSample(ws, { ts: Date.now(), kind: "safety", metrics: { passRate: 1 } });
  await recordFeedback(ws, { runId: "r1", userId: "u", rating: "up" });

  const { request, app } = await buildHarness();
  const r = await request(app).get(`/api/admin/health-score?workspace=${ws}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.components.benchmarkPassRate, 1);
  assert.equal(r.body.components.safetyPassRate, 1);
  assert.equal(r.body.components.feedbackUpRate, 1);
  assert.ok(r.body.score >= 0.5); // bench(0.25) + safety(0.25) + feedback(0.20) = 0.70
});

test("POST /refresh updates the Prometheus gauge for this workspace", async () => {
  const ws = `wsRefresh-${Date.now()}`;
  const { recordSample } = await import("../lib/eval-history-store.js");
  await recordSample(ws, { ts: Date.now(), kind: "benchmark", metrics: { passRate: 0.8 } });
  await recordSample(ws, { ts: Date.now(), kind: "safety", metrics: { passRate: 0.92 } });

  const metrics = await import("../lib/metrics.js");
  metrics.__resetAgentHealthScoreForTests();

  const { request, app } = await buildHarness();
  const r = await request(app).post(`/api/admin/health-score/refresh?workspace=${ws}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.ok(typeof r.body.score === "number");
  assert.ok(r.body.healthScore && r.body.healthScore.components);
  assert.ok(r.body.alert && typeof r.body.alert.emitted === "boolean");

  // Verify Prometheus output contains the gauge with the labeled workspace.
  const out = metrics.renderPrometheus();
  assert.match(out, /# TYPE siskelbot_agent_health_score gauge/);
  const wsLabel = ws.replace(/[^a-zA-Z0-9_:]/g, "_").slice(0, 64);
  const re = new RegExp(`siskelbot_agent_health_score\\{workspace="${wsLabel}"\\}`);
  assert.match(out, re);
});

test("admin auth required (401 when adminAuth rejects)", async () => {
  const { request, app } = await buildHarness({ auth: "reject" });
  const r1 = await request(app).get("/api/admin/health-score?workspace=x");
  assert.equal(r1.status, 401);
  const r2 = await request(app).post("/api/admin/health-score/refresh?workspace=x");
  assert.equal(r2.status, 401);
});

test("weights in response match DEFAULT_WEIGHTS", async () => {
  const { DEFAULT_WEIGHTS } = await import("../lib/agent-health-score.js");
  const { request, app } = await buildHarness();
  const r = await request(app).get(`/api/admin/health-score?workspace=wsWeights-${Date.now()}`);
  assert.equal(r.status, 200);
  for (const k of Object.keys(DEFAULT_WEIGHTS)) {
    assert.equal(r.body.weights[k], DEFAULT_WEIGHTS[k]);
  }
});
