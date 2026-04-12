/**
 * Phase 51.4: Policy audit trail.
 *
 * Append-only log of every safety decision (allow/warn/block/revise) keyed by
 * (workspaceId, policyId, decisionId). Used as a unifying audit sink for the
 * jailbreak-detector, output-classifiers, and constitutional-ai modules so an
 * operator can reconstruct why any response was gated.
 *
 * Storage layout:
 *   data/policy-audit/{workspaceId}.json — append-only ring buffer per workspace
 *   data/policy-audit/_index.json       — known workspaces
 */
import { randomUUID } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

export const DECISION_ACTIONS = Object.freeze(["allow", "warn", "block", "revise", "sanitize", "quarantine"]);

const DEFAULT_MAX_ENTRIES = 10_000;

function sanitizeId(val, fallback = "default") {
  if (typeof val !== "string" || !val.trim()) return fallback;
  return val.trim().replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || fallback;
}

function workspacePath(workspaceId) {
  return join(getDataDir(), "policy-audit", `${sanitizeId(workspaceId, "default")}.json`);
}

function indexPath() {
  return join(getDataDir(), "policy-audit", "_index.json");
}

async function touchIndex(workspaceId) {
  const ws = sanitizeId(workspaceId, "default");
  return withPathLock(indexPath(), async () => {
    const idx = await readJsonPath(indexPath(), { workspaces: [] });
    const list = Array.isArray(idx.workspaces) ? idx.workspaces : [];
    if (!list.includes(ws)) {
      list.push(ws);
      await writeJsonPath(indexPath(), { workspaces: list });
    }
  });
}

/**
 * Append a decision record to the audit log. Non-throwing: if the caller is a
 * hot path we never want audit failure to propagate — we log and continue.
 *
 * @param {{
 *   workspaceId?: string | null,
 *   policyId?: string | null,
 *   source?: string,         // e.g. "jailbreak-detector", "output-classifiers"
 *   action?: string,         // allow | warn | block | revise | sanitize | quarantine
 *   reason?: string,
 *   severity?: number,
 *   userId?: string | null,
 *   subjectHash?: string | null,
 *   metadata?: object,
 *   timestamp?: number,
 * }} input
 * @returns {Promise<object>} the stored decision record
 */
export async function recordDecision(input = {}) {
  try {
    const workspaceId = sanitizeId(input.workspaceId, "default");
    const record = {
      decisionId: randomUUID(),
      workspaceId,
      policyId: input.policyId ? String(input.policyId) : "default",
      source: input.source ? String(input.source) : "unknown",
      action: DECISION_ACTIONS.includes(input.action) ? input.action : "allow",
      reason: input.reason ? String(input.reason).slice(0, 500) : null,
      severity: typeof input.severity === "number" ? input.severity : null,
      userId: input.userId ? String(input.userId) : null,
      subjectHash: input.subjectHash ? String(input.subjectHash) : null,
      metadata: input.metadata && typeof input.metadata === "object" ? input.metadata : {},
      timestamp: typeof input.timestamp === "number" ? input.timestamp : Date.now(),
    };
    const file = workspacePath(workspaceId);
    await withPathLock(file, async () => {
      const store = await readJsonPath(file, { entries: [] });
      const entries = Array.isArray(store.entries) ? store.entries : [];
      entries.push(record);
      const max = Number(process.env.POLICY_AUDIT_MAX_ENTRIES) || DEFAULT_MAX_ENTRIES;
      const trimmed = entries.length > max ? entries.slice(-max) : entries;
      await writeJsonPath(file, { entries: trimmed });
    });
    await touchIndex(workspaceId);
    return record;
  } catch (err) {
    // Never throw from audit — record stderr and continue.
    console.warn("[policy-audit] recordDecision failed:", err?.message || err);
    return null;
  }
}

