/**
 * Phase 67.5: Human-in-the-loop moderation queue.
 *
 * Workflow:
 *   pending → under-review (claimed by a reviewer)
 *               ├→ decided (decision persisted: allow/reject/escalate)
 *               └→ released back to pending (if reviewer abandons)
 *
 * A queue item carries the artifact to review (content, context, hints from
 * automated scanners). Reviewers claim items with a lease; claims expire after
 * a TTL so stuck items don't disappear forever.
 *
 * Storage:
 *   data/hitl-moderation/{id}.json   — queue item record
 *   data/hitl-moderation/_index.json — registry
 */
import { randomUUID } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

export const STATE_PENDING = "pending";
export const STATE_UNDER_REVIEW = "under-review";
export const STATE_DECIDED = "decided";
const STATE_ORDER = [STATE_PENDING, STATE_UNDER_REVIEW, STATE_DECIDED];

export const DECISION_ALLOW = "allow";
export const DECISION_REJECT = "reject";
export const DECISION_ESCALATE = "escalate";
const DECISIONS = new Set([DECISION_ALLOW, DECISION_REJECT, DECISION_ESCALATE]);

const DEFAULT_CLAIM_TTL_MS = 15 * 60 * 1000;

function sanitize(value) {
  return String(value || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || "default";
}

function itemPath(id) {
  return join(getDataDir(), "hitl-moderation", `${sanitize(id)}.json`);
}

function indexPath() {
  return join(getDataDir(), "hitl-moderation", "_index.json");
}

async function updateIndex(id, remove = false, entry = null) {
  return withPathLock(indexPath(), async () => {
    const idx = await readJsonPath(indexPath(), { items: [] });
    const list = Array.isArray(idx.items) ? idx.items : [];
    const filtered = list.filter((e) => e.id !== id);
    if (!remove && entry) filtered.push(entry);
    await writeJsonPath(indexPath(), { items: filtered });
  });
}

// ─── CRUD ───────────────────────────────────────────────────────────────────

/**
 * Enqueue a content artifact for human review.
 */
export async function enqueue({
  kind,
  content,
  context,
  submittedBy,
  priority,
  tags,
  scannerHits,
} = {}) {
  if (!kind || typeof kind !== "string") {
    throw new Error("kind is required");
  }
  if (typeof content !== "string") {
    throw new Error("content string is required");
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  const item = {
    id,
    kind,
    content,
    context: context && typeof context === "object" ? context : {},
    submittedBy: submittedBy || "system",
    priority: Number.isFinite(Number(priority)) ? Number(priority) : 0,
    tags: Array.isArray(tags) ? tags.map(String) : [],
    scannerHits: Array.isArray(scannerHits) ? scannerHits : [],
    state: STATE_PENDING,
    createdAt: now,
    updatedAt: now,
    claim: null,
    decision: null,
    history: [
      { at: now, state: STATE_PENDING, by: submittedBy || "system", reason: "enqueued" },
    ],
  };
  await writeJsonPath(itemPath(id), item);
  await updateIndex(id, false, { id, kind, priority: item.priority, state: item.state, createdAt: now });
  return item;
}

async function loadItem(id) {
  const rec = await readJsonPath(itemPath(id), null);
  if (!rec || !rec.id || rec._deleted) return null;
  return rec;
}

async function mutateItem(id, mutator) {
  return withPathLock(itemPath(id), async () => {
    const rec = await readJsonPath(itemPath(id), null);
    if (!rec || !rec.id || rec._deleted) {
      const err = new Error(`item ${id} not found`);
      err.code = "NOT_FOUND";
      throw err;
    }
    const updated = await mutator(rec);
    if (updated) {
      updated.updatedAt = new Date().toISOString();
      await writeJsonPath(itemPath(id), updated);
      await updateIndex(updated.id, false, {
        id: updated.id,
        kind: updated.kind,
        priority: updated.priority,
        state: updated.state,
        createdAt: updated.createdAt,
      });
      return updated;
    }
    return rec;
  });
}

function isClaimActive(item, nowMs = Date.now()) {
  const claim = item.claim;
  if (!claim) return false;
  const expires = Date.parse(claim.expiresAt);
  return Number.isFinite(expires) && expires > nowMs;
}

/**
 * Claim the next (or a specific) item for review. Returns the claimed item
 * with the reviewer's lease.
 *
 * @param {object} opts
 * @param {string} opts.reviewer
 * @param {string} [opts.itemId]  — if omitted, picks highest-priority pending
 * @param {number} [opts.ttlMs]
 */
export async function claimItem({ reviewer, itemId, ttlMs = DEFAULT_CLAIM_TTL_MS } = {}) {
  if (!reviewer || typeof reviewer !== "string") {
    throw new Error("reviewer is required");
  }
  const now = Date.now();
  let targetId = itemId;
  if (!targetId) {
    const idx = await readJsonPath(indexPath(), { items: [] });
    const entries = Array.isArray(idx.items) ? idx.items : [];
    const pending = [];
    for (const entry of entries) {
      const rec = await loadItem(entry.id);
      if (!rec) continue;
      if (rec.state === STATE_PENDING) {
        pending.push(rec);
      } else if (rec.state === STATE_UNDER_REVIEW && !isClaimActive(rec, now)) {
        pending.push(rec); // stale claim: reclaimable
      }
    }
    if (pending.length === 0) {
      return null;
    }
    pending.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return Date.parse(a.createdAt) - Date.parse(b.createdAt);
    });
    targetId = pending[0].id;
  }
  return mutateItem(targetId, (rec) => {
    if (rec.state === STATE_DECIDED) {
      const err = new Error(`item ${rec.id} already decided`);
      err.code = "INVALID_STATE";
      throw err;
    }
    if (rec.state === STATE_UNDER_REVIEW && isClaimActive(rec, now) && rec.claim.reviewer !== reviewer) {
      const err = new Error(`item ${rec.id} already claimed by ${rec.claim.reviewer}`);
      err.code = "CONFLICT";
      throw err;
    }
    const nowIso = new Date(now).toISOString();
    rec.state = STATE_UNDER_REVIEW;
    rec.claim = {
      reviewer,
      claimedAt: nowIso,
      expiresAt: new Date(now + ttlMs).toISOString(),
    };
    rec.history.push({ at: nowIso, state: STATE_UNDER_REVIEW, by: reviewer, reason: "claimed" });
    return rec;
  });
}

