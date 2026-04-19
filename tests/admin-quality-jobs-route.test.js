/**
 * Route tests for /api/admin/quality-jobs/* endpoints. Uses supertest against
 * a minimal Express harness and an isolated STORAGE_PATH.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const tmpRoot = mkdtempSync(join(tmpdir(), "siskel-quality-jobs-route-"));
process.env.STORAGE_PATH = tmpRoot;

test.after(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

async function buildHarness({ adminOk = true } = {}) {
  const request = (await import("supertest")).default;
  const express = (await import("express")).default;
  const { default: mountAdminQualityJobsRoutes } = await import(
    "../routes/admin-quality-jobs.js"
  );
  const scheduler = await import("../lib/agent-quality-scheduler.js");
  if (typeof scheduler.__resetForTests === "function") {
    scheduler.__resetForTests();
  }
  await scheduler.installAllJobs();

  const app = express();
  app.use(express.json());

  const apiError = (res, status, code, message) =>
    res.status(status).json({ error: message, code });
  const logRequest = (_req, _res, next) => next();
  const adminAuth = (_req, res, next) => {
    if (!adminOk) return res.status(401).json({ error: "unauthorized" });
    next();
  };
  const requireScope = () => (_req, _res, next) => next();

  mountAdminQualityJobsRoutes(app, {
    apiError,
    logRequest,
    adminAuth,
    requireScope,
  });
  return { request, app, scheduler };
}

test("GET /api/admin/quality-jobs lists all 4 jobs", async () => {
  const { request, app } = await buildHarness();
  const r = await request(app).get("/api/admin/quality-jobs");
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.jobs));
  assert.equal(r.body.jobs.length, 4);
  const names = r.body.jobs.map((j) => j.name).sort();
  assert.deepEqual(names, [
    "daily-patch-synth",
    "hourly-health-score",
    "nightly-benchmark",
    "weekly-safety",
  ]);
});

test("GET /api/admin/quality-jobs/:name returns single job", async () => {
  const { request, app } = await buildHarness();
  const r = await request(app).get("/api/admin/quality-jobs/weekly-safety");
  assert.equal(r.status, 200);
  assert.equal(r.body.job.name, "weekly-safety");
  assert.equal(r.body.job.schedule, "weekly Sunday 03:00 UTC");
});

test("GET /api/admin/quality-jobs/:unknown → 404", async () => {
  const { request, app } = await buildHarness();
  const r = await request(app).get("/api/admin/quality-jobs/does-not-exist");
  assert.equal(r.status, 404);
});

test("POST /:name/run triggers handler and records run outcome", async () => {
  const { request, app, scheduler } = await buildHarness();
  let called = 0;
  scheduler.__setHandlerForTests("nightly-benchmark", async () => {
    called++;
    return { ok: true };
  });

  const r = await request(app)
    .post("/api/admin/quality-jobs/nightly-benchmark/run")
    .send({});
  assert.equal(r.status, 200);
  assert.equal(r.body.name, "nightly-benchmark");
  assert.equal(r.body.status, "ok");
  assert.equal(called, 1);
  assert.equal(r.body.job.lastStatus, "idle");
  assert.ok(r.body.job.lastRunAt);
});

test("POST /:name/run surfaces handler errors as status:error", async () => {
  const { request, app, scheduler } = await buildHarness();
  scheduler.__setHandlerForTests("daily-patch-synth", async () => {
    throw new Error("boom");
  });
  const r = await request(app)
    .post("/api/admin/quality-jobs/daily-patch-synth/run")
    .send({});
  assert.equal(r.status, 200);
  assert.equal(r.body.status, "error");
  assert.match(r.body.error, /boom/);
  assert.equal(r.body.job.lastStatus, "error");
});

test("POST /:name/enable toggles the enabled flag", async () => {
  const { request, app } = await buildHarness();
  const off = await request(app)
    .post("/api/admin/quality-jobs/weekly-safety/enable")
    .send({ enabled: false });
  assert.equal(off.status, 200);
  assert.equal(off.body.job.enabled, false);

  const list = await request(app).get("/api/admin/quality-jobs/weekly-safety");
  assert.equal(list.body.job.enabled, false);

  const on = await request(app)
    .post("/api/admin/quality-jobs/weekly-safety/enable")
    .send({ enabled: true });
  assert.equal(on.status, 200);
  assert.equal(on.body.job.enabled, true);
});

test("POST /:name/enable rejects missing/non-boolean body", async () => {
  const { request, app } = await buildHarness();
  const r = await request(app)
    .post("/api/admin/quality-jobs/weekly-safety/enable")
    .send({});
  assert.equal(r.status, 400);
  assert.match(r.body.error, /boolean/);
});

test("POST /:unknown/run → 404", async () => {
  const { request, app } = await buildHarness();
  const r = await request(app)
    .post("/api/admin/quality-jobs/no-such/run")
    .send({});
  assert.equal(r.status, 404);
});

test("POST /start and /stop control the loop", async () => {
  const { request, app, scheduler } = await buildHarness();
  // Overrides intervals so timers don't actually tick during the test.
  for (const name of [
    "nightly-benchmark",
    "weekly-safety",
    "daily-patch-synth",
    "hourly-health-score",
  ]) {
    scheduler.__setHandlerForTests(name, async () => ({ ok: true }), {
      intervalMs: 60_000,
    });
  }

  const start = await request(app).post("/api/admin/quality-jobs/start").send({});
  assert.equal(start.status, 200);
  assert.equal(start.body.ok, true);
  assert.equal(start.body.running, true);

  const stop = await request(app).post("/api/admin/quality-jobs/stop").send({});
  assert.equal(stop.status, 200);
  assert.equal(stop.body.ok, true);
  assert.equal(stop.body.running, false);
});

test("admin auth gate: unauthorized requests are rejected", async () => {
  const { request, app } = await buildHarness({ adminOk: false });
  const r = await request(app).get("/api/admin/quality-jobs");
  assert.equal(r.status, 401);
});
