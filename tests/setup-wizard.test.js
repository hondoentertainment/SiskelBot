import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import { buildSetupReport } from "../lib/setup-wizard.js";
import { mountSetupWizardRoutes } from "../routes/setup-wizard.js";

function withEnv(values, fn) {
  const prev = {};
  for (const key of Object.keys(values)) {
    prev[key] = process.env[key];
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of Object.keys(prev)) {
        if (prev[key] === undefined) delete process.env[key];
        else process.env[key] = prev[key];
      }
    });
}

test("setup report never echoes secrets and classifies each integration", async () => {
  const secret = "sk_live_super_secret_value";
  const slack = "xoxb-super-secret-token";
  await withEnv({
    GOOGLE_CLIENT_ID: "client-id-value",
    GOOGLE_CLIENT_SECRET: "client-secret-value",
    SMTP_HOST: "smtp.example.com",
    SMTP_PASS: "mailbox-password",
    SLACK_BOT_TOKEN: slack,
    SLACK_WEBHOOK_URL: undefined,
    STRIPE_SECRET_KEY: secret,
    BROWSER_FILE_TRANSFER: undefined,
    OPENAPI_TOOLS_WRITE: "1",
  }, async () => {
    const report = await buildSetupReport({
      verifySmtp: async () => {},
      slackAuth: async () => ({ ok: true }),
      stripeBalance: async () => {},
    });
    const text = JSON.stringify(report);
    assert.equal(text.includes(secret), false);
    assert.equal(text.includes(slack), false);
    assert.equal(text.includes("client-secret-value"), false);
    assert.equal(text.includes("mailbox-password"), false);
    const byId = Object.fromEntries(report.checks.map((item) => [item.id, item]));
    assert.equal(byId.google_oauth.state, "configured");
    assert.equal(byId.smtp.state, "working");
    assert.equal(byId.slack.state, "working");
    assert.equal(byId.stripe.state, "working");
    const write = report.flags.find((flag) => flag.id === "OPENAPI_TOOLS_WRITE");
    const files = report.flags.find((flag) => flag.id === "BROWSER_FILE_TRANSFER");
    assert.equal(write.state, "on");
    assert.equal(files.state, "off");
  });
});

test("missing integrations and a failed probe stay free of secrets", async () => {
  await withEnv({
    GOOGLE_CLIENT_ID: undefined,
    GOOGLE_CLIENT_SECRET: undefined,
    SMTP_HOST: "smtp.example.com",
    SLACK_BOT_TOKEN: undefined,
    SLACK_WEBHOOK_URL: "https://hooks.example/secret-hook",
    STRIPE_SECRET_KEY: "sk_test_not_live",
  }, async () => {
    const report = await buildSetupReport({
      verifySmtp: async () => { throw new Error("password=mailbox-password rejected"); },
    });
    const text = JSON.stringify(report);
    assert.equal(text.includes("mailbox-password"), false);
    assert.equal(text.includes("secret-hook"), false);
    const byId = Object.fromEntries(report.checks.map((item) => [item.id, item]));
    assert.equal(byId.google_oauth.state, "missing");
    assert.equal(byId.smtp.state, "error");
    assert.match(byId.smtp.detail, /password=\*\*\*/);
    assert.equal(byId.slack.state, "configured");
    assert.equal(byId.stripe.state, "configured");
    assert.match(byId.stripe.detail, /test key/i);
  });
});

test("GET /admin/setup returns the report", async () => {
  const app = express();
  mountSetupWizardRoutes(app, {
    apiRoute: (method, path, ...handlers) => app[method](`/api/v1${path}`, ...handlers),
    apiError: (res, status, code, msg) => res.status(status).json({ error: msg, code }),
    logRequest: (_q, _s, n) => n(),
    adminAuth: (_q, _s, n) => n(),
  });
  const res = await request(app).get("/api/v1/admin/setup");
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.checks));
  assert.ok(res.body.flags.some((flag) => flag.id === "AGENT_DB_QUERY"));
});
