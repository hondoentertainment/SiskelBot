/**
 * Phase 67.5: HITL moderation queue tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-hitl-moderation-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  enqueue,
  getItem,
  listQueue,
  claimItem,
  decideItem,
  releaseClaim,
  STATE_PENDING,
  STATE_UNDER_REVIEW,
  STATE_DECIDED,
  DECISION_ALLOW,
  DECISION_REJECT,
  DECISION_ESCALATE,
} = await import("../lib/hitl-moderation.js");

test.after(() => {
  try { rmSync(TMP_DATA_DIR, { recursive: true, force: true }); } catch (_) {}
});

test("enqueue validates kind/content", async () => {
  await assert.rejects(() => enqueue({}), /kind/);
  await assert.rejects(() => enqueue({ kind: "x" }), /content/);
});

test("enqueue persists a pending item with history", async () => {
  const item = await enqueue({
    kind: "text",
    content: "needs review",
    submittedBy: "alice",
    priority: 5,
    tags: ["auto-flagged"],
    scannerHits: [{ ruleId: "r1", severity: "warn" }],
  });
  assert.ok(item.id);
  assert.equal(item.state, STATE_PENDING);
  assert.equal(item.priority, 5);
  assert.equal(item.history.length, 1);
});

test("claimItem picks highest-priority pending item when itemId omitted", async () => {
  await enqueue({ kind: "text", content: "low", priority: 1 });
  const high = await enqueue({ kind: "text", content: "high", priority: 10 });
  const claimed = await claimItem({ reviewer: "bob" });
  assert.equal(claimed.id, high.id);
  assert.equal(claimed.state, STATE_UNDER_REVIEW);
  assert.equal(claimed.claim.reviewer, "bob");
});

test("claimItem locks out a second reviewer while claim active", async () => {
  const item = await enqueue({ kind: "text", content: "lockout", priority: 1 });
  await claimItem({ reviewer: "rev1", itemId: item.id });
  await assert.rejects(
    () => claimItem({ reviewer: "rev2", itemId: item.id }),
    /already claimed/,
  );
});

test("claimItem allows reclaim after TTL expiry", async () => {
  const item = await enqueue({ kind: "text", content: "expiring", priority: 1 });
  await claimItem({ reviewer: "rev1", itemId: item.id, ttlMs: -1 }); // already expired
  const second = await claimItem({ reviewer: "rev2", itemId: item.id });
  assert.equal(second.claim.reviewer, "rev2");
});

test("decideItem requires claim and correct reviewer", async () => {
  const item = await enqueue({ kind: "text", content: "decide", priority: 1 });
  // Not claimed yet.
  await assert.rejects(
    () => decideItem(item.id, { reviewer: "rev", decision: DECISION_ALLOW }),
    /must be claimed/,
  );
  await claimItem({ reviewer: "rev", itemId: item.id });
  await assert.rejects(
    () => decideItem(item.id, { reviewer: "other", decision: DECISION_ALLOW }),
    /not claimed by/,
  );
  const decided = await decideItem(item.id, { reviewer: "rev", decision: DECISION_REJECT, reason: "violates policy" });
  assert.equal(decided.state, STATE_DECIDED);
  assert.equal(decided.decision.decision, DECISION_REJECT);
  assert.equal(decided.decision.reason, "violates policy");
});

test("decideItem rejects invalid decisions", async () => {
  const item = await enqueue({ kind: "text", content: "invalid", priority: 1 });
  await claimItem({ reviewer: "rev", itemId: item.id });
  await assert.rejects(
    () => decideItem(item.id, { reviewer: "rev", decision: "whatever" }),
    /decision must be/,
  );
});

test("releaseClaim returns item to pending", async () => {
  const item = await enqueue({ kind: "text", content: "release", priority: 1 });
  await claimItem({ reviewer: "rev", itemId: item.id });
  const released = await releaseClaim(item.id, { reviewer: "rev", reason: "not my team" });
  assert.equal(released.state, STATE_PENDING);
  assert.equal(released.claim, null);
});

test("decideItem blocks re-decision after state is decided", async () => {
  const item = await enqueue({ kind: "text", content: "re-decide", priority: 1 });
  await claimItem({ reviewer: "rev", itemId: item.id });
  await decideItem(item.id, { reviewer: "rev", decision: DECISION_ALLOW });
  await assert.rejects(
    () => decideItem(item.id, { reviewer: "rev", decision: DECISION_REJECT }),
    /already decided/,
  );
});

test("listQueue filters by state/kind/reviewer", async () => {
  await enqueue({ kind: "image", content: "img1", priority: 1 });
  const textItem = await enqueue({ kind: "text", content: "txt1", priority: 1 });
  await claimItem({ reviewer: "alice", itemId: textItem.id });
  const under = await listQueue({ state: STATE_UNDER_REVIEW });
  assert.ok(under.some((i) => i.id === textItem.id));
  const byReviewer = await listQueue({ reviewer: "alice" });
  assert.ok(byReviewer.every((i) => i.claim?.reviewer === "alice"));
  const images = await listQueue({ kind: "image" });
  assert.ok(images.every((i) => i.kind === "image"));
});

test("claimItem returns null when queue has no claimable items", async () => {
  // Drain: decide everything that's currently claimable.
  let item;
  while ((item = await claimItem({ reviewer: "drain-rev" }))) {
    await decideItem(item.id, { reviewer: "drain-rev", decision: DECISION_ESCALATE });
  }
  const none = await claimItem({ reviewer: "rev" });
  assert.equal(none, null);
});

test("getItem returns null for missing ids", async () => {
  assert.equal(await getItem("nope"), null);
});
