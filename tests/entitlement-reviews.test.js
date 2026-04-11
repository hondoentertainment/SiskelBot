/**
 * Tests for Phase 46.5 entitlement reviews (lib/entitlement-reviews.js).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "siskelbot-entitlement-"));
process.env.STORAGE_PATH = tempDir;

// Seed a couple of fake users + workspaces so listAllUsers returns rows.
mkdirSync(join(tempDir, "users", "alice"), { recursive: true });
mkdirSync(join(tempDir, "users", "bob"), { recursive: true });
mkdirSync(join(tempDir, "users", "carol"), { recursive: true });
writeFileSync(
  join(tempDir, "workspace-members.json"),
  JSON.stringify({
    _version: 1,
    items: {
      "ws-eng": {
        ownerId: "alice",
        members: [
          { userId: "alice", role: "admin", joinedAt: "2025-01-01T00:00:00Z" },
          { userId: "bob", role: "member", joinedAt: "2025-02-01T00:00:00Z" },
          { userId: "carol", role: "viewer", joinedAt: "2025-03-01T00:00:00Z" },
        ],
      },
    },
  })
);

const {
  createReview,
  listReviews,
  getReview,
  getReviewItems,
  approveAccess,
  revokeAccess,
  requestChange,
  completeReview,
  getReviewReport,
  getOverdueReviews,
  sendReviewReminders,
  scheduleRecurringReview,
  listRecurringSchedules,
  _resetForTests,
} = await import("../lib/entitlement-reviews.js");

test.after(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch (_) {}
});

function futureIso(daysFromNow = 30) {
  return new Date(Date.now() + daysFromNow * 24 * 60 * 60 * 1000).toISOString();
}

function pastIso(daysAgo = 1) {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
}

// ─── Creation ──────────────────────────────────────────────────────────────

test("createReview creates a review with items", async () => {
  await _resetForTests();
  const review = await createReview({
    name: "Test review",
    scope: "all_users",
    reviewers: ["admin@example.com"],
    dueDate: futureIso(),
  });
  assert.ok(review.id.startsWith("rev_"));
  assert.equal(review.name, "Test review");
  assert.equal(review.scope, "all_users");
  assert.equal(review.status, "open");
  assert.ok(review.items.length >= 3, "expected at least 3 items from seeded users");
  assert.equal(review.summary.pending, review.items.length);
  assert.equal(review.summary.approved, 0);
});

test("createReview validates required fields", async () => {
  await assert.rejects(
    () => createReview({ scope: "all_users", reviewers: ["a"], dueDate: futureIso() }),
    /name/
  );
  await assert.rejects(
    () => createReview({ name: "x", reviewers: ["a"], dueDate: futureIso() }),
    /scope/
  );
  await assert.rejects(
    () => createReview({ name: "x", scope: "bad", reviewers: ["a"], dueDate: futureIso() }),
    /scope/
  );
  await assert.rejects(
    () => createReview({ name: "x", scope: "all_users", reviewers: [], dueDate: futureIso() }),
    /reviewers/
  );
  await assert.rejects(
    () => createReview({ name: "x", scope: "all_users", reviewers: ["a"] }),
    /dueDate/
  );
});

test("createReview supports workspace scope", async () => {
  await _resetForTests();
  const review = await createReview({
    name: "Eng workspace review",
    scope: "workspace",
    scopeFilter: { workspaceId: "ws-eng" },
    reviewers: ["admin@example.com"],
    dueDate: futureIso(),
  });
  assert.ok(review.items.length >= 3);
  for (const item of review.items) {
    assert.equal(item.workspaces[0].id, "ws-eng");
  }
});

test("createReview supports role scope", async () => {
  await _resetForTests();
  const review = await createReview({
    name: "Admins review",
    scope: "role",
    scopeFilter: { role: "admin" },
    reviewers: ["admin@example.com"],
    dueDate: futureIso(),
  });
  // Only alice has the admin role
  assert.ok(review.items.some((it) => it.userId === "alice"));
});

test("createReview supports specific users scope", async () => {
  await _resetForTests();
  const review = await createReview({
    name: "Specific users",
    scope: "users",
    scopeFilter: { userIds: ["alice", "bob"] },
    reviewers: ["admin@example.com"],
    dueDate: futureIso(),
  });
  assert.equal(review.items.length, 2);
  const ids = review.items.map((it) => it.userId).sort();
  assert.deepEqual(ids, ["alice", "bob"]);
});

// ─── Listing ───────────────────────────────────────────────────────────────

test("listReviews returns all reviews", async () => {
  await _resetForTests();
  await createReview({
    name: "R1",
    scope: "all_users",
    reviewers: ["a"],
    dueDate: futureIso(),
  });
  await createReview({
    name: "R2",
    scope: "all_users",
    reviewers: ["a"],
    dueDate: futureIso(),
  });
  const all = await listReviews();
  assert.equal(all.length, 2);
});

test("listReviews filters by status", async () => {
  await _resetForTests();
  const r = await createReview({
    name: "R-open",
    scope: "all_users",
    reviewers: ["a"],
    dueDate: futureIso(),
  });
  const open = await listReviews("open");
  assert.equal(open.length, 1);
  const completed = await listReviews("completed");
  assert.equal(completed.length, 0);
  // sanity that the same id is returned
  assert.equal(open[0].id, r.id);
});

// ─── Decision tracking ────────────────────────────────────────────────────

test("approveAccess marks an item approved", async () => {
  await _resetForTests();
  const review = await createReview({
    name: "Approve test",
    scope: "users",
    scopeFilter: { userIds: ["alice", "bob"] },
    reviewers: ["admin@example.com"],
    dueDate: futureIso(),
  });
  const item = await approveAccess(review.id, "alice", "admin@example.com", "Looks good");
  assert.equal(item.decision, "approved");
  assert.equal(item.reviewedBy, "admin@example.com");
  assert.equal(item.comment, "Looks good");

  const fresh = await getReview(review.id);
  assert.equal(fresh.summary.approved, 1);
  assert.equal(fresh.summary.pending, 1);
});

test("revokeAccess marks an item revoked", async () => {
  await _resetForTests();
  const review = await createReview({
    name: "Revoke test",
    scope: "users",
    scopeFilter: { userIds: ["bob"] },
    reviewers: ["admin@example.com"],
    dueDate: futureIso(),
  });
  await revokeAccess(review.id, "bob", "admin@example.com", "no longer with team");
  const fresh = await getReview(review.id);
  assert.equal(fresh.summary.revoked, 1);
  assert.equal(fresh.summary.pending, 0);
});

test("requestChange marks an item changed with new role", async () => {
  await _resetForTests();
  const review = await createReview({
    name: "Change test",
    scope: "users",
    scopeFilter: { userIds: ["carol"] },
    reviewers: ["admin@example.com"],
    dueDate: futureIso(),
  });
  await requestChange(review.id, "carol", "member", "admin@example.com", "promote");
  const fresh = await getReview(review.id);
  assert.equal(fresh.summary.changed, 1);
  assert.equal(fresh.items[0].newRole, "member");
});

test("requestChange requires newRole", async () => {
  await _resetForTests();
  const review = await createReview({
    name: "Change validation",
    scope: "users",
    scopeFilter: { userIds: ["alice"] },
    reviewers: ["admin@example.com"],
    dueDate: futureIso(),
  });
  await assert.rejects(
    () => requestChange(review.id, "alice", null, "admin@example.com"),
    /newRole/
  );
});

test("decisions reject unauthorized reviewers", async () => {
  await _resetForTests();
  const review = await createReview({
    name: "Auth test",
    scope: "users",
    scopeFilter: { userIds: ["alice"] },
    reviewers: ["admin@example.com"],
    dueDate: futureIso(),
  });
  await assert.rejects(
    () => approveAccess(review.id, "alice", "stranger@example.com"),
    /not authorized/
  );
});

test("decisions reject unknown user", async () => {
  await _resetForTests();
  const review = await createReview({
    name: "Unknown user",
    scope: "users",
    scopeFilter: { userIds: ["alice"] },
    reviewers: ["admin@example.com"],
    dueDate: futureIso(),
  });
  await assert.rejects(
    () => approveAccess(review.id, "ghost", "admin@example.com"),
    /not in review/
  );
});

// ─── Items ────────────────────────────────────────────────────────────────

test("getReviewItems returns items for an existing review", async () => {
  await _resetForTests();
  const review = await createReview({
    name: "Items test",
    scope: "users",
    scopeFilter: { userIds: ["alice"] },
    reviewers: ["admin@example.com"],
    dueDate: futureIso(),
  });
  const items = await getReviewItems(review.id);
  assert.equal(items.length, 1);
});

test("getReviewItems returns null for missing review", async () => {
  const items = await getReviewItems("rev_does_not_exist");
  assert.equal(items, null);
});

// ─── Completion ────────────────────────────────────────────────────────────

test("completeReview applies all pending decisions", async () => {
  await _resetForTests();
  const review = await createReview({
    name: "Complete test",
    scope: "users",
    scopeFilter: { userIds: ["alice", "bob", "carol"] },
    reviewers: ["admin@example.com"],
    dueDate: futureIso(),
  });
  await approveAccess(review.id, "alice", "admin@example.com");
  await revokeAccess(review.id, "bob", "admin@example.com");
  await requestChange(review.id, "carol", "member", "admin@example.com");

  const result = await completeReview(review.id, "admin@example.com");
  assert.equal(result.totalReviewed, 3);
  assert.equal(result.approved, 1);
  assert.equal(result.revoked, 1);
  assert.equal(result.changed, 1);

  const fresh = await getReview(review.id);
  assert.equal(fresh.status, "completed");
  assert.ok(fresh.completedAt);
});

test("completeReview leaves pending alone when autoRevoke disabled", async () => {
  await _resetForTests();
  const review = await createReview({
    name: "No auto revoke",
    scope: "users",
    scopeFilter: { userIds: ["alice", "bob"] },
    reviewers: ["admin@example.com"],
    dueDate: futureIso(),
    autoRevokeOnNoAction: false,
  });
  await approveAccess(review.id, "alice", "admin@example.com");
  const result = await completeReview(review.id);
  assert.equal(result.approved, 1);
  assert.equal(result.totalReviewed, 1);
  assert.equal(result.revoked, 0);
});

test("completeReview auto-revokes pending when configured", async () => {
  await _resetForTests();
  const review = await createReview({
    name: "Auto revoke",
    scope: "users",
    scopeFilter: { userIds: ["alice", "bob"] },
    reviewers: ["admin@example.com"],
    dueDate: futureIso(),
    autoRevokeOnNoAction: true,
  });
  await approveAccess(review.id, "alice", "admin@example.com");
  const result = await completeReview(review.id);
  assert.equal(result.approved, 1);
  assert.equal(result.revoked, 1);
  assert.equal(result.totalReviewed, 2);
});

test("completeReview rejects already-completed reviews", async () => {
  await _resetForTests();
  const review = await createReview({
    name: "Double complete",
    scope: "users",
    scopeFilter: { userIds: ["alice"] },
    reviewers: ["admin@example.com"],
    dueDate: futureIso(),
  });
  await approveAccess(review.id, "alice", "admin@example.com");
  await completeReview(review.id);
  await assert.rejects(() => completeReview(review.id), /already/);
});

// ─── Reports ───────────────────────────────────────────────────────────────

test("getReviewReport produces audit-ready report", async () => {
  await _resetForTests();
  const review = await createReview({
    name: "Report test",
    scope: "users",
    scopeFilter: { userIds: ["alice", "bob"] },
    reviewers: ["admin@example.com"],
    dueDate: futureIso(),
  });
  await approveAccess(review.id, "alice", "admin@example.com", "ok");
  await revokeAccess(review.id, "bob", "admin@example.com", "off-board");

  const report = await getReviewReport(review.id);
  assert.equal(report.reviewId, review.id);
  assert.equal(report.name, "Report test");
  assert.equal(report.decisions.approved, 1);
  assert.equal(report.decisions.revoked, 1);
  assert.equal(report.decisions.pending, 0);
  assert.equal(report.reviewerActivity["admin@example.com"], 2);
  assert.ok(Array.isArray(report.auditTrail));
  assert.equal(report.auditTrail.length, 2);
  assert.ok(report.generatedAt);
});

test("getReviewReport returns null for missing review", async () => {
  const report = await getReviewReport("rev_missing");
  assert.equal(report, null);
});

// ─── Overdue ───────────────────────────────────────────────────────────────

test("getOverdueReviews returns open reviews past their dueDate", async () => {
  await _resetForTests();
  await createReview({
    name: "Overdue 1",
    scope: "users",
    scopeFilter: { userIds: ["alice"] },
    reviewers: ["a"],
    dueDate: pastIso(2),
  });
  await createReview({
    name: "Future",
    scope: "users",
    scopeFilter: { userIds: ["bob"] },
    reviewers: ["a"],
    dueDate: futureIso(30),
  });
  const overdue = await getOverdueReviews();
  assert.equal(overdue.length, 1);
  assert.equal(overdue[0].name, "Overdue 1");
});

test("getOverdueReviews skips completed reviews", async () => {
  await _resetForTests();
  const r = await createReview({
    name: "Was overdue",
    scope: "users",
    scopeFilter: { userIds: ["alice"] },
    reviewers: ["a"],
    dueDate: pastIso(2),
  });
  await approveAccess(r.id, "alice", "a");
  await completeReview(r.id);
  const overdue = await getOverdueReviews();
  assert.equal(overdue.length, 0);
});

// ─── Reminders ─────────────────────────────────────────────────────────────

test("sendReviewReminders reports per-reviewer status", async () => {
  await _resetForTests();
  const review = await createReview({
    name: "Reminders",
    scope: "users",
    scopeFilter: { userIds: ["alice"] },
    reviewers: ["a@example.com", "b@example.com"],
    dueDate: futureIso(),
  });
  const result = await sendReviewReminders(review.id);
  assert.equal(result.reviewId, review.id);
  assert.equal(result.sent, 2);
  assert.deepEqual(result.reviewers, ["a@example.com", "b@example.com"]);
});

test("sendReviewReminders rejects missing review", async () => {
  await assert.rejects(() => sendReviewReminders("rev_missing"), /not found/);
});

// ─── Recurring schedules ──────────────────────────────────────────────────

test("scheduleRecurringReview creates schedule and first review", async () => {
  await _resetForTests();
  const result = await scheduleRecurringReview({
    name: "Quarterly review",
    scope: "users",
    scopeFilter: { userIds: ["alice", "bob"] },
    reviewers: ["admin@example.com"],
    frequency: "quarterly",
  });
  assert.ok(result.schedule.id.startsWith("recur_"));
  assert.equal(result.schedule.frequency, "quarterly");
  assert.ok(result.firstReview.id.startsWith("rev_"));
  assert.equal(result.firstReview.items.length, 2);

  const schedules = await listRecurringSchedules();
  assert.equal(schedules.length, 1);
  assert.equal(schedules[0].lastReviewId, result.firstReview.id);
});

test("scheduleRecurringReview validates frequency", async () => {
  await assert.rejects(
    () =>
      scheduleRecurringReview({
        name: "x",
        scope: "all_users",
        reviewers: ["a"],
        frequency: "weekly",
      }),
    /frequency/
  );
});

test("completing a recurring review auto-schedules the next one", async () => {
  await _resetForTests();
  const { schedule, firstReview } = await scheduleRecurringReview({
    name: "Monthly",
    scope: "users",
    scopeFilter: { userIds: ["alice"] },
    reviewers: ["admin@example.com"],
    frequency: "monthly",
  });
  await approveAccess(firstReview.id, "alice", "admin@example.com");
  await completeReview(firstReview.id);

  // The schedule should now point at a new review, not the completed one
  const schedules = await listRecurringSchedules();
  assert.equal(schedules.length, 1);
  assert.notEqual(schedules[0].lastReviewId, firstReview.id);

  const all = await listReviews();
  assert.equal(all.length, 2);
  const open = await listReviews("open");
  assert.equal(open.length, 1);
  assert.equal(open[0].id, schedules[0].lastReviewId);
  assert.equal(open[0].name, "Monthly");
  // Just sanity-check we have a schedule reference
  assert.ok(schedule.id);
});
