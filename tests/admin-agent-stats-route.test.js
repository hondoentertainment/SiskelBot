/**
 * Route tests for /api/admin/agent-stats/* endpoints.
 * Covers: failures + reliability GET/DELETE with isolated STORAGE_PATH.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const tmpRoot = mkdtempSync(join(tmpdir(), "siskel-admin-stats-"));
process.env.STORAGE_PATH = tmpRoot;

test.after(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
});

async function buildHarness() {
  const request = (await import("supertest")).default;
  const express = (await import("express")).default;
  const { default: mountAgentStatsAdminRoutes } = await import("../routes/admin-agent-stats.js");

  const app = express();
  app.use(express.json());

  const apiError = (res, status, code, message) => res.status(status).json({ error: message, code });
  const logRequest = (_req, _res, next) => next();
  const adminAuth = (_req, _res, next) => next();
  const requireScope = () => (_req, _res, next) => next();
  const sanitizeWorkspace = (ws) => String(ws || "default").replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80);

  mountAgentStatsAdminRoutes(app, { apiError, logRequest, adminAuth, requireScope, sanitizeWorkspace });
  return { request, app };
}

test("GET /api/admin/agent-stats/failures: empty workspace returns empty chronic list", async () => {
  const { request, app } = await buildHarness();
  const r = await request(app).get("/api/admin/agent-stats/failures?workspace=wsEmpty");
  assert.equal(r.status, 200);
  assert.equal(r.body.workspace, "wsEmpty");
  assert.equal(r.body.totals.tools, 0);
  assert.equal(r.body.totals.failures, 0);
  assert.deepEqual(r.body.chronic, []);
});

test("GET /api/admin/agent-stats/failures: reports counts after recording failures", async () => {
  const { recordRunFailures } = await import("../lib/agent-failure-store.js");
  const ws = `wsFail-${Date.now()}`;
  await recordRunFailures(ws, [
    { tool: "web_search", category: "rate_limit" },
    { tool: "web_search", category: "rate_limit" },
    { tool: "bad_tool", category: "permission" },
    { tool: "bad_tool", category: "permission" },
    { tool: "bad_tool", category: "permission" },
  ]);

  const { request, app } = await buildHarness();
  const r = await request(app).get(`/api/admin/agent-stats/failures?workspace=${ws}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.totals.tools, 2);
  assert.equal(r.body.totals.failures, 5);
  // bad_tool has 3 permission (terminal) -> higher chronic score than web_search
  assert.equal(r.body.chronic[0].tool, "bad_tool");
});

test("DELETE /api/admin/agent-stats/failures: resets workspace stats", async () => {
  const { recordFailure } = await import("../lib/agent-failure-store.js");
  const ws = `wsReset-${Date.now()}`;
  await recordFailure(ws, "t", "permission");

  const { request, app } = await buildHarness();
  const del = await request(app).delete(`/api/admin/agent-stats/failures?workspace=${ws}`);
  assert.equal(del.status, 200);
  assert.equal(del.body.ok, true);

  const after = await request(app).get(`/api/admin/agent-stats/failures?workspace=${ws}`);
  assert.equal(after.body.totals.tools, 0);
});

test("GET /api/admin/agent-stats/reliability: empty workspace returns empty ranked list and no hint", async () => {
  const { request, app } = await buildHarness();
  const r = await request(app).get("/api/admin/agent-stats/reliability?workspace=wsEmptyRel");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.ranked, []);
  assert.equal(r.body.hint, "");
});

test("GET /api/admin/agent-stats/reliability: reports ranked tools + hint with enough signal", async () => {
  const { recordToolOutcomes } = await import("../lib/agent-genealogy.js");
  const ws = `wsRel-${Date.now()}`;
  const outs = [];
  for (let i = 0; i < 10; i++) outs.push({ tool: "winner", ok: true });
  for (let i = 0; i < 8; i++) outs.push({ tool: "loser", ok: false });
  await recordToolOutcomes(ws, outs);

  const { request, app } = await buildHarness();
  const r = await request(app).get(`/api/admin/agent-stats/reliability?workspace=${ws}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.totals.samples, 18);
  assert.equal(r.body.ranked[0].tool, "winner");
  assert.equal(r.body.ranked[r.body.ranked.length - 1].tool, "loser");
  assert.match(r.body.hint, /winner/);
  assert.match(r.body.hint, /loser/);
});

test("DELETE /api/admin/agent-stats/reliability: resets genealogy", async () => {
  const { recordToolOutcomes } = await import("../lib/agent-genealogy.js");
  const ws = `wsRelReset-${Date.now()}`;
  await recordToolOutcomes(ws, [{ tool: "x", ok: true }]);

  const { request, app } = await buildHarness();
  const del = await request(app).delete(`/api/admin/agent-stats/reliability?workspace=${ws}`);
  assert.equal(del.status, 200);

  const after = await request(app).get(`/api/admin/agent-stats/reliability?workspace=${ws}`);
  assert.equal(after.body.totals.tools, 0);
});

test("GET /api/admin/agent-stats/reliability: minSamples filters low-signal tools", async () => {
  const { recordToolOutcomes } = await import("../lib/agent-genealogy.js");
  const ws = `wsMin-${Date.now()}`;
  await recordToolOutcomes(ws, [
    { tool: "few", ok: true },
    { tool: "many", ok: true },
    { tool: "many", ok: true },
    { tool: "many", ok: true },
    { tool: "many", ok: false },
  ]);

  const { request, app } = await buildHarness();
  const r = await request(app).get(`/api/admin/agent-stats/reliability?workspace=${ws}&minSamples=3`);
  assert.ok(r.body.ranked.every((x) => x.tool !== "few"));
  assert.ok(r.body.ranked.some((x) => x.tool === "many"));
});
