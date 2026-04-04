import test from "node:test";
import assert from "node:assert/strict";
import {
  getRegisteredActions,
  executeStep,
  registerAction,
  appendAuditLog,
} from "../lib/action-executor.js";

test("action-executor: getRegisteredActions returns built-in actions", () => {
  const actions = getRegisteredActions();
  assert.ok(Array.isArray(actions));
  assert.ok(actions.includes("build"), "should include build action");
  assert.ok(actions.includes("deploy"), "should include deploy action");
  assert.ok(actions.includes("copy"), "should include copy action");
  assert.ok(actions.includes("webhook"), "should include webhook action");
});

test("action-executor: executeStep rejects null/invalid step", async () => {
  const result = await executeStep(null);
  assert.equal(result.ok, false);
  assert.ok(result.error.includes("action"));
});

test("action-executor: executeStep rejects step without action", async () => {
  const result = await executeStep({ payload: {} });
  assert.equal(result.ok, false);
  assert.ok(result.error);
});

test("action-executor: executeStep rejects unknown action type", async () => {
  const result = await executeStep({ action: "nonexistent_action_xyz" });
  assert.equal(result.ok, false);
  assert.ok(result.error.includes("Unknown action"));
  assert.ok(result.error.includes("nonexistent_action_xyz"));
});

test("action-executor: executeStep runs copy action successfully", async () => {
  const result = await executeStep({ action: "copy" });
  assert.equal(result.ok, true);
  assert.ok(result.stdout.includes("Copy"));
});

test("action-executor: executeStep deploy fails without VERCEL_TOKEN", async (t) => {
  const origToken = process.env.VERCEL_TOKEN;
  delete process.env.VERCEL_TOKEN;
  t.after(() => {
    if (origToken !== undefined) process.env.VERCEL_TOKEN = origToken;
    else delete process.env.VERCEL_TOKEN;
  });

  const result = await executeStep({ action: "deploy" });
  assert.equal(result.ok, false);
  assert.ok(result.error.includes("VERCEL_TOKEN"));
});

test("action-executor: executeStep build rejects unsafe commands", async () => {
  const result = await executeStep({
    action: "build",
    payload: { command: "rm -rf /" },
  });
  assert.equal(result.ok, false);
  assert.ok(result.error.includes("Unsupported command"));
});

test("action-executor: executeStep build allows npm run scripts", async () => {
  // This will likely fail because the script doesn't exist, but it should
  // be accepted by the command pattern validation
  const result = await executeStep({
    action: "build",
    payload: { command: "npm run nonexistent-script", cwd: "/tmp" },
  });
  // It should either succeed or fail with a build error, not a command validation error
  if (!result.ok) {
    assert.ok(!result.error.includes("Unsupported command"));
  }
});

test("action-executor: registerAction adds custom action", async () => {
  const actionName = "test-custom-" + Date.now();
  registerAction(actionName, async (payload) => {
    return { ok: true, stdout: `custom: ${payload.msg || "none"}` };
  });

  assert.ok(getRegisteredActions().includes(actionName));

  const result = await executeStep({
    action: actionName,
    payload: { msg: "hello" },
  });
  assert.equal(result.ok, true);
  assert.ok(result.stdout.includes("hello"));
});

test("action-executor: registerAction ignores empty name", () => {
  const before = getRegisteredActions().length;
  registerAction("", async () => ({ ok: true }));
  registerAction("  ", async () => ({ ok: true }));
  assert.equal(getRegisteredActions().length, before);
});

test("action-executor: registerAction ignores non-function handler", () => {
  const before = getRegisteredActions().length;
  registerAction("should-not-register", "not a function");
  assert.equal(getRegisteredActions().length, before);
});

test("action-executor: appendAuditLog writes without throwing", async () => {
  // Should not throw even with minimal input
  await assert.doesNotReject(async () => {
    await appendAuditLog({
      action: "test",
      payload: { foo: "bar" },
      ok: true,
    });
  });
});

test("action-executor: appendAuditLog handles error entries", async () => {
  await assert.doesNotReject(async () => {
    await appendAuditLog({
      action: "test-fail",
      payload: {},
      ok: false,
      error: "something went wrong",
    });
  });
});

test("action-executor: webhook action disabled by default", async () => {
  const origAllow = process.env.ALLOW_WEBHOOK_ACTIONS;
  delete process.env.ALLOW_WEBHOOK_ACTIONS;
  // The ALLOW_WEBHOOK_ACTIONS is read at module load time, so this only tests
  // the current state
  const result = await executeStep({
    action: "webhook",
    payload: { url: "https://example.com/hook" },
  });
  // Should be disabled (ok: false) unless ALLOW_WEBHOOK_ACTIONS was set before module loaded
  assert.equal(result.ok, false);
  if (origAllow !== undefined) process.env.ALLOW_WEBHOOK_ACTIONS = origAllow;
});
