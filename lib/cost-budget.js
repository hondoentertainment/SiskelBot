/**
 * Per-workspace cost attribution and budget enforcement.
 *
 * Tracks LLM spend per workspace within a rolling period (day or month) and
 * lets callers cap spend with a budget. Durable via json-path-store (works on
 * file / SQLite KV / Postgres KV).
 *
 * Storage: data/cost-budgets/{workspaceId}.json
 *
 * Config:
 *   WORKSPACE_BUDGET_USD   default per-workspace cap (0 / unset = unlimited)
 *   COST_BUDGET_PERIOD     "day" | "month" (default "month")
 */
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";
import { getModelCost } from "./smart-router.js";

const DEFAULT_BUDGET_USD = Math.max(0, Number(process.env.WORKSPACE_BUDGET_USD) || 0);
const PERIOD = (process.env.COST_BUDGET_PERIOD || "month").toLowerCase() === "day" ? "day" : "month";

function sanitizeWorkspace(ws) {
  if (typeof ws !== "string" || !String(ws).trim()) return "default";
  return String(ws).trim().slice(0, 50).replace(/[^a-zA-Z0-9._-]/g, "") || "default";
}

function storePath(workspaceId) {
  return join(getDataDir(), "cost-budgets", sanitizeWorkspace(workspaceId) + ".json");
}

/** Current period key — "YYYY-MM-DD" (day) or "YYYY-MM" (month). */
export function periodKey(date = new Date()) {
  const iso = date.toISOString();
  return PERIOD === "day" ? iso.slice(0, 10) : iso.slice(0, 7);
}

function normalize(raw) {
  if (raw && typeof raw === "object") {
    return {
      budgetUsd: typeof raw.budgetUsd === "number" ? raw.budgetUsd : null,
      spentUsd: Number(raw.spentUsd) || 0,
      periodKey: typeof raw.periodKey === "string" ? raw.periodKey : periodKey(),
      byModel: raw.byModel && typeof raw.byModel === "object" ? raw.byModel : {},
      updatedAt: raw.updatedAt || null,
    };
  }
  return { budgetUsd: null, spentUsd: 0, periodKey: periodKey(), byModel: {}, updatedAt: null };
}

/** Estimate USD cost of a completion from its token count. */
export function estimateUsd(model, totalTokens) {
  const costPer1k = Number(getModelCost(model)) || 0;
  const tokens = Math.max(0, Number(totalTokens) || 0);
  return costPer1k > 0 ? (tokens / 1000) * costPer1k : 0;
}

/** Effective budget cap for a workspace (per-workspace override or env default). */
function effectiveBudget(store) {
  if (typeof store.budgetUsd === "number" && store.budgetUsd >= 0) return store.budgetUsd;
  return DEFAULT_BUDGET_USD;
}

/**
 * Record spend against a workspace's current-period ledger. Resets the ledger
 * when the period rolls over. Best-effort: never throws.
 * @param {string} workspaceId
 * @param {number} usd
 * @param {{ model?: string }} [opts]
 * @returns {Promise<object>} budget status after recording
 */
export async function recordSpend(workspaceId, usd, opts = {}) {
  const amount = Math.max(0, Number(usd) || 0);
  const ws = sanitizeWorkspace(workspaceId);
  const path = storePath(ws);
  let status = null;
  try {
    await withPathLock(path, async () => {
      const store = normalize(await readJsonPath(path, null));
      const cur = periodKey();
      if (store.periodKey !== cur) {
        store.periodKey = cur;
        store.spentUsd = 0;
        store.byModel = {};
      }
      store.spentUsd += amount;
      if (opts.model) {
        store.byModel[opts.model] = (Number(store.byModel[opts.model]) || 0) + amount;
      }
      store.updatedAt = new Date().toISOString();
      await writeJsonPath(path, store);
      status = toStatus(ws, store);
    });
  } catch {
    /* best-effort accounting */
  }
  return status || (await getBudgetStatus(ws));
}

function toStatus(ws, store) {
  const budgetUsd = effectiveBudget(store);
  const cur = periodKey();
  const spentUsd = store.periodKey === cur ? store.spentUsd : 0;
  const unlimited = !budgetUsd || budgetUsd <= 0;
  return {
    workspaceId: ws,
    period: PERIOD,
    periodKey: cur,
    budgetUsd: unlimited ? null : budgetUsd,
    spentUsd: Math.round(spentUsd * 1e6) / 1e6,
    remainingUsd: unlimited ? null : Math.max(0, budgetUsd - spentUsd),
    exceeded: unlimited ? false : spentUsd >= budgetUsd,
    byModel: store.periodKey === cur ? store.byModel : {},
  };
}

/**
 * Get the current budget status for a workspace (read-only; period rollover is
 * reflected without mutating the store).
 * @param {string} workspaceId
 */
export async function getBudgetStatus(workspaceId) {
  const ws = sanitizeWorkspace(workspaceId);
  const store = normalize(await readJsonPath(storePath(ws), null));
  return toStatus(ws, store);
}

/**
 * Check whether a workspace is allowed to incur more spend.
 * @param {string} workspaceId
 * @returns {Promise<{ allowed: boolean, reason: string|null, status: object }>}
 */
export async function checkBudget(workspaceId) {
  const status = await getBudgetStatus(workspaceId);
  if (status.exceeded) {
    return {
      allowed: false,
      reason: `Workspace budget exceeded: $${status.spentUsd.toFixed(4)} of $${status.budgetUsd} for ${status.period}`,
      status,
    };
  }
  return { allowed: true, reason: null, status };
}

/**
 * Set (or clear) a per-workspace budget cap. Pass null to fall back to the
 * env default.
 * @param {string} workspaceId
 * @param {number|null} budgetUsd
 */
export async function setBudget(workspaceId, budgetUsd) {
  const ws = sanitizeWorkspace(workspaceId);
  const path = storePath(ws);
  let status = null;
  await withPathLock(path, async () => {
    const store = normalize(await readJsonPath(path, null));
    if (budgetUsd === null || budgetUsd === undefined) {
      store.budgetUsd = null;
    } else {
      const n = Number(budgetUsd);
      if (!Number.isFinite(n) || n < 0) throw new Error("budgetUsd must be a non-negative number");
      store.budgetUsd = n;
    }
    store.updatedAt = new Date().toISOString();
    await writeJsonPath(path, store);
    status = toStatus(ws, store);
  });
  return status;
}
