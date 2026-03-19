/**
 * Phase 21: Per-workspace token quotas.
 * Tracks monthly token usage per workspace; enforces QUOTA_TOKENS_PER_WORKSPACE when set.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { getRecordsForPeriod } from "./usage-tracker.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DATA_DIR = process.env.STORAGE_PATH || join(process.cwd(), "data");
const OVERRIDES_PATH = join(DATA_DIR, "quota-overrides.json");

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

let _lock = Promise.resolve();

function withLock(fn) {
  const next = _lock.then(() => fn()).catch((e) => {
    throw e;
  });
  _lock = next;
  return next;
}

/**
 * Get start of current quota period (based on QUOTA_WORKSPACE_PERIOD_DAYS).
 * Uses calendar month when period is 30 days; otherwise rolling window.
 */
function getPeriodStart() {
  const now = new Date();
  if (QUOTA_WORKSPACE_PERIOD_DAYS >= 28 && QUOTA_WORKSPACE_PERIOD_DAYS <= 31) {
    // Treat as "month" - use first of current month
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
 * Get token usage for workspace in current period.
 * @param {string} workspace
 * @returns {number}
 */
export function getWorkspaceTokensUsed(workspace) {
  const periodStart = getPeriodStart();
  const cutoff = periodStart.getTime();
  const records = getRecordsForPeriod(QUOTA_WORKSPACE_PERIOD_DAYS, {
    workspace: workspace || "default",
  });
  return records
    .filter((r) => new Date(r.timestamp).getTime() >= cutoff)
    .reduce((sum, r) => sum + (r.inputTokens || 0) + (r.outputTokens || 0), 0);
}

function loadOverrides() {
  try {
    if (existsSync(OVERRIDES_PATH)) {
      const raw = readFileSync(OVERRIDES_PATH, "utf8");
      const data = JSON.parse(raw);
      return data && typeof data === "object" ? data : {};
    }
  } catch (e) {
    console.warn("[quotas] Failed to load overrides:", e.message);
  }
  return {};
}

function saveOverrides(overrides) {
  const dir = dirname(OVERRIDES_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(OVERRIDES_PATH, JSON.stringify(overrides, null, 0), "utf8");
}

/**
 * Get effective limit for workspace (override or default).
 * @param {string} workspace
 * @returns {number | null}
 */
function getWorkspaceLimit(workspace) {
  const ws = String(workspace || "default").trim();
  const overrides = loadOverrides();
  if (overrides[ws] != null && Number(overrides[ws]) > 0) {
    return Number(overrides[ws]);
  }
  return QUOTA_TOKENS_PER_WORKSPACE;
}

/**
 * Get quota status for a workspace.
 * @param {string} workspace
 * @param {string} [userId] - when provided, admin users bypass
 * @returns {{ limit: number, used: number, remaining: number, resetAt: number } | null}
 *   Returns null when quota not configured.
 */
export function getWorkspaceQuota(workspace, userId) {
  const limit = getWorkspaceLimit(workspace);
  if (limit == null || limit <= 0) return null;
  if (isQuotaAdmin(userId)) {
    return { limit, used: 0, remaining: limit, resetAt: Math.floor(getPeriodEnd().getTime() / 1000) };
  }
  const used = getWorkspaceTokensUsed(workspace || "default");
  const remaining = Math.max(0, limit - used);
  const resetAt = Math.floor(getPeriodEnd().getTime() / 1000);
  return { limit, used, remaining, resetAt };
}

/**
 * Phase 25: Set admin override for workspace quota limit.
 * @param {string} workspace
 * @param {number | null} limit - token limit, or null to clear override
 * @returns {{ ok: boolean, limit?: number, error?: string }}
 */
export async function setWorkspaceQuotaOverride(workspace, limit) {
  const ws = String(workspace || "default").trim();
  if (!ws) return { ok: false, error: "Workspace required" };
  return withLock(() => {
    const overrides = loadOverrides();
    if (limit == null || limit <= 0) {
      delete overrides[ws];
      saveOverrides(overrides);
      return { ok: true };
    }
    const num = Number(limit);
    if (!Number.isFinite(num) || num <= 0) {
      return { ok: false, error: "Limit must be a positive number" };
    }
    overrides[ws] = Math.floor(num);
    saveOverrides(overrides);
    return { ok: true, limit: overrides[ws] };
  });
}

/**
 * Get all quota overrides (for admin dashboard).
 * @returns {Record<string, number>}
 */
export function getQuotaOverrides() {
  return { ...loadOverrides() };
}

/**
 * Check if a chat request would exceed quota (before recording usage).
 * Call before proxying to backend.
 * @param {string} workspace
 * @param {string} [userId]
 * @param {number} [estimatedTokens] - optional; if provided, check used + estimated <= limit
 * @returns {{ allowed: boolean, quota: object | null }}
 */
export function checkQuota(workspace, userId, estimatedTokens = 0) {
  const quota = getWorkspaceQuota(workspace, userId);
  if (!quota) return { allowed: true, quota: null };
  const wouldExceed = quota.used + estimatedTokens > quota.limit;
  return { allowed: !wouldExceed, quota };
}
