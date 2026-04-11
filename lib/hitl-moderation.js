// @ts-check
/**
 * Phase 67.5: Human-in-the-loop moderation queue.
 *
 * A simple review workflow: callers enqueue items flagged by automated
 * guardrails, human reviewers claim items (taking a lease), and then
 * decide (approve / reject / escalate). Stats surface open/claimed
 * counts, oldest item age, and per-reviewer throughput.
 *
 * Exports:
 *   - enqueueForReview
 *   - listQueue
 *   - claimItem
 *   - decideItem
 *   - getQueueStats
 *   - releaseItem
 *
 * @module hitl-moderation
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
const VALID_STATUSES = new Set(["pending", "claimed", "approved", "rejected", "escalated"]);
const DEFAULT_LEASE_MS = 10 * 60 * 1000;

function storePath() {
  return join(getDataDir(), "hitl-moderation.json");
}

function newId() {
  return `mod_${randomBytes(8).toString("hex")}`;
}

function nowIso() {
  return new Date().toISOString();
}

async function loadStore() {
  const data = await readJsonPath(storePath(), {
    version: STORE_VERSION,
    items: {},
  });
  if (!data.items || typeof data.items !== "object") data.items = {};
  return data;
}

async function saveStore(data) {
  await writeJsonPath(storePath(), {
    version: STORE_VERSION,
    items: data.items || {},
  });
}

function isLeaseExpired(rec) {
  if (!rec.claimedUntil) return true;
  const t = Date.parse(rec.claimedUntil);
  if (!Number.isFinite(t)) return true;
  return t < Date.now();
}

/**
 * Enqueue an item for human review.
 *
 * @param {{content: string, reason: string, priority?: "low"|"normal"|"high", metadata?: object, workspaceId?: string}} payload
 * @returns {Promise<object>}
 */
export async function enqueueForReview(payload) {
  if (!payload || typeof payload !== "object") throw new Error("payload required");
  if (!payload.content || typeof payload.content !== "string") throw new Error("content required");
  if (!payload.reason) throw new Error("reason required");
  const priority = String(payload.priority || "normal").toLowerCase();
  if (!["low", "normal", "high"].includes(priority)) {
    throw new Error("priority must be low, normal, or high");
  }

  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    const id = newId();
    const ts = nowIso();
    const record = {
      id,
      content: String(payload.content),
      reason: String(payload.reason),
      priority,
      status: "pending",
      metadata: payload.metadata && typeof payload.metadata === "object" ? { ...payload.metadata } : {},
      workspaceId: payload.workspaceId ? String(payload.workspaceId) : "",
      history: [{ at: ts, actor: "system", action: "enqueued", notes: String(payload.reason) }],
      enqueuedAt: ts,
      updatedAt: ts,
      claimedBy: "",
      claimedAt: "",
      claimedUntil: "",
    };
    data.items[id] = record;
    await saveStore(data);
    return record;
  });
}

/**
 * List queue items filtered by status / priority.
 *
 * @param {{status?: string, priority?: string, workspaceId?: string, limit?: number}} [filter]
 * @returns {Promise<object[]>}
 */
export async function listQueue(filter = {}) {
  const data = await loadStore();
  let all = Object.values(data.items || {});
  if (filter.status) {
    const s = String(filter.status).toLowerCase();
    if (!VALID_STATUSES.has(s)) throw new Error(`unknown status ${s}`);
    all = all.filter((i) => i.status === s);
  }
  if (filter.priority) {
    all = all.filter((i) => i.priority === filter.priority);
  }
  if (filter.workspaceId) {
    all = all.filter((i) => i.workspaceId === filter.workspaceId);
  }
  // Pending items first; within status, high priority first; ties: oldest first.
  const rank = { pending: 0, claimed: 1, escalated: 2, approved: 3, rejected: 4 };
  const priorityRank = { high: 0, normal: 1, low: 2 };
  all.sort((a, b) => {
    const r = (rank[a.status] ?? 9) - (rank[b.status] ?? 9);
    if (r !== 0) return r;
    const p = (priorityRank[a.priority] ?? 9) - (priorityRank[b.priority] ?? 9);
    if (p !== 0) return p;
    return a.enqueuedAt < b.enqueuedAt ? -1 : 1;
  });
  const limit = Number.isFinite(filter.limit) && filter.limit > 0 ? Math.floor(filter.limit) : 200;
  return all.slice(0, limit);
}

/**
 * Claim an item for review. If `id` is omitted, the oldest pending
 * high-priority item is selected.
 *
 * @param {{reviewer: string, id?: string, leaseMs?: number}} payload
 * @returns {Promise<object | null>}
 */
