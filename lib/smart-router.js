/**
 * Smart router — extends A/B routing with quality-aware, cost-aware,
 * and latency-aware model selection strategies.
 */

import { getModelQuality, getModelRanking, checkAutoPromotion } from "./model-quality.js";

/**
 * Per-model cost config (tokens per dollar, lower = cheaper).
 * Defaults populated from env MODEL_COSTS or sensible fallbacks.
 * Format: "model1:0.002,model2:0.06" (cost per 1K tokens)
 * @type {Map<string, number>}
 */
const costMap = new Map();

/** Round-robin index tracker per candidate set */
let rrIndex = 0;

/**
 * Parse MODEL_COSTS env variable.
 * @param {string} [configString]
 */
export function parseCostConfig(configString) {
  costMap.clear();
  if (!configString || typeof configString !== "string") return;
  for (const pair of configString.split(",")) {
    const [model, costStr] = pair.split(":");
    if (!model || !costStr) continue;
    const cost = Number(costStr);
    if (Number.isFinite(cost) && cost >= 0) {
      costMap.set(model.trim().toLowerCase(), cost);
    }
  }
}

/**
 * Get cost for a model (defaults to 0 if unknown).
 * @param {string} model
 * @returns {number}
 */
export function getModelCost(model) {
  return costMap.get(model?.toLowerCase()) ?? 0;
}

/**
 * Select the best backend from candidates using the given strategy.
 *
 * @param {string[]} candidates - List of model/backend names
 * @param {"quality" | "cost" | "latency" | "round-robin" | "weighted"} [strategy="quality"]
 * @param {{ weights?: Record<string, number> }} [options]
 * @returns {{ model: string; reason: string }}
 */
export function selectSmartBackend(candidates, strategy, options) {
  if (!candidates || candidates.length === 0) {
    return { model: null, reason: "no candidates" };
  }
  if (candidates.length === 1) {
    return { model: candidates[0], reason: "single candidate" };
  }

  strategy = strategy || "quality";

  switch (strategy) {
    case "quality":
      return selectByQuality(candidates);
    case "cost":
      return selectByCost(candidates);
    case "latency":
      return selectByLatency(candidates);
    case "round-robin":
      return selectRoundRobin(candidates);
    case "weighted":
      return selectWeighted(candidates, options?.weights);
    default:
      return selectByQuality(candidates);
  }
}

function selectByQuality(candidates) {
  let best = candidates[0];
  let bestScore = -1;
  let hasData = false;

  for (const c of candidates) {
    const q = getModelQuality(c);
    if (q.sampleCount > 0) {
      hasData = true;
      if (q.score > bestScore) {
        bestScore = q.score;
        best = c;
      }
    }
  }

  if (!hasData) {
    return { model: candidates[0], reason: "no quality data, using first candidate" };
  }
  return { model: best, reason: `highest quality score: ${bestScore}` };
}

function selectByCost(candidates) {
  let cheapest = candidates[0];
  let lowestCost = Infinity;

  for (const c of candidates) {
    const cost = getModelCost(c);
    if (cost < lowestCost) {
      lowestCost = cost;
      cheapest = c;
    }
  }

  return { model: cheapest, reason: `lowest cost: ${lowestCost}` };
}

function selectByLatency(candidates) {
  let best = candidates[0];
  let bestP50 = Infinity;
  let hasData = false;

  for (const c of candidates) {
    const q = getModelQuality(c);
    if (q.sampleCount > 0) {
      hasData = true;
      if (q.latencyP50 < bestP50) {
        bestP50 = q.latencyP50;
        best = c;
      }
    }
  }

  if (!hasData) {
    return { model: candidates[0], reason: "no latency data, using first candidate" };
  }
  return { model: best, reason: `lowest p50 latency: ${bestP50}ms` };
}

function selectRoundRobin(candidates) {
  const idx = rrIndex % candidates.length;
  rrIndex = (rrIndex + 1) % Number.MAX_SAFE_INTEGER;
  return { model: candidates[idx], reason: `round-robin index ${idx}` };
}

function selectWeighted(candidates, weights) {
  if (!weights || typeof weights !== "object") {
    return { model: candidates[0], reason: "no weights provided, using first candidate" };
  }

  const entries = candidates.map((c) => ({ model: c, weight: weights[c] || 0 }));
  const total = entries.reduce((s, e) => s + e.weight, 0);
  if (total <= 0) {
    return { model: candidates[0], reason: "all weights zero, using first candidate" };
  }

  const rand = Math.random();
  let cumulative = 0;
  for (const entry of entries) {
    cumulative += entry.weight / total;
    if (rand < cumulative) {
      return { model: entry.model, reason: `weighted selection (weight ${entry.weight})` };
    }
  }

  return { model: entries[entries.length - 1].model, reason: "weighted fallback" };
}

/**
 * Check if any candidate model should be auto-promoted over the current default.
 * Logs a recommendation when a model exceeds the default by 10+ points with 100+ samples.
 * @param {string} currentDefault
 * @returns {{ recommended: string; currentScore: number; recommendedScore: number; sampleCount: number } | null}
 */
export function checkAndLogPromotion(currentDefault) {
  const result = checkAutoPromotion(currentDefault);
  if (result) {
    console.log(
      JSON.stringify({
        event: "model_promotion_recommendation",
        current: currentDefault,
        recommended: result.recommended,
        currentScore: result.currentScore,
        recommendedScore: result.recommendedScore,
        sampleCount: result.sampleCount,
        timestamp: new Date().toISOString(),
      })
    );
  }
  return result;
}

/**
 * Get a summary of all models with quality and cost data.
 * @returns {{ model: string; score: number; cost: number; latencyP50: number; sampleCount: number }[]}
 */
export function getRoutingSummary() {
  const ranking = getModelRanking();
  return ranking.map((r) => ({
    model: r.model,
    score: r.score,
    cost: getModelCost(r.model),
    latencyP50: r.latencyP50,
    latencyP95: r.latencyP95,
    errorRate: r.errorRate,
    throughput: r.throughput,
    sampleCount: r.sampleCount,
  }));
}

/**
 * Reset round-robin index (for testing).
 */
export function resetRoundRobin() {
  rrIndex = 0;
}
