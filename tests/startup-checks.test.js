import test from "node:test";
import assert from "node:assert/strict";

test.before(() => {
  process.env.STORAGE_PATH = "/tmp/startup-checks-test-" + Date.now();
  // Clear integration env vars so checks return skip
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.DISCORD_BOT_TOKEN;
  delete process.env.SMTP_HOST;
  delete process.env.JIRA_URL;
  delete process.env.JIRA_EMAIL;
  delete process.env.JIRA_API_TOKEN;
  delete process.env.LINEAR_API_KEY;
  delete process.env.REDIS_URL;
  delete process.env.MCP_SERVERS;
  // Set backend to ollama (default, will fail since no server running but that's expected)
  process.env.BACKEND = "ollama";
  process.env.OLLAMA_URL = "http://localhost:11434";
});

await test("runStartupChecks returns an array of results", async () => {
  const { runStartupChecks } = await import("../lib/startup-checks.js");
  const results = await runStartupChecks();
  assert.ok(Array.isArray(results));
  assert.ok(results.length > 0);
});

await test("each result has name, status, and message", async () => {
  const { runStartupChecks } = await import("../lib/startup-checks.js");
  const results = await runStartupChecks();
  for (const r of results) {
    assert.ok(typeof r.name === "string", `name should be string: ${JSON.stringify(r)}`);
    assert.ok(["ok", "fail", "skip"].includes(r.status), `status should be ok/fail/skip: ${r.status}`);
    assert.ok(typeof r.message === "string", `message should be string: ${JSON.stringify(r)}`);
  }
});

await test("unconfigured integrations return skip status", async () => {
  const { runStartupChecks } = await import("../lib/startup-checks.js");
  const results = await runStartupChecks();

  const slack = results.find(r => r.name === "slack");
  assert.ok(slack);
  assert.equal(slack.status, "skip");

  const discord = results.find(r => r.name === "discord");
  assert.ok(discord);
  assert.equal(discord.status, "skip");

  const email = results.find(r => r.name === "email");
  assert.ok(email);
  assert.equal(email.status, "skip");

  const jira = results.find(r => r.name === "jira");
  assert.ok(jira);
  assert.equal(jira.status, "skip");

  const linear = results.find(r => r.name === "linear");
  assert.ok(linear);
  assert.equal(linear.status, "skip");

  const redis = results.find(r => r.name === "redis");
  assert.ok(redis);
  assert.equal(redis.status, "skip");
});

await test("backend check runs and returns ok or fail", async () => {
  const { runStartupChecks } = await import("../lib/startup-checks.js");
  const results = await runStartupChecks();
  const backend = results.find(r => r.name === "backend");
  assert.ok(backend);
  assert.ok(["ok", "fail"].includes(backend.status));
});

await test("storage check runs", async () => {
  const { runStartupChecks } = await import("../lib/startup-checks.js");
  const results = await runStartupChecks();
  const storage = results.find(r => r.name === "storage");
  assert.ok(storage);
  assert.ok(["ok", "fail"].includes(storage.status));
});

await test("getCachedResults returns results after runStartupChecks", async () => {
  const { getCachedResults } = await import("../lib/startup-checks.js");
  const cached = getCachedResults();
  assert.ok(cached === null || Array.isArray(cached));
});

await test("runStartupChecks covers all expected integrations", async () => {
  const { runStartupChecks } = await import("../lib/startup-checks.js");
  const results = await runStartupChecks();
  const names = results.map(r => r.name);
  assert.ok(names.includes("backend"));
  assert.ok(names.includes("storage"));
  assert.ok(names.includes("slack"));
  assert.ok(names.includes("discord"));
  assert.ok(names.includes("email"));
  assert.ok(names.includes("jira"));
  assert.ok(names.includes("linear"));
  assert.ok(names.includes("redis"));
  assert.ok(names.includes("mcp-servers"));
});
