// @ts-check
/**
 * Phase 65.1: Model approval workflows.
 *
 * Risk-review gate for LLM or tool-model deployments. Teams can submit
 * a model for approval, reviewers approve or reject with a comment,
 * and the full history is queryable for audit.
 *
 * Persistence is JSON-backed via `json-path-store.js` so it works across
 * file, SQLite, or Postgres KV backends.
 *
 * Exports:
 *   - submitForApproval
 *   - approveModel
 *   - rejectModel
 *   - listPending
 *   - getApprovalHistory
 *   - getApproval (helper)
 *
 * @module model-approvals
 */
import { join } from "path";
import { randomBytes } from "crypto";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;

const RISK_LEVELS = new Set(["low", "medium", "high", "critical"]);
const STATUSES = new Set(["pending", "approved", "rejected", "withdrawn"]);

function storePath() {
  return join(getDataDir(), "model-approvals.json");
}

function newId() {
  return `app_${randomBytes(8).toString("hex")}`;
}

function nowIso() {
  return new Date().toISOString();
}

async function loadStore() {
  const data = await readJsonPath(storePath(), {
    version: STORE_VERSION,
    approvals: {},
  });
  if (!data.approvals || typeof data.approvals !== "object") data.approvals = {};
  return data;
}

async function saveStore(data) {
  await writeJsonPath(storePath(), {
    version: STORE_VERSION,
    approvals: data.approvals || {},
  });
}

/**
 * @typedef {Object} ApprovalRequest
 * @property {string} id
 * @property {string} modelName
 * @property {string} version
 * @property {string} submittedBy
 * @property {string} riskLevel
 * @property {string} justification
 * @property {string} status
 * @property {Array<object>} history
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {string} [decidedAt]
 * @property {string} [decidedBy]
 * @property {string} [decisionNotes]
 */

/**
 * Validate the request shape without mutating the input.
 * @param {object} req
 */
function validateSubmission(req) {
  if (!req || typeof req !== "object") {
    throw new Error("submission is required");
  }
  if (!req.modelName || typeof req.modelName !== "string") {
    throw new Error("modelName is required");
  }
  if (!req.version || typeof req.version !== "string") {
    throw new Error("version is required");
  }
  if (!req.submittedBy || typeof req.submittedBy !== "string") {
    throw new Error("submittedBy is required");
  }
  const risk = String(req.riskLevel || "low").toLowerCase();
  if (!RISK_LEVELS.has(risk)) {
    throw new Error(`riskLevel must be one of ${[...RISK_LEVELS].join(", ")}`);
  }
  return risk;
}

/**
 * Submit a model for approval.
 *
 * @param {{modelName: string, version: string, submittedBy: string, riskLevel?: string, justification?: string, tags?: string[], metadata?: object}} request
 * @returns {Promise<ApprovalRequest>}
 */
export async function submitForApproval(request) {
  const risk = validateSubmission(request);
  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    const id = newId();
    const ts = nowIso();
    const record = {
      id,
      modelName: String(request.modelName),
      version: String(request.version),
      submittedBy: String(request.submittedBy),
      riskLevel: risk,
      justification: String(request.justification || ""),
      tags: Array.isArray(request.tags) ? request.tags.slice() : [],
      metadata: request.metadata && typeof request.metadata === "object" ? { ...request.metadata } : {},
      status: "pending",
      history: [
        {
          at: ts,
          actor: String(request.submittedBy),
          action: "submitted",
          notes: String(request.justification || ""),
        },
      ],
      createdAt: ts,
      updatedAt: ts,
    };
    data.approvals[id] = record;
    await saveStore(data);
    return record;
  });
}

/**
 * Approve a pending model.
 *
 * @param {string} id
 * @param {{reviewer: string, notes?: string}} decision
 * @returns {Promise<ApprovalRequest>}
 */
export async function approveModel(id, decision) {
  if (!id || typeof id !== "string") throw new Error("id is required");
  if (!decision || typeof decision !== "object") throw new Error("decision is required");
  if (!decision.reviewer || typeof decision.reviewer !== "string") {
    throw new Error("reviewer is required");
  }
  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    const rec = data.approvals[id];
    if (!rec) throw new Error(`approval ${id} not found`);
    if (rec.status !== "pending") {
      throw new Error(`approval ${id} is already ${rec.status}`);
    }
    const ts = nowIso();
    rec.status = "approved";
    rec.decidedAt = ts;
    rec.decidedBy = String(decision.reviewer);
    rec.decisionNotes = String(decision.notes || "");
    rec.updatedAt = ts;
    rec.history.push({
      at: ts,
      actor: String(decision.reviewer),
      action: "approved",
      notes: String(decision.notes || ""),
    });
    data.approvals[id] = rec;
    await saveStore(data);
    return rec;
  });
}

