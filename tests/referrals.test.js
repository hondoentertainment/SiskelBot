/**
 * Tests for lib/referrals.js — Phase 34.5 affiliate/referral system.
 *
 * Each test suite uses a unique STORAGE_PATH (set before importing the module)
 * so that referral state is isolated from other tests and from prior runs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_ROOT = mkdtempSync(join(tmpdir(), "siskelbot-referrals-"));
process.env.STORAGE_PATH = TMP_ROOT;
process.env.PUBLIC_BASE_URL = "https://siskel.test";

const {
  createReferralCode,
  listUserReferralCodes,
  getReferralCode,
  deactivateReferralCode,
  recordReferralSignup,
  recordReferralConversion,
  getReferralStats,
  getTopReferrers,
  getReferralLeaderboard,
  calculateRewards,
  REFERRAL_CONSTANTS,
} = await import("../lib/referrals.js");

test.after(() => {
  try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch (_) {}
});

// ─── createReferralCode ──────────────────────────────────────────────

test("createReferralCode generates unique URL-safe codes", async () => {
  const a = await createReferralCode("user-a", { name: "Twitter campaign" });
  const b = await createReferralCode("user-a");
  assert.ok(a.code, "code is set");
  assert.ok(b.code);
  assert.notEqual(a.code, b.code, "codes are unique");
  assert.ok(a.url.startsWith("https://siskel.test/r/"), "URL contains base + /r/");
  assert.equal(a.url, `https://siskel.test/r/${a.code}`);
  assert.equal(a.name, "Twitter campaign");
  assert.equal(a.uses, 0);
  assert.equal(a.deactivated, false);
});

test("createReferralCode requires userId", async () => {
  await assert.rejects(() => createReferralCode(""), { message: "userId is required" });
  await assert.rejects(() => createReferralCode(null), { message: "userId is required" });
});

test("createReferralCode honors expiresAt and maxUses", async () => {
  const future = new Date(Date.now() + 86400_000).toISOString();
  const c = await createReferralCode("user-meta", { expiresAt: future, maxUses: 3 });
  assert.equal(c.maxUses, 3);
  assert.equal(c.expiresAt, future);
});

test("createReferralCode enforces per-user max codes", async () => {
  const u = "user-bulk";
  const max = REFERRAL_CONSTANTS.MAX_CODES_PER_USER;
  for (let i = 0; i < max; i++) {
    await createReferralCode(u);
  }
  await assert.rejects(() => createReferralCode(u), /Maximum referral codes/);
});

// ─── listUserReferralCodes ───────────────────────────────────────────

test("listUserReferralCodes returns only the caller's codes", async () => {
  await createReferralCode("user-list-1");
  await createReferralCode("user-list-1");
  await createReferralCode("user-list-2");
  const codes1 = await listUserReferralCodes("user-list-1");
  const codes2 = await listUserReferralCodes("user-list-2");
  assert.equal(codes1.length, 2);
  assert.equal(codes2.length, 1);
  for (const c of codes1) assert.equal(c.userId, "user-list-1");
});

// ─── getReferralCode ─────────────────────────────────────────────────

test("getReferralCode returns null for unknown codes", async () => {
  const c = await getReferralCode("DOES_NOT_EXIST");
  assert.equal(c, null);
});

test("getReferralCode returns active=true for fresh codes", async () => {
  const created = await createReferralCode("user-get");
  const fetched = await getReferralCode(created.code);
  assert.ok(fetched);
  assert.equal(fetched.active, true);
});

// ─── deactivateReferralCode ──────────────────────────────────────────

test("deactivateReferralCode marks code inactive", async () => {
  const c = await createReferralCode("user-deact");
  const result = await deactivateReferralCode(c.code, "user-deact");
  assert.equal(result.deactivated, true);
  const fetched = await getReferralCode(c.code);
  assert.equal(fetched.deactivated, true);
  assert.equal(fetched.active, false);
});

test("deactivateReferralCode rejects non-owners", async () => {
  const c = await createReferralCode("user-owner");
  await assert.rejects(
    () => deactivateReferralCode(c.code, "user-attacker"),
    /Not authorized/,
  );
});

test("deactivateReferralCode rejects unknown codes", async () => {
  await assert.rejects(
    () => deactivateReferralCode("UNKNOWN1", "user-x"),
    /not found/,
  );
});

// ─── recordReferralSignup ────────────────────────────────────────────

test("recordReferralSignup increments uses and credits referrer", async () => {
  const code = await createReferralCode("referrer-1");
  const result = await recordReferralSignup(code.code, "referee-1");
  assert.ok(result.referralId);
  assert.equal(result.referrerId, "referrer-1");
  assert.equal(result.refereeId, "referee-1");

  const updated = await getReferralCode(code.code);
  assert.equal(updated.uses, 1);

  // signup conversion should be recorded automatically
  const stats = await getReferralStats("referrer-1");
  assert.equal(stats.totalReferrals, 1);
  assert.equal(stats.conversions.signup, 1);
});

test("recordReferralSignup rejects self-referral", async () => {
  const code = await createReferralCode("user-self");
  await assert.rejects(
    () => recordReferralSignup(code.code, "user-self"),
    /self-refer/,
  );
});

test("recordReferralSignup rejects deactivated codes", async () => {
  const code = await createReferralCode("user-inactive");
  await deactivateReferralCode(code.code, "user-inactive");
  await assert.rejects(
    () => recordReferralSignup(code.code, "new-user"),
    /not active/,
  );
});

test("recordReferralSignup rejects duplicate signup for same code/user", async () => {
  const code = await createReferralCode("user-dup");
  await recordReferralSignup(code.code, "referee-dup");
  await assert.rejects(
    () => recordReferralSignup(code.code, "referee-dup"),
    /already recorded/,
  );
  // Uses should be back to 1, not 2 (rollback).
  const after = await getReferralCode(code.code);
  assert.equal(after.uses, 1);
});

// ─── max uses enforcement ────────────────────────────────────────────

test("recordReferralSignup enforces maxUses", async () => {
  const code = await createReferralCode("user-cap", { maxUses: 2 });
  await recordReferralSignup(code.code, "ref-cap-1");
  await recordReferralSignup(code.code, "ref-cap-2");
  await assert.rejects(
    () => recordReferralSignup(code.code, "ref-cap-3"),
    /not active/,
  );
});

// ─── conversion events ──────────────────────────────────────────────

test("recordReferralConversion stores valid events", async () => {
  const code = await createReferralCode("conv-user");
  const signup = await recordReferralSignup(code.code, "referee-conv");
  const upgrade = await recordReferralConversion(signup.referralId, "plan_upgrade", 50);
  assert.equal(upgrade.event, "plan_upgrade");
  assert.equal(upgrade.value, 50);
  assert.ok(upgrade.id);
});

test("recordReferralConversion rejects invalid event names", async () => {
  await assert.rejects(
    () => recordReferralConversion("ref_x", "bogus"),
    /Invalid event/,
  );
});

// ─── calculateRewards ────────────────────────────────────────────────

test("calculateRewards: signup gives $5 credit, plan_upgrade gives 20% cash", async () => {
  const code = await createReferralCode("rewards-user");
  const sig1 = await recordReferralSignup(code.code, "rewards-referee-1");
  const sig2 = await recordReferralSignup(code.code, "rewards-referee-2");
  // upgrade events on each
  await recordReferralConversion(sig1.referralId, "plan_upgrade", 100);
  await recordReferralConversion(sig2.referralId, "plan_upgrade", 50);

  const r = await calculateRewards("rewards-user");
  // 2 signups × $5 credit = $10
  assert.equal(r.credits, 10);
  // (100 + 50) × 20% = $30 cash
  assert.equal(r.cash, 30);
  assert.equal(r.totalValue, 40);
});

test("calculateRewards returns zero for unknown user", async () => {
  const r = await calculateRewards("unknown-user-xyz");
  assert.deepEqual(r, { credits: 0, cash: 0, totalValue: 0 });
});

// ─── getReferralStats ────────────────────────────────────────────────

test("getReferralStats counts active referrals (those with non-signup conversions)", async () => {
  const code = await createReferralCode("stats-user");
  const a = await recordReferralSignup(code.code, "stats-ref-a");
  const b = await recordReferralSignup(code.code, "stats-ref-b");
  await recordReferralSignup(code.code, "stats-ref-c");
  // Only a and b have post-signup activity
  await recordReferralConversion(a.referralId, "first_chat");
  await recordReferralConversion(b.referralId, "plan_upgrade", 10);

  const stats = await getReferralStats("stats-user");
  assert.equal(stats.totalReferrals, 3);
  assert.equal(stats.activeReferrals, 2);
  assert.equal(stats.conversions.signup, 3);
  assert.ok(stats.earnings >= 15); // 3 × $5 credit + 20% × $10 = $17
});

// ─── leaderboard ─────────────────────────────────────────────────────

test("getTopReferrers and leaderboard sort by conversions descending", async () => {
  // Three users with varying activity.
  const u1 = "lb-user-1", u2 = "lb-user-2", u3 = "lb-user-3";
  const c1 = await createReferralCode(u1);
  const c2 = await createReferralCode(u2);
  const c3 = await createReferralCode(u3);

  // u2 gets the most conversions.
  for (let i = 0; i < 3; i++) {
    await recordReferralSignup(c2.code, `lb-r2-${i}`);
  }
  // u1 gets two
  for (let i = 0; i < 2; i++) {
    await recordReferralSignup(c1.code, `lb-r1-${i}`);
  }
  // u3 gets one
  await recordReferralSignup(c3.code, "lb-r3-0");

  const top = await getTopReferrers(10);
  // Find positions of u1/u2/u3 in the top list.
  const pos2 = top.findIndex((r) => r.userId === u2);
  const pos1 = top.findIndex((r) => r.userId === u1);
  const pos3 = top.findIndex((r) => r.userId === u3);
  assert.ok(pos2 >= 0 && pos1 >= 0 && pos3 >= 0);
  assert.ok(pos2 < pos1, "u2 ranks above u1");
  assert.ok(pos1 < pos3, "u1 ranks above u3");
});

test("getReferralLeaderboard accepts valid periods", async () => {
  const board7 = await getReferralLeaderboard("7d");
  const board30 = await getReferralLeaderboard("30d");
  const boardAll = await getReferralLeaderboard("all");
  assert.ok(Array.isArray(board7));
  assert.ok(Array.isArray(board30));
  assert.ok(Array.isArray(boardAll));
  // 'all' should include at least as many entries as 30d
  assert.ok(boardAll.length >= board30.length);
});
