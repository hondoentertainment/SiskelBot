/**
 * Phase 26: AI Quality & Safety — Cost controls.
 * Estimates request costs, enforces per-workspace cost limits, and provides summaries.
 */

import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

// Default model costs per 1K tokens (USD)
const DEFAULT_MODEL_COSTS = {
  "gpt-4o": { input: 0.005, output: 0.015 },
  "gpt-4o-mini": { input: 0.00015, output: 0.0006 },
  "gpt-3.5-turbo": { input: 0.0005, output: 0.0015 },
  "gpt-4": { input: 0.03, output: 0.06 },
  "gpt-4-turbo": { input: 0.01, output: 0.03 },
  "claude-3-opus": { input: 0.015, output: 0.075 },
  "claude-3-sonnet": { input: 0.003, output: 0.015 },
  "claude-3-haiku": { input: 0.00025, output: 0.00125 },
};

let _modelCosts = null;

/**
 * Parse MODEL_COSTS env var if set, merged with defaults.
 * Format: "model:input:output,model2:input2:output2"
 */
function loadModelCosts() {
  if (_modelCosts) return _modelCosts;

  _modelCosts = { ...DEFAULT_MODEL_COSTS };
  const env = process.env.MODEL_COSTS;
  if (typeof env === "string" && env.trim()) {
    for (const entry of env.split(",")) {
      const parts = entry.trim().split(":");
      if (parts.length === 3) {
        const [model, input, output] = parts;
        const inputCost = parseFloat(input);
        const outputCost = parseFloat(output);
        if (model && Number.isFinite(inputCost) && Number.isFinite(outputCost)) {
          _modelCosts[model.trim()] = { input: inputCost, output: outputCost };
        }
      }
    }
  }
  return _modelCosts;
}

/**
 * Reset cached model costs (for testing).
 */
export function resetModelCosts() {
  _modelCosts = null;
}

/**
 * Estimate the cost of a request based on model and token counts.
 * @param {string} model - Model name
 * @param {number} inputTokens - Number of input tokens
 * @param {number} outputTokens - Number of output tokens
 * @returns {{ cost: number, currency: string, breakdown: { input: number, output: number } }}
 */
export function estimateRequestCost(model, inputTokens, outputTokens) {
  const costs = loadModelCosts();
  const modelKey = findModelKey(costs, model);
  const rates = modelKey ? costs[modelKey] : null;

  if (!rates) {
    return { cost: 0, currency: "USD", breakdown: { input: 0, output: 0 } };
  }

  const inputCost = (Math.max(0, inputTokens) / 1000) * rates.input;
  const outputCost = (Math.max(0, outputTokens) / 1000) * rates.output;

  return {
    cost: Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000,
    currency: "USD",
    breakdown: {
      input: Math.round(inputCost * 1_000_000) / 1_000_000,
      output: Math.round(outputCost * 1_000_000) / 1_000_000,
    },
  };
}

/**
 * Find the best matching key in the costs map for a given model name.
 * Supports exact match and prefix match (e.g. "gpt-4o-2024-01" matches "gpt-4o").
 */
function findModelKey(costs, model) {
  if (!model || typeof model !== "string") return null;
  const lower = model.toLowerCase();
  // Exact match first
  if (costs[lower]) return lower;
  // Prefix match: find the longest key that is a prefix of the model name
  let best = null;
  let bestLen = 0;
  for (const key of Object.keys(costs)) {
    if (lower.startsWith(key) && key.length > bestLen) {
      best = key;
      bestLen = key.length;
    }
  }
  return best;
}

function costLedgerPath() {
  return join(getDataDir(), "cost-ledger.json");
}

async function loadLedger() {
  const data = await readJsonPath(costLedgerPath(), { _version: 1, workspaces: {} });
  return data;
}

async function saveLedger(ledger) {
  await writeJsonPath(costLedgerPath(), ledger);
}

