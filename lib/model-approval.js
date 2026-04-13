/**
 * Phase 65.1: Model approval workflows — risk review gates before deployment.
 *
 * Approvals flow through states: draft → review → approved → deployed → retired.
 * Reviewers can approve with a written reason, reject with a reason, or leave a
 * comment. A record keeps the full transition history so audit queries can
 * reconstruct who approved what, when, and why.
 *
 * Storage layout (via json-path-store):
 *   data/model-approval/{id}.json   — approval record
 *   data/model-approval/_index.json — registry of known ids
 */
import { randomUUID } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

// ─── States ─────────────────────────────────────────────────────────────────

export const STATE_DRAFT = "draft";
export const STATE_REVIEW = "review";
export const STATE_APPROVED = "approved";
export const STATE_REJECTED = "rejected";
export const STATE_DEPLOYED = "deployed";
export const STATE_RETIRED = "retired";

const VALID_TRANSITIONS = {
  [STATE_DRAFT]: new Set([STATE_REVIEW, STATE_RETIRED]),
  [STATE_REVIEW]: new Set([STATE_APPROVED, STATE_REJECTED, STATE_DRAFT]),
  [STATE_APPROVED]: new Set([STATE_DEPLOYED, STATE_RETIRED, STATE_REVIEW]),
  [STATE_REJECTED]: new Set([STATE_DRAFT, STATE_RETIRED]),
  [STATE_DEPLOYED]: new Set([STATE_RETIRED]),
  [STATE_RETIRED]: new Set([]),
};

// ─── Path helpers ───────────────────────────────────────────────────────────

