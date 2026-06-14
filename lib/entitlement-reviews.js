/**
 * Phase 46.5: Entitlement reviews for SOC 2 and compliance.
 *
 * Periodic access review workflows where designated reviewers certify
 * each user's access to workspaces and roles. Pending decisions are
 * applied atomically when the review is completed, producing an
 * audit-ready compliance report.
 */
import { join } from "path";
import { randomUUID } from "crypto";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";
import { listAllUsers } from "./admin-data.js";
import {
  getWorkspacesForMember,
  getWorkspaceMembers,
} from "./teams.js";

const VALID_SCOPES = new Set(["all_users", "workspace", "role", "users"]);
const VALID_DECISIONS = new Set(["approved", "revoked", "changed"]);
const VALID_FREQUENCIES = new Set(["monthly", "quarterly", "annual"]);

function reviewsPath() {
  return join(getDataDir(), "entitlement-reviews.json");
}

function recurringPath() {
  return join(getDataDir(), "entitlement-reviews-recurring.json");
}

function emptyStore() {
  return { _version: 1, reviews: {} };
}

function emptyRecurringStore() {
  return { _version: 1, schedules: {} };
}

async function loadStore() {
  return readJsonPath(reviewsPath(), emptyStore());
}

async function loadRecurringStore() {
  return readJsonPath(recurringPath(), emptyRecurringStore());
}

function nowIso() {
  return new Date().toISOString();
}

function frequencyToMs(frequency) {
  switch (frequency) {
    case "monthly":
      return 30 * 24 * 60 * 60 * 1000;
    case "quarterly":
      return 91 * 24 * 60 * 60 * 1000;
    case "annual":
      return 365 * 24 * 60 * 60 * 1000;
    default:
      return 30 * 24 * 60 * 60 * 1000;
  }
}

/**
 * Build the list of items (users + their access) for a review based on scope.
 * Pluggable so callers can override for testing.
 */
async function buildReviewItems(scope, scopeFilter) {
  const allUsers = await listAllUsers();
  const items = [];
  const userWorkspaces = new Map();

  // Build a map of workspaceId -> {ownerId, members[]} to capture both
  // owner and member roles. getWorkspacesForMember intentionally excludes
  // owners, so we walk the raw store via the members helper.
  let rawMembers = {};
  try {
    const { readJsonPath: rd, getDataDir: dd } = await import("./json-path-store.js");
    const { join: pjoin } = await import("path");
    const data = await rd(pjoin(dd(), "workspace-members.json"), { items: {} });
    rawMembers = data.items || {};
  } catch (_) {
    rawMembers = {};
  }

  function workspacesForUser(userId) {
    const out = [];
    for (const [wsId, entry] of Object.entries(rawMembers)) {
      if (!entry) continue;
      if (String(entry.ownerId) === String(userId)) {
        const mem = (entry.members || []).find((m) => String(m.userId) === String(userId));
        out.push({
          workspaceId: wsId,
          role: mem?.role || "admin",
          joinedAt: mem?.joinedAt || null,
          lastActive: mem?.lastActive || null,
        });
        continue;
      }
      const mem = (entry.members || []).find((m) => String(m.userId) === String(userId));
      if (mem) {
        out.push({
          workspaceId: wsId,
          role: mem.role,
          joinedAt: mem.joinedAt || null,
          lastActive: mem.lastActive || null,
        });
      }
    }
    return out;
  }

  for (const u of allUsers) {
    const userId = u.userId;
    if (!userId) continue;
    let workspaces = workspacesForUser(userId);
    if (workspaces.length === 0) {
      // Fallback: still try the public helper in case storage is non-default
      try {
        workspaces = await getWorkspacesForMember(userId);
      } catch (_) {
        workspaces = [];
      }
    }
    userWorkspaces.set(userId, { user: u, workspaces });
  }

  if (scope === "all_users") {
    for (const [userId, { user, workspaces }] of userWorkspaces) {
      items.push({
        userId,
        user,
        workspaces: workspaces.map((w) => ({
          id: w.workspaceId || w.id,
          role: w.role,
          grantedAt: w.joinedAt || w.grantedAt || null,
          lastActive: w.lastActive || null,
        })),
      });
    }
  } else if (scope === "workspace") {
    const targetWs = scopeFilter?.workspaceId;
    if (!targetWs) throw new Error("scope=workspace requires scopeFilter.workspaceId");
    let entry;
    try {
      entry = await getWorkspaceMembers(targetWs);
    } catch (_) {
      entry = null;
    }
    const members = Array.isArray(entry)
      ? entry
      : Array.isArray(entry?.members)
      ? entry.members
      : [];
    for (const m of members) {
      const userId = m.userId;
      if (!userId) continue;
      const entry = userWorkspaces.get(userId) || { user: { userId } };
      items.push({
        userId,
        user: entry.user,
        workspaces: [
          {
            id: targetWs,
            role: m.role,
            grantedAt: m.joinedAt || m.grantedAt || null,
            lastActive: m.lastActive || null,
          },
        ],
      });
    }
  } else if (scope === "role") {
    const targetRole = scopeFilter?.role;
    if (!targetRole) throw new Error("scope=role requires scopeFilter.role");
    for (const [userId, { user, workspaces }] of userWorkspaces) {
      const matching = workspaces.filter((w) => w.role === targetRole);
      if (matching.length === 0) continue;
      items.push({
        userId,
        user,
        workspaces: matching.map((w) => ({
          id: w.workspaceId || w.id,
          role: w.role,
          grantedAt: w.joinedAt || w.grantedAt || null,
          lastActive: w.lastActive || null,
        })),
      });
    }
  } else if (scope === "users") {
    const targetUsers = Array.isArray(scopeFilter?.userIds) ? scopeFilter.userIds : [];
    if (targetUsers.length === 0) throw new Error("scope=users requires scopeFilter.userIds[]");
    for (const userId of targetUsers) {
      let entry = userWorkspaces.get(userId);
      if (!entry) {
        entry = { user: { userId }, workspaces: workspacesForUser(userId) };
      }
      items.push({
        userId,
        user: entry.user,
        workspaces: (entry.workspaces || []).map((w) => ({
          id: w.workspaceId || w.id,
          role: w.role,
          grantedAt: w.joinedAt || w.grantedAt || null,
          lastActive: w.lastActive || null,
        })),
      });
    }
  }

  return items;
}

