/**
 * Route tests for /api/admin/eval-history/* endpoints.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const tmpRoot = mkdtempSync(join(tmpdir(), "siskel-admin-eval-history-"));
process.env.STORAGE_PATH = tmpRoot;

test.after(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
});

async function buildHarness() {
  const request = (await import("supertest")).default;
  const express = (await import("express")).default;
  const { default: mountAdminEvalHistoryRoutes } = await import("../routes/admin-eval-history.js");

  const app = express();
  app.use(express.json());

  const apiError = (res, status, code, message) => res.status(status).json({ error: message, code });
  const logRequest = (_req, _res, next) => next();
  const adminAuth = (_req, _res, next) => next();
  const requireScope = () => (_req, _res, next) => next();
  const sanitizeWorkspace = (ws) => String(ws || "default").replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80);

  mountAdminEvalHistoryRoutes(app, { apiError, logRequest, adminAuth, requireScope, sanitizeWorkspace });
  return { request, app };
}

test("GET /api/admin/eval-history: empty workspace returns empty samples", async () => {
  const { request, app } = await buildHarness();
  const r = await request(app).get("/api/admin/eval-history?workspace=wsEmpty");
  assert.equal(r.status, 200);
  assert.equal(r.body.workspace, "wsEmpty");
  assert.deepEqual(r.body.samples, []);
});

test("POST then GET: records and returns samples newest-first", async () => {
  const ws = `wsPost-${Date.now()}`;
  const { request, app } = await buildHarness();

  const post1 = await request(app)
    .post(`/api/admin/eval-history?workspace=${ws}`)
    .send({
      ts: 1_700_000_000_000,
      kind: "benchmark",
      suite: "mini",
      metrics: { passRate: 0.8, total: 10 },
    });
  assert.equal(post1.status, 201);
  assert.equal(post1.body.sample.kind, "benchmark");
  assert.equal(post1.body.sample.metrics.passRate, 0.8);

  const post2 = await request(app)
    .post(`/api/admin/eval-history?workspace=${ws}`)
    .send({
      ts: 1_700_000_001_000,
      kind: "benchmark",
      suite: "mini",
      metrics: { passRate: 0.9, total: 10 },
    });
  assert.equal(post2.status, 201);

  const list = await request(app).get(`/api/admin/eval-history?workspace=${ws}&kind=benchmark&suite=mini`);
  assert.equal(list.status, 200);
  assert.equal(list.body.samples.length, 2);
  assert.equal(list.body.samples[0].metrics.passRate, 0.9); // newest first
  assert.equal(list.body.samples[1].metrics.passRate, 0.8);
});

test("GET /series: returns buckets oldest-first", async () => {
  const ws = `wsSeries-${Date.now()}`;
  const { request, app } = await buildHarness();
  const MS_DAY = 86_400_000;
  const day0 = Date.UTC(2024, 0, 1, 12, 0, 0);
  const day1 = day0 + MS_DAY;

  for (const { ts, v } of [
    { ts: day0, v: 0.5 },
    { ts: day0 + 1000, v: 0.7 },
    { ts: day1, v: 0.9 },
  ]) {
    const r = await request(app)
      .post(`/api/admin/eval-history?workspace=${ws}`)
      .send({ ts, kind: "benchmark", suite: "mini", metrics: { passRate: v } });
    assert.equal(r.status, 201);
  }

  const s = await request(app).get(
    `/api/admin/eval-history/series?workspace=${ws}&kind=benchmark&metric=passRate&suite=mini&bucket=day`,
  );
  assert.equal(s.status, 200);
  assert.equal(s.body.kind, "benchmark");
  assert.equal(s.body.metric, "passRate");
  assert.equal(s.body.bucket, "day");
  assert.equal(s.body.series.length, 2);
  assert.ok(s.body.series[0].ts < s.body.series[1].ts);
  assert.equal(s.body.series[0].count, 2);
  assert.ok(Math.abs(s.body.series[0].value - 0.6) < 1e-9);
  assert.equal(s.body.series[1].count, 1);
  assert.equal(s.body.series[1].value, 0.9);
});

test("GET /latest: returns most recent matching sample", async () => {
  const ws = `wsLatest-${Date.now()}`;
  const { request, app } = await buildHarness();

  await request(app).post(`/api/admin/eval-history?workspace=${ws}`).send({
    ts: 100, kind: "safety", suite: "jailbreak", metrics: { passRate: 0.1 },
  });
  await request(app).post(`/api/admin/eval-history?workspace=${ws}`).send({
    ts: 300, kind: "safety", suite: "jailbreak", metrics: { passRate: 0.8 },
  });
  await request(app).post(`/api/admin/eval-history?workspace=${ws}`).send({
    ts: 200, kind: "benchmark", suite: "mini", metrics: { passRate: 0.9 },
  });

  const r = await request(app).get(`/api/admin/eval-history/latest?workspace=${ws}&kind=safety`);
  assert.equal(r.status, 200);
  assert.ok(r.body.sample);
  assert.equal(r.body.sample.ts, 300);
  assert.equal(r.body.sample.metrics.passRate, 0.8);

  const miss = await request(app).get(`/api/admin/eval-history/latest?workspace=${ws}&kind=feedback`);
  assert.equal(miss.status, 200);
  assert.equal(miss.body.sample, null);
});

test("DELETE clears history for that workspace only", async () => {
  const wsA = `wsDelA-${Date.now()}`;
  const wsB = `wsDelB-${Date.now()}`;
  const { request, app } = await buildHarness();

  for (const ws of [wsA, wsB]) {
    await request(app).post(`/api/admin/eval-history?workspace=${ws}`).send({
      ts: 1, kind: "custom", metrics: { v: 1 },
    });
  }

  const del = await request(app).delete(`/api/admin/eval-history?workspace=${wsA}`);
  assert.equal(del.status, 200);
  assert.equal(del.body.ok, true);
  assert.equal(del.body.workspace, wsA);

  const listA = await request(app).get(`/api/admin/eval-history?workspace=${wsA}`);
  assert.equal(listA.body.samples.length, 0);
  const listB = await request(app).get(`/api/admin/eval-history?workspace=${wsB}`);
  assert.equal(listB.body.samples.length, 1);
});

test("invalid POST body returns 400", async () => {
  const ws = `wsBad-${Date.now()}`;
  const { request, app } = await buildHarness();

  const missingKind = await request(app)
    .post(`/api/admin/eval-history?workspace=${ws}`)
    .send({ ts: 1, metrics: { v: 1 } });
  assert.equal(missingKind.status, 400);
  assert.equal(missingKind.body.code, "INVALID_SAMPLE");

  const badKind = await request(app)
    .post(`/api/admin/eval-history?workspace=${ws}`)
    .send({ ts: 1, kind: "not_a_kind", metrics: { v: 1 } });
  assert.equal(badKind.status, 400);

  const noMetrics = await request(app)
    .post(`/api/admin/eval-history?workspace=${ws}`)
    .send({ ts: 1, kind: "benchmark" });
  assert.equal(noMetrics.status, 400);

  const emptyMetrics = await request(app)
    .post(`/api/admin/eval-history?workspace=${ws}`)
    .send({ ts: 1, kind: "benchmark", metrics: {} });
  assert.equal(emptyMetrics.status, 400);
});

test("invalid query params return 400", async () => {
  const { request, app } = await buildHarness();
  const bad1 = await request(app).get("/api/admin/eval-history?kind=bogus");
  assert.equal(bad1.status, 400);
  const bad2 = await request(app).get("/api/admin/eval-history/series?kind=benchmark&metric=passRate&bucket=decade");
  assert.equal(bad2.status, 400);
  const bad3 = await request(app).get("/api/admin/eval-history/series?kind=benchmark"); // missing metric
  assert.equal(bad3.status, 400);
});
