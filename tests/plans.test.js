import test from "node:test";
import assert from "node:assert/strict";

const TEST_STORAGE = "/tmp/plans-test-" + Date.now();

test.before(() => {
  process.env.STORAGE_PATH = TEST_STORAGE;
});

await test("listPlans returns all plan definitions", async () => {
  const { listPlans } = await import("../lib/plans.js");
  const plans = listPlans();
  assert.ok(Array.isArray(plans));
  assert.ok(plans.length >= 3);

  const ids = plans.map((p) => p.id);
  assert.ok(ids.includes("free"));
  assert.ok(ids.includes("pro"));
  assert.ok(ids.includes("enterprise"));
});

await test("listPlans includes expected fields on each plan", async () => {
  const { listPlans } = await import("../lib/plans.js");
  const plans = listPlans();
  for (const plan of plans) {
    assert.ok(typeof plan.id === "string");
    assert.ok(typeof plan.name === "string");
    assert.ok(typeof plan.tokensPerMonth === "number");
    assert.ok(typeof plan.maxWorkspaces === "number");
    assert.ok(typeof plan.maxMembers === "number");
    assert.ok(Array.isArray(plan.features));
    assert.ok(typeof plan.priceMonthly === "number");
  }
});

await test("getPlanDefinition returns plan for valid ID", async () => {
  const { getPlanDefinition } = await import("../lib/plans.js");
  const pro = getPlanDefinition("pro");
  assert.ok(pro);
  assert.equal(pro.id, "pro");
  assert.equal(pro.name, "Pro");
  assert.equal(pro.tokensPerMonth, 1_000_000);
});

await test("getPlanDefinition returns null for unknown plan", async () => {
  const { getPlanDefinition } = await import("../lib/plans.js");
  const result = getPlanDefinition("nonexistent");
  assert.equal(result, null);
});

await test("free plan has correct token limit", async () => {
  const { getPlanDefinition } = await import("../lib/plans.js");
  const free = getPlanDefinition("free");
  assert.equal(free.tokensPerMonth, 100_000);
  assert.equal(free.maxWorkspaces, 2);
  assert.equal(free.maxMembers, 3);
});

await test("enterprise plan has Infinity limits", async () => {
  const { getPlanDefinition } = await import("../lib/plans.js");
  const ent = getPlanDefinition("enterprise");
  assert.equal(ent.tokensPerMonth, Infinity);
  assert.equal(ent.maxWorkspaces, Infinity);
  assert.equal(ent.maxMembers, Infinity);
  assert.ok(ent.features.includes("*"));
});

await test("getPlan returns free plan by default", async () => {
  const { getPlan } = await import("../lib/plans.js");
  const plan = await getPlan("unassigned-workspace-" + Date.now());
  assert.equal(plan.id, "free");
  assert.equal(plan.name, "Free");
});

await test("setPlan assigns and persists plan", async () => {
  const { setPlan, getPlan } = await import("../lib/plans.js");
  const wsId = "plan-test-ws-" + Date.now();

  const result = await setPlan(wsId, "pro");
  assert.equal(result.ok, true);
  assert.equal(result.plan.id, "pro");
  assert.equal(result.plan.name, "Pro");

  const plan = await getPlan(wsId);
  assert.equal(plan.id, "pro");
  assert.equal(plan.tokensPerMonth, 1_000_000);
});

await test("setPlan rejects unknown plan ID", async () => {
  const { setPlan } = await import("../lib/plans.js");
  const result = await setPlan("some-workspace", "ultra");
  assert.equal(result.ok, false);
  assert.ok(result.error.includes("Unknown plan"));
});

await test("setPlan rejects empty workspace", async () => {
  const { setPlan } = await import("../lib/plans.js");
  const result = await setPlan("", "pro");
  assert.equal(result.ok, false);
  assert.ok(result.error.includes("Workspace ID"));
});

await test("checkFeatureAccess allows features in plan", async () => {
  const { setPlan, checkFeatureAccess } = await import("../lib/plans.js");
  const wsId = "feature-test-ws-" + Date.now();
  await setPlan(wsId, "pro");

  const result = await checkFeatureAccess(wsId, "agent");
  assert.equal(result.allowed, true);
  assert.equal(result.plan, "pro");
  assert.equal(result.feature, "agent");
});

await test("checkFeatureAccess denies features not in plan", async () => {
  const { setPlan, checkFeatureAccess } = await import("../lib/plans.js");
  const wsId = "feature-deny-ws-" + Date.now();
  await setPlan(wsId, "free");

  const result = await checkFeatureAccess(wsId, "agent");
  assert.equal(result.allowed, false);
  assert.equal(result.plan, "free");
});

await test("checkFeatureAccess allows all features for enterprise", async () => {
  const { setPlan, checkFeatureAccess } = await import("../lib/plans.js");
  const wsId = "enterprise-ws-" + Date.now();
  await setPlan(wsId, "enterprise");

  const chat = await checkFeatureAccess(wsId, "chat");
  assert.equal(chat.allowed, true);

  const exotic = await checkFeatureAccess(wsId, "some-future-feature");
  assert.equal(exotic.allowed, true);
});

await test("free plan allows chat and knowledge", async () => {
  const { checkFeatureAccess } = await import("../lib/plans.js");
  const wsId = "free-features-" + Date.now();

  const chat = await checkFeatureAccess(wsId, "chat");
  assert.equal(chat.allowed, true);

  const knowledge = await checkFeatureAccess(wsId, "knowledge");
  assert.equal(knowledge.allowed, true);
});