/**
 * Create a new entitlement review campaign.
 * @param {object} config
 * @param {string} config.name
 * @param {string} config.scope - all_users | workspace | role | users
 * @param {object} [config.scopeFilter]
 * @param {string[]} config.reviewers
 * @param {string} config.dueDate - ISO date
 * @param {number} [config.requiredApprovals]
 * @param {boolean} [config.autoRevokeOnNoAction]
 * @param {string} [config.createdBy]
 */
export async function createReview(config = {}) {
  const {
    name,
    scope,
    scopeFilter,
    reviewers,
    dueDate,
    requiredApprovals = 1,
    autoRevokeOnNoAction = false,
    createdBy = null,
  } = config;

  if (!name || typeof name !== "string") {
    throw new Error("name is required");
  }
  if (!scope || !VALID_SCOPES.has(scope)) {
    throw new Error(`scope must be one of: ${Array.from(VALID_SCOPES).join(", ")}`);
  }
  if (!Array.isArray(reviewers) || reviewers.length === 0) {
    throw new Error("reviewers must be a non-empty array");
  }
  if (!dueDate) {
    throw new Error("dueDate is required");
  }
  const due = new Date(dueDate);
  if (isNaN(due.getTime())) {
    throw new Error("dueDate must be a valid ISO date");
  }

  const items = await buildReviewItems(scope, scopeFilter);
  const reviewId = `rev_${randomUUID()}`;

  const review = {
    id: reviewId,
    name,
    scope,
    scopeFilter: scopeFilter || null,
    reviewers: reviewers.slice(),
    requiredApprovals: Math.max(1, Number(requiredApprovals) || 1),
    autoRevokeOnNoAction: !!autoRevokeOnNoAction,
    status: "open",
    dueDate: due.toISOString(),
    createdAt: nowIso(),
    createdBy,
    completedAt: null,
    completedBy: null,
    items: items.map((it) => ({
      ...it,
      decision: null,
      newRole: null,
      reviewedBy: null,
      reviewedAt: null,
      comment: null,
    })),
    summary: {
      total: items.length,
      pending: items.length,
      approved: 0,
      revoked: 0,
      changed: 0,
    },
  };

  const path = reviewsPath();
  return withPathLock(path, async () => {
    const store = await readJsonPath(path, emptyStore());
    if (!store.reviews) store.reviews = {};
    store.reviews[reviewId] = review;
    await writeJsonPath(path, store);
    return review;
  });
}

