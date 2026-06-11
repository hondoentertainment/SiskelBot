/**
 * Freemium trial tests: start/get/end, one-per-workspace, and plan resolution
 * honoring an active trial. Uses a temp STORAGE_PATH.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "siskelbot-trials-"));
process.env.STORAGE_PATH = tempDir;

test.after(() => {
  try {
    rmSync(tempDir, { recursive: true });
  } catch (_) {}
});

test("startTrial grants the upgraded plan and reports days remaining", async () => {
  const { startTrial, getTrial } = await import("../lib/trials.js");
  const res = await startTrial("trial-ws", { plan: "pro", days: 14 });
  assert.equal(res.ok, true);
  assert.equal(res.trial.plan, "pro");
  assert.equal(res.trial.active, true);
  assert.ok(res.trial.daysRemaining >= 13 && res.trial.daysRemaining <= 14);

  const status = await getTrial("trial-ws");
  assert.equal(status.active, true);
});

test("only one trial per workspace", async () => {
  const { startTrial } = await import("../lib/trials.js");
  const again = await startTrial("trial-ws", { plan: "pro" });
  assert.equal(again.ok, false);
  assert.match(again.error, /already/i);
});

test("startTrial rejects an unknown plan", async () => {
  const { startTrial } = await import("../lib/trials.js");
  const res = await startTrial("bad-trial-ws", { plan: "platinum" });
  assert.equal(res.ok, false);
});

test("getPlan resolves to the trial plan while active", async () => {
  const { startTrial } = await import("../lib/trials.js");
  const { getPlan } = await import("../lib/plans.js");

  const before = await getPlan("plan-trial-ws");
  assert.equal(before.id, "free");

  await startTrial("plan-trial-ws", { plan: "pro", days: 7 });
  const during = await getPlan("plan-trial-ws");
  assert.equal(during.id, "pro");
  assert.equal(during.maxMembers, 20);
});

test("an expired trial does not upgrade the plan", async () => {
  const { startTrial } = await import("../lib/trials.js");
  const { getPlan } = await import("../lib/plans.js");
  // 0-day clamps to 1 day minimum, so simulate expiry by starting then ending.
  await startTrial("expired-ws", { plan: "pro", days: 1 });
  const { endTrial } = await import("../lib/trials.js");
  await endTrial("expired-ws");
  const after = await getPlan("expired-ws");
  assert.equal(after.id, "free", "ended trial should revert to free");
});

test("entitlements reflect the trial plan's seats and features", async () => {
  const { startTrial } = await import("../lib/trials.js");
  const { getEntitlements, checkFeature } = await import("../lib/entitlements.js");
  await startTrial("ent-trial-ws", { plan: "pro" });

  const ent = await getEntitlements("ent-trial-ws");
  assert.equal(ent.planId, "pro");
  assert.equal(ent.maxMembers, 20);

  const feat = await checkFeature("ent-trial-ws", "workflows");
  assert.equal(feat.allowed, true, "trial grants Pro features");
});