function sanitize(value) {
  return String(value || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || "default";
}

function approvalPath(id) {
  return join(getDataDir(), "model-approval", `${sanitize(id)}.json`);
}

function indexPath() {
  return join(getDataDir(), "model-approval", "_index.json");
}

async function updateIndex(id, remove = false, entry = null) {
  return withPathLock(indexPath(), async () => {
    const idx = await readJsonPath(indexPath(), { approvals: [] });
    const list = Array.isArray(idx.approvals) ? idx.approvals : [];
    const filtered = list.filter((e) => e.id !== id);
    if (!remove && entry) filtered.push(entry);
    await writeJsonPath(indexPath(), { approvals: filtered });
  });
}

// ─── CRUD ───────────────────────────────────────────────────────────────────

/**
 * Create a new approval request in DRAFT state.
 */
export async function submitForApproval({
  modelId,
  modelVersion,
  submittedBy,
  riskLevel,
  description,
  reviewers,
  metadata,
} = {}) {
  if (!modelId || typeof modelId !== "string") {
    throw new Error("modelId is required");
  }
  if (!modelVersion || typeof modelVersion !== "string") {
    throw new Error("modelVersion is required");
  }
  if (!submittedBy || typeof submittedBy !== "string") {
    throw new Error("submittedBy is required");
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  const record = {
    id,
    modelId,
    modelVersion,
    submittedBy,
    riskLevel: riskLevel || "unknown",
    description: description || "",
    reviewers: Array.isArray(reviewers) ? reviewers.map(String) : [],
    metadata: metadata && typeof metadata === "object" ? metadata : {},
    state: STATE_DRAFT,
    createdAt: now,
    updatedAt: now,
    submittedAt: null,
    decidedAt: null,
    deployedAt: null,
    retiredAt: null,
    decisions: [],
    history: [
      { at: now, state: STATE_DRAFT, by: submittedBy, reason: "created", data: { modelId, modelVersion } },
    ],
  };
  await writeJsonPath(approvalPath(id), record);
  await updateIndex(id, false, {
    id,
    modelId,
    modelVersion,
    state: STATE_DRAFT,
    createdAt: now,
  });
  return record;
}

export async function getApproval(id) {
  if (!id) return null;
  const data = await readJsonPath(approvalPath(id), null);
  if (!data || !data.id || data._deleted) return null;
  return data;
}

export async function listApprovals(filter = {}) {
  const idx = await readJsonPath(indexPath(), { approvals: [] });
  const entries = Array.isArray(idx.approvals) ? idx.approvals : [];
  const records = [];
  for (const entry of entries) {
    const rec = await getApproval(entry.id);
    if (!rec) continue;
    if (filter.state && rec.state !== filter.state) continue;
    if (filter.modelId && rec.modelId !== filter.modelId) continue;
    if (filter.reviewer && !rec.reviewers.includes(filter.reviewer)) continue;
    records.push(rec);
  }
  return records;
}

async function mutateApproval(id, mutator) {
  return withPathLock(approvalPath(id), async () => {
    const rec = await readJsonPath(approvalPath(id), null);
    if (!rec || !rec.id || rec._deleted) {
      const err = new Error(`approval ${id} not found`);
      err.code = "NOT_FOUND";
      throw err;
    }
    const updated = await mutator(rec);
    if (updated) {
      updated.updatedAt = new Date().toISOString();
      await writeJsonPath(approvalPath(id), updated);
      await updateIndex(updated.id, false, {
        id: updated.id,
        modelId: updated.modelId,
        modelVersion: updated.modelVersion,
        state: updated.state,
        createdAt: updated.createdAt,
      });
      return updated;
    }
    return rec;
  });
}

function assertTransition(from, to) {
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed || !allowed.has(to)) {
    const err = new Error(`cannot transition from ${from} to ${to}`);
    err.code = "INVALID_STATE";
    throw err;
  }
}

/**
 * Move a DRAFT approval into REVIEW so reviewers can act on it.
 */
export async function startReview(id, actor) {
  return mutateApproval(id, (rec) => {
    assertTransition(rec.state, STATE_REVIEW);
    const now = new Date().toISOString();
    rec.state = STATE_REVIEW;
    rec.submittedAt = now;
    rec.history.push({ at: now, state: STATE_REVIEW, by: actor || rec.submittedBy, reason: "submitted_for_review" });
    return rec;
  });
}

/**
 * Record a reviewer's decision. decision: "approve" | "reject" | "comment".
 */
export async function reviewApproval(id, { reviewer, decision, reason } = {}) {
  if (!reviewer || typeof reviewer !== "string") {
    throw new Error("reviewer is required");
  }
  if (!decision || !["approve", "reject", "comment"].includes(decision)) {
    throw new Error("decision must be approve, reject, or comment");
  }
  return mutateApproval(id, (rec) => {
    if (rec.state !== STATE_REVIEW) {
      const err = new Error(`approval ${id} is not in review (state=${rec.state})`);
      err.code = "INVALID_STATE";
      throw err;
    }
    if (rec.reviewers.length > 0 && !rec.reviewers.includes(reviewer)) {
      const err = new Error(`${reviewer} is not an assigned reviewer`);
      err.code = "FORBIDDEN";
      throw err;
    }
    const now = new Date().toISOString();
    const entry = { at: now, reviewer, decision, reason: reason || "" };
    rec.decisions.push(entry);
    if (decision === "approve") {
      rec.state = STATE_APPROVED;
      rec.decidedAt = now;
      rec.history.push({ at: now, state: STATE_APPROVED, by: reviewer, reason: reason || "approved" });
    } else if (decision === "reject") {
      rec.state = STATE_REJECTED;
      rec.decidedAt = now;
      rec.history.push({ at: now, state: STATE_REJECTED, by: reviewer, reason: reason || "rejected" });
    } else {
      rec.history.push({ at: now, state: STATE_REVIEW, by: reviewer, reason: reason || "commented" });
    }
    return rec;
  });
}

/**
 * Mark an APPROVED record as DEPLOYED.
 */
export async function markDeployed(id, actor) {
  return mutateApproval(id, (rec) => {
    assertTransition(rec.state, STATE_DEPLOYED);
    const now = new Date().toISOString();
    rec.state = STATE_DEPLOYED;
    rec.deployedAt = now;
    rec.history.push({ at: now, state: STATE_DEPLOYED, by: actor || "system", reason: "deployed" });
    return rec;
  });
}

/**
 * Retire any approval that is no longer valid/wanted.
 */
export async function retireApproval(id, actor, reason) {
  return mutateApproval(id, (rec) => {
    assertTransition(rec.state, STATE_RETIRED);
    const now = new Date().toISOString();
    rec.state = STATE_RETIRED;
    rec.retiredAt = now;
    rec.history.push({ at: now, state: STATE_RETIRED, by: actor || "system", reason: reason || "retired" });
    return rec;
  });
}

/**
 * Assign one or more reviewers to an existing record.
 */
export async function assignReviewers(id, reviewers, actor) {
  if (!Array.isArray(reviewers) || reviewers.length === 0) {
    throw new Error("reviewers array is required");
  }
  return mutateApproval(id, (rec) => {
    const existing = new Set(rec.reviewers);
    for (const r of reviewers) {
      if (typeof r === "string" && r.trim()) existing.add(r.trim());
    }
    rec.reviewers = [...existing];
    const now = new Date().toISOString();
    rec.history.push({ at: now, state: rec.state, by: actor || "system", reason: "reviewers_assigned", data: { reviewers: rec.reviewers } });
    return rec;
  });
}

export const _internals = { approvalPath, indexPath, VALID_TRANSITIONS };