/**
 * List reviews, optionally filtered by status.
 */
export async function listReviews(status) {
  const store = await loadStore();
  const all = Object.values(store.reviews || {});
  if (!status) return all;
  return all.filter((r) => r.status === status);
}

/**
 * Get a single review by id.
 */
export async function getReview(reviewId) {
  const store = await loadStore();
  return store.reviews?.[reviewId] || null;
}

/**
 * Get the items (users + access) attached to a review.
 */
export async function getReviewItems(reviewId) {
  const review = await getReview(reviewId);
  if (!review) return null;
  return review.items || [];
}

function recomputeSummary(review) {
  const items = review.items || [];
  let approved = 0;
  let revoked = 0;
  let changed = 0;
  let pending = 0;
  for (const it of items) {
    if (it.decision === "approved") approved++;
    else if (it.decision === "revoked") revoked++;
    else if (it.decision === "changed") changed++;
    else pending++;
  }
  review.summary = {
    total: items.length,
    pending,
    approved,
    revoked,
    changed,
  };
}

async function applyDecision(reviewId, userId, reviewer, decision, extra = {}) {
  if (!VALID_DECISIONS.has(decision)) {
    throw new Error(`invalid decision: ${decision}`);
  }
  const path = reviewsPath();
  return withPathLock(path, async () => {
    const store = await readJsonPath(path, emptyStore());
    const review = store.reviews?.[reviewId];
    if (!review) throw new Error("review not found");
    if (review.status !== "open") {
      throw new Error(`cannot modify review in status: ${review.status}`);
    }
    if (reviewer && review.reviewers.length > 0 && !review.reviewers.includes(reviewer)) {
      throw new Error("reviewer is not authorized for this review");
    }
    const item = (review.items || []).find((it) => String(it.userId) === String(userId));
    if (!item) throw new Error("user not in review");
    item.decision = decision;
    item.reviewedBy = reviewer || null;
    item.reviewedAt = nowIso();
    item.comment = extra.comment || null;
    if (decision === "changed") {
      item.newRole = extra.newRole || null;
    } else {
      item.newRole = null;
    }
    recomputeSummary(review);
    await writeJsonPath(path, store);
    return item;
  });
}

/**
 * Mark a user's access as approved.
 */
export async function approveAccess(reviewId, userId, reviewer, comment) {
  return applyDecision(reviewId, userId, reviewer, "approved", { comment });
}

/**
 * Mark a user's access for revocation.
 */
export async function revokeAccess(reviewId, userId, reviewer, comment) {
  return applyDecision(reviewId, userId, reviewer, "revoked", { comment });
}

/**
 * Mark a user for a role change. Applied at completion.
 */
export async function requestChange(reviewId, userId, newRole, reviewer, comment) {
  if (!newRole) throw new Error("newRole is required");
  return applyDecision(reviewId, userId, reviewer, "changed", { newRole, comment });
}

/**
 * Apply pending decisions to underlying access controls.
 * Returns counts and any errors encountered.
 */
async function applyAllDecisions(review) {
  const result = { totalReviewed: 0, approved: 0, revoked: 0, changed: 0, errors: [] };
  let teamsModule;
  try {
    teamsModule = await import("./teams.js");
  } catch (_) {
    teamsModule = null;
  }

  for (const item of review.items || []) {
    let effectiveDecision = item.decision;
    if (!effectiveDecision) {
      if (review.autoRevokeOnNoAction) {
        effectiveDecision = "revoked";
        item.decision = "revoked";
        item.reviewedBy = item.reviewedBy || "auto";
        item.reviewedAt = item.reviewedAt || nowIso();
        item.comment = item.comment || "auto-revoked: no action by reviewer";
      } else {
        // No action and not auto-revoking — leave as pending
        continue;
      }
    }
    result.totalReviewed++;
    try {
      if (effectiveDecision === "approved") {
        result.approved++;
      } else if (effectiveDecision === "revoked") {
        result.revoked++;
        if (teamsModule?.removeWorkspaceMember) {
          for (const ws of item.workspaces || []) {
            try {
              await teamsModule.removeWorkspaceMember(ws.id, item.userId);
            } catch (e) {
              result.errors.push({ userId: item.userId, workspaceId: ws.id, error: e.message });
            }
          }
        }
      } else if (effectiveDecision === "changed") {
        result.changed++;
        if (teamsModule?.updateWorkspaceMemberRole && item.newRole) {
          for (const ws of item.workspaces || []) {
            try {
              await teamsModule.updateWorkspaceMemberRole(ws.id, item.userId, item.newRole);
            } catch (e) {
              result.errors.push({ userId: item.userId, workspaceId: ws.id, error: e.message });
            }
          }
        }
      }
    } catch (e) {
      result.errors.push({ userId: item.userId, error: e.message });
    }
  }
  return result;
}

