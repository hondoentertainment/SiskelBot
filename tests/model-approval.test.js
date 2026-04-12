/**
 * Phase 65.1: Model approval workflow tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-model-approval-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  submitForApproval,
  getApproval,
  listApprovals,
  startReview,
  reviewApproval,
  markDeployed,
  retireApproval,
  assignReviewers,
  STATE_DRAFT,
  STATE_REVIEW,
  STATE_APPROVED,
  STATE_REJECTED,
  STATE_DEPLOYED,
  STATE_RETIRED,
} = await import("../lib/model-approval.js");

test.after(() => {
  try { rmSync(TMP_DATA_DIR, { recursive: true, force: true }); } catch (_) {}
});

test("submitForApproval requires modelId/version/submittedBy", async () => {
  await assert.rejects(() => submitForApproval({}), /modelId/);
  await assert.rejects(() => submitForApproval({ modelId: "m" }), /modelVersion/);
  await assert.rejects(() => submitForApproval({ modelId: "m", modelVersion: "v" }), /submittedBy/);
});

test("submitForApproval creates a DRAFT record with history", async () => {
  const rec = await submitForApproval({
    modelId: "gpt-review",
    modelVersion: "1.0.0",
    submittedBy: "alice",
    riskLevel: "high",
    description: "new model",
    reviewers: ["bob", "carol"],
  });
  assert.ok(rec.id);
  assert.equal(rec.state, STATE_DRAFT);
  assert.equal(rec.modelId, "gpt-review");
  assert.deepEqual(rec.reviewers, ["bob", "carol"]);
  assert.equal(rec.history.length, 1);
  assert.equal(rec.history[0].state, STATE_DRAFT);
  const fetched = await getApproval(rec.id);
  assert.equal(fetched.id, rec.id);
});

test("startReview transitions DRAFT → REVIEW", async () => {
  const rec = await submitForApproval({ modelId: "m", modelVersion: "v", submittedBy: "alice", reviewers: ["bob"] });
  const reviewed = await startReview(rec.id, "alice");
  assert.equal(reviewed.state, STATE_REVIEW);
  assert.ok(reviewed.submittedAt);
});

test("reviewApproval rejects non-assigned reviewers", async () => {
  const rec = await submitForApproval({ modelId: "m", modelVersion: "v", submittedBy: "alice", reviewers: ["bob"] });
  await startReview(rec.id, "alice");
  await assert.rejects(
    () => reviewApproval(rec.id, { reviewer: "eve", decision: "approve" }),
    /not an assigned reviewer/,
  );
});

test("reviewApproval approve → APPROVED with decidedAt and decisions log", async () => {
  const rec = await submitForApproval({ modelId: "m", modelVersion: "v", submittedBy: "alice", reviewers: ["bob"] });
  await startReview(rec.id, "alice");
  const approved = await reviewApproval(rec.id, { reviewer: "bob", decision: "approve", reason: "lgtm" });
  assert.equal(approved.state, STATE_APPROVED);
  assert.ok(approved.decidedAt);
  assert.equal(approved.decisions.length, 1);
  assert.equal(approved.decisions[0].decision, "approve");
  assert.equal(approved.decisions[0].reason, "lgtm");
});

test("reviewApproval reject → REJECTED and blocks further transitions", async () => {
  const rec = await submitForApproval({ modelId: "m", modelVersion: "v", submittedBy: "alice", reviewers: ["bob"] });
  await startReview(rec.id, "alice");
  const rejected = await reviewApproval(rec.id, { reviewer: "bob", decision: "reject", reason: "too risky" });
  assert.equal(rejected.state, STATE_REJECTED);
  await assert.rejects(() => markDeployed(rec.id), /cannot transition/);
});

test("reviewApproval comment keeps state in REVIEW", async () => {
  const rec = await submitForApproval({ modelId: "m", modelVersion: "v", submittedBy: "alice", reviewers: ["bob"] });
  await startReview(rec.id, "alice");
  const after = await reviewApproval(rec.id, { reviewer: "bob", decision: "comment", reason: "need more info" });
  assert.equal(after.state, STATE_REVIEW);
  assert.equal(after.decisions.length, 1);
});

test("markDeployed requires APPROVED state", async () => {
  const rec = await submitForApproval({ modelId: "m", modelVersion: "v", submittedBy: "alice", reviewers: ["bob"] });
  await assert.rejects(() => markDeployed(rec.id), /cannot transition/);
  await startReview(rec.id, "alice");
  await reviewApproval(rec.id, { reviewer: "bob", decision: "approve" });
  const deployed = await markDeployed(rec.id, "ops");
  assert.equal(deployed.state, STATE_DEPLOYED);
  assert.ok(deployed.deployedAt);
});

test("retireApproval ends the lifecycle", async () => {
  const rec = await submitForApproval({ modelId: "m", modelVersion: "v", submittedBy: "alice", reviewers: ["bob"] });
  await startReview(rec.id, "alice");
  await reviewApproval(rec.id, { reviewer: "bob", decision: "approve" });
  await markDeployed(rec.id);
  const retired = await retireApproval(rec.id, "ops", "end-of-life");
  assert.equal(retired.state, STATE_RETIRED);
  await assert.rejects(() => markDeployed(rec.id), /cannot transition/);
});

test("assignReviewers appends without duplicates", async () => {
  const rec = await submitForApproval({ modelId: "m", modelVersion: "v", submittedBy: "alice", reviewers: ["bob"] });
  const updated = await assignReviewers(rec.id, ["carol", "bob", "dave"], "alice");
  assert.deepEqual(updated.reviewers.sort(), ["bob", "carol", "dave"]);
});

test("listApprovals filters by state and modelId", async () => {
  await submitForApproval({ modelId: "alpha", modelVersion: "1", submittedBy: "x" });
  await submitForApproval({ modelId: "beta", modelVersion: "1", submittedBy: "x" });
  const all = await listApprovals();
  assert.ok(all.length >= 2);
  const byModel = await listApprovals({ modelId: "alpha" });
  assert.ok(byModel.every((r) => r.modelId === "alpha"));
  const drafts = await listApprovals({ state: STATE_DRAFT });
  assert.ok(drafts.every((r) => r.state === STATE_DRAFT));
});

test("getApproval returns null for missing ids", async () => {
  assert.equal(await getApproval("does-not-exist"), null);
});
