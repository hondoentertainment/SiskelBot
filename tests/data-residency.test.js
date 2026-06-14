/**
 * Tests for Phase 40.3 data residency controls (lib/data-residency.js).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "siskelbot-residency-"));
process.env.STORAGE_PATH = tempDir;
process.env.DATA_RESIDENCY_REGION = "us";

const {
  RESIDENCY_REGIONS,
  setWorkspaceResidency,
  getWorkspaceResidency,
  enforceResidency,
  residencyMiddleware,
  validateCrossRegionAccess,
  generateResidencyReport,
  migrateWorkspaceResidency,
  grantCrossRegionConsent,
  recordViolation,
  listViolations,
  regionForCountry,
  getInstanceRegion,
  _resetResidencyForTests,
} = await import("../lib/data-residency.js");

test.after(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch (_) {}
});

// ─── Region catalog ────────────────────────────────────────────────────────

test("RESIDENCY_REGIONS exposes the expected regions", () => {
  const ids = Object.keys(RESIDENCY_REGIONS);
  assert.ok(ids.includes("us"));
  assert.ok(ids.includes("eu"));
  assert.ok(ids.includes("uk"));
  assert.ok(ids.includes("apac"));
  assert.ok(ids.includes("ca"));
  assert.ok(RESIDENCY_REGIONS.eu.compliance.includes("GDPR"));
  assert.ok(RESIDENCY_REGIONS.uk.compliance.includes("UK-GDPR"));
  assert.ok(RESIDENCY_REGIONS.ca.compliance.includes("PIPEDA"));
});

test("regionForCountry maps ISO codes to regions", () => {
  assert.equal(regionForCountry("US"), "us");
  assert.equal(regionForCountry("DE"), "eu");
  assert.equal(regionForCountry("GB"), "uk");
  assert.equal(regionForCountry("JP"), "apac");
  assert.equal(regionForCountry("CA"), "ca");
  assert.equal(regionForCountry("ZZ"), null);
  assert.equal(regionForCountry(""), null);
});

test("getInstanceRegion reflects DATA_RESIDENCY_REGION env", () => {
  assert.equal(getInstanceRegion(), "us");
});

// ─── Setting and locking residency ─────────────────────────────────────────

test("setWorkspaceResidency persists region and lock state", async () => {
  await _resetResidencyForTests();
  const record = await setWorkspaceResidency("ws-set-1", "eu", false);
  assert.equal(record.region, "eu");
  assert.equal(record.regionName, "European Union");
  assert.equal(record.locked, false);
  assert.deepEqual(record.compliance, ["GDPR"]);

  const fetched = await getWorkspaceResidency("ws-set-1");
  assert.equal(fetched.region, "eu");
  assert.equal(fetched.locked, false);
});

test("setWorkspaceResidency rejects invalid regions", async () => {
  await assert.rejects(
    () => setWorkspaceResidency("ws-set-bad", "atlantis"),
    /Invalid region/,
  );
});

test("setWorkspaceResidency rejects missing workspace id", async () => {
  await assert.rejects(() => setWorkspaceResidency("", "eu"), /workspaceId/);
});

test("locked workspaces cannot be re-pinned to a different region", async () => {
  await _resetResidencyForTests();
  await setWorkspaceResidency("ws-lock-1", "eu", true);
  const fetched = await getWorkspaceResidency("ws-lock-1");
  assert.equal(fetched.locked, true);
  await assert.rejects(
    () => setWorkspaceResidency("ws-lock-1", "us", true),
    /locked/,
  );
});

test("locked workspaces tolerate re-confirming the same region", async () => {
  await _resetResidencyForTests();
  await setWorkspaceResidency("ws-lock-2", "eu", true);
  const again = await setWorkspaceResidency("ws-lock-2", "eu", true);
  assert.equal(again.region, "eu");
});

test("getWorkspaceResidency returns null for unconfigured workspaces", async () => {
  await _resetResidencyForTests();
  const result = await getWorkspaceResidency("ws-missing");
  assert.equal(result, null);
});

// ─── Enforcement ────────────────────────────────────────────────────────────

test("enforceResidency allows operations when no residency is configured", async () => {
  await _resetResidencyForTests();
  const result = await enforceResidency("ws-no-config", "read");
  assert.equal(result.allowed, true);
});

test("enforceResidency allows in-region operations", async () => {
  await _resetResidencyForTests();
  process.env.DATA_RESIDENCY_REGION = "us";
  await setWorkspaceResidency("ws-enforce-1", "us");
  const result = await enforceResidency("ws-enforce-1", "write");
  assert.equal(result.allowed, true);
  assert.equal(result.region, "us");
});

test("enforceResidency blocks operations when instance region differs from pin", async () => {
  await _resetResidencyForTests();
  process.env.DATA_RESIDENCY_REGION = "us";
  await setWorkspaceResidency("ws-enforce-eu", "eu");
  const result = await enforceResidency("ws-enforce-eu", "read");
  assert.equal(result.allowed, false);
  assert.match(result.reason, /pinned/i);
});

test("enforceResidency rejects unknown operations", async () => {
  await _resetResidencyForTests();
  await setWorkspaceResidency("ws-enforce-2", "us");
  const result = await enforceResidency("ws-enforce-2", "telepathy");
  assert.equal(result.allowed, false);
  assert.match(result.reason, /Unknown operation/);
});

// ─── Middleware ─────────────────────────────────────────────────────────────

function fakeRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

test("residencyMiddleware passes through when no workspace id is present", async () => {
  await _resetResidencyForTests();
  const middleware = residencyMiddleware({ operation: "read" });
  const req = { headers: {}, params: {}, query: {}, body: {} };
  const res = fakeRes();
  let nextCalled = false;
  await middleware(req, res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, 200);
});

test("residencyMiddleware passes through for in-region requests", async () => {
  await _resetResidencyForTests();
  process.env.DATA_RESIDENCY_REGION = "us";
  await setWorkspaceResidency("ws-mw-1", "us");
  const middleware = residencyMiddleware({ operation: "read" });
  const req = {
    headers: { "cf-ipcountry": "US" },
    params: { id: "ws-mw-1" },
    query: {},
    body: {},
  };
  const res = fakeRes();
  let nextCalled = false;
  await middleware(req, res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(req.residency.region, "us");
});

test("residencyMiddleware returns 403 for cross-region requests", async () => {
  await _resetResidencyForTests();
  process.env.DATA_RESIDENCY_REGION = "us";
  await setWorkspaceResidency("ws-mw-2", "eu");
  const middleware = residencyMiddleware({ operation: "read" });
  const req = {
    headers: { "cf-ipcountry": "DE" },
    params: { id: "ws-mw-2" },
    query: {},
    body: {},
  };
  const res = fakeRes();
  let nextCalled = false;
  await middleware(req, res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "data_residency_violation");

  // Violation should be persisted to the audit log.
  const violations = await listViolations({ workspaceId: "ws-mw-2" });
  assert.ok(violations.length >= 1);
  assert.equal(violations[0].operation, "read");
});

// ─── Cross-region access ────────────────────────────────────────────────────

test("validateCrossRegionAccess allows same-region access", async () => {
  const result = await validateCrossRegionAccess("us", "us");
  assert.equal(result.allowed, true);
});

test("validateCrossRegionAccess allows non-protected target regions", async () => {
  const result = await validateCrossRegionAccess("us", "apac");
  assert.equal(result.allowed, true);
});

test("validateCrossRegionAccess blocks EU access from non-EU without consent", async () => {
  await _resetResidencyForTests();
  await setWorkspaceResidency("ws-cross-1", "eu");
  const result = await validateCrossRegionAccess("us", "eu", "ws-cross-1");
  assert.equal(result.allowed, false);
  assert.equal(result.requiresConsent, true);
  assert.match(result.reason, /consent/i);
});

test("validateCrossRegionAccess blocks UK access from non-UK without consent", async () => {
  await _resetResidencyForTests();
  await setWorkspaceResidency("ws-cross-uk", "uk");
  const result = await validateCrossRegionAccess("us", "uk", "ws-cross-uk");
  assert.equal(result.allowed, false);
  assert.match(result.reason, /consent/i);
});

test("validateCrossRegionAccess respects explicit consent", async () => {
  await _resetResidencyForTests();
  await setWorkspaceResidency("ws-cross-consent", "eu");
  await grantCrossRegionConsent("ws-cross-consent", "us", "eu", "test-admin");
  const result = await validateCrossRegionAccess("us", "eu", "ws-cross-consent");
  assert.equal(result.allowed, true);
});

test("validateCrossRegionAccess rejects unknown target regions", async () => {
  const result = await validateCrossRegionAccess("us", "atlantis");
  assert.equal(result.allowed, false);
  assert.match(result.reason, /Unknown target region/);
});

// ─── Compliance report ──────────────────────────────────────────────────────

test("generateResidencyReport returns null shape for unconfigured workspace", async () => {
  await _resetResidencyForTests();
  const report = await generateResidencyReport("ws-report-missing");
  assert.equal(report.configured, false);
  assert.equal(report.region, null);
  assert.deepEqual(report.complianceFrameworks, []);
  assert.ok(Array.isArray(report.operations));
  assert.ok(report.operations.includes("read"));
});

test("generateResidencyReport returns full report for configured workspace", async () => {
  await _resetResidencyForTests();
  await setWorkspaceResidency("ws-report-1", "eu", true);
  await recordViolation({
    workspaceId: "ws-report-1",
    sourceRegion: "us",
    targetRegion: "eu",
    operation: "read",
    reason: "test violation",
    allowed: false,
  });
  const report = await generateResidencyReport("ws-report-1");
  assert.equal(report.configured, true);
  assert.equal(report.region, "eu");
  assert.equal(report.locked, true);
  assert.deepEqual(report.complianceFrameworks, ["GDPR"]);
  assert.ok(report.violations.length >= 1);
  assert.equal(report.violationCount, report.violations.length);
});

// ─── Migration ──────────────────────────────────────────────────────────────

test("migrateWorkspaceResidency dry-run does not mutate residency", async () => {
  await _resetResidencyForTests();
  await setWorkspaceResidency("ws-mig-1", "us");
  const result = await migrateWorkspaceResidency("ws-mig-1", "eu");
  assert.equal(result.dryRun, true);
  assert.equal(result.plan.fromRegion, "us");
  assert.equal(result.plan.toRegion, "eu");
  assert.ok(Array.isArray(result.plan.estimatedSteps));
  assert.ok(result.plan.estimatedSteps.length > 0);

  const after = await getWorkspaceResidency("ws-mig-1");
  assert.equal(after.region, "us");
});

test("migrateWorkspaceResidency confirmed mode flips the pinned region and unlocks", async () => {
  await _resetResidencyForTests();
  await setWorkspaceResidency("ws-mig-2", "us", true);
  const result = await migrateWorkspaceResidency("ws-mig-2", "eu", {
    confirm: true,
    performedBy: "test-admin",
  });
  assert.equal(result.ok, true);
  assert.equal(result.dryRun, false);
  assert.equal(result.record.region, "eu");
  assert.equal(result.record.locked, false);
  assert.equal(result.record.previousRegion, "us");
  assert.equal(result.record.migratedBy, "test-admin");
});

test("migrateWorkspaceResidency rejects when no residency record exists", async () => {
  await _resetResidencyForTests();
  await assert.rejects(
    () => migrateWorkspaceResidency("ws-mig-missing", "eu", { confirm: true }),
    /no residency record/,
  );
});

test("migrateWorkspaceResidency to the same region is a no-op", async () => {
  await _resetResidencyForTests();
  await setWorkspaceResidency("ws-mig-noop", "eu");
  const result = await migrateWorkspaceResidency("ws-mig-noop", "eu", { confirm: true });
  assert.equal(result.noop, true);
});

test("migrateWorkspaceResidency rejects invalid target region", async () => {
  await _resetResidencyForTests();
  await setWorkspaceResidency("ws-mig-bad", "us");
  await assert.rejects(
    () => migrateWorkspaceResidency("ws-mig-bad", "atlantis", { confirm: true }),
    /Invalid region/,
  );
});