/**
 * Complete a review: apply all pending decisions, mark complete,
 * generate completion report.
 */
export async function completeReview(reviewId, completedBy = null) {
  const path = reviewsPath();
  const summary = await withPathLock(path, async () => {
    const store = await readJsonPath(path, emptyStore());
    const review = store.reviews?.[reviewId];
    if (!review) throw new Error("review not found");
    if (review.status !== "open") {
      throw new Error(`review already ${review.status}`);
    }

    const result = await applyAllDecisions(review);

    review.status = "completed";
    review.completedAt = nowIso();
    review.completedBy = completedBy;
    review.completionResult = result;
    recomputeSummary(review);
    await writeJsonPath(path, store);

    return result;
  });

  // Schedule next recurring review if applicable
  try {
    await maybeScheduleNextRecurring(reviewId);
  } catch (e) {
    console.warn("[entitlement-reviews] Failed to schedule next recurring:", e.message);
  }

  return summary;
}

/**
 * Generate an audit-ready compliance report for a review.
 */
export async function getReviewReport(reviewId) {
  const review = await getReview(reviewId);
  if (!review) return null;

  const items = review.items || [];
  const decisionsByType = {
    approved: items.filter((i) => i.decision === "approved"),
    revoked: items.filter((i) => i.decision === "revoked"),
    changed: items.filter((i) => i.decision === "changed"),
    pending: items.filter((i) => !i.decision),
  };

  const reviewerActivity = {};
  for (const it of items) {
    if (it.reviewedBy) {
      reviewerActivity[it.reviewedBy] = (reviewerActivity[it.reviewedBy] || 0) + 1;
    }
  }

  return {
    reviewId: review.id,
    name: review.name,
    scope: review.scope,
    scopeFilter: review.scopeFilter,
    status: review.status,
    createdAt: review.createdAt,
    createdBy: review.createdBy,
    dueDate: review.dueDate,
    completedAt: review.completedAt,
    completedBy: review.completedBy,
    reviewers: review.reviewers,
    summary: review.summary,
    completionResult: review.completionResult || null,
    decisions: {
      approved: decisionsByType.approved.length,
      revoked: decisionsByType.revoked.length,
      changed: decisionsByType.changed.length,
      pending: decisionsByType.pending.length,
    },
    reviewerActivity,
    auditTrail: items.map((it) => ({
      userId: it.userId,
      decision: it.decision || "pending",
      reviewedBy: it.reviewedBy,
      reviewedAt: it.reviewedAt,
      comment: it.comment,
      newRole: it.newRole,
      workspaces: (it.workspaces || []).map((w) => ({
        id: w.id,
        role: w.role,
        grantedAt: w.grantedAt,
        lastActive: w.lastActive,
      })),
    })),
    generatedAt: nowIso(),
  };
}

/**
 * Get reviews that are past their dueDate and still open.
 */
export async function getOverdueReviews() {
  const all = await listReviews("open");
  const now = Date.now();
  return all.filter((r) => {
    const due = new Date(r.dueDate).getTime();
    return !isNaN(due) && due < now;
  });
}

/**
 * Notify reviewers about a pending review.
 */
export async function sendReviewReminders(reviewId) {
  const review = await getReview(reviewId);
  if (!review) throw new Error("review not found");
  if (review.status !== "open") {
    return { reviewId, sent: 0, reason: "review not open" };
  }

  let sent = 0;
  const errors = [];

  let notifModule;
  try {
    notifModule = await import("./notifications.js");
  } catch (_) {
    notifModule = null;
  }

  for (const reviewer of review.reviewers || []) {
    try {
      if (notifModule?.pushFromEvent) {
        await notifModule.pushFromEvent(
          "entitlement_review_reminder",
          {
            reviewId,
            name: review.name,
            dueDate: review.dueDate,
            pending: review.summary?.pending || 0,
          },
          { userId: reviewer }
        );
      }
      sent++;
    } catch (e) {
      errors.push({ reviewer, error: e.message });
    }
  }

  return { reviewId, sent, errors, reviewers: review.reviewers };
}

