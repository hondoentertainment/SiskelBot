/**
 * Entitlements tests: plan resolution, seat/workspace/feature checks, and the
 * feature-gate middleware. Uses a temp STORAGE_PATH; toggles
 * ENFORCE_PLAN_LIMITS per-case via the module's env read.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "siskelbot-entitlements-"));
process.env.STORAGE_PATH = tempDir;

test.after(() => {
  try {
    rmSync(tempDir, { recursive: true });
  } catch (_) {}
});

test("getEntitlements defaults a new workspace to the free plan", async () => {
  const { getEntitlements } = await import("../lib/entitlements.js");
  const ent = await getEntitlements("new-ws");
  assert.equal(ent.planId, "free");
  assert.equal(ent.maxMembers, 3);
  assert.deepEqual(ent.features, ["chat", "knowledge"]);
});

test("checkMemberLimit blocks at the free plan seat cap", async () => {
  const { checkMemberLimit } = await import("../lib/entitlements.js");
  const under = await checkMemberLimit("seat-ws", 2);
  assert.equal(under.allowed, true);
  const at = await checkMemberLimit("seat-ws", 3);
  assert.equal(at.allowed, false);
  assert.match(at.reason, /Upgrade/);
  assert.equal(at.limit, 3);
});

test("checkMemberLimit allows unlimited on enterprise (Infinity)", async () => {
  const { setPlan } = await import("../lib/plans.js");
  const { checkMemberLimit } = await import("../lib/entitlements.js");
  await setPlan("ent-ws", "enterprise");
  const res = await checkMemberLimit("ent-ws", 9999);
  assert.equal(res.allowed, true);
  assert.equal(res.limit, Infinity);
});

test("checkWorkspaceLimit enforces the plan workspace cap", async () => {
  const { checkWorkspaceLimit } = await import("../lib/entitlements.js");
  assert.equal(checkWorkspaceLimit("free", 1).allowed, true);
  assert.equal(checkWorkspaceLimit("free", 2).allowed, false); // free cap is 2
  assert.equal(checkWorkspaceLimit("pro", 5).allowed, true);
});

test("checkFeature reflects plan feature lists", async () => {
  const { setPlan } = await import("../lib/plans.js");
  const { checkFeature } = await import("../lib/entitlements.js");
  // free lacks workflows
  const free = await checkFeature("feat-free-ws", "workflows");
  assert.equal(free.allowed, false);
  assert.match(free.reason, /Upgrade/);
  // pro has workflows
  await setPlan("feat-pro-ws", "pro");
  const pro = await checkFeature("feat-pro-ws", "workflows");
  assert.equal(pro.allowed, true);
});

test("requireFeature is a no-op when enforcement is disabled", async () => {
  delete process.env.ENFORCE_PLAN_LIMITS;
  const { requireFeature } = await import("../lib/entitlements.js");
  const gate = requireFeature("workflows");
  let called = false;
  await gate({ headers: {}, query: {} }, {}, () => { called = true; });
  assert.equal(called, true);
});

test("requireFeature blocks a free workspace with 402 when enforcement is on", async () => {
  process.env.ENFORCE_PLAN_LIMITS = "1";
  const { requireFeature } = await import("../lib/entitlements.js");
  const gate = requireFeature("workflows");

  let status = null;
  let payload = null;
  const res = {
    status(c) { status = c; return this; },
    json(b) { payload = b; return this; },
  };
  let nextCalled = false;
  await gate({ headers: { "x-workspace-id": "gate-free-ws" }, query: {} }, res, () => { nextCalled = true; });

  assert.equal(nextCalled, false);
  assert.equal(status, 402);
  assert.equal(payload.error.code, "PLAN_UPGRADE_REQUIRED");
  delete process.env.ENFORCE_PLAN_LIMITS;
});

test("requireFeature allows a pro workspace when enforcement is on", async () => {
  process.env.ENFORCE_PLAN_LIMITS = "1";
  const { setPlan } = await import("../lib/plans.js");
  const { requireFeature } = await import("../lib/entitlements.js");
  await setPlan("gate-pro-ws", "pro");
  const gate = requireFeature("workflows");
  let called = false;
  await gate({ headers: { "x-workspace-id": "gate-pro-ws" }, query: {} }, {}, () => { called = true; });
  assert.equal(called, true);
  delete process.env.ENFORCE_PLAN_LIMITS;
});