export async function claimItem(payload) {
  if (!payload || typeof payload !== "object") throw new Error("payload required");
  if (!payload.reviewer) throw new Error("reviewer required");
  const leaseMs = Number.isFinite(payload.leaseMs) && payload.leaseMs > 0 ? payload.leaseMs : DEFAULT_LEASE_MS;
  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    let candidate = null;
    if (payload.id) {
      const rec = data.items[payload.id];
      if (!rec) throw new Error(`item ${payload.id} not found`);
      if (rec.status !== "pending" && !(rec.status === "claimed" && isLeaseExpired(rec))) {
        throw new Error(`item ${payload.id} is not claimable (${rec.status})`);
      }
      candidate = rec;
    } else {
      const pending = await listQueue({ status: "pending" });
      candidate = pending[0] || null;
      if (!candidate) {
        // Try reclaiming expired leases
        const claimed = await listQueue({ status: "claimed" });
        candidate = claimed.find((c) => isLeaseExpired(c)) || null;
      }
    }
    if (!candidate) return null;
    const now = Date.now();
    candidate.status = "claimed";
    candidate.claimedBy = String(payload.reviewer);
    candidate.claimedAt = new Date(now).toISOString();
    candidate.claimedUntil = new Date(now + leaseMs).toISOString();
    candidate.updatedAt = candidate.claimedAt;
    candidate.history.push({
      at: candidate.claimedAt,
      actor: candidate.claimedBy,
      action: "claimed",
      notes: "",
    });
    data.items[candidate.id] = candidate;
    await saveStore(data);
    return candidate;
  });
}

/**
 * Release a claimed item back into the pending queue.
 *
 * @param {{id: string, reviewer?: string}} payload
 * @returns {Promise<object>}
 */
export async function releaseItem(payload) {
  if (!payload || !payload.id) throw new Error("id required");
  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    const rec = data.items[payload.id];
    if (!rec) throw new Error(`item ${payload.id} not found`);
    if (rec.status !== "claimed") throw new Error(`item ${payload.id} is not claimed`);
    rec.status = "pending";
    rec.claimedBy = "";
    rec.claimedAt = "";
    rec.claimedUntil = "";
    rec.updatedAt = nowIso();
    rec.history.push({
      at: rec.updatedAt,
      actor: payload.reviewer || "system",
      action: "released",
      notes: "",
    });
    data.items[payload.id] = rec;
    await saveStore(data);
    return rec;
  });
}

/**
 * Make a final (or escalation) decision on a claimed item.
 *
 * @param {{id: string, reviewer: string, decision: "approved"|"rejected"|"escalated", notes?: string}} payload
 * @returns {Promise<object>}
 */
export async function decideItem(payload) {
  if (!payload || typeof payload !== "object") throw new Error("payload required");
  if (!payload.id) throw new Error("id required");
  if (!payload.reviewer) throw new Error("reviewer required");
  const decision = String(payload.decision || "").toLowerCase();
  if (!["approved", "rejected", "escalated"].includes(decision)) {
    throw new Error("decision must be approved, rejected, or escalated");
  }
  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    const rec = data.items[payload.id];
    if (!rec) throw new Error(`item ${payload.id} not found`);
    if (rec.status !== "claimed" && rec.status !== "pending") {
      throw new Error(`item ${payload.id} is ${rec.status}`);
    }
    rec.status = decision;
    rec.decidedBy = String(payload.reviewer);
    rec.decidedAt = nowIso();
    rec.notes = payload.notes ? String(payload.notes) : "";
    rec.updatedAt = rec.decidedAt;
    rec.history.push({
      at: rec.decidedAt,
      actor: rec.decidedBy,
      action: decision,
      notes: rec.notes,
    });
    data.items[payload.id] = rec;
    await saveStore(data);
    return rec;
  });
}

/**
 * Return queue statistics.
 *
 * @returns {Promise<{total: number, pending: number, claimed: number, approved: number, rejected: number, escalated: number, oldestPendingAgeMs: number | null, byReviewer: Record<string, number>}>}
 */
export async function getQueueStats() {
  const data = await loadStore();
  const all = Object.values(data.items || {});
  const counts = { total: 0, pending: 0, claimed: 0, approved: 0, rejected: 0, escalated: 0 };
  /** @type {Record<string, number>} */
  const byReviewer = {};
  let oldestPending = null;
  const now = Date.now();
  for (const rec of all) {
    counts.total += 1;
    if (counts[rec.status] != null) counts[rec.status] += 1;
    if (rec.status === "pending") {
      const t = Date.parse(rec.enqueuedAt);
      if (Number.isFinite(t) && (oldestPending == null || t < oldestPending)) {
        oldestPending = t;
      }
    }
    if (rec.decidedBy) {
      byReviewer[rec.decidedBy] = (byReviewer[rec.decidedBy] || 0) + 1;
    }
  }
  return {
    ...counts,
    oldestPendingAgeMs: oldestPending == null ? null : now - oldestPending,
    byReviewer,
  };
}
