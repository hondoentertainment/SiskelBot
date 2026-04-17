/**
 * Route tests for /api/admin/traces* endpoints.
 *
 * Mounts only the admin-traces routes against an isolated STORAGE_PATH
 * so we can exercise the underlying agent-trajectory store directly.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const tmpRoot = mkdtempSync(join(tmpdir(), "siskel-admin-traces-"));
process.env.STORAGE_PATH = tmpRoot;
// Keep trajectories in memory + on disk for the length of this test run.
process.env.AGENT_TRAJECTORY_TTL_MS = "3600000";

test.after(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
});

async function buildHarness() {
  const request = (await import("supertest")).default;
  const express = (await import("express")).default;
  const { default: mountAdminTracesRoutes } = await import("../routes/admin-traces.js");

  const app = express();
  app.use(express.json());

  const apiError = (res, status, code, message) => res.status(status).json({ error: message, code });
  const logRequest = (_req, _res, next) => next();
  const adminAuth = (_req, _res, next) => next();
  const requireScope = () => (_req, _res, next) => next();
  const sanitizeWorkspace = (ws) => String(ws || "default").replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80);

  mountAdminTracesRoutes(app, { apiError, logRequest, adminAuth, requireScope, sanitizeWorkspace });
  return { request, app };
}

/** Seed a trajectory with the shape produced by lib/agent-loop.js. */
async function seedTrajectory(runId, workspace, extra = {}) {
  const { saveTrajectory } = await import("../lib/agent-trajectory.js");
  const baseMs = Date.now();
  const at = (offset) => new Date(baseMs + offset).toISOString();
  const steps = extra.steps || [
    { type: "start", at: at(0), model: "gpt-test" },
    { type: "iteration", iteration: 1, at: at(5) },
    { type: "tool_call", iteration: 1, name: "web_search", argsPreview: JSON.stringify({ q: "foo" }), at: at(10) },
    { type: "tool_result", iteration: 1, name: "web_search", ok: true, preview: "result A", at: at(120) },
    { type: "iteration", iteration: 2, at: at(130) },
    { type: "tool_call", iteration: 2, name: "fetch_allowed_url", argsPreview: JSON.stringify({ url: "https://x" }), at: at(135) },
    { type: "tool_error", iteration: 2, name: "fetch_allowed_url", message: "timeout", at: at(250) },
    { type: "replan", iteration: 2, reason: "tool_failure", at: at(260) },
    { type: "stop", iteration: 2, reason: "model_finished", iterations: 2, at: at(300) },
  ];
  const payload = {
    runId,
    workspace,
    sessionId: extra.sessionId || null,
    recordedAt: at(310),
    stepCount: steps.length,
    steps,
  };
  await saveTrajectory(runId, payload);
  return payload;
}

test("GET /api/admin/traces: empty workspace returns empty traces list", async () => {
  const { request, app } = await buildHarness();
  const r = await request(app).get("/api/admin/traces?workspace=wsEmptyTrace");
  assert.equal(r.status, 200);
  assert.equal(r.body.workspace, "wsEmptyTrace");
  assert.deepEqual(r.body.traces, []);
});

test("GET /api/admin/traces: returns list summary for pre-populated traces", async () => {
  const ws = `wsTraces-${Date.now()}`;
  await seedTrajectory(`run-a-${Date.now()}`, ws, { sessionId: "sess-1" });
  await seedTrajectory(`run-b-${Date.now()}`, ws, { sessionId: "sess-2" });

  const { request, app } = await buildHarness();
  const r = await request(app).get(`/api/admin/traces?workspace=${ws}&limit=10`);
  assert.equal(r.status, 200);
  assert.equal(r.body.workspace, ws);
  assert.equal(Array.isArray(r.body.traces), true);
  assert.ok(r.body.traces.length >= 2, "should list both seeded traces");
  const sample = r.body.traces[0];
  for (const k of ["runId", "sessionId", "startedAt", "stopReason", "iterationCount", "toolCallCount", "totalCostUsd"]) {
    assert.ok(k in sample, `list item is missing key: ${k}`);
  }
  assert.equal(sample.stopReason, "model_finished");
  assert.equal(sample.iterationCount, 2);
  assert.equal(sample.toolCallCount, 2);
});