/**
 * Record the final decision for a claimed item.
 */
export async function decideItem(id, { reviewer, decision, reason, metadata } = {}) {
  if (!reviewer || typeof reviewer !== "string") {
    throw new Error("reviewer is required");
  }
  if (!decision || !DECISIONS.has(decision)) {
    throw new Error(`decision must be one of ${[...DECISIONS].join(", ")}`);
  }
  return mutateItem(id, (rec) => {
    if (rec.state === STATE_DECIDED) {
      const err = new Error(`item ${id} already decided`);
      err.code = "INVALID_STATE";
      throw err;
    }
    if (rec.state !== STATE_UNDER_REVIEW) {
      const err = new Error(`item ${id} must be claimed before deciding`);
      err.code = "INVALID_STATE";
      throw err;
    }
    if (rec.claim?.reviewer !== reviewer) {
      const err = new Error(`item ${id} not claimed by ${reviewer}`);
      err.code = "FORBIDDEN";
      throw err;
    }
    const now = new Date().toISOString();
    rec.state = STATE_DECIDED;
    rec.decision = {
      at: now,
      reviewer,
      decision,
      reason: reason || "",
      metadata: metadata && typeof metadata === "object" ? metadata : {},
    };
    rec.history.push({ at: now, state: STATE_DECIDED, by: reviewer, reason: decision });
    return rec;
  });
}

/**
 * Release a claim without deciding. Item returns to pending.
 */
export async function releaseClaim(id, { reviewer, reason } = {}) {
  if (!reviewer) {
    throw new Error("reviewer is required");
  }
  return mutateItem(id, (rec) => {
    if (rec.state !== STATE_UNDER_REVIEW) {
      const err = new Error(`item ${id} is not under review`);
      err.code = "INVALID_STATE";
      throw err;
    }
    if (rec.claim?.reviewer !== reviewer) {
      const err = new Error(`item ${id} not claimed by ${reviewer}`);
      err.code = "FORBIDDEN";
      throw err;
    }
    const now = new Date().toISOString();
    rec.state = STATE_PENDING;
    rec.claim = null;
    rec.history.push({ at: now, state: STATE_PENDING, by: reviewer, reason: reason || "released" });
    return rec;
  });
}

export async function getItem(id) {
  if (!id) return null;
  return loadItem(id);
}

export async function listQueue(filter = {}) {
  const idx = await readJsonPath(indexPath(), { items: [] });
  const entries = Array.isArray(idx.items) ? idx.items : [];
  const records = [];
  for (const entry of entries) {
    const rec = await loadItem(entry.id);
    if (!rec) continue;
    if (filter.state && rec.state !== filter.state) continue;
    if (filter.kind && rec.kind !== filter.kind) continue;
    if (filter.reviewer && rec.claim?.reviewer !== filter.reviewer) continue;
    records.push(rec);
  }
  // Sort: state (pending first), then priority desc, then createdAt asc.
  records.sort((a, b) => {
    const sa = STATE_ORDER.indexOf(a.state);
    const sb = STATE_ORDER.indexOf(b.state);
    if (sa !== sb) return sa - sb;
    if (b.priority !== a.priority) return b.priority - a.priority;
    return Date.parse(a.createdAt) - Date.parse(b.createdAt);
  });
  return records;
}

export const _internals = { itemPath, indexPath, isClaimActive };
