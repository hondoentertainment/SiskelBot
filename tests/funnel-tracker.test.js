/**
 * Tests for lib/funnel-tracker.js — funnel definition, event tracking,
 * conversion stats, dropoff, user paths, and pre-defined funnel seeding.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const tempDir = mkdtempSync(join(tmpdir(), "funnel-tracker-test-"));
process.env.STORAGE_PATH = tempDir;

const {
  defineFunnel,
  trackFunnelEvent,
  getFunnelStats,
  getFunnelPathForUser,
  listFunnels,
  deleteFunnel,
  getDropoffUsers,
  getFunnel,
  seedPredefinedFunnels,
  PREDEFINED_FUNNELS,
  __test__,
} = await import("../lib/funnel-tracker.js");

test.after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

const WS = "ftest";
const STEPS = [
  { name: "signup", event: "signup" },
  { name: "verify", event: "verify" },
  { name: "first_chat", event: "first_chat" },
];

// --- defineFunnel ---

test("defineFunnel creates a funnel with the given steps", async () => {
  const f = await defineFunnel("onboarding", STEPS, {
    workspaceId: WS,
    description: "test onboarding funnel",
    windowMs: 60_000,
  });
  assert.ok(f.id);
  assert.equal(f.name, "onboarding");
  assert.equal(f.workspaceId, WS);
  assert.equal(f.windowMs, 60_000);
  assert.equal(f.steps.length, 3);
  assert.equal(f.steps[0].name, "signup");
  assert.ok(f.createdAt);
});

test("defineFunnel rejects empty name", async () => {
  const r = await defineFunnel("", STEPS, { workspaceId: WS });
  assert.equal(r.code, "INVALID_INPUT");
});

test("defineFunnel rejects empty steps", async () => {
  const r = await defineFunnel("bad", [], { workspaceId: WS });
  assert.equal(r.code, "INVALID_INPUT");
});

test("defineFunnel rejects steps missing name or event", async () => {
  const r = await defineFunnel("bad", [{ name: "x" }], { workspaceId: WS });
  assert.equal(r.code, "INVALID_INPUT");
});

// --- trackFunnelEvent ---

test("trackFunnelEvent stores an event with timestamp", async () => {
  const ts = Date.now();
  const r = await trackFunnelEvent("user-1", "signup", { timestamp: ts, source: "web" });
  assert.equal(r.ok, true);
  assert.equal(r.timestamp, ts);
  assert.ok(r.id);
});

test("trackFunnelEvent rejects missing userId", async () => {
  const r = await trackFunnelEvent("", "signup", {});
  assert.equal(r.code, "INVALID_INPUT");
});

test("trackFunnelEvent rejects missing event", async () => {
  const r = await trackFunnelEvent("u1", "", {});
  assert.equal(r.code, "INVALID_INPUT");
});

// --- step matching ---

test("walkFunnelForUser matches steps in order, respecting timestamps", () => {
  const funnel = {
    steps: STEPS,
    windowMs: 60_000,
  };
  const userEvents = [
    { event: "signup", timestamp: 1000 },
    { event: "verify", timestamp: 2000 },
    { event: "first_chat", timestamp: 3000 },
  ];
  const reached = __test__.walkFunnelForUser(funnel, userEvents);
  assert.equal(reached.length, 3);
  assert.equal(reached[0].step, "signup");
  assert.equal(reached[2].step, "first_chat");
});

test("walkFunnelForUser stops at first missing step", () => {
  const funnel = { steps: STEPS, windowMs: 60_000 };
  const userEvents = [
    { event: "signup", timestamp: 1000 },
    { event: "first_chat", timestamp: 2000 }, // skipped verify
  ];
  const reached = __test__.walkFunnelForUser(funnel, userEvents);
  assert.equal(reached.length, 1);
  assert.equal(reached[0].step, "signup");
});

test("walkFunnelForUser enforces window relative to first step", () => {
  const funnel = { steps: STEPS, windowMs: 1000 };
  const userEvents = [
    { event: "signup", timestamp: 0 },
    { event: "verify", timestamp: 500 },
    { event: "first_chat", timestamp: 5000 }, // outside window
  ];
  const reached = __test__.walkFunnelForUser(funnel, userEvents);
  assert.equal(reached.length, 2);
});

test("matchCondition with simple equality", () => {
  assert.equal(__test__.matchCondition({ source: "web" }, { source: "web" }), true);
  assert.equal(__test__.matchCondition({ source: "web" }, { source: "ios" }), false);
});

test("matchCondition with gte/lte operators", () => {
  assert.equal(__test__.matchCondition({ count: { gte: 10 } }, { count: 12 }), true);
  assert.equal(__test__.matchCondition({ count: { gte: 10 } }, { count: 5 }), false);
});

// --- getFunnelStats ---

test("getFunnelStats computes conversion across users", async () => {
  const f = await defineFunnel("conv-test", STEPS, {
    workspaceId: WS,
    windowMs: 24 * 60 * 60 * 1000,
  });

  const baseTs = Date.now() - 1000 * 60 * 60; // one hour ago
  const dateRange = { from: baseTs - 1000, to: baseTs + 60_000 };

  // user A — completes all 3 steps
  await trackFunnelEvent("conv-uA", "signup", { timestamp: baseTs });
  await trackFunnelEvent("conv-uA", "verify", { timestamp: baseTs + 100 });
  await trackFunnelEvent("conv-uA", "first_chat", { timestamp: baseTs + 200 });

  // user B — completes 2
  await trackFunnelEvent("conv-uB", "signup", { timestamp: baseTs + 1 });
  await trackFunnelEvent("conv-uB", "verify", { timestamp: baseTs + 50 });

  // user C — only signup
  await trackFunnelEvent("conv-uC", "signup", { timestamp: baseTs + 2 });

  const stats = await getFunnelStats(f.id, dateRange);
  assert.equal(stats.total, 3);
  assert.equal(stats.steps[0].count, 3);
  assert.equal(stats.steps[1].count, 2);
  assert.equal(stats.steps[2].count, 1);
  assert.equal(stats.steps[1].conversionRate, 2 / 3);
  assert.equal(stats.steps[2].conversionRate, 1 / 2);
  assert.equal(stats.overallConversion, 1 / 3);
});

test("getFunnelStats avgTimeToStep is computed for downstream steps", async () => {
  const f = await defineFunnel("timing-test", STEPS, { workspaceId: WS });
  const baseTs = Date.now() - 1000 * 60 * 60 * 2;
  const dateRange = { from: baseTs - 1000, to: baseTs + 10_000 };
  await trackFunnelEvent("timing-ut1", "signup", { timestamp: baseTs });
  await trackFunnelEvent("timing-ut1", "verify", { timestamp: baseTs + 1000 });
  await trackFunnelEvent("timing-ut1", "first_chat", { timestamp: baseTs + 3000 });

  const stats = await getFunnelStats(f.id, dateRange);
  assert.equal(stats.steps[1].avgTimeToStep, 1000);
  assert.equal(stats.steps[2].avgTimeToStep, 2000);
});

test("getFunnelStats returns NOT_FOUND for unknown funnel", async () => {
  const r = await getFunnelStats("nonexistent-funnel-id");
  assert.equal(r.code, "NOT_FOUND");
});

// --- getDropoffUsers ---

test("getDropoffUsers returns users who reached but did not pass step", async () => {
  const f = await defineFunnel("drop-test", STEPS, { workspaceId: WS });
  const baseTs = Date.now() - 1000 * 60 * 60 * 3;
  const dateRange = { from: baseTs - 1000, to: baseTs + 10_000 };

  // dropoff at step 2 (verify): reaches verify, no first_chat
  await trackFunnelEvent("drop-dropA", "signup", { timestamp: baseTs });
  await trackFunnelEvent("drop-dropA", "verify", { timestamp: baseTs + 100 });

  // dropoff at step 1 (signup): never verified
  await trackFunnelEvent("drop-dropB", "signup", { timestamp: baseTs });

  // completes everything
  await trackFunnelEvent("drop-doneC", "signup", { timestamp: baseTs });
  await trackFunnelEvent("drop-doneC", "verify", { timestamp: baseTs + 100 });
  await trackFunnelEvent("drop-doneC", "first_chat", { timestamp: baseTs + 200 });

  const drop2 = await getDropoffUsers(f.id, 2, dateRange);
  assert.equal(drop2.droppedCount, 1);
  assert.equal(drop2.users[0].userId, "drop-dropA");
  assert.equal(drop2.stepName, "verify");
  assert.equal(drop2.nextStepName, "first_chat");

  const drop1 = await getDropoffUsers(f.id, 1, dateRange);
  assert.equal(drop1.droppedCount, 1);
  assert.equal(drop1.users[0].userId, "drop-dropB");
});

test("getDropoffUsers rejects invalid step index", async () => {
  const f = await defineFunnel("drop-invalid", STEPS, { workspaceId: WS });
  const r = await getDropoffUsers(f.id, 99);
  assert.equal(r.code, "INVALID_INPUT");
});

// --- getFunnelPathForUser ---

test("getFunnelPathForUser returns user progression", async () => {
  const f = await defineFunnel("path-test", STEPS, { workspaceId: WS });
  const baseTs = Date.now() - 1000 * 60 * 30;
  await trackFunnelEvent("pathUser", "signup", { timestamp: baseTs });
  await trackFunnelEvent("pathUser", "verify", { timestamp: baseTs + 100 });

  const path = await getFunnelPathForUser(f.id, "pathUser");
  assert.equal(path.userId, "pathUser");
  assert.equal(path.reached.length, 2);
  assert.equal(path.completed, false);
  assert.equal(path.currentStep, "verify");
  assert.ok(path.progress > 0 && path.progress < 1);
});

test("getFunnelPathForUser flags completed when all steps reached", async () => {
  const f = await defineFunnel("path-done", STEPS, { workspaceId: WS });
  const baseTs = Date.now() - 1000 * 60 * 30;
  await trackFunnelEvent("doneUser", "signup", { timestamp: baseTs });
  await trackFunnelEvent("doneUser", "verify", { timestamp: baseTs + 100 });
  await trackFunnelEvent("doneUser", "first_chat", { timestamp: baseTs + 200 });

  const path = await getFunnelPathForUser(f.id, "doneUser");
  assert.equal(path.completed, true);
  assert.equal(path.progress, 1);
});

// --- listFunnels / deleteFunnel ---

test("listFunnels returns funnels for workspace", async () => {
  const ws = "list-ws";
  await defineFunnel("ll1", STEPS, { workspaceId: ws });
  await defineFunnel("ll2", STEPS, { workspaceId: ws });
  const list = await listFunnels(ws);
  assert.ok(list.length >= 2);
  assert.ok(list.every((f) => f.workspaceId === ws));
});

test("deleteFunnel removes a funnel", async () => {
  const f = await defineFunnel("to-delete", STEPS, { workspaceId: WS });
  const r = await deleteFunnel(f.id);
  assert.equal(r.ok, true);
  const after = await getFunnel(f.id);
  assert.equal(after.code, "NOT_FOUND");
});

test("deleteFunnel returns NOT_FOUND for unknown funnel", async () => {
  const r = await deleteFunnel("nonexistent");
  assert.equal(r.code, "NOT_FOUND");
});

// --- pre-defined funnels ---

test("seedPredefinedFunnels creates the three pre-defined funnels", async () => {
  const ws = "predef-ws";
  const created = await seedPredefinedFunnels(ws);
  assert.equal(created.length, 3);
  const names = new Set(created.map((f) => f.name));
  assert.ok(names.has("signup_to_first_chat"));
  assert.ok(names.has("chat_to_upgrade"));
  assert.ok(names.has("knowledge_adoption"));
});

test("seedPredefinedFunnels is idempotent — does not duplicate", async () => {
  const ws = "predef-idempotent";
  await seedPredefinedFunnels(ws);
  const second = await seedPredefinedFunnels(ws);
  assert.equal(second.length, 0);
  const all = await listFunnels(ws);
  assert.equal(all.length, 3);
});

test("PREDEFINED_FUNNELS shape matches the documented signup_to_first_chat", () => {
  const f = PREDEFINED_FUNNELS.signup_to_first_chat;
  assert.ok(f);
  assert.equal(f.steps.length, 3);
  assert.equal(f.steps[0].event, "signup");
  assert.equal(f.steps[2].event, "first_chat");
});

test("PREDEFINED_FUNNELS knowledge_adoption walks signup -> add_document -> search_knowledge -> use_in_chat", () => {
  const f = PREDEFINED_FUNNELS.knowledge_adoption;
  const events = f.steps.map((s) => s.event);
  assert.deepEqual(events, ["signup", "add_document", "search_knowledge", "use_in_chat"]);
});