/**
 * Record a cost against a workspace.
 * @param {string} workspaceId
 * @param {number} cost
 * @param {object} [meta] - Additional metadata (model, timestamp, etc.)
 */
export async function recordCost(workspaceId, cost, meta = {}) {
  const ws = workspaceId || "default";
  await withPathLock(costLedgerPath(), async () => {
    const ledger = await loadLedger();
    if (!ledger.workspaces[ws]) {
      ledger.workspaces[ws] = { totalCost: 0, entries: [] };
    }
    ledger.workspaces[ws].totalCost = Math.round((ledger.workspaces[ws].totalCost + cost) * 1_000_000) / 1_000_000;
    ledger.workspaces[ws].entries.push({
      cost,
      timestamp: meta.timestamp || new Date().toISOString(),
      model: meta.model || "unknown",
    });
    // Keep only recent entries (max 10000 per workspace)
    if (ledger.workspaces[ws].entries.length > 10_000) {
      ledger.workspaces[ws].entries = ledger.workspaces[ws].entries.slice(-10_000);
    }
    await saveLedger(ledger);
  });
}

/**
 * Check whether a workspace is allowed to incur a given cost.
 * Uses COST_LIMIT_PER_WORKSPACE env var (in USD) as the default limit.
 * @param {string} workspaceId
 * @param {number} estimatedCost
 * @returns {Promise<{ allowed: boolean, remaining: number, limit: number }>}
 */
export async function checkCostLimit(workspaceId, estimatedCost) {
  const limitEnv = process.env.COST_LIMIT_PER_WORKSPACE;
  const limit = limitEnv ? parseFloat(limitEnv) : null;

  if (!limit || !Number.isFinite(limit) || limit <= 0) {
    return { allowed: true, remaining: Infinity, limit: 0 };
  }

  const ws = workspaceId || "default";
  const ledger = await loadLedger();
  const wsData = ledger.workspaces?.[ws];
  const currentCost = wsData?.totalCost || 0;
  const remaining = Math.max(0, Math.round((limit - currentCost) * 1_000_000) / 1_000_000);
  const allowed = currentCost + estimatedCost <= limit;

  return { allowed, remaining, limit };
}

/**
 * Get a cost summary for a workspace within a time period.
 * @param {string} workspaceId
 * @param {'day'|'week'|'month'|'all'} [period='month']
 * @returns {Promise<{ totalCost: number, currency: string, entries: number, byModel: Record<string, number>, period: string }>}
 */
export async function getCostSummary(workspaceId, period = "month") {
  const ws = workspaceId || "default";
  const ledger = await loadLedger();
  const wsData = ledger.workspaces?.[ws];

  if (!wsData || !Array.isArray(wsData.entries)) {
    return { totalCost: 0, currency: "USD", entries: 0, byModel: {}, period };
  }

  const now = Date.now();
  const cutoffs = {
    day: now - 24 * 60 * 60 * 1000,
    week: now - 7 * 24 * 60 * 60 * 1000,
    month: now - 30 * 24 * 60 * 60 * 1000,
    all: 0,
  };
  const cutoff = cutoffs[period] ?? cutoffs.month;

  let totalCost = 0;
  const byModel = {};
  let count = 0;

  for (const entry of wsData.entries) {
    const ts = new Date(entry.timestamp).getTime();
    if (ts >= cutoff) {
      totalCost += entry.cost;
      count++;
      const m = entry.model || "unknown";
      byModel[m] = (byModel[m] || 0) + entry.cost;
    }
  }

  // Round values
  totalCost = Math.round(totalCost * 1_000_000) / 1_000_000;
  for (const k of Object.keys(byModel)) {
    byModel[k] = Math.round(byModel[k] * 1_000_000) / 1_000_000;
  }

  return { totalCost, currency: "USD", entries: count, byModel, period };
}

/**
 * Get the loaded model cost rates for inspection.
 */
export function getModelCosts() {
  return { ...loadModelCosts() };
}
