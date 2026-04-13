/**
 * Phase 58.1: Cost-aware router.
 *
 * Composes on top of `lib/smart-router.js`. Where smart-router optimizes for
 * quality, cost-aware-router routes based on $/token tradeoffs with a tunable
 * quality floor.
 *
 * Usage:
 *   const pick = pickModel(candidates, { qualityFloor: 0.7, strategy: "cost" });
 *   await recordCost({ model: pick.model, inputTokens, outputTokens });
 *   const report = await getCostReport({ since });
 *
 * Storage:
 *   data/cost-aware-router/usage.json — rolling log of recorded costs
 *   data/cost-aware-router/config.json — per-model cost table (persisted)
 */
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";
import { getModelCost, parseCostConfig, selectSmartBackend } from "./smart-router.js";
import { getModelQuality } from "./model-quality.js";

const DEFAULT_MAX_USAGE_ENTRIES = 20_000;

function usagePath() {
  return join(getDataDir(), "cost-aware-router", "usage.json");
}

function configPath() {
  return join(getDataDir(), "cost-aware-router", "config.json");
}

/**
 * Compose a cost-aware model pick. Filters by quality floor, then picks the
 * cheapest remaining candidate. Falls back to smart-router quality strategy
 * when candidates lack cost info.
 *
 * @param {string[]} candidates
 * @param {{ qualityFloor?: number, strategy?: "cost"|"cost-quality"|"pareto", maxCostPerKTokens?: number }} [options]
 * @returns {{ model: string|null, reason: string, cost?: number, quality?: number }}
 */
export function pickModel(candidates, options = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { model: null, reason: "no_candidates" };
  }
  const strategy = options.strategy || "cost-quality";
  const qualityFloor = Number(options.qualityFloor);
  const maxCost = Number(options.maxCostPerKTokens);

  // Score each candidate with (cost, quality).
  const scored = candidates.map((model) => {
    const cost = getModelCost(model);
    let quality = 1;
    try {
      const q = getModelQuality(model);
      if (q && typeof q === "object" && typeof q.score === "number") {
        // If there's no sample yet, give neutral score of 1 so we don't penalize new models.
        quality = q.sampleCount > 0 ? q.score : 1;
      } else if (typeof q === "number") {
        quality = q;
      }
    } catch (_) { /* ignore */ }
    return { model, cost, quality };
  });

  // Filter by quality floor and cost ceiling.
  let eligible = scored;
  if (Number.isFinite(qualityFloor)) {
    eligible = eligible.filter((s) => s.quality >= qualityFloor);
  }
  if (Number.isFinite(maxCost)) {
    eligible = eligible.filter((s) => s.cost <= maxCost);
  }
  if (eligible.length === 0) {
    // Nothing survives; fall back to cheapest overall.
    const cheapest = [...scored].sort((a, b) => a.cost - b.cost)[0];
    return { model: cheapest.model, reason: "no_eligible_fallback_cheapest", cost: cheapest.cost, quality: cheapest.quality };
  }

  if (strategy === "cost") {
    const cheapest = [...eligible].sort((a, b) => a.cost - b.cost)[0];
    return { model: cheapest.model, reason: "cheapest_within_floor", cost: cheapest.cost, quality: cheapest.quality };
  }
  if (strategy === "pareto") {
    // Pick the Pareto front (non-dominated by any other) and return the best by
    // quality/cost ratio.
    const front = eligible.filter((a) =>
      !eligible.some((b) => b !== a && b.cost <= a.cost && b.quality >= a.quality && (b.cost < a.cost || b.quality > a.quality)));
    const best = front.sort((a, b) => (b.quality / Math.max(1e-9, b.cost)) - (a.quality / Math.max(1e-9, a.cost)))[0] || eligible[0];
    return { model: best.model, reason: "pareto_best_ratio", cost: best.cost, quality: best.quality };
  }
  // Default: cost-quality ratio (higher quality-per-dollar is better).
  const best = [...eligible].sort((a, b) => {
    const ra = a.quality / Math.max(1e-9, a.cost);
    const rb = b.quality / Math.max(1e-9, b.cost);
    return rb - ra;
  })[0];
  return { model: best.model, reason: "best_quality_per_cost", cost: best.cost, quality: best.quality };
}

