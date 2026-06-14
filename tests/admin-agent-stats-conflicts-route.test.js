/**
 * Route tests for the swarm-conflicts admin endpoints:
 *   GET    /api/admin/agent-stats/swarm-conflicts?workspace=X&limit=N
 *   DELETE /api/admin/agent-stats/swarm-conflicts?workspace=X
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const tmpRoot = mkdtempSync(join(tmpdir(), "siskel-admin-conflicts-"));
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

test("GET /api/admin/agent-stats/swarm-conflicts: empty workspace returns empty list", async () => {
  const { request, app } = await buildHarness();
  const r = await request(app).get("/api/admin/agent-stats/swarm-conflicts?workspace=wsEmptyConflicts");
  assert.equal(r.status, 200);
  assert.equal(r.body.workspace, "wsEmptyConflicts");
  assert.equal(r.body.total, 0);
  assert.deepEqual(r.body.events, []);
});

test("GET /api/admin/agent-stats/swarm-conflicts: reports events after recordConflict", async () => {
  const { recordConflict } = await import("../lib/swarm-conflict-store.js");
  const ws = `wsConflicts-${Date.now()}`;
  await recordConflict(ws, {
    type: "polarity",
    similarity: 0.3,
    summary: "Yes/no split",
    specialists: ["researcher", "executor"],
    responses: [
      { specialist: "researcher", output: "Yes." },
      { specialist: "executor", output: "No." },
    ],
  });
  await recordConflict(ws, {
    type: "numeric",
    similarity: 0.2,
    summary: "42 vs 7",
    specialists: ["a", "b"],
    responses: [
      { specialist: "a", output: "42" },
      { specialist: "b", output: "7" },
    ],
    reconciled: "42",
  });

  const { request, app } = await buildHarness();
  const r = await request(app).get(`/api/admin/agent-stats/swarm-conflicts?workspace=${ws}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.total, 2);
  // newest-first
  assert.equal(r.body.events[0].type, "numeric");
  assert.equal(r.body.events[0].reconciled, "42");
  assert.equal(r.body.events[1].type, "polarity");
});

test("GET /api/admin/agent-stats/swarm-conflicts: limit param clamps result count (1-200)", async () => {
  const { recordConflict } = await import("../lib/swarm-conflict-store.js");
  const ws = `wsConflictsLimit-${Date.now()}`;
  for (let i = 0; i < 30; i++) {
    await recordConflict(ws, {
      type: "divergent",
      similarity: 0.1,
      summary: `evt-${i}`,
      specialists: ["r", "e"],
      responses: [{ specialist: "r", output: `r-${i}` }, { specialist: "e", output: `e-${i}` }],
    });
  }

  const { request, app } = await buildHarness();
  const small = await request(app).get(`/api/admin/agent-stats/swarm-conflicts?workspace=${ws}&limit=5`);
  assert.equal(small.status, 200);
  assert.equal(small.body.total, 5);
  assert.equal(small.body.events.length, 5);
  // newest-first
  assert.equal(small.body.events[0].summary, "evt-29");

  const dflt = await request(app).get(`/api/admin/agent-stats/swarm-conflicts?workspace=${ws}`);
  assert.equal(dflt.body.total, 20, "default limit is 20");
});

test("DELETE /api/admin/agent-stats/swarm-conflicts: clears workspace log", async () => {
  const { recordConflict } = await import("../lib/swarm-conflict-store.js");
  const ws = `wsConflictsDel-${Date.now()}`;
  await recordConflict(ws, {
    type: "polarity",
    similarity: 0.3,
    summary: "s",
    specialists: ["a", "b"],
    responses: [{ specialist: "a", output: "x" }, { specialist: "b", output: "y" }],
  });

  const { request, app } = await buildHarness();
  const del = await request(app).delete(`/api/admin/agent-stats/swarm-conflicts?workspace=${ws}`);
  assert.equal(del.status, 200);
  assert.equal(del.body.ok, true);
  assert.equal(del.body.workspace, ws);

  const after = await request(app).get(`/api/admin/agent-stats/swarm-conflicts?workspace=${ws}`);
  assert.equal(after.body.total, 0);
  assert.deepEqual(after.body.events, []);
});
