/**
 * Tests for Wave 19B GDPR tooling:
 *   lib/pii-scanner.js   — scanForPii, redactPii
 *   lib/dpia.js          — generateDpiaTemplate
 *   routes/gdpr.js       — HTTP endpoints
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "siskelbot-gdpr-"));
process.env.STORAGE_PATH = tempDir;

test.after(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch (_) {}
});

// ─── lib/pii-scanner.js ────────────────────────────────────────────────────

const { scanForPii, redactPii, scanWorkspaceForPii } = await import("../lib/pii-scanner.js");

test("scanForPii detects email addresses", () => {
  const { hasPii, findings } = scanForPii("Contact us at alice@example.com for help.");
  assert.ok(hasPii, "should have PII");
  const email = findings.find((f) => f.type === "email");
  assert.ok(email, "should find an email finding");
  assert.equal(email.severity, "high");
  assert.ok(email.value.includes("@"), "redacted value should retain @ for readability");
  assert.ok(typeof email.position === "number");
});

test("scanForPii detects SSNs with high severity", () => {
  const { hasPii, findings } = scanForPii("SSN: 123-45-6789");
  assert.ok(hasPii);
  const ssn = findings.find((f) => f.type === "ssn");
  assert.ok(ssn, "should find an SSN finding");
  assert.equal(ssn.severity, "high");
});

test("scanForPii detects Luhn-valid credit card numbers", () => {
  const { hasPii, findings } = scanForPii("Card: 4111111111111111");
  assert.ok(hasPii);
  const cc = findings.find((f) => f.type === "credit_card");
  assert.ok(cc, "should detect a Luhn-valid CC");
  assert.equal(cc.severity, "high");
});

test("scanForPii does not flag Luhn-invalid numbers as credit cards", () => {
  const { findings } = scanForPii("Number: 1234567890123456");
  const cc = findings.find((f) => f.type === "credit_card");
  assert.ok(!cc, "should not detect Luhn-invalid number as CC");
});

test("scanForPii detects phone numbers with medium severity", () => {
  const { hasPii, findings } = scanForPii("Call (555) 123-4567 anytime.");
  assert.ok(hasPii);
  const phone = findings.find((f) => f.type === "phone");
  assert.ok(phone, "should find a phone finding");
  assert.equal(phone.severity, "medium");
});

test("scanForPii detects IPv4 addresses with low severity", () => {
  const { hasPii, findings } = scanForPii("Server at 192.168.1.100.");
  assert.ok(hasPii);
  const ip = findings.find((f) => f.type === "ipv4");
  assert.ok(ip, "should find an IPv4 finding");
  assert.equal(ip.severity, "low");
});

test("scanForPii detects high-entropy API keys", () => {
  const key = "sk_live_" + "abcdefghijklmnopqrstuvwxyz1234567890";
  const { hasPii, findings } = scanForPii(`Token: ${key}`);
  assert.ok(hasPii);
  const apiKey = findings.find((f) => f.type === "api_key");
  assert.ok(apiKey, "should find an API key finding");
  assert.equal(apiKey.severity, "high");
});

test("scanForPii returns hasPii false for clean text", () => {
  const { hasPii, findings } = scanForPii("This is a completely clean paragraph.");
  assert.ok(!hasPii);
  assert.equal(findings.length, 0);
});

test("scanForPii returns empty result for empty string", () => {
  const { hasPii, findings } = scanForPii("");
  assert.ok(!hasPii);
  assert.equal(findings.length, 0);
});

test("redactPii replaces email with [REDACTED:email]", () => {
  const result = redactPii("Email me at user@example.com please.");
  assert.ok(result.includes("[REDACTED:email]"), `expected redacted email, got: ${result}`);
  assert.ok(!result.includes("user@example.com"), "original email must be removed");
});

test("redactPii replaces SSN with [REDACTED:ssn]", () => {
  const result = redactPii("My SSN is 123-45-6789.");
  assert.ok(result.includes("[REDACTED:ssn]"), `expected redacted SSN, got: ${result}`);
  assert.ok(!result.includes("123-45-6789"));
});

test("redactPii preserves non-PII text", () => {
  const input = "Hello world, no PII here at all!";
  const result = redactPii(input);
  assert.equal(result, input);
});

test("redactPii handles null/undefined safely", () => {
  assert.equal(redactPii(null), null);
  assert.equal(redactPii(undefined), undefined);
});

test("scanWorkspaceForPii returns valid structure for empty workspace", async () => {
  const result = await scanWorkspaceForPii("test-ws-empty", { sampleSize: 10 });
  assert.equal(result.workspaceId, "test-ws-empty");
  assert.ok(result.scannedAt, "should have scannedAt");
  assert.ok(typeof result.documentsScanned === "number");
  assert.ok(Array.isArray(result.piiFindings));
  assert.ok(typeof result.summary === "object");
  assert.ok(typeof result.summary.high === "number");
  assert.ok(typeof result.summary.medium === "number");
  assert.ok(typeof result.summary.low === "number");
});

// ─── lib/dpia.js ───────────────────────────────────────────────────────────

const { generateDpiaTemplate, generateAndSaveDpia } = await import("../lib/dpia.js");

test("generateDpiaTemplate returns a string", () => {
  const md = generateDpiaTemplate();
  assert.equal(typeof md, "string");
  assert.ok(md.length > 100);
});

test("generateDpiaTemplate includes all 8 required sections", () => {
  const md = generateDpiaTemplate();
  assert.ok(md.includes("## 1. Processing Description"), "missing section 1");
  assert.ok(md.includes("## 2. Purpose and Legal Basis"), "missing section 2");
  assert.ok(md.includes("## 3. Data Categories Processed"), "missing section 3");
  assert.ok(md.includes("## 4. Data Retention Periods"), "missing section 4");
  assert.ok(md.includes("## 5. Third-Party Processors"), "missing section 5");
  assert.ok(md.includes("## 6. Risk Assessment"), "missing section 6");
  assert.ok(md.includes("## 7. Safeguards"), "missing section 7");
  assert.ok(md.includes("## 8. Data Subject Rights"), "missing section 8");
});

test("generateDpiaTemplate reflects custom description", () => {
  const md = generateDpiaTemplate({ description: "Custom Widget Processing System" });
  assert.ok(md.includes("Custom Widget Processing System"));
});

test("generateDpiaTemplate mentions data subject rights endpoints", () => {
  const md = generateDpiaTemplate();
  assert.ok(md.includes("/api/v1/compliance/data-subject-request"));
  assert.ok(md.includes("/api/v1/gdpr/data-deletion"));
});

test("generateAndSaveDpia returns key, markdown, and generatedAt", async () => {
  const result = await generateAndSaveDpia("ws-test-dpia");
  assert.ok(result.key.startsWith("dpia:ws-test-dpia:"));
  assert.ok(typeof result.markdown === "string");
  assert.ok(result.generatedAt);
});

// ─── routes/gdpr.js — HTTP endpoints ─────────────────────────────────────

import express from "express";
import request from "supertest";
import { mountGdprRoutes } from "../routes/gdpr.js";

function buildApp({ authenticated = true } = {}) {
  const app = express();
  app.use(express.json());

  const deps = {
    apiRoute(method, path, ...handlers) {
      app[method](`/api/v1${path}`, ...handlers);
    },
    apiError(res, status, code, message, hint) {
      return res.status(status).json({ error: message, code, hint });
    },
    userAuth: authenticated
      ? (req, res, next) => {
          req.userId = "test-user";
          next();
        }
      : (req, res, next) => res.status(401).json({ error: "Unauthorized", code: "UNAUTHORIZED" }),
    requireScope: () => (req, res, next) => next(),
    logRequest: (req, res, next) => next(),
    storageRateLimiter: (req, res, next) => next(),
    sanitizeWorkspace: (ws) =>
      String(ws || "default")
        .replace(/[^a-zA-Z0-9_.\-]/g, "")
        .slice(0, 50) || "default",
  };

  mountGdprRoutes(app, deps);
  return app;
}

test("POST /api/v1/gdpr/pii-scan returns 401 without auth", async () => {
  const app = buildApp({ authenticated: false });
  const res = await request(app).post("/api/v1/gdpr/pii-scan").send({});
  assert.equal(res.status, 401);
});

test("POST /api/v1/gdpr/pii-scan returns valid scan result when authenticated", async () => {
  const app = buildApp({ authenticated: true });
  const res = await request(app)
    .post("/api/v1/gdpr/pii-scan")
    .send({ workspaceId: "test-ws" });
  assert.equal(res.status, 200);
  assert.ok(typeof res.body.workspaceId === "string");
  assert.ok(typeof res.body.documentsScanned === "number");
  assert.ok(Array.isArray(res.body.piiFindings));
  assert.ok(typeof res.body.summary === "object");
});

test("GET /api/v1/gdpr/dpia returns 401 without auth", async () => {
  const app = buildApp({ authenticated: false });
  const res = await request(app).get("/api/v1/gdpr/dpia");
  assert.equal(res.status, 401);
});

test("GET /api/v1/gdpr/dpia returns JSON with markdown when authenticated", async () => {
  const app = buildApp({ authenticated: true });
  const res = await request(app).get("/api/v1/gdpr/dpia");
  assert.equal(res.status, 200);
  assert.ok(typeof res.body.markdown === "string");
  assert.ok(res.body.markdown.includes("## 1. Processing Description"));
});

test("GET /api/v1/gdpr/dpia returns text/markdown when Accept header requests it", async () => {
  const app = buildApp({ authenticated: true });
  const res = await request(app)
    .get("/api/v1/gdpr/dpia")
    .set("Accept", "text/markdown");
  assert.equal(res.status, 200);
  assert.ok(res.headers["content-type"].includes("text/markdown"));
  assert.ok(typeof res.text === "string");
  assert.ok(res.text.includes("## 1. Processing Description"));
});

test("POST /api/v1/gdpr/data-export returns 401 without auth", async () => {
  const app = buildApp({ authenticated: false });
  const res = await request(app).post("/api/v1/gdpr/data-export").send({});
  assert.equal(res.status, 401);
});

test("POST /api/v1/gdpr/data-export queues a job and returns 202 with jobId", async () => {
  const app = buildApp({ authenticated: true });
  const res = await request(app).post("/api/v1/gdpr/data-export").send({});
  assert.equal(res.status, 202);
  assert.ok(res.body.jobId, "should have a jobId");
  assert.equal(res.body.status, "pending");
  assert.ok(res.body.estimatedReadyAt);
});

test("POST /api/v1/gdpr/data-deletion requires confirmation string", async () => {
  const app = buildApp({ authenticated: true });
  const res = await request(app)
    .post("/api/v1/gdpr/data-deletion")
    .send({ confirmation: "WRONG_STRING" });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "CONFIRMATION_REQUIRED");
});

test("POST /api/v1/gdpr/data-deletion returns 401 without auth", async () => {
  const app = buildApp({ authenticated: false });
  const res = await request(app)
    .post("/api/v1/gdpr/data-deletion")
    .send({ confirmation: "DELETE_MY_DATA" });
  assert.equal(res.status, 401);
});

test("POST /api/v1/gdpr/data-deletion returns 202 with valid confirmation", async () => {
  const app = buildApp({ authenticated: true });
  const res = await request(app)
    .post("/api/v1/gdpr/data-deletion")
    .send({ confirmation: "DELETE_MY_DATA" });
  assert.equal(res.status, 202);
  assert.ok(res.body.jobId);
  assert.equal(res.body.status, "pending");
});

test("GET /api/v1/gdpr/data-deletion/status returns 401 without auth", async () => {
  const app = buildApp({ authenticated: false });
  const res = await request(app).get("/api/v1/gdpr/data-deletion/status");
  assert.equal(res.status, 401);
});

test("GET /api/v1/gdpr/data-deletion/status returns not_requested for a fresh user", async () => {
  const freshUserId = `fresh-user-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const freshApp = express();
  freshApp.use(express.json());
  const freshDeps = {
    apiRoute(method, path, ...handlers) {
      freshApp[method](`/api/v1${path}`, ...handlers);
    },
    apiError(res, status, code, message, hint) {
      return res.status(status).json({ error: message, code, hint });
    },
    userAuth: (req, res, next) => {
      req.userId = freshUserId;
      next();
    },
    requireScope: () => (req, res, next) => next(),
    logRequest: (req, res, next) => next(),
    storageRateLimiter: (req, res, next) => next(),
    sanitizeWorkspace: (ws) =>
      String(ws || "default")
        .replace(/[^a-zA-Z0-9_.\-]/g, "")
        .slice(0, 50) || "default",
  };
  mountGdprRoutes(freshApp, freshDeps);
  const res = await request(freshApp).get("/api/v1/gdpr/data-deletion/status");
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "not_requested");
});

test("GET /api/v1/gdpr/data-deletion/status reflects queued deletion job", async () => {
  const userId = `user-status-${Date.now()}`;
  const app = buildApp({ authenticated: true });

  const appWithUser = express();
  appWithUser.use(express.json());
  const depsWithUser = {
    apiRoute(method, path, ...handlers) {
      appWithUser[method](`/api/v1${path}`, ...handlers);
    },
    apiError(res, status, code, message, hint) {
      return res.status(status).json({ error: message, code, hint });
    },
    userAuth: (req, res, next) => {
      req.userId = userId;
      next();
    },
    requireScope: () => (req, res, next) => next(),
    logRequest: (req, res, next) => next(),
    storageRateLimiter: (req, res, next) => next(),
    sanitizeWorkspace: (ws) =>
      String(ws || "default")
        .replace(/[^a-zA-Z0-9_.\-]/g, "")
        .slice(0, 50) || "default",
  };
  mountGdprRoutes(appWithUser, depsWithUser);

  await request(appWithUser)
    .post("/api/v1/gdpr/data-deletion")
    .send({ confirmation: "DELETE_MY_DATA" });

  const statusRes = await request(appWithUser).get("/api/v1/gdpr/data-deletion/status");
  assert.equal(statusRes.status, 200);
  assert.ok(statusRes.body.jobId, "should have a jobId");
  assert.equal(statusRes.body.status, "pending");
});
