/**
 * Tests for compliance controls (lib/compliance.js).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