test("GET /api/admin/traces/:runId: returns full grouped trace", async () => {
  const runId = `run-detail-${Date.now()}`;
  const ws = `wsDetail-${Date.now()}`;
  await seedTrajectory(runId, ws, { sessionId: "sess-detail" });

  const { request, app } = await buildHarness();
  const r = await request(app).get(`/api/admin/traces/${runId}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.runId, runId);
  assert.equal(r.body.sessionId, "sess-detail");
  assert.equal(Array.isArray(r.body.iterations), true);
  assert.ok(r.body.iterations.length >= 2);

  const iter1 = r.body.iterations.find((x) => x.iteration === 1);
  assert.ok(iter1, "iteration 1 present");
  assert.equal(iter1.toolCalls.length, 1);
  assert.equal(iter1.toolCalls[0].name, "web_search");
  assert.equal(iter1.toolCalls[0].ok, true);
  assert.deepEqual(iter1.toolCalls[0].args, { q: "foo" });
  assert.equal(iter1.toolCalls[0].result, "result A");
  assert.ok(typeof iter1.toolCalls[0].latencyMs === "number" && iter1.toolCalls[0].latencyMs >= 0);

  const iter2 = r.body.iterations.find((x) => x.iteration === 2);
  assert.ok(iter2);
  assert.equal(iter2.toolCalls.length, 1);
  assert.equal(iter2.toolCalls[0].ok, false);
  assert.equal(iter2.toolCalls[0].result, "timeout");
  assert.ok(iter2.signals.some((s) => s.kind === "replan"));
  assert.ok(iter2.signals.some((s) => s.kind === "stop"));
});

test("GET /api/admin/traces/:unknown: returns 404 with proper error shape", async () => {
  const { request, app } = await buildHarness();
  const r = await request(app).get("/api/admin/traces/this-run-does-not-exist");
  assert.equal(r.status, 404);
  assert.equal(r.body.code, "NOT_FOUND");
  assert.ok(typeof r.body.error === "string" && r.body.error.length > 0);
});

test("GET /api/admin/traces/:runId: truncates message content over 10000 chars", async () => {
  const runId = `run-bigmsg-${Date.now()}`;
  const ws = `wsBig-${Date.now()}`;
  const big = "X".repeat(15000);
  const at = (o) => new Date(Date.now() + o).toISOString();
  await seedTrajectory(runId, ws, {
    steps: [
      { type: "start", at: at(0) },
      { type: "iteration", iteration: 1, at: at(1) },
      { type: "tool_call", iteration: 1, name: "t", argsPreview: "{}", at: at(2) },
      { type: "tool_result", iteration: 1, name: "t", ok: true, preview: big, at: at(3) },
      { type: "message", iteration: 1, role: "assistant", content: big, at: at(4) },
      { type: "stop", iteration: 1, reason: "model_finished", at: at(5) },
    ],
  });

  const { request, app } = await buildHarness();
  const r = await request(app).get(`/api/admin/traces/${runId}`);
  assert.equal(r.status, 200);
  const iter = r.body.iterations.find((x) => x.iteration === 1);
  assert.ok(iter);
  const tc = iter.toolCalls.find((x) => x.name === "t");
  assert.ok(tc, "tool call present");
  assert.ok(typeof tc.result === "string");
  assert.ok(tc.result.length <= 10000 + 32, "result is truncated (plus marker)");
  assert.ok(tc.result.endsWith("…[truncated]"), "result ends with truncation marker");

  const msg = iter.messages[0];
  assert.ok(msg, "message present");
  assert.ok(msg.content.length <= 10000 + 32);
  assert.ok(msg.content.endsWith("…[truncated]"));
});