// ─── Recurring reviews ─────────────────────────────────────────────────────

/**
 * Schedule a recurring review campaign that auto-creates the next review
 * when the prior one completes.
 */
export async function scheduleRecurringReview(config = {}) {
  const {
    name,
    scope,
    scopeFilter,
    reviewers,
    requiredApprovals = 1,
    autoRevokeOnNoAction = false,
    frequency,
    createdBy = null,
  } = config;

  if (!name) throw new Error("name is required");
  if (!frequency || !VALID_FREQUENCIES.has(frequency)) {
    throw new Error(`frequency must be one of: ${Array.from(VALID_FREQUENCIES).join(", ")}`);
  }
  if (!scope || !VALID_SCOPES.has(scope)) {
    throw new Error(`scope must be valid`);
  }
  if (!Array.isArray(reviewers) || reviewers.length === 0) {
    throw new Error("reviewers must be a non-empty array");
  }

  const scheduleId = `recur_${randomUUID()}`;
  const schedule = {
    id: scheduleId,
    name,
    scope,
    scopeFilter: scopeFilter || null,
    reviewers: reviewers.slice(),
    requiredApprovals,
    autoRevokeOnNoAction,
    frequency,
    createdAt: nowIso(),
    createdBy,
    lastReviewId: null,
    nextDueDate: new Date(Date.now() + frequencyToMs(frequency)).toISOString(),
  };

  const path = recurringPath();
  await withPathLock(path, async () => {
    const store = await readJsonPath(path, emptyRecurringStore());
    if (!store.schedules) store.schedules = {};
    store.schedules[scheduleId] = schedule;
    await writeJsonPath(path, store);
  });

  // Create the first review immediately
  const firstReview = await createReview({
    name: `${name} (initial)`,
    scope,
    scopeFilter,
    reviewers,
    requiredApprovals,
    autoRevokeOnNoAction,
    dueDate: schedule.nextDueDate,
    createdBy,
  });

  // Link the schedule to the new review
  await withPathLock(path, async () => {
    const store = await readJsonPath(path, emptyRecurringStore());
    if (store.schedules?.[scheduleId]) {
      store.schedules[scheduleId].lastReviewId = firstReview.id;
      await writeJsonPath(path, store);
    }
  });

  return { schedule, firstReview };
}

/**
 * List all recurring schedules.
 */
export async function listRecurringSchedules() {
  const store = await loadRecurringStore();
  return Object.values(store.schedules || {});
}

/**
 * When a review completes, check if it was created by a recurring schedule
 * and create the next instance.
 */
async function maybeScheduleNextRecurring(completedReviewId) {
  const store = await loadRecurringStore();
  const schedules = Object.values(store.schedules || {});
  const linked = schedules.find((s) => s.lastReviewId === completedReviewId);
  if (!linked) return null;

  const nextDue = new Date(Date.now() + frequencyToMs(linked.frequency)).toISOString();
  const nextReview = await createReview({
    name: linked.name,
    scope: linked.scope,
    scopeFilter: linked.scopeFilter,
    reviewers: linked.reviewers,
    requiredApprovals: linked.requiredApprovals,
    autoRevokeOnNoAction: linked.autoRevokeOnNoAction,
    dueDate: nextDue,
    createdBy: linked.createdBy,
  });

  const path = recurringPath();
  await withPathLock(path, async () => {
    const s = await readJsonPath(path, emptyRecurringStore());
    if (s.schedules?.[linked.id]) {
      s.schedules[linked.id].lastReviewId = nextReview.id;
      s.schedules[linked.id].nextDueDate = nextDue;
      await writeJsonPath(path, s);
    }
  });

  return nextReview;
}

/**
 * Test helper: reset all entitlement review state.
 */
export async function _resetForTests() {
  await writeJsonPath(reviewsPath(), emptyStore());
  await writeJsonPath(recurringPath(), emptyRecurringStore());
}