/**
 * Query the audit log. Filters can be combined; omitted filters match all.
 *
 * @param {{
 *   workspaceId?: string,
 *   policyId?: string,
 *   source?: string,
 *   action?: string,
 *   userId?: string,
 *   since?: number, // ms epoch
 *   until?: number, // ms epoch
 *   limit?: number,
 *   offset?: number,
 * }} filter
 */
export async function queryDecisions(filter = {}) {
  const limit = Math.max(1, Math.min(10000, Number(filter.limit) || 100));
  const offset = Math.max(0, Number(filter.offset) || 0);
  let workspaces;
  if (filter.workspaceId) {
    workspaces = [sanitizeId(filter.workspaceId, "default")];
  } else {
    const idx = await readJsonPath(indexPath(), { workspaces: [] });
    workspaces = Array.isArray(idx.workspaces) ? idx.workspaces.slice() : [];
  }
  const all = [];
  for (const ws of workspaces) {
    const store = await readJsonPath(workspacePath(ws), { entries: [] });
    const entries = Array.isArray(store.entries) ? store.entries : [];
    for (const e of entries) {
      if (filter.policyId && e.policyId !== filter.policyId) continue;
      if (filter.source && e.source !== filter.source) continue;
      if (filter.action && e.action !== filter.action) continue;
      if (filter.userId && e.userId !== filter.userId) continue;
      if (filter.since && e.timestamp < filter.since) continue;
      if (filter.until && e.timestamp > filter.until) continue;
      all.push(e);
    }
  }
  all.sort((a, b) => b.timestamp - a.timestamp);
  return {
    total: all.length,
    offset,
    limit,
    decisions: all.slice(offset, offset + limit),
  };
}

/**
 * Export decisions (all matching filter) in a given format. Supports "json"
 * (default) and "csv". Useful for regulator export or offline analysis.
 */
export async function exportDecisions(filter = {}, format = "json") {
  const { decisions } = await queryDecisions({ ...filter, limit: 10000, offset: 0 });
  if (format === "csv") {
    const header = ["decisionId", "timestamp", "workspaceId", "policyId", "source", "action", "severity", "userId", "reason"];
    const lines = [header.join(",")];
    for (const d of decisions) {
      const row = header.map((h) => csvEscape(d[h]));
      lines.push(row.join(","));
    }
    return { format: "csv", body: lines.join("\n"), count: decisions.length };
  }
  return { format: "json", body: JSON.stringify(decisions, null, 2), count: decisions.length };
}

function csvEscape(val) {
  if (val == null) return "";
  const s = String(val);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * Compact summary statistics for a workspace (or all). Useful for dashboards.
 */
export async function getDecisionStats(filter = {}) {
  const { decisions } = await queryDecisions({ ...filter, limit: 10000, offset: 0 });
  const byAction = {};
  const bySource = {};
  const byPolicy = {};
  let minTs = Infinity;
  let maxTs = 0;
  for (const d of decisions) {
    byAction[d.action] = (byAction[d.action] || 0) + 1;
    bySource[d.source] = (bySource[d.source] || 0) + 1;
    byPolicy[d.policyId] = (byPolicy[d.policyId] || 0) + 1;
    if (d.timestamp < minTs) minTs = d.timestamp;
    if (d.timestamp > maxTs) maxTs = d.timestamp;
  }
  return {
    total: decisions.length,
    byAction,
    bySource,
    byPolicy,
    firstAt: decisions.length ? minTs : null,
    lastAt: decisions.length ? maxTs : null,
  };
}

/**
 * Reset (test helper). Drops all audit state for the given workspace (or all).
 */
export async function _reset(workspaceId) {
  if (workspaceId) {
    await writeJsonPath(workspacePath(workspaceId), { entries: [] });
    return;
  }
  const idx = await readJsonPath(indexPath(), { workspaces: [] });
  const list = Array.isArray(idx.workspaces) ? idx.workspaces : [];
  for (const ws of list) {
    await writeJsonPath(workspacePath(ws), { entries: [] });
  }
  await writeJsonPath(indexPath(), { workspaces: [] });
}

export const _internals = { sanitizeId, workspacePath, indexPath };
