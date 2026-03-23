/**
 * Phase 21: Per-workspace token quotas.
 * Tracks monthly token usage per workspace; enforces QUOTA_TOKENS_PER_WORKSPACE when set.
 * Phase 68: quota-overrides.json via json-path-store (Postgres / SQLite / file).
 */
import { join } from "path";
import { getRecordsForPeriod } from "./usage-tracker.js";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const QUOTA_TOKENS_PER_WORKSPACE = process.env.QUOTA_TOKENS_PER_WORKSPACE
  ? Number(process.env.QUOTA_TOKENS_PER_WORKSPACE)
  : null;
const QUOTA_WORKSPACE_PERIOD_DAYS = Number(process.env.QUOTA_WORKSPACE_PERIOD_DAYS) || 30;
const QUOTA_ADMIN_USER_IDS_RAW = process.env.QUOTA_ADMIN_USER_IDS || "";
const QUOTA_ADMIN_USER_IDS = new Set(
  QUOTA_ADMIN_USER_IDS_RAW.split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

function overridesPath() {
  return join(getDataDir(), "quota-overrides.json");
}

/**
 * Legacy files were a flat map { workspaceId: limit }. New shape adds _version + overrides.
 * @param {object} data
 * @returns {Record<string, number>}
 */
function normalizeOverridesPayload(data) {
  if (!data || typeof data !== "object") return {};
  if (data.overrides && typeof data.overrides === "object") {
    const out = {};
    for (const [k, v] of Object.entries(data.overrides)) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) out[String(k)] = Math.floor(n);
    }
    return out;
  }
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    if (k === "_version") continue;
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) out[String(k)] = Math.floor(n);
  }
  return out;
}

async function loadOverrides() {
  const data = await readJsonPath(overridesPath(), {});
  return normalizeOverridesPayload(data);
}

/**
 * Check if quota is configured and enforced.
 */
export function isQuotaConfigured() {
  return QUOTA_TOKENS_PER_WORKSPACE != null && QUOTA_TOKENS_PER_WORKSPACE > 0;
}

/**
 * Check if userId is an admin (bypasses quota).
 */
export function isQuotaAdmin(userId) {
  if (!userId || typeof userId !== "string") return false;
  return QUOTA_ADMIN_USER_IDS.has(userId.trim());
}

/**
 * Get start of current quota period (based on QUOTA_WORKSPACE_PERIOD_DAYS).
 * Uses calendar month when period is 30 days; otherwise rolling window.
 */
function getPeriodStart() {
  const now = new Date();
  if (QUOTA_WORKSPACE_PERIOD_DAYS >= 28 && QUOTA_WORKSPACE_PERIOD_DAYS <= 31) {
    return new Date(now.getFullYear(), now.getMonth(), 1);
  }
  const ms = QUOTA_WORKSPACE_PERIOD_DAYS * 24 * 60 * 60 * 1000;
  return new Date(now.getTime() - ms);
}

/**
 * Get end of current period (for X-Quota-Reset header).
 */
function getPeriodEnd() {
  const now = new Date();
  if (QUOTA_WORKSPACE_PERIOD_DAYS >= 28 && QUOTA_WORKSPACE_PERIOD_DAYS <= 31) {
    return new Date(now.getFullYear(), now.getMonth() + 1, 1);
  }
  const ms = QUOTA_WORKSPACE_PERIOD_DAYS * 24 * 60 * 60 * 1000;
  return new Date(now.getTime() + ms);
}

/**
 * Get token usage for workspace in current period.
 * @param {string} workspace
 * @returns {Promise<number>}
 */
export async function getWorkspaceTokensUsed(workspace) {
  const periodStart = getPeriodStart();
  const cutoff = periodStart.getTime();
  const records = await getRecordsForPeriod(QUOTA_WORKSPACE_PERIOD_DAYS, {
    workspace: workspace || "default",
  });
  return records
    .filter((r) => new Date(r.timestamp).getTime() >= cutoff)
    .reduce((sum, r) => sum + (r.inputTokens || 0) + (r.outputTokens || 0), 0);
}

async function getWorkspaceLimit(workspace) {
  const ws = String(workspace || "default").trim();
  const overrides = await loadOverrides();
  if (overrides[ws] != null && Number(overrides[ws]) > 0) {
    return Number(overrides[ws]);
  }
  return QUOTA_TOKENS_PER_WORKSPACE;
}

/**
 * Get quota status for a workspace.
 * @param {string} workspace
 * @param {string} [userId] - when provided, admin users bypass
 * @returns {Promise<{ limit: number, used: number, remaining: number, resetAt: number } | null>}
 */
export async function getWorkspaceQuota(workspace, userId) {
  const limit = await getWorkspaceLimit(workspace);
  if (limit == null || limit <= 0) return null;
  if (isQuotaAdmin(userId)) {
    return { limit, used: 0, remaining: limit, resetAt: Math.floor(getPeriodEnd().getTime() / 1000) };
  }
  const used = await getWorkspaceTokensUsed(workspace || "default");
  const remaining = Math.max(0, limit - used);
  const resetAt = Math.floor(getPeriodEnd().getTime() / 1000);
  return { limit, used, remaining, resetAt };
}

/**
 * Phase 25: Set admin override for workspace quota limit.
 * @param {string} workspace
 * @param {number | null} limit - token limit, or null to clear override
 * @returns {Promise<{ ok: boolean, limit?: number, error?: string }>}
 */
export async function setWorkspaceQuotaOverride(workspace, limit) {
  const ws = String(workspace || "default").trim();
  if (!ws) return { ok: false, error: "Workspace required" };
  const path = overridesPath();
  return withPathLock(path, async () => {
    const raw = await readJsonPath(path, { _version: 1, overrides: {} });
    const overrides = normalizeOverridesPayload(raw);
    if (limit == null || limit <= 0) {
      delete overrides[ws];
    } else {
      const num = Number(limit);
      if (!Number.isFinite(num) || num <= 0) {
        return { ok: false, error: "Limit must be a positive number" };
      }
      overrides[ws] = Math.floor(num);
    }
    await writeJsonPath(path, { _version: 1, overrides });
    if (limit == null || limit <= 0) return { ok: true };
    return { ok: true, limit: overrides[ws] };
  });
}

/**
 * Get all quota overrides (for admin dashboard).
 * @returns {Promise<Record<string, number>>}
 */
export async function getQuotaOverrides() {
  const o = await loadOverrides();
  return { ...o };
}

/**
 * Check if a chat request would exceed quota (before recording usage).
 * @param {string} workspace
 * @param {string} [userId]
 * @param {number} [estimatedTokens]
 * @returns {Promise<{ allowed: boolean, quota: object | null }>}
 */
export async function checkQuota(workspace, userId, estimatedTokens = 0) {
  const quota = await getWorkspaceQuota(workspace, userId);
  if (!quota) return { allowed: true, quota: null };
  const wouldExceed = quota.used + estimatedTokens > quota.limit;
  return { allowed: !wouldExceed, quota };
}
