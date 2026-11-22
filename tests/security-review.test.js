import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertResolvedPublicHost, isBlockedHostname, validatePublicHttpsUrl } from "../lib/ssrf-guard.js";
import { validateMcpUrl } from "../lib/workspace-mcp.js";
import { validateReadOnlySelect } from "../lib/governed-sql.js";
import { redactSecrets, replaySteps } from "../lib/audit-redaction.js";
import { checkUrlAllowed } from "../lib/browser-agent.js";
import { extractZipSafe } from "../lib/safe-unzip.js";
import { sendEmail } from "../lib/email-notifications.js";
import { adminAuth } from "../lib/admin-auth.js";
import { mountApprovalRoutes } from "../routes/approvals.js";

test("outbound https checks block loopback, private, and metadata hosts", async () => {
  assert.equal(isBlockedHostname("127.0.0.2"), true);
  assert.equal(isBlockedHostname("10.1.2.3"), true);
  assert.equal(isBlockedHostname("169.254.169.254"), true);
  assert.equal(isBlockedHostname("metadata.google.internal"), true);
  assert.equal(validatePublicHttpsUrl("https://api.example.com/v1").ok, true);
  assert.equal(validatePublicHttpsUrl("https://user:pass@api.example.com").ok, false);
  assert.equal(validateMcpUrl("https://10.0.0.5/mcp", ["10.0.0.5"]).ok, false);
  assert.equal(validateMcpUrl("https://127.0.0.2/mcp", ["127.0.0.2"]).ok, false);
  const resolved = await assertResolvedPublicHost("api.example.com", async () => [{ address: "127.0.0.1" }]);
  assert.equal(resolved.ok, false);
});

test("governed SQL rejects a broken wrapper and connection functions", () => {
  assert.equal(validateReadOnlySelect("SELECT 1) AS governed_sql").ok, false);
  assert.equal(validateReadOnlySelect("SELECT dblink_connect('host=127.0.0.1')").ok, false);
  assert.equal(validateReadOnlySelect("SELECT '(ok)'").ok, true);
});

test("audit replay redacts tokens that are not field names", () => {
  const secret = "ya29.a0AfGoogleAccessTokenValue";
  const steps = replaySteps({
    events: [{ type: "tool", name: "gmail", result: { body: secret }, args: { note: "ghp_githubtokenvalue1234567890" } }],
  });
  const text = JSON.stringify(steps);
  assert.equal(text.includes(secret), false);
  assert.equal(text.includes("ghp_githubtokenvalue1234567890"), false);
  assert.match(text, /\[redacted\]/);
  assert.equal(redactSecrets({ privateKey: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----" }).privateKey, "[redacted]");
});

test("browser allowlist matches hosts, not URL prefixes", () => {
  const allow = ["https://files.example.com/a"];
  assert.equal(checkUrlAllowed("https://files.example.com/a.txt", { allowlist: allow }).allowed, true);
  assert.equal(checkUrlAllowed("https://files.example.com.evil.com/a", { allowlist: allow }).allowed, false);
  assert.equal(checkUrlAllowed("https://files.example.com@evil.com/a", { allowlist: allow }).allowed, false);
});

test("approval decisions require an admin", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sec-approve-"));
  const prev = {
    STORAGE_PATH: process.env.STORAGE_PATH,
    ADMIN_API_KEY: process.env.ADMIN_API_KEY,
    APPROVAL_QUEUE: process.env.APPROVAL_QUEUE,
  };
  process.env.STORAGE_PATH = dir;
  process.env.ADMIN_API_KEY = "admin-review-key";
  process.env.APPROVAL_QUEUE = "1";
  try {
    const { createApproval } = await import("../lib/approval-queue.js");
    const pending = await createApproval({
      workspaceId: "default",
      userId: "ada",
      tool: "send_notification",
      args: { message: "ship", apiKey: "sk_live_supersecretvalue" },
    });
    assert.equal(JSON.stringify(pending).includes("sk_live_supersecretvalue"), false);
    const app = express();
    app.use(express.json());
    mountApprovalRoutes(app, {
      apiRoute: (method, path, ...handlers) => app[method](`/api/v1${path}`, ...handlers),
      apiError: (res, status, code, msg) => res.status(status).json({ error: msg, code }),
      logRequest: (_q, _s, next) => next(),
      adminAuth,
    });
    const denied = await request(app).post(`/api/v1/approvals/${pending.id}/approve`).send({ workspace: "default" });
    assert.equal(denied.status, 401);
    const allowed = await request(app)
      .post(`/api/v1/approvals/${pending.id}/approve`)
      .set("Authorization", "Bearer admin-review-key")
      .send({ workspace: "default" });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body.approval.status, "approved");
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("zip extraction rejects a path that escapes the destination", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sec-zip-"));
  const zipPath = join(dir, "bad.zip");
  execFileSync("python3", ["-c", `
import stat, zipfile
z = zipfile.ZipFile(${JSON.stringify(zipPath)}, "w")
info = zipfile.ZipInfo("link")
info.create_system = 3
info.external_attr = (stat.S_IFLNK | 0o777) << 16
z.writestr(info, "/tmp/escaped")
z.close()
`]);
  await assert.rejects(() => extractZipSafe(zipPath, join(dir, "out")), /symlink|not allowed/);
  rmSync(dir, { recursive: true, force: true });
});

test("email headers reject CR LF", async () => {
  const prev = process.env.SMTP_HOST;
  process.env.SMTP_HOST = "smtp.example.com";
  try {
    await assert.rejects(() => sendEmail("ada@example.com", "Hello\r\nBcc: eve@example.com", "body"), /line break/);
  } finally {
    if (prev === undefined) delete process.env.SMTP_HOST;
    else process.env.SMTP_HOST = prev;
  }
});

test("production refuses the dev secrets key", async () => {
  const prevEnv = process.env.NODE_ENV;
  const prevKey = process.env.SECRETS_ENCRYPTION_KEY;
  process.env.NODE_ENV = "production";
  delete process.env.SECRETS_ENCRYPTION_KEY;
  try {
    const { getSecretValue } = await import("../lib/secrets-store.js");
    await assert.rejects(() => getSecretValue("workspace", "default", "byok_openai"), /SECRETS_ENCRYPTION_KEY/);
  } finally {
    if (prevEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevEnv;
    if (prevKey === undefined) delete process.env.SECRETS_ENCRYPTION_KEY;
    else process.env.SECRETS_ENCRYPTION_KEY = prevKey;
  }
});
