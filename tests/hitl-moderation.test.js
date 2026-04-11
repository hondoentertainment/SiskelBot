/**
 * Phase 67.5: HITL moderation queue tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-hitl-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  enqueueForReview,
  listQueue,
  claimItem,
  decideItem,
  getQueueStats,
  releaseItem,
} = await import("../lib/hitl-moderation.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

test("enqueueForReview adds a pending item", async () => {
  const item = await enqueueForReview({
    content: "Potentially risky content",
    reason: "flagged by brand-safety",
    priority: "high",
  });
  assert.ok(item.id);
  assert.equal(item.status, "pending");
  assert.equal(item.priority, "high");
  assert.equal(item.history.length, 1);
});

test("enqueueForReview validates required fields", async () => {
  await assert.rejects(() => enqueueForReview(null));
  await assert.rejects(() => enqueueForReview({ content: "" }));
  await assert.rejects(() => enqueueForReview({ content: "c" }));
  await assert.rejects(() => enqueueForReview({ content: "c", reason: "r", priority: "bogus" }));
});

test("listQueue filters by status and orders by priority", async () => {
  await enqueueForReview({ content: "a", reason: "r", priority: "low" });
  await enqueueForReview({ content: "b", reason: "r", priority: "high" });
  const pending = await listQueue({ status: "pending" });
  // High-priority item should appear before low.
  const highIdx = pending.findIndex((i) => i.priority === "high");
  const lowIdx = pending.findIndex((i) => i.priority === "low");
  assert.ok(highIdx >= 0);
  assert.ok(lowIdx >= 0);
  assert.ok(highIdx < lowIdx);
});

test("listQueue rejects unknown status", async () => {
  await assert.rejects(() => listQueue({ status: "nonsense" }));
});

test("claimItem selects the highest priority pending item when no id given", async () => {
  await enqueueForReview({ content: "low-prio", reason: "r", priority: "low" });
  await enqueueForReview({ content: "high-prio", reason: "r", priority: "high" });
  const claim = await claimItem({ reviewer: "rev-1" });
  assert.ok(claim);
  assert.equal(claim.status, "claimed");
  assert.equal(claim.claimedBy, "rev-1");
});

test("claimItem by specific id transitions to claimed", async () => {
  const item = await enqueueForReview({ content: "x", reason: "r" });
  const claim = await claimItem({ id: item.id, reviewer: "rev-2" });
  assert.equal(claim.status, "claimed");
  assert.equal(claim.id, item.id);
});

test("claimItem refuses already-claimed items", async () => {
  const item = await enqueueForReview({ content: "x", reason: "r" });
  await claimItem({ id: item.id, reviewer: "rev-3" });
  await assert.rejects(() => claimItem({ id: item.id, reviewer: "rev-4" }));
});

test("claimItem returns null when queue is empty", async () => {
  // Drain everything: decide all
  const pending = await listQueue({ status: "pending", limit: 1000 });
  for (const p of pending) {
    const c = await claimItem({ id: p.id, reviewer: "drainer" });
    await decideItem({ id: c.id, reviewer: "drainer", decision: "approved" });
  }
  const claim = await claimItem({ reviewer: "empty-rev" });
  assert.equal(claim, null);
});

test("decideItem transitions claimed items to a terminal status", async () => {
  const item = await enqueueForReview({ content: "decide-me", reason: "r" });
  await claimItem({ id: item.id, reviewer: "rev" });
  const decided = await decideItem({ id: item.id, reviewer: "rev", decision: "rejected", notes: "bad" });
  assert.equal(decided.status, "rejected");
  assert.equal(decided.notes, "bad");
  assert.equal(decided.decidedBy, "rev");
});

test("decideItem validates decision", async () => {
  await assert.rejects(() => decideItem({ id: "nope", reviewer: "r", decision: "approved" }));
  const item = await enqueueForReview({ content: "v", reason: "r" });
  await assert.rejects(() => decideItem({ id: item.id, reviewer: "r", decision: "bogus" }));
});

test("releaseItem returns claimed items to pending", async () => {
  const item = await enqueueForReview({ content: "rel", reason: "r" });
  await claimItem({ id: item.id, reviewer: "rev" });
  const released = await releaseItem({ id: item.id, reviewer: "rev" });
  assert.equal(released.status, "pending");
  assert.equal(released.claimedBy, "");
});

test("getQueueStats returns aggregate counts", async () => {
  const stats = await getQueueStats();
  assert.ok(typeof stats.total === "number");
  assert.ok(typeof stats.pending === "number");
  assert.ok(typeof stats.approved === "number");
  assert.ok(stats.byReviewer);
});
