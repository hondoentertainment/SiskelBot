/**
 * Phase 65.1: Model approval workflow tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-model-approvals-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  submitForApproval,
  approveModel,
  rejectModel,
  listPending,
  getApprovalHistory,
  getApproval,
  withdrawApproval,
  getApprovalStats,
} = await import("../lib/model-approvals.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

test("submitForApproval persists a pending record with history", async () => {
  const rec = await submitForApproval({
    modelName: "llama-3-70b",
    version: "2024-01-01",
    submittedBy: "alice",
    riskLevel: "high",
    justification: "production rollout",
  });
  assert.ok(rec.id);
  assert.equal(rec.modelName, "llama-3-70b");
  assert.equal(rec.status, "pending");
  assert.equal(rec.riskLevel, "high");
  assert.equal(rec.history.length, 1);
  assert.equal(rec.history[0].action, "submitted");
  assert.ok(rec.createdAt);
});

test("submitForApproval validates required fields", async () => {
  await assert.rejects(() => submitForApproval(null));
  await assert.rejects(() => submitForApproval({ modelName: "", version: "1", submittedBy: "alice" }));
  await assert.rejects(() => submitForApproval({ modelName: "m", submittedBy: "alice" }));
  await assert.rejects(() => submitForApproval({ modelName: "m", version: "1" }));
  await assert.rejects(() =>
    submitForApproval({ modelName: "m", version: "1", submittedBy: "alice", riskLevel: "nuclear" }),
  );
});

test("approveModel transitions pending to approved", async () => {
  const rec = await submitForApproval({
    modelName: "gpt-4o",
    version: "v1",
    submittedBy: "bob",
  });
  const approved = await approveModel(rec.id, { reviewer: "carol", notes: "looks fine" });
  assert.equal(approved.status, "approved");
  assert.equal(approved.decidedBy, "carol");
  assert.equal(approved.decisionNotes, "looks fine");
  assert.equal(approved.history.length, 2);
  assert.equal(approved.history[1].action, "approved");
});

test("rejectModel transitions pending to rejected", async () => {
  const rec = await submitForApproval({
    modelName: "claude-3-haiku",
    version: "v2",
    submittedBy: "dave",
    riskLevel: "medium",
  });
  const rejected = await rejectModel(rec.id, { reviewer: "eve", notes: "insufficient evals" });
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.decidedBy, "eve");
  assert.equal(rejected.decisionNotes, "insufficient evals");
});

test("approveModel refuses double decisions", async () => {
  const rec = await submitForApproval({
    modelName: "mistral-7b",
    version: "v1",
    submittedBy: "frank",
  });
  await approveModel(rec.id, { reviewer: "grace" });
  await assert.rejects(() => approveModel(rec.id, { reviewer: "grace" }));
  await assert.rejects(() => rejectModel(rec.id, { reviewer: "grace" }));
});

test("withdrawApproval lets submitter retract a pending request", async () => {
  const rec = await submitForApproval({
    modelName: "phi-3",
    version: "v1",
    submittedBy: "hank",
  });
  const withdrawn = await withdrawApproval(rec.id, { actor: "hank", notes: "changed my mind" });
  assert.equal(withdrawn.status, "withdrawn");
  assert.equal(withdrawn.history[1].action, "withdrawn");
});

test("listPending only returns pending requests and supports filters", async () => {
  await submitForApproval({ modelName: "m1", version: "v1", submittedBy: "u", riskLevel: "low" });
  const h = await submitForApproval({ modelName: "m2", version: "v1", submittedBy: "u", riskLevel: "high" });
  await approveModel(h.id, { reviewer: "rev" });
  const pending = await listPending();
  for (const r of pending) assert.equal(r.status, "pending");
  const highOnly = await listPending({ riskLevel: "high" });
  for (const r of highOnly) assert.equal(r.riskLevel, "high");
});

test("getApprovalHistory filters by model name and status", async () => {
  await submitForApproval({ modelName: "history_model", version: "v1", submittedBy: "u" });
  const second = await submitForApproval({ modelName: "history_model", version: "v2", submittedBy: "u" });
  await approveModel(second.id, { reviewer: "rev" });
  const all = await getApprovalHistory({ modelName: "history_model" });
  assert.ok(all.length >= 2);
  const approved = await getApprovalHistory({ modelName: "history_model", status: "approved" });
  for (const r of approved) assert.equal(r.status, "approved");
  await assert.rejects(() => getApprovalHistory({ status: "bogus" }));
});

test("getApproval returns a record by id or null", async () => {
  const rec = await submitForApproval({ modelName: "look", version: "v1", submittedBy: "u" });
  const found = await getApproval(rec.id);
  assert.ok(found);
  assert.equal(found.id, rec.id);
  const missing = await getApproval("app_missing");
  assert.equal(missing, null);
});

test("getApprovalStats returns counts by status and risk", async () => {
  const stats = await getApprovalStats();
  assert.ok(typeof stats.total === "number");
  assert.ok(typeof stats.pending === "number");
  assert.ok(typeof stats.approved === "number");
  assert.ok(stats.byRisk);
  assert.ok(Object.prototype.hasOwnProperty.call(stats.byRisk, "low"));
});
