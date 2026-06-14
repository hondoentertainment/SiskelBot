/**
 * Tests for routes/observability-snapshot.js.
 *
 * Spin up a minimal Express app, inject the standard deps contract
 * (apiRoute / apiError / userAuth / requireScope / logRequest), and assert
 * the /observability/snapshot endpoint returns the expected shape and
 * requires auth.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import express from "express";
import request from "supertest";

const dir = mkdtempSync(join(tmpdir(), "obs-snapshot-route-"));
const prev = process.env.STORAGE_PATH;
process.env.STORAGE_PATH = dir;

const { mountObservabilitySnapshotRoutes, buildObservabilitySnapshot } = await import(
  "../routes/observability-snapshot.js"
);

test.after(() => {
  if (prev === undefined) delete process.env.STORAGE_PATH;
  else process.env.STORAGE_PATH = prev;
  try { rmSync(dir, { recursive: true, force: true }); } catch (_) {}
});

function buildApp({ userId = "test-user", authFail = false } = {}) {
  const app = express();
  app.use(express.json());
  const deps = {
    apiRoute(method, path, ...handlers) {
      app[method](`/api/v1${path}`, ...handlers);
    },
    apiError(res, status, code, message, hint) {
      return res.status(status).json({ error: message, code, hint });
    },
    userAuth(req, res, next) {
      if (authFail) return res.status(401).json({ error: "Authentication required", code: "AUTH_REQUIRED" });
      req.userId = userId;
      next();
    },
    requireScope: () => (req, res, next) => next(),
    logRequest: (req, res, next) => next(),
  };
  mountObservabilitySnapshotRoutes(app, deps);
  return app;
}

test("observability snapshot requires auth", async () => {
  const app = buildApp({ authFail: true });
  const res = await request(app).get("/api/v1/observability/snapshot");
  assert.equal(res.status, 401);
  assert.equal(res.body.code, "AUTH_REQUIRED");
});

test("observability snapshot returns 200 with expected shape", async () => {
  const app = buildApp({ userId: "reader" });
  const res = await request(app).get("/api/v1/observability/snapshot");
  assert.equal(res.status, 200);

  const body = res.body;
  assert.ok(body && typeof body === "object", "body is an object");

  // breakers — richer fields sourced from getBreakerSnapshot()
  assert.ok(Array.isArray(body.breakers), "breakers is an array");
  assert.ok(body.breakers.length > 0, "at least one known backend reported");
  for (const b of body.breakers) {
    assert.ok(typeof b.name === "string" && b.name.length > 0);
    assert.ok(
      ["open", "closed", "half_open", "unknown"].includes(b.state),
      `unexpected breaker state: ${b.state}`,
    );
    assert.equal(typeof b.failures, "number");
    assert.ok(b.failures >= 0, "failures is non-negative");
    assert.ok(
      b.lastFailureAt === null || typeof b.lastFailureAt === "string",
      "lastFailureAt is null or string",
    );
    if (typeof b.lastFailureAt === "string") {
      assert.ok(!Number.isNaN(Date.parse(b.lastFailureAt)), "lastFailureAt is parseable");
    }
    assert.equal(typeof b.cooldownRemainingMs, "number");
    assert.ok(b.cooldownRemainingMs >= 0, "cooldownRemainingMs is non-negative");
  }

  // slowRoutes
  assert.ok(Array.isArray(body.slowRoutes));
  assert.ok(body.slowRoutes.length <= 10, "top-10 cap enforced");
  for (const r of body.slowRoutes) {
    assert.equal(typeof r.route, "string");
    assert.equal(typeof r.p95Ms, "number");
    assert.equal(typeof r.p50Ms, "number");
    assert.equal(typeof r.hits, "number");
  }

  // recentTrajectories
  assert.ok(Array.isArray(body.recentTrajectories));
  assert.ok(body.recentTrajectories.length <= 20);

  // pool
  assert.ok(body.pool && typeof body.pool === "object");
  assert.equal(typeof body.pool.dbConnections, "number");
  assert.equal(typeof body.pool.inUse, "number");
  assert.equal(typeof body.pool.waiting, "number");

  // rates + uptime
  assert.equal(typeof body.uptimeSec, "number");
  assert.ok(body.uptimeSec >= 0);
  assert.equal(typeof body.requestsPerMinute, "number");
  assert.equal(typeof body.errorsPerMinute, "number");
});

test("buildObservabilitySnapshot is callable directly", async () => {
  const snap = await buildObservabilitySnapshot();
  assert.ok(Array.isArray(snap.breakers));
  assert.ok(Array.isArray(snap.slowRoutes));
  assert.ok(Array.isArray(snap.recentTrajectories));
  assert.ok(snap.pool && typeof snap.pool === "object");
  assert.equal(typeof snap.uptimeSec, "number");
});

test("observability snapshot surfaces real breaker failures/lastFailureAt", async () => {
  const cb = await import("../lib/circuit-breaker.js");
  // Prime a known backend with a failure so failures>0 and lastFailureAt
  // is a real timestamp in the emitted snapshot.
  cb.recordSuccess("ollama");
  cb.recordFailure("ollama");

  const snap = await buildObservabilitySnapshot();
  const row = snap.breakers.find((b) => b.name === "ollama");
  assert.ok(row, "expected a row for 'ollama'");
  assert.ok(row.failures >= 1, `expected failures >= 1, got ${row.failures}`);
  assert.equal(typeof row.lastFailureAt, "string");
  assert.ok(!Number.isNaN(Date.parse(row.lastFailureAt)), "lastFailureAt parseable");
  assert.ok(["closed", "open", "half_open"].includes(row.state));
  assert.equal(typeof row.cooldownRemainingMs, "number");

  // Reset so we don't leak state into sibling tests.
  cb.recordSuccess("ollama");
});
