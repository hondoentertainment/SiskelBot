/**
 * Tests for compliance controls (lib/compliance.js).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "siskelbot-compliance-"));
process.env.STORAGE_PATH = tempDir;

import {
  getAvailableRegions,
  setDataResidency,
  getDataResidency,
  detectPII,
  redactPII,
  setRetentionPolicy,
  getRetentionPolicy,
  enforceRetention,
  generateComplianceReport,
  scanTextForPII,
  piiRedactionMiddleware,
  SOC2_CONTROLS,
  HIPAA_CONTROLS,
  GDPR_CONTROLS,
  generateSOC2Report,
  generateHIPAAReport,
  generateGDPRReport,
  getComplianceDashboard,
  generateDataSubjectRequest,
  executeRightToErasure,
  exportUserData,
  mapAuditEventToControls,
} from "../lib/compliance.js";

test.after(() => {
  try {
    rmSync(tempDir, { recursive: true });
  } catch (_) {}
});

// --- Data Residency ---

test("getAvailableRegions returns regions", () => {
  const regions = getAvailableRegions();
  assert.ok(regions.length > 0);
  assert.ok(regions.find((r) => r.id === "us-east-1"));
  assert.ok(regions.find((r) => r.id === "eu-west-1"));
  assert.ok(regions[0].country);
  assert.ok(regions[0].name);
});

test("setDataResidency and getDataResidency", async () => {
  const result = await setDataResidency("ws-comp-1", "eu-west-1");
  assert.equal(result.region, "eu-west-1");
  assert.equal(result.country, "IE");
  assert.ok(result.setAt);

  const retrieved = await getDataResidency("ws-comp-1");
  assert.equal(retrieved.region, "eu-west-1");
});

test("setDataResidency rejects invalid region", async () => {
  await assert.rejects(() => setDataResidency("ws-comp-1", "invalid-region"), /Invalid region/);
});

test("getDataResidency returns null for unconfigured workspace", async () => {
  const result = await getDataResidency("ws-nonexistent");
  assert.equal(result, null);
});

// --- PII Detection ---

test("detectPII finds email addresses", () => {
  const results = detectPII("Contact us at user@example.com for info.");
  assert.ok(results.length > 0);
  const email = results.find((r) => r.type === "EMAIL");
  assert.ok(email);
  assert.equal(email.value, "user@example.com");
});

test("detectPII finds phone numbers", () => {
  const results = detectPII("Call me at (555) 123-4567 or 555-987-6543.");
  const phones = results.filter((r) => r.type === "PHONE");
  assert.ok(phones.length >= 1);
});

test("detectPII finds SSNs", () => {
  const results = detectPII("SSN: 123-45-6789");
  const ssn = results.find((r) => r.type === "SSN");
  assert.ok(ssn);
  assert.equal(ssn.value, "123-45-6789");
});

test("detectPII finds credit card numbers (Luhn valid)", () => {
  // 4111111111111111 is a well-known Luhn-valid test number
  const results = detectPII("Card: 4111111111111111");
  const cc = results.find((r) => r.type === "CREDIT_CARD");
  assert.ok(cc, "Should detect Luhn-valid credit card");
});

test("detectPII does not flag invalid credit card numbers", () => {
  const results = detectPII("Not a card: 1234567890123456");
  const cc = results.find((r) => r.type === "CREDIT_CARD");
  // 1234567890123456 fails Luhn check
  assert.ok(!cc, "Should not detect Luhn-invalid number as credit card");
});

test("detectPII finds IPv4 addresses", () => {
  const results = detectPII("Server at 192.168.1.100");
  const ip = results.find((r) => r.type === "IP_ADDRESS");
  assert.ok(ip);
  assert.equal(ip.value, "192.168.1.100");
});

test("detectPII finds IPv6 addresses", () => {
  const results = detectPII("IPv6: 2001:0db8:85a3:0000:0000:8a2e:0370:7334");
  const ip = results.find((r) => r.type === "IP_ADDRESS");
  assert.ok(ip);
});

test("detectPII returns empty for clean text", () => {
  const results = detectPII("This is a clean text with no personal information.");
  assert.equal(results.length, 0);
});

test("detectPII handles null/empty input", () => {
  assert.deepEqual(detectPII(null), []);
  assert.deepEqual(detectPII(""), []);
  assert.deepEqual(detectPII(undefined), []);
});

// --- PII Redaction ---

test("redactPII replaces all PII", () => {
  const input = "Email: user@example.com, SSN: 123-45-6789";
  const { text, redactions } = redactPII(input);
  assert.ok(!text.includes("user@example.com"));
  assert.ok(!text.includes("123-45-6789"));
  assert.ok(redactions.length >= 2);
});

test("redactPII with type filter only redacts specified types", () => {
  const input = "Email: user@example.com, SSN: 123-45-6789";
  const { text, redactions } = redactPII(input, { types: ["EMAIL"] });
  assert.ok(!text.includes("user@example.com"));
  assert.ok(text.includes("123-45-6789")); // SSN not redacted
  assert.equal(redactions.length, 1);
});

test("redactPII with partial mode shows partial values", () => {
  const input = "Email: john@example.com";
  const { text } = redactPII(input, { partial: true });
  assert.ok(text.includes("j***@example.com"));
});

test("redactPII handles empty input", () => {
  const { text, redactions } = redactPII("");
  assert.equal(text, "");
  assert.deepEqual(redactions, []);
});

// --- Retention Policy ---

test("setRetentionPolicy and getRetentionPolicy", async () => {
  const policy = await setRetentionPolicy("ws-comp-2", {
    retentionDays: 90,
    autoDeleteExpired: true,
    autoRedactPII: false,
  });
  assert.equal(policy.retentionDays, 90);
  assert.equal(policy.autoDeleteExpired, true);
  assert.equal(policy.autoRedactPII, false);

  const retrieved = await getRetentionPolicy("ws-comp-2");
  assert.equal(retrieved.retentionDays, 90);
});

test("setRetentionPolicy clamps extreme retention days", async () => {
  const policy = await setRetentionPolicy("ws-comp-3", { retentionDays: 99999 });
  assert.equal(policy.retentionDays, 3650);
});

test("getRetentionPolicy returns null for unconfigured workspace", async () => {
  const result = await getRetentionPolicy("ws-nonexistent");
  assert.equal(result, null);
});

test("enforceRetention returns enforced info", async () => {
  const result = await enforceRetention("ws-comp-2");
  assert.ok(result.enforced);
  assert.equal(result.retentionDays, 90);
  assert.ok(result.cutoffDate);
});

test("enforceRetention returns not-enforced when no policy", async () => {
  const result = await enforceRetention("ws-no-policy");
  assert.equal(result.enforced, false);
});

// --- Compliance Report ---

test("generateComplianceReport produces a report", async () => {
  const report = await generateComplianceReport("ws-comp-1");
  assert.equal(report.workspaceId, "ws-comp-1");
  assert.ok(report.generatedAt);
  assert.ok(report.dataResidency);
  assert.equal(report.dataResidency.region, "eu-west-1");
  assert.ok(report.piiExposure);
  assert.ok(report.activitySummary);
});

test("generateComplianceReport handles unconfigured workspace", async () => {
  const report = await generateComplianceReport("ws-unconfigured");
  assert.ok(report.dataResidency.status === "not_configured");
  assert.ok(report.retentionPolicy.status === "not_configured");
});

// --- scanTextForPII ---

test("scanTextForPII scans multiple texts", () => {
  const result = scanTextForPII([
    "Email: a@b.com",
    "SSN: 111-22-3333",
    "Clean text",
  ]);
  assert.ok(result.totalDetections >= 2);
  assert.ok(result.byType.EMAIL >= 1);
  assert.ok(result.byType.SSN >= 1);
});

// --- piiRedactionMiddleware ---

test("piiRedactionMiddleware redacts when policy enables autoRedactPII", async () => {
  await setRetentionPolicy("ws-auto-redact", {
    retentionDays: 30,
    autoDeleteExpired: false,
    autoRedactPII: true,
  });
  const middleware = piiRedactionMiddleware();
  const req = {
    params: { id: "ws-auto-redact" },
    query: {},
    body: {
      messages: [{ role: "user", content: "My email is test@example.com" }],
    },
  };
  let nextCalled = false;
  await middleware(req, {}, () => { nextCalled = true; });
  assert.ok(nextCalled);
  assert.ok(!req.body.messages[0].content.includes("test@example.com"));
});

test("piiRedactionMiddleware passes through when no policy", async () => {
  const middleware = piiRedactionMiddleware();
  const original = "My email is test@example.com";
  const req = {
    params: { id: "ws-no-auto-redact" },
    query: {},
    body: { messages: [{ role: "user", content: original }] },
  };
  let nextCalled = false;
  await middleware(req, {}, () => { nextCalled = true; });
  assert.ok(nextCalled);
  assert.equal(req.body.messages[0].content, original);
});

// ============================================================================
// Phase 33.5: SOC 2 / HIPAA / GDPR compliance framework tests.
// ============================================================================

function seedAuditLog(entries) {
  const path = join(tempDir, "execution-audit.json");
  writeFileSync(path, JSON.stringify(entries), "utf8");
}

function nowIso(offsetMs = 0) {
  return new Date(Date.now() - offsetMs).toISOString();
}

test("SOC2_CONTROLS catalog contains expected controls", () => {
  assert.ok(SOC2_CONTROLS.CC6_1);
  assert.ok(SOC2_CONTROLS.CC6_2);
  assert.ok(SOC2_CONTROLS.CC8_1);
  assert.equal(typeof SOC2_CONTROLS.CC6_1.name, "string");
  assert.equal(typeof SOC2_CONTROLS.CC6_1.description, "string");
});

test("HIPAA_CONTROLS and GDPR_CONTROLS have expected keys", () => {
  assert.ok(HIPAA_CONTROLS["164_308_a_4"]);
  assert.ok(HIPAA_CONTROLS["164_312_b"]);
  assert.ok(GDPR_CONTROLS.ART_15);
  assert.ok(GDPR_CONTROLS.ART_17);
  assert.ok(GDPR_CONTROLS.ART_20);
});

test("mapAuditEventToControls maps login to access-control controls", () => {
  const m = mapAuditEventToControls({ action: "auth.login.success" });
  assert.ok(m.soc2.includes("CC6_2"));
  assert.ok(m.hipaa.includes("164_312_a_1"));
});

test("mapAuditEventToControls maps api_key.create to CC6_3 / CC8_1", () => {
  const m = mapAuditEventToControls({ action: "api_key.create" });
  assert.ok(m.soc2.includes("CC6_3"));
  assert.ok(m.soc2.includes("CC8_1"));
});

test("mapAuditEventToControls maps erasure actions to GDPR Art. 17", () => {
  const m = mapAuditEventToControls({ action: "right_to_erasure" });
  assert.ok(m.gdpr.includes("ART_17"));
});

test("mapAuditEventToControls returns empty arrays for unknown actions", () => {
  const m = mapAuditEventToControls({ action: "some_unknown_thing" });
  assert.deepEqual(m, { soc2: [], hipaa: [], gdpr: [] });
});

test("mapAuditEventToControls handles missing action", () => {
  const m = mapAuditEventToControls({});
  assert.deepEqual(m, { soc2: [], hipaa: [], gdpr: [] });
});

test("generateSOC2Report returns a structured report", async () => {
  seedAuditLog([
    { timestamp: nowIso(1000), action: "auth.login.success", userId: "u1", ok: true },
    { timestamp: nowIso(2000), action: "auth.login.success", userId: "u2", ok: true },
    { timestamp: nowIso(3000), action: "auth.login.success", userId: "u3", ok: true },
    { timestamp: nowIso(4000), action: "api_key.create", userId: "u1", ok: true },
    { timestamp: nowIso(5000), action: "config.change", userId: "u1", ok: true },
  ]);

  const report = await generateSOC2Report({
    startDate: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    endDate: new Date().toISOString(),
  });

  assert.equal(report.framework, "SOC2");
  assert.ok(Array.isArray(report.controls));
  assert.ok(report.controls.length > 0);
  assert.equal(typeof report.coverage, "number");
  assert.ok(report.totalEvents >= 5);

  // CC6_2 (authentication) should have at least 3 events from logins
  const cc62 = report.controls.find((c) => c.id === "CC6_2");
  assert.ok(cc62);
  assert.ok(cc62.evidenceCount >= 3, `expected >=3 evidence, got ${cc62.evidenceCount}`);
  assert.equal(cc62.status, "ok");
});

test("generateHIPAAReport maps login events to 164.312(a)(1)", async () => {
  seedAuditLog([
    { timestamp: nowIso(1000), action: "auth.login.success", userId: "u1", ok: true },
    { timestamp: nowIso(2000), action: "auth.login.success", userId: "u2", ok: true },
    { timestamp: nowIso(3000), action: "auth.login.success", userId: "u3", ok: true },
  ]);
  const report = await generateHIPAAReport({});
  assert.equal(report.framework, "HIPAA");
  const accessControl = report.controls.find((c) => c.id === "164_312_a_1");
  assert.ok(accessControl);
  assert.ok(accessControl.evidenceCount >= 3);
});

test("generateGDPRReport maps erasure to Article 17", async () => {
  seedAuditLog([
    { timestamp: nowIso(1000), action: "right_to_erasure", userId: "u1", ok: true },
    { timestamp: nowIso(2000), action: "right_to_erasure", userId: "u2", ok: true },
    { timestamp: nowIso(3000), action: "right_to_erasure", userId: "u3", ok: true },
  ]);
  const report = await generateGDPRReport({});
  const art17 = report.controls.find((c) => c.id === "ART_17");
  assert.ok(art17);
  assert.ok(art17.evidenceCount >= 3);
  assert.equal(art17.status, "ok");
});

test("coverage is 0 when there is no matching audit activity", async () => {
  seedAuditLog([]);
  const report = await generateSOC2Report({});
  assert.equal(report.coverage, 0);
  for (const c of report.controls) {
    assert.equal(c.status, "no_evidence");
    assert.equal(c.evidenceCount, 0);
  }
});

test("coverage calculation tracks ok controls", async () => {
  // Seed only events that hit CC6_2 / CC8_1
  seedAuditLog([
    { timestamp: nowIso(1000), action: "auth.login.success", ok: true },
    { timestamp: nowIso(2000), action: "auth.login.success", ok: true },
    { timestamp: nowIso(3000), action: "auth.login.success", ok: true },
    { timestamp: nowIso(4000), action: "config.change", ok: true },
    { timestamp: nowIso(5000), action: "config.change", ok: true },
    { timestamp: nowIso(6000), action: "config.change", ok: true },
  ]);
  const report = await generateSOC2Report({});
  const totalControls = report.controls.length;
  const okCount = report.controls.filter((c) => c.status === "ok").length;
  assert.equal(report.coverage, Math.round((okCount / totalControls) * 100));
});

test("getComplianceDashboard summarises all three frameworks", async () => {
  seedAuditLog([
    { timestamp: nowIso(1000), action: "auth.login.success", ok: true },
    { timestamp: nowIso(2000), action: "auth.login.success", ok: true },
    { timestamp: nowIso(3000), action: "auth.login.success", ok: true },
  ]);
  const dashboard = await getComplianceDashboard({});
  assert.ok(dashboard.soc2);
  assert.ok(dashboard.hipaa);
  assert.ok(dashboard.gdpr);
  assert.equal(dashboard.soc2.framework, "SOC2");
  assert.equal(dashboard.hipaa.framework, "HIPAA");
  assert.equal(dashboard.gdpr.framework, "GDPR");
  assert.equal(typeof dashboard.soc2.coverage, "number");
  assert.equal(typeof dashboard.soc2.totalControls, "number");
  assert.equal(typeof dashboard.soc2.violations, "number");
});

test("generateDataSubjectRequest returns a user report", async () => {
  seedAuditLog([
    { timestamp: nowIso(1000), action: "auth.login.success", userId: "dsr-user", ok: true },
  ]);
  const report = await generateDataSubjectRequest("dsr-user");
  assert.equal(report.user.id, "dsr-user");
  assert.ok(report.user.generatedAt);
  assert.ok(Array.isArray(report.conversations));
  assert.ok(Array.isArray(report.knowledge));
  assert.ok(Array.isArray(report.memory));
  assert.ok(Array.isArray(report.audit));
  assert.ok(Array.isArray(report.feedback));
  // The audit log should include the login event
  assert.ok(report.audit.some((e) => e.userId === "dsr-user"));
});

test("generateDataSubjectRequest rejects empty userId", async () => {
  await assert.rejects(() => generateDataSubjectRequest(""), /userId is required/);
});

test("executeRightToErasure in dry-run mode does not delete", async () => {
  const result = await executeRightToErasure("test-user", { dryRun: true });
  assert.equal(result.userId, "test-user");
  assert.equal(result.dryRun, true);
  assert.ok(result.deleted);
  assert.equal(typeof result.deleted.conversations, "number");
  assert.equal(typeof result.deleted.knowledge, "number");
  assert.equal(typeof result.deleted.memory, "number");
  assert.ok(Array.isArray(result.errors));
});

test("executeRightToErasure defaults to preserving audit", async () => {
  const result = await executeRightToErasure("test-user", { dryRun: true });
  assert.equal(result.preserveAudit, true);
  assert.equal(result.deleted.auditEntries, 0);
});

test("executeRightToErasure rejects empty userId", async () => {
  await assert.rejects(() => executeRightToErasure(""), /userId is required/);
});

test("exportUserData JSON returns a JSON payload", async () => {
  const out = await exportUserData("export-user", "json");
  assert.equal(out.contentType, "application/json");
  assert.match(out.filename, /\.json$/);
  const parsed = JSON.parse(out.data);
  assert.equal(parsed.user.id, "export-user");
});

test("exportUserData CSV returns CSV with section headers", async () => {
  const out = await exportUserData("csv-user", "csv");
  assert.equal(out.contentType, "text/csv");
  assert.match(out.filename, /\.csv$/);
  assert.match(out.data, /# Section: conversations/);
  assert.match(out.data, /# Section: audit/);
});

test("exportUserData rejects unsupported formats", async () => {
  await assert.rejects(() => exportUserData("u", "xml"), /Unsupported format/);
});

test("evidence arrays are truncated to 25 events per control", async () => {
  const entries = [];
  for (let i = 0; i < 40; i++) {
    entries.push({
      timestamp: nowIso(i * 100),
      action: "auth.login.success",
      userId: `u${i}`,
      ok: true,
    });
  }
  seedAuditLog(entries);
  const report = await generateSOC2Report({});
  const cc62 = report.controls.find((c) => c.id === "CC6_2");
  assert.ok(cc62);
  assert.ok(cc62.evidence.length <= 25, `expected <=25 evidence, got ${cc62.evidence.length}`);
  // evidenceCount is the stored length, not the raw match count
  assert.equal(cc62.evidenceCount, cc62.evidence.length);
});
