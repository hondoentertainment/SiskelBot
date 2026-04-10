/**
 * Phase 34.1: Plugin certification tests.
 *
 * Covers lib/plugin-certification.js and lib/plugin-publishers.js:
 * - Security scan catches HTTP URLs, wildcard patterns, dangerous actions, secrets, bad semver
 * - certify / revoke / get / list
 * - Badge rendering
 * - Publisher register, verify, list, get
 * - Manifest signature verification (valid, tampered, untrusted key, missing)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createHash } from "crypto";

const dir = mkdtempSync(join(tmpdir(), "plugin-cert-"));
const prevStorage = process.env.STORAGE_PATH;
process.env.STORAGE_PATH = dir;

const {
  CERT_LEVELS,
  verifyPluginSignature,
  scanPluginSecurity,
  certifyPlugin,
  revokeCertification,
  getCertification,
  listCertifiedPlugins,
  getCertificationBadge,
} = await import("../lib/plugin-certification.js");

const {
  registerPublisher,
  verifyPublisher,
  getPublisher,
  listPublishers,
} = await import("../lib/plugin-publishers.js");

const { stableStringify } = await import("../lib/marketplace-registry.js");

test.after(() => {
  if (prevStorage === undefined) delete process.env.STORAGE_PATH;
  else process.env.STORAGE_PATH = prevStorage;
  rmSync(dir, { recursive: true, force: true });
});

// Helpers
function signManifest(manifest, keyId, extra = {}) {
  const unsigned = { ...manifest };
  delete unsigned.signature;
  const digest = createHash("sha256").update(stableStringify(unsigned), "utf8").digest("hex");
  return {
    ...unsigned,
    signature: { algorithm: "sha256", keyId, value: digest, ...extra },
  };
}

// ---------------------------------------------------------------------------
// scanPluginSecurity
// ---------------------------------------------------------------------------

test("scanPluginSecurity: clean manifest passes with score 100", async () => {
  const manifest = {
    id: "clean-pack",
    version: "1.0.0",
    description: "A clean example pack",
    author: "Acme",
    webhooks: [{ url: "https://hooks.example.com/incoming" }],
  };
  const result = await scanPluginSecurity(manifest);
  assert.equal(result.passed, true);
  assert.equal(result.score, 100);
  assert.deepEqual(result.issues, []);
});

test("scanPluginSecurity: catches HTTP webhook URL", async () => {
  const manifest = {
    id: "http-pack",
    version: "1.0.0",
    description: "Uses plaintext http",
    author: "Acme",
    webhooks: [{ url: "http://insecure.example.com/hook" }],
  };
  const result = await scanPluginSecurity(manifest);
  assert.equal(result.passed, false);
  const transportIssues = result.issues.filter((i) => i.category === "transport");
  assert.ok(transportIssues.length >= 1);
  assert.ok(transportIssues[0].message.includes("https://"));
});

test("scanPluginSecurity: catches wildcard URL patterns", async () => {
  const manifest = {
    id: "wild-pack",
    version: "1.0.0",
    description: "Uses wildcards",
    author: "Acme",
    webhooks: [{ url: "https://*.example.com/hook" }],
  };
  const result = await scanPluginSecurity(manifest);
  assert.equal(result.passed, false);
  const wildIssues = result.issues.filter((i) => i.category === "url-pattern");
  assert.ok(wildIssues.length >= 1);
});

test("scanPluginSecurity: catches dangerous action types", async () => {
  const manifest = {
    id: "exec-pack",
    version: "1.0.0",
    description: "Tries to exec",
    author: "Acme",
    actions: [{ name: "run", type: "shell" }, { name: "ev", type: "eval" }],
  };
  const result = await scanPluginSecurity(manifest);
  assert.equal(result.passed, false);
  const dangerous = result.issues.filter((i) => i.category === "dangerous-action");
  assert.equal(dangerous.length, 2);
});

test("scanPluginSecurity: catches hardcoded secrets in config", async () => {
  const manifest = {
    id: "secret-pack",
    version: "1.0.0",
    description: "Hardcodes a secret",
    author: "Acme",
    config: { api_key: "abcdef-1234567", normalSetting: "fine" },
  };
  const result = await scanPluginSecurity(manifest);
  assert.equal(result.passed, false);
  const secrets = result.issues.filter((i) => i.category === "secrets");
  assert.equal(secrets.length, 1);
  assert.ok(secrets[0].message.includes("api_key"));
});

test("scanPluginSecurity: catches non-semver version", async () => {
  const manifest = {
    id: "bad-ver",
    version: "v1",
    description: "Bad version",
    author: "Acme",
  };
  const result = await scanPluginSecurity(manifest);
  assert.equal(result.passed, false);
  const versionIssues = result.issues.filter((i) => i.category === "version");
  assert.ok(versionIssues.length >= 1);
});

test("scanPluginSecurity: score decreases with multiple errors", async () => {
  const manifest = {
    id: "bad-pack",
    version: "not-semver",
    webhooks: [{ url: "http://a.example.com" }, { url: "https://*.b.com" }],
    actions: [{ name: "run", type: "shell" }],
    config: { password: "hunter2" },
  };
  const result = await scanPluginSecurity(manifest);
  assert.equal(result.passed, false);
  assert.ok(result.score < 100);
  // At least 5 errors: version, http, wildcard, dangerous-action, secret
  const errors = result.issues.filter((i) => i.severity === "error");
  assert.ok(errors.length >= 5);
});

test("scanPluginSecurity: rejects non-object input", async () => {
  const result = await scanPluginSecurity(null);
  assert.equal(result.passed, false);
  assert.equal(result.score, 0);
});

// ---------------------------------------------------------------------------
// certify / revoke / get / list
// ---------------------------------------------------------------------------

test("certifyPlugin: requires a valid level", async () => {
  const r = await certifyPlugin("pack-a", "bogus", {});
  assert.equal(r.ok, false);
  assert.equal(r.code, "INVALID_LEVEL");
});

test("certifyPlugin: requires a packId", async () => {
  const r = await certifyPlugin("", "signed", {});
  assert.equal(r.ok, false);
  assert.equal(r.code, "INVALID_INPUT");
});

test("certifyPlugin + getCertification: round-trip", async () => {
  const r = await certifyPlugin("round-trip", "verified", {
    publisher: "acme",
    auditUrl: "https://audits.example.com/acme",
    certifiedBy: "admin@example.com",
  });
  assert.equal(r.ok, true);
  assert.equal(r.certification.packId, "round-trip");
  assert.equal(r.certification.level, "verified");
  assert.equal(r.certification.badge, "green");
  assert.equal(r.certification.revoked, false);

  const got = await getCertification("round-trip");
  assert.ok(got);
  assert.equal(got.publisher, "acme");
  assert.equal(got.auditUrl, "https://audits.example.com/acme");
});

test("getCertification: unknown pack returns null", async () => {
  const got = await getCertification("does-not-exist");
  assert.equal(got, null);
});

test("certifyPlugin: certified level sets gold badge", async () => {
  const r = await certifyPlugin("gold-pack", "certified", {});
  assert.equal(r.ok, true);
  assert.equal(r.certification.badge, "gold");
});

test("revokeCertification: flags record revoked and keeps history", async () => {
  await certifyPlugin("revoke-me", "signed", {});
  const r = await revokeCertification("revoke-me", "security issue");
  assert.equal(r.ok, true);
  assert.equal(r.certification.revoked, true);
  assert.equal(r.certification.revokedReason, "security issue");
  assert.ok(r.certification.revokedAt);

  const got = await getCertification("revoke-me");
  assert.equal(got.revoked, true);
});

test("revokeCertification: missing pack returns NOT_FOUND", async () => {
  const r = await revokeCertification("nonexistent-pack-xyz", "reason");
  assert.equal(r.ok, false);
  assert.equal(r.code, "NOT_FOUND");
});

test("listCertifiedPlugins: returns only active certifications", async () => {
  await certifyPlugin("active-1", "signed", {});
  await certifyPlugin("active-2", "certified", {});
  await certifyPlugin("to-revoke", "signed", {});
  await revokeCertification("to-revoke", "test");

  const all = await listCertifiedPlugins();
  const ids = all.map((c) => c.packId);
  assert.ok(ids.includes("active-1"));
  assert.ok(ids.includes("active-2"));
  assert.ok(!ids.includes("to-revoke"), "revoked certifications are excluded");
});

test("listCertifiedPlugins: filters by level", async () => {
  await certifyPlugin("only-cert", "certified", {});
  const onlyCertified = await listCertifiedPlugins("certified");
  assert.ok(onlyCertified.every((c) => c.level === "certified"));
  assert.ok(onlyCertified.some((c) => c.packId === "only-cert"));
});

// ---------------------------------------------------------------------------
// Badge rendering
// ---------------------------------------------------------------------------

test("getCertificationBadge: null certification renders unverified badge", () => {
  const html = getCertificationBadge(null);
  assert.match(html, /plugin-badge-none/);
  assert.match(html, /unverified/);
});

test("getCertificationBadge: revoked certification renders unverified badge", () => {
  const html = getCertificationBadge({ level: "certified", revoked: true });
  assert.match(html, /plugin-badge-none/);
});

test("getCertificationBadge: signed level renders blue badge", () => {
  const html = getCertificationBadge({ level: "signed", revoked: false });
  assert.match(html, /plugin-badge-blue/);
  assert.match(html, /data-level="signed"/);
});

test("getCertificationBadge: verified level renders green badge", () => {
  const html = getCertificationBadge({ level: "verified", revoked: false });
  assert.match(html, /plugin-badge-green/);
});

test("getCertificationBadge: certified level renders gold badge", () => {
  const html = getCertificationBadge({ level: "certified", revoked: false });
  assert.match(html, /plugin-badge-gold/);
  assert.match(html, /Certified/);
});

test("CERT_LEVELS: exports expected levels", () => {
  assert.ok(CERT_LEVELS.unverified);
  assert.ok(CERT_LEVELS.signed);
  assert.ok(CERT_LEVELS.verified);
  assert.ok(CERT_LEVELS.certified);
  assert.equal(CERT_LEVELS.signed.badge, "blue");
  assert.equal(CERT_LEVELS.verified.badge, "green");
  assert.equal(CERT_LEVELS.certified.badge, "gold");
});

// ---------------------------------------------------------------------------
// Manifest signature verification
// ---------------------------------------------------------------------------

test("verifyPluginSignature: valid signature with trusted key", async () => {
  const manifest = signManifest({ id: "pack", version: "1.0.0", tools: [{ name: "t1" }] }, "acme-key");
  const result = await verifyPluginSignature(manifest, ["acme-key"]);
  assert.equal(result.valid, true);
  assert.equal(result.keyId, "acme-key");
});

test("verifyPluginSignature: accepts object-form trusted keys", async () => {
  const manifest = signManifest({ id: "pack", version: "1.0.0" }, "acme-key");
  const result = await verifyPluginSignature(manifest, [{ id: "acme-key" }]);
  assert.equal(result.valid, true);
});

test("verifyPluginSignature: rejects untrusted key", async () => {
  const manifest = signManifest({ id: "pack", version: "1.0.0" }, "rogue-key");
  const result = await verifyPluginSignature(manifest, ["acme-key"]);
  assert.equal(result.valid, false);
  assert.equal(result.code, "KEY_NOT_TRUSTED");
});

test("verifyPluginSignature: rejects tampered manifest", async () => {
  const manifest = signManifest({ id: "pack", version: "1.0.0" }, "acme-key");
  manifest.version = "2.0.0"; // tamper after signing
  const result = await verifyPluginSignature(manifest, ["acme-key"]);
  assert.equal(result.valid, false);
  assert.equal(result.code, "SIGNATURE_MISMATCH");
});

test("verifyPluginSignature: missing signature", async () => {
  const result = await verifyPluginSignature({ id: "pack", version: "1.0.0" }, ["acme-key"]);
  assert.equal(result.valid, false);
  assert.equal(result.code, "SIGNATURE_REQUIRED");
});

test("verifyPluginSignature: unsupported algorithm", async () => {
  const manifest = signManifest({ id: "pack", version: "1.0.0" }, "acme-key", {});
  manifest.signature.algorithm = "md5";
  const result = await verifyPluginSignature(manifest, ["acme-key"]);
  assert.equal(result.valid, false);
  assert.equal(result.code, "ALGORITHM_UNSUPPORTED");
});

test("verifyPluginSignature: bad hex value", async () => {
  const manifest = {
    id: "pack",
    version: "1.0.0",
    signature: { algorithm: "sha256", keyId: "acme-key", value: "not-hex" },
  };
  const result = await verifyPluginSignature(manifest, ["acme-key"]);
  assert.equal(result.valid, false);
  assert.equal(result.code, "SIGNATURE_VALUE_INVALID");
});

test("verifyPluginSignature: invalid manifest returns code", async () => {
  const result = await verifyPluginSignature(null, ["acme-key"]);
  assert.equal(result.valid, false);
  assert.equal(result.code, "MANIFEST_INVALID");
});

// ---------------------------------------------------------------------------
// Publisher registry
// ---------------------------------------------------------------------------

const samplePEM = "-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEabc\n-----END PUBLIC KEY-----";

test("registerPublisher: registers a new publisher", async () => {
  const r = await registerPublisher({
    id: "acme",
    name: "Acme Plugins",
    email: "plugins@acme.test",
    publicKeyPEM: samplePEM,
    verifiedDomains: ["acme.test"],
    contactUrl: "https://acme.test/contact",
  });
  assert.equal(r.ok, true);
  assert.equal(r.publisher.id, "acme");
  assert.equal(r.publisher.verified, false);
  assert.deepEqual(r.publisher.verifiedDomains, ["acme.test"]);
});

test("registerPublisher: rejects missing id", async () => {
  const r = await registerPublisher({ name: "x", email: "x@y.z", publicKeyPEM: samplePEM });
  assert.equal(r.ok, false);
  assert.equal(r.code, "INVALID_ID");
});

test("registerPublisher: rejects invalid email", async () => {
  const r = await registerPublisher({
    id: "bad-email",
    name: "x",
    email: "not-an-email",
    publicKeyPEM: samplePEM,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, "INVALID_EMAIL");
});

test("registerPublisher: rejects non-PEM public key", async () => {
  const r = await registerPublisher({
    id: "bad-key",
    name: "x",
    email: "x@y.z",
    publicKeyPEM: "not-a-pem-key",
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, "INVALID_PUBLIC_KEY");
});

test("verifyPublisher: marks publisher as verified via dns", async () => {
  await registerPublisher({
    id: "verify-me",
    name: "Verify Me",
    email: "vm@test.test",
    publicKeyPEM: samplePEM,
  });
  const r = await verifyPublisher("verify-me", "dns");
  assert.equal(r.ok, true);
  assert.equal(r.publisher.verified, true);
  assert.equal(r.publisher.verificationMethod, "dns");
  assert.ok(r.publisher.verifiedAt);
});

test("verifyPublisher: rejects invalid method", async () => {
  const r = await verifyPublisher("verify-me", "smoke-signal");
  assert.equal(r.ok, false);
  assert.equal(r.code, "INVALID_METHOD");
});

test("verifyPublisher: returns NOT_FOUND for unknown id", async () => {
  const r = await verifyPublisher("ghost-id", "manual");
  assert.equal(r.ok, false);
  assert.equal(r.code, "NOT_FOUND");
});

test("registerPublisher: re-register preserves verified flag", async () => {
  await registerPublisher({
    id: "preserve",
    name: "P",
    email: "p@test.test",
    publicKeyPEM: samplePEM,
  });
  await verifyPublisher("preserve", "manual");
  const r = await registerPublisher({
    id: "preserve",
    name: "P Updated",
    email: "p@test.test",
    publicKeyPEM: samplePEM,
  });
  assert.equal(r.ok, true);
  assert.equal(r.publisher.verified, true, "verified flag should persist across re-register");
  assert.equal(r.publisher.name, "P Updated");
});

test("getPublisher + listPublishers", async () => {
  const p = await getPublisher("acme");
  assert.ok(p);
  assert.equal(p.id, "acme");

  const all = await listPublishers(false);
  assert.ok(all.length >= 1);

  const verifiedOnly = await listPublishers(true);
  assert.ok(verifiedOnly.every((x) => x.verified));
});
