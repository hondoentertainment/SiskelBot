/**
 * Wave 19A: Tests for SOC2 compliance evidence collector.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "siskelbot-evidence-"));
process.env.STORAGE_PATH = tempDir;

test.after(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch (_) {}
});

// --- collectEvidence ---

test("collectEvidence returns all required top-level keys", async () => {
  const { collectEvidence } = await import("../lib/compliance-evidence.js");
  const ev = await collectEvidence();
  assert.ok(ev.collectedAt, "missing collectedAt");
  assert.equal(ev.version, "1.0");
  assert.ok(ev.controls, "missing controls");
  assert.ok(ev.controls.accessControl, "missing accessControl");
  assert.ok(ev.controls.auditLogging, "missing auditLogging");
  assert.ok(ev.controls.authMethods, "missing authMethods");
  assert.ok(ev.controls.dataProtection, "missing dataProtection");
  assert.ok(ev.controls.availability, "missing availability");
});

test("collectEvidence accessControl has expected fields", async () => {
  const { collectEvidence } = await import("../lib/compliance-evidence.js");
  const ev = await collectEvidence();
  const ac = ev.controls.accessControl;
  assert.ok(typeof ac.workspaceCount === "number");
  assert.ok(typeof ac.userCount === "number");
  assert.ok(typeof ac.adminCount === "number");
  assert.ok(typeof ac.mfaConfigured === "boolean");
});

test("collectEvidence auditLogging has expected fields", async () => {
  const { collectEvidence } = await import("../lib/compliance-evidence.js");
  const ev = await collectEvidence();
  const al = ev.controls.auditLogging;
  assert.ok(typeof al.loginEventsLast30Days === "number");
  assert.ok(typeof al.failedLoginsLast30Days === "number");
  assert.ok(typeof al.retentionDays === "number");
});

test("collectEvidence authMethods has all provider flags as booleans", async () => {
  const { collectEvidence } = await import("../lib/compliance-evidence.js");
  const ev = await collectEvidence();
  const am = ev.controls.authMethods;
  for (const key of ["oidc", "saml", "github", "google", "ldap"]) {
    assert.ok(typeof am[key] === "boolean", `authMethods.${key} should be boolean`);
  }
});

test("collectEvidence dataProtection has storageBackend and security flags", async () => {
  const { collectEvidence } = await import("../lib/compliance-evidence.js");
  const ev = await collectEvidence();
  const dp = ev.controls.dataProtection;
  assert.ok(typeof dp.storageBackend === "string");
  assert.ok(typeof dp.databaseSsl === "boolean");
  assert.ok(typeof dp.sessionSecretSet === "boolean");
});

test("collectEvidence availability has uptimeSeconds and nodeVersion", async () => {
  const { collectEvidence } = await import("../lib/compliance-evidence.js");
  const ev = await collectEvidence();
  const av = ev.controls.availability;
  assert.ok(typeof av.uptimeSeconds === "number" && av.uptimeSeconds >= 0);
  assert.ok(typeof av.nodeVersion === "string" && av.nodeVersion.startsWith("v"));
  assert.ok(typeof av.platform === "string");
});

// --- saveEvidenceSnapshot / listEvidenceSnapshots round-trip ---

test("saveEvidenceSnapshot and listEvidenceSnapshots round-trip", async () => {
  const { collectEvidence, saveEvidenceSnapshot, registerSnapshotKey, listEvidenceSnapshots } =
    await import("../lib/compliance-evidence.js");

  const ev = await collectEvidence();
  const key = await saveEvidenceSnapshot(ev);
  await registerSnapshotKey(key);

  const list = await listEvidenceSnapshots({ limit: 10 });
  assert.ok(Array.isArray(list));
  assert.ok(list.length >= 1);
  const found = list.find((s) => s.key === key);
  assert.ok(found, "saved snapshot should appear in list");
  assert.ok(typeof found.collectedAt === "string");
  assert.ok(typeof found.summary === "object");
});

test("getEvidenceByDate returns null for non-existent date", async () => {
  const { getEvidenceByDate } = await import("../lib/compliance-evidence.js");
  const result = await getEvidenceByDate("1999-01-01");
  assert.equal(result, null);
});

test("getEvidenceByDate returns null for invalid date format", async () => {
  const { getEvidenceByDate } = await import("../lib/compliance-evidence.js");
  const result = await getEvidenceByDate("not-a-date");
  assert.equal(result, null);
});

// --- HTTP endpoint tests ---

async function buildHarness() {
  const request = (await import("supertest")).default;
  const express = (await import("express")).default;
  const { mountComplianceRoutes } = await import("../routes/compliance.js");

  const app = express();
  app.use(express.json());

  const apiError = (res, status, code, message) =>
    res.status(status).json({ error: message, code });
  const logRequest = (_req, _res, next) => next();
  const adminAuth = (_req, _res, next) => next();
  const storageRateLimiter = (_req, _res, next) => next();

  const apiRoute = (method, path, ...handlers) => {
    app[method](`/api/v1${path}`, ...handlers);
  };

  mountComplianceRoutes(app, { apiRoute, apiError, logRequest, adminAuth, storageRateLimiter });
  return { request, app };
}

async function buildHarnessNoAdmin() {
  const request = (await import("supertest")).default;
  const express = (await import("express")).default;
  const { mountComplianceRoutes } = await import("../routes/compliance.js");

  const app = express();
  app.use(express.json());

  const apiError = (res, status, code, message) =>
    res.status(status).json({ error: message, code });
  const logRequest = (_req, _res, next) => next();
  const adminAuth = (_req, res) =>
    res.status(401).json({ error: "Admin required", code: "ADMIN_REQUIRED" });
  const storageRateLimiter = (_req, _res, next) => next();

  const apiRoute = (method, path, ...handlers) => {
    app[method](`/api/v1${path}`, ...handlers);
  };

  mountComplianceRoutes(app, { apiRoute, apiError, logRequest, adminAuth, storageRateLimiter });
  return { request, app };
}

test("GET /api/v1/admin/compliance/evidence returns 401 without auth", async () => {
  const { request, app } = await buildHarnessNoAdmin();
  const r = await request(app).get("/api/v1/admin/compliance/evidence");
  assert.equal(r.status, 401);
});

test("GET /api/v1/admin/compliance/evidence returns valid evidence structure", async () => {
  const { request, app } = await buildHarness();
  const r = await request(app).get("/api/v1/admin/compliance/evidence");
  assert.equal(r.status, 200);
  assert.ok(r.body.collectedAt);
  assert.equal(r.body.version, "1.0");
  assert.ok(r.body.controls);
  assert.ok(r.body.controls.accessControl);
  assert.ok(r.body.controls.auditLogging);
  assert.ok(r.body.controls.authMethods);
  assert.ok(r.body.controls.dataProtection);
  assert.ok(r.body.controls.availability);
});

test("POST /api/v1/admin/compliance/evidence/collect returns 401 without auth", async () => {
  const { request, app } = await buildHarnessNoAdmin();
  const r = await request(app).post("/api/v1/admin/compliance/evidence/collect");
  assert.equal(r.status, 401);
});

test("POST /api/v1/admin/compliance/evidence/collect saves snapshot and returns key", async () => {
  const { request, app } = await buildHarness();
  const r = await request(app).post("/api/v1/admin/compliance/evidence/collect");
  assert.equal(r.status, 201);
  assert.ok(r.body.key, "should return storage key");
  assert.ok(r.body.collectedAt);
  assert.ok(r.body.controls);
});

test("GET /api/v1/admin/compliance/evidence/history returns snapshot list", async () => {
  const { request, app } = await buildHarness();
  const r = await request(app).get("/api/v1/admin/compliance/evidence/history");
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.snapshots));
});

test("GET /api/v1/admin/compliance/evidence/history/:date returns 404 for unknown date", async () => {
  const { request, app } = await buildHarness();
  const r = await request(app).get("/api/v1/admin/compliance/evidence/history/1999-01-01");
  assert.equal(r.status, 404);
});

test("GET /api/v1/admin/compliance/evidence/history/:date returns 400 for bad date format", async () => {
  const { request, app } = await buildHarness();
  const r = await request(app).get("/api/v1/admin/compliance/evidence/history/baddate");
  assert.equal(r.status, 400);
});

test("collect then retrieve by date succeeds", async () => {
  const { request, app } = await buildHarness();
  const post = await request(app).post("/api/v1/admin/compliance/evidence/collect");
  assert.equal(post.status, 201);

  const date = post.body.collectedAt.slice(0, 10);
  const get = await request(app).get(`/api/v1/admin/compliance/evidence/history/${date}`);
  assert.equal(get.status, 200);
  assert.equal(get.body.version, "1.0");
  assert.ok(get.body.controls);
});