/**
 * Record an observed cost/usage for a model. Persisted to a rolling log.
 *
 * @param {{ model: string, inputTokens?: number, outputTokens?: number, costUsd?: number, userId?: string, workspaceId?: string, timestamp?: number }} entry
 */
export async function recordCost(entry) {
  if (!entry || !entry.model) throw new Error("model is required");
  const inputTokens = Math.max(0, Number(entry.inputTokens) || 0);
  const outputTokens = Math.max(0, Number(entry.outputTokens) || 0);
  const costPerK = getModelCost(entry.model);
  const costUsd = entry.costUsd != null
    ? Number(entry.costUsd)
    : ((inputTokens + outputTokens) / 1000) * costPerK;
  const record = {
    model: entry.model,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    costUsd: Number.isFinite(costUsd) ? costUsd : 0,
    userId: entry.userId ? String(entry.userId) : null,
    workspaceId: entry.workspaceId ? String(entry.workspaceId) : null,
    timestamp: typeof entry.timestamp === "number" ? entry.timestamp : Date.now(),
  };
  await withPathLock(usagePath(), async () => {
    const store = await readJsonPath(usagePath(), { entries: [] });
    const entries = Array.isArray(store.entries) ? store.entries : [];
    entries.push(record);
    const max = Number(process.env.COST_ROUTER_MAX_ENTRIES) || DEFAULT_MAX_USAGE_ENTRIES;
    const trimmed = entries.length > max ? entries.slice(-max) : entries;
    await writeJsonPath(usagePath(), { entries: trimmed });
  });
  return record;
}

/**
 * Aggregate cost stats over a time window / filters.
 */
export async function getCostReport(filter = {}) {
  const store = await readJsonPath(usagePath(), { entries: [] });
  const entries = Array.isArray(store.entries) ? store.entries : [];
  const since = Number(filter.since) || 0;
  const until = Number(filter.until) || Infinity;
  const out = [];
  for (const e of entries) {
    if (e.timestamp < since || e.timestamp > until) continue;
    if (filter.model && e.model !== filter.model) continue;
    if (filter.workspaceId && e.workspaceId !== filter.workspaceId) continue;
    if (filter.userId && e.userId !== filter.userId) continue;
    out.push(e);
  }
  const byModel = {};
  let totalUsd = 0;
  let totalTokens = 0;
  for (const e of out) {
    if (!byModel[e.model]) byModel[e.model] = { model: e.model, costUsd: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, calls: 0 };
    byModel[e.model].costUsd += e.costUsd;
    byModel[e.model].inputTokens += e.inputTokens;
    byModel[e.model].outputTokens += e.outputTokens;
    byModel[e.model].totalTokens += e.totalTokens;
    byModel[e.model].calls += 1;
    totalUsd += e.costUsd;
    totalTokens += e.totalTokens;
  }
  return {
    totalCallCount: out.length,
    totalUsd,
    totalTokens,
    byModel: Object.values(byModel).sort((a, b) => b.costUsd - a.costUsd),
    window: { since: since || null, until: until === Infinity ? null : until },
  };
}

/**
 * Persist the cost table for later reload (env MODEL_COSTS is transient).
 */
export async function saveCostConfig(configString) {
  parseCostConfig(configString);
  await writeJsonPath(configPath(), { configString, savedAt: Date.now() });
}

export async function loadCostConfig() {
  const rec = await readJsonPath(configPath(), null);
  if (rec && typeof rec.configString === "string") {
    parseCostConfig(rec.configString);
    return rec.configString;
  }
  return null;
}

/**
 * Delegate to smart-router for other strategies — this keeps callers from
 * having to import two modules.
 */
export { selectSmartBackend };

/**
 * Test helper.
 */
export async function _reset() {
  await writeJsonPath(usagePath(), { entries: [] });
  await writeJsonPath(configPath(), { configString: "", savedAt: Date.now() });
  parseCostConfig("");
}

export const _internals = { usagePath, configPath };