/**
 * Reject a pending model.
 *
 * @param {string} id
 * @param {{reviewer: string, notes?: string}} decision
 * @returns {Promise<ApprovalRequest>}
 */
export async function rejectModel(id, decision) {
  if (!id || typeof id !== "string") throw new Error("id is required");
  if (!decision || typeof decision !== "object") throw new Error("decision is required");
  if (!decision.reviewer || typeof decision.reviewer !== "string") {
    throw new Error("reviewer is required");
  }
  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    const rec = data.approvals[id];
    if (!rec) throw new Error(`approval ${id} not found`);
    if (rec.status !== "pending") {
      throw new Error(`approval ${id} is already ${rec.status}`);
    }
    const ts = nowIso();
    rec.status = "rejected";
    rec.decidedAt = ts;
    rec.decidedBy = String(decision.reviewer);
    rec.decisionNotes = String(decision.notes || "");
    rec.updatedAt = ts;
    rec.history.push({
      at: ts,
      actor: String(decision.reviewer),
      action: "rejected",
      notes: String(decision.notes || ""),
    });
    data.approvals[id] = rec;
    await saveStore(data);
    return rec;
  });
}

/**
 * Withdraw a pending approval request.
 *
 * @param {string} id
 * @param {{actor: string, notes?: string}} request
 * @returns {Promise<ApprovalRequest>}
 */
export async function withdrawApproval(id, request) {
  if (!id || typeof id !== "string") throw new Error("id is required");
  if (!request || typeof request !== "object") throw new Error("request is required");
  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    const rec = data.approvals[id];
    if (!rec) throw new Error(`approval ${id} not found`);
    if (rec.status !== "pending") {
      throw new Error(`approval ${id} is already ${rec.status}`);
    }
    const ts = nowIso();
    rec.status = "withdrawn";
    rec.updatedAt = ts;
    rec.history.push({
      at: ts,
      actor: String(request.actor || "system"),
      action: "withdrawn",
      notes: String(request.notes || ""),
    });
    data.approvals[id] = rec;
    await saveStore(data);
    return rec;
  });
}

/**
 * List all pending approval requests (optionally filtered).
 *
 * @param {{riskLevel?: string, modelName?: string}} [filter]
 * @returns {Promise<ApprovalRequest[]>}
 */
export async function listPending(filter = {}) {
  const data = await loadStore();
  const all = Object.values(data.approvals || {});
  const result = all.filter((r) => {
    if (r.status !== "pending") return false;
    if (filter.riskLevel && r.riskLevel !== String(filter.riskLevel).toLowerCase()) return false;
    if (filter.modelName && r.modelName !== filter.modelName) return false;
    return true;
  });
  result.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return result;
}

/**
 * List all approval records for a given model, sorted oldest-first.
 *
 * @param {{modelName?: string, status?: string, limit?: number}} [filter]
 * @returns {Promise<ApprovalRequest[]>}
 */
export async function getApprovalHistory(filter = {}) {
  const data = await loadStore();
  const all = Object.values(data.approvals || {});
  let result = all;
  if (filter.modelName) {
    result = result.filter((r) => r.modelName === filter.modelName);
  }
  if (filter.status) {
    const s = String(filter.status).toLowerCase();
    if (!STATUSES.has(s)) throw new Error(`unknown status ${s}`);
    result = result.filter((r) => r.status === s);
  }
  result.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  if (Number.isFinite(filter.limit) && filter.limit > 0) {
    result = result.slice(0, Math.floor(filter.limit));
  }
  return result;
}

/**
 * Fetch a single approval by id.
 *
 * @param {string} id
 * @returns {Promise<ApprovalRequest | null>}
 */
export async function getApproval(id) {
  if (!id || typeof id !== "string") return null;
  const data = await loadStore();
  return data.approvals[id] || null;
}

/**
 * Compute summary stats across all approvals.
 * @returns {Promise<{total: number, pending: number, approved: number, rejected: number, withdrawn: number, byRisk: Record<string, number>}>}
 */
export async function getApprovalStats() {
  const data = await loadStore();
  const all = Object.values(data.approvals || {});
  const byRisk = { low: 0, medium: 0, high: 0, critical: 0 };
  const counts = { total: 0, pending: 0, approved: 0, rejected: 0, withdrawn: 0 };
  for (const r of all) {
    counts.total += 1;
    if (counts[r.status] != null) counts[r.status] += 1;
    if (byRisk[r.riskLevel] != null) byRisk[r.riskLevel] += 1;
  }
  return { ...counts, byRisk };
}
