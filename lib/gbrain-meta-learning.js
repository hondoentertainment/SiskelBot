/**
 * GBrain meta-learning: learns from outcomes to improve decisions.
 *
 * "Learning to learn" -- GBrain observes outcomes across its decisions
 * (strategy, model, tools, specialists) and uses reinforcement, Bayesian
 * updating, and exploration/exploitation to improve future decision-making.
 *
 * Storage: data/gbrain/meta-learning.json (flushed periodically).
 *
 * @module gbrain-meta-learning
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

const DATA_FILE = join(process.cwd(), "data", "gbrain", "meta-learning.json");

const FLUSH_INTERVAL_MS = 30_000;
const MAX_DECISIONS = 5_000;
const MAX_OUTCOMES_PER_KEY = 1_000;
const DEFAULT_EPSILON = 0.1;
const WEIGHT_FLOOR = 0.01;
const WEIGHT_CEILING = 100;
const REINFORCE_STEP = 0.1;
const PENALTY_STEP = 0.15;

// ─── in-memory store ────────────────────────────────────────────────────────

/**
 * @typedef {{
 *   id: string;
 *   ts: number;
 *   taskType?: string;
 *   strategy?: string;
 *   model?: string;
 *   tools?: string[];
 *   specialists?: string[];
 *   workspaceId?: string;
 * }} Decision
 *
 * @typedef {{
 *   success: boolean;
 *   userRating?: number;
 *   duration?: number;
 *   cost?: number;
 *   errorType?: string;
 *   category?: string;
 * }} Outcome
 *
 * @typedef {{
 *   decisions: Record<string, { decision: Decision; outcome: Outcome }>;
 *   strategyWeights: Record<string, Record<string, number>>;
 *   modelPerformance: Record<string, Record<string, {
 *     successes: number; failures: number; totalDuration: number;
 *     totalCost: number; totalRating: number; ratingCount: number; count: number;
 *   }>>;
 *   toolPerformance: Record<string, Record<string, { successes: number; failures: number; count: number }>>;
 *   outcomesLog: { ts: number; taskType?: string; success: boolean; errorType?: string; category?: string; strategy?: string; model?: string; workspaceId?: string; duration?: number; cost?: number }[];
 *   beliefs: Record<string, { mean: number; variance: number; count: number }>;
 * }} Store
 */

/** @type {Store} */
const store = emptyStore();

let flushTimer = null;
let dirty = false;
let loaded = false;

function emptyStore() {
  return {
    decisions: {},
    strategyWeights: {},
    modelPerformance: {},
    toolPerformance: {},
    outcomesLog: [],
    beliefs: {},
  };
}

function markDirty() {
  dirty = true;
  scheduleFlush();
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    await flushToDisk().catch((e) =>
      console.warn("[gbrain-meta-learning] flush failed:", e?.message || e)
    );
  }, FLUSH_INTERVAL_MS);
  if (flushTimer && flushTimer.unref) flushTimer.unref();
}

async function flushToDisk() {
  if (!dirty) return;
  const payload = JSON.stringify(store, null, 2);
  await mkdir(dirname(DATA_FILE), { recursive: true });
  await writeFile(DATA_FILE, payload);
  dirty = false;
}

/**
 * Load persisted meta-learning data from disk (safe to call multiple times).
 */
export async function loadFromDisk() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await readFile(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    Object.assign(store, emptyStore(), parsed);
    store.decisions = parsed.decisions || {};
    store.strategyWeights = parsed.strategyWeights || {};
    store.modelPerformance = parsed.modelPerformance || {};
    store.toolPerformance = parsed.toolPerformance || {};
    store.outcomesLog = Array.isArray(parsed.outcomesLog) ? parsed.outcomesLog : [];
    store.beliefs = parsed.beliefs || {};
  } catch {
    // no persisted data — start fresh
  }
}

/**
 * Force a synchronous-ish flush (for graceful shutdown).
 */
export async function flush() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  dirty = true;
  await flushToDisk();
}

// ─── helpers ────────────────────────────────────────────────────────────────

function clamp(v, lo, hi) {
  if (!Number.isFinite(v)) return lo;
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

function normalizeCategory(errorType) {
  if (!errorType || typeof errorType !== "string") return "other";
  const t = errorType.toLowerCase();
  if (t.includes("timeout")) return "timeout";
  if (t.includes("tool") || t.includes("exec")) return "tool_error";
  if (t.includes("rate") || t.includes("quota")) return "rate_limit";
  if (t.includes("parse") || t.includes("json")) return "parse_error";
  if (t.includes("auth") || t.includes("permission") || t.includes("forbidden")) return "auth_error";
  if (t.includes("reason") || t.includes("hallucin") || t.includes("stuck")) return "reasoning_error";
  if (t.includes("network") || t.includes("fetch") || t.includes("connect")) return "network_error";
  return "other";
}

function logOutcome(decision, outcome) {
  store.outcomesLog.push({
    ts: Date.now(),
    taskType: decision?.taskType,
    success: !!outcome.success,
    errorType: outcome.errorType,
    category: outcome.category || normalizeCategory(outcome.errorType),
    strategy: decision?.strategy,
    model: decision?.model,
    workspaceId: decision?.workspaceId,
    duration: outcome.duration,
    cost: outcome.cost,
  });
  if (store.outcomesLog.length > MAX_OUTCOMES_PER_KEY * 4) {
    store.outcomesLog = store.outcomesLog.slice(-MAX_OUTCOMES_PER_KEY * 4);
  }
}

// ─── decision recording ────────────────────────────────────────────────────

/**
 * Record the outcome of a decision GBrain made.
 * @param {string} decisionId
 * @param {{ decision?: Decision; outcome: Outcome }} arg - decision context and outcome
 */
export async function recordDecisionOutcome(decisionId, arg) {
  await loadFromDisk();
  if (!decisionId || !arg || !arg.outcome) {
    throw new Error("recordDecisionOutcome requires decisionId and { decision, outcome }");
  }
  const decision = arg.decision || {};
  const outcome = { ...arg.outcome };
  if (!outcome.category) outcome.category = normalizeCategory(outcome.errorType);

  store.decisions[decisionId] = {
    decision: { id: decisionId, ts: Date.now(), ...decision },
    outcome,
  };

  // Cap size
  const ids = Object.keys(store.decisions);
  if (ids.length > MAX_DECISIONS) {
    ids
      .sort((a, b) => (store.decisions[a].decision.ts || 0) - (store.decisions[b].decision.ts || 0))
      .slice(0, ids.length - MAX_DECISIONS)
      .forEach((id) => delete store.decisions[id]);
  }

  // Propagate to sub-systems
  if (decision.taskType && decision.strategy) {
    await updateStrategyWeights(decision.taskType, decision.strategy, outcome);
  }
  if (decision.model && decision.taskType) {
    await updateModelPerformance(decision.model, decision.taskType, outcome);
  }
  if (Array.isArray(decision.tools)) {
    for (const tool of decision.tools) {
      await updateToolPerformance(tool, { taskType: decision.taskType }, outcome);
    }
  }

  logOutcome(decision, outcome);
  markDirty();
  return store.decisions[decisionId];
}

// ─── strategy weights ──────────────────────────────────────────────────────

/**
 * Reinforcement update: positive outcomes increase strategy weight for its
 * task type; failures decrease it. Weights are clamped to [WEIGHT_FLOOR, WEIGHT_CEILING].
 */
export async function updateStrategyWeights(taskType, strategy, outcome) {
  await loadFromDisk();
  if (!taskType || !strategy) return;
  const bucket = (store.strategyWeights[taskType] ||= {});
  if (!(strategy in bucket)) bucket[strategy] = 1;

  const rating = typeof outcome.userRating === "number" ? outcome.userRating : null;
  let delta;
  if (outcome.success) {
    const bonus = rating != null ? ((rating - 3) / 2) * REINFORCE_STEP : 0;
    delta = REINFORCE_STEP + bonus;
  } else {
    delta = -PENALTY_STEP;
  }
  bucket[strategy] = clamp(bucket[strategy] + delta, WEIGHT_FLOOR, WEIGHT_CEILING);
  markDirty();
  return bucket[strategy];
}

/**
 * Return normalized strategy weights for the given task type.
 * @param {string} taskType
 * @returns {Promise<Record<string, number>>}
 */
export async function getStrategyWeights(taskType) {
  await loadFromDisk();
  const bucket = store.strategyWeights[taskType];
  if (!bucket) return {};
  return { ...bucket };
}

// ─── batch learning ────────────────────────────────────────────────────────

/**
 * Process many outcomes together and return a small summary.
 * Each element should be `{ decisionId, decision, outcome }`.
 */
export async function learnFromBatch(outcomes) {
  await loadFromDisk();
  if (!Array.isArray(outcomes)) {
    throw new Error("learnFromBatch expects an array");
  }
  let processed = 0;
  let successes = 0;
  let failures = 0;
  for (const item of outcomes) {
    if (!item || !item.outcome) continue;
    const decisionId =
      item.decisionId || `batch-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    await recordDecisionOutcome(decisionId, {
      decision: item.decision,
      outcome: item.outcome,
    });
    processed += 1;
    if (item.outcome.success) successes += 1;
    else failures += 1;
  }
  markDirty();
  return { processed, successes, failures };
}

// ─── model performance ────────────────────────────────────────────────────

/**
 * Track which models perform best for which task types.
 */
export async function updateModelPerformance(model, taskType, outcome) {
  await loadFromDisk();
  if (!model || !taskType) return;
  const taskBucket = (store.modelPerformance[taskType] ||= {});
  const stats =
    (taskBucket[model] ||= {
      successes: 0,
      failures: 0,
      totalDuration: 0,
      totalCost: 0,
      totalRating: 0,
      ratingCount: 0,
      count: 0,
    });
  stats.count += 1;
  if (outcome.success) stats.successes += 1;
  else stats.failures += 1;
  if (typeof outcome.duration === "number") stats.totalDuration += outcome.duration;
  if (typeof outcome.cost === "number") stats.totalCost += outcome.cost;
  if (typeof outcome.userRating === "number") {
    stats.totalRating += outcome.userRating;
    stats.ratingCount += 1;
  }
  markDirty();
  return stats;
}

/**
 * Return ranked models for a task type, best first. Ranking uses a combined
 * score of success rate, avg rating, and (inverse) avg duration.
 */
export async function getBestModelForTask(taskType) {
  await loadFromDisk();
  const taskBucket = store.modelPerformance[taskType];
  if (!taskBucket) return [];
  const ranking = [];
  for (const [model, stats] of Object.entries(taskBucket)) {
    const successRate = stats.count > 0 ? stats.successes / stats.count : 0;
    const avgDuration = stats.count > 0 ? stats.totalDuration / stats.count : 0;
    const avgCost = stats.count > 0 ? stats.totalCost / stats.count : 0;
    const avgRating = stats.ratingCount > 0 ? stats.totalRating / stats.ratingCount : 3;
    // Normalize duration into a 0..1 quality factor (cap at 60s)
    const latencyFactor = avgDuration > 0 ? clamp(1 - avgDuration / 60_000, 0, 1) : 0.5;
    const score =
      successRate * 0.6 + (avgRating / 5) * 0.25 + latencyFactor * 0.15;
    ranking.push({
      model,
      score: Math.round(score * 10000) / 10000,
      successRate: Math.round(successRate * 10000) / 10000,
      avgDuration: Math.round(avgDuration),
      avgCost: Math.round(avgCost * 10000) / 10000,
      avgRating: Math.round(avgRating * 100) / 100,
      sampleCount: stats.count,
    });
  }
  ranking.sort((a, b) => b.score - a.score);
  return ranking;
}

// ─── tool performance ─────────────────────────────────────────────────────

/**
 * Update which tools succeed in which contexts.
 * @param {string} tool
 * @param {{ taskType?: string }} context
 * @param {Outcome} outcome
 */
export async function updateToolPerformance(tool, context, outcome) {
  await loadFromDisk();
  if (!tool) return;
  const ctxKey = context && context.taskType ? context.taskType : "_global";
  const bucket = (store.toolPerformance[tool] ||= {});
  const stats = (bucket[ctxKey] ||= { successes: 0, failures: 0, count: 0 });
  stats.count += 1;
  if (outcome.success) stats.successes += 1;
  else stats.failures += 1;
  markDirty();
  return stats;
}

/**
 * Return a flat ranking of tools by success rate for a given context
 * (optionally filtered by task type). Useful for diagnostic panels.
 */
export async function getToolRanking(taskType) {
  await loadFromDisk();
  const ranking = [];
  for (const [tool, contexts] of Object.entries(store.toolPerformance)) {
    let successes = 0;
    let failures = 0;
    let count = 0;
    for (const [ctxKey, stats] of Object.entries(contexts)) {
      if (taskType && ctxKey !== taskType) continue;
      successes += stats.successes;
      failures += stats.failures;
      count += stats.count;
    }
    if (count === 0) continue;
    const successRate = successes / count;
    ranking.push({ tool, successRate, successes, failures, sampleCount: count });
  }
  ranking.sort((a, b) => b.successRate - a.successRate);
  return ranking;
}

// ─── failure analysis ────────────────────────────────────────────────────

/**
 * Group recent failures and return systematic diagnostic info.
 * @param {{ sinceMs?: number; since?: number; untilMs?: number }} [timeRange]
 */
export async function analyzeFailures(timeRange = {}) {
  await loadFromDisk();
  const now = Date.now();
  const since =
    typeof timeRange.since === "number"
      ? timeRange.since
      : now - (typeof timeRange.sinceMs === "number" ? timeRange.sinceMs : 7 * 86_400_000);
  const until =
    typeof timeRange.untilMs === "number" ? timeRange.untilMs : now;

  const result = {
    totalFailures: 0,
    totalOutcomes: 0,
    failureRate: 0,
    byCategory: {},
    byStrategy: {},
    byModel: {},
    byTaskType: {},
    recommendations: [],
  };

  for (const entry of store.outcomesLog) {
    if (entry.ts < since || entry.ts > until) continue;
    result.totalOutcomes += 1;
    if (entry.success) continue;
    result.totalFailures += 1;

    const cat = entry.category || "other";
    result.byCategory[cat] = (result.byCategory[cat] || 0) + 1;

    if (entry.strategy) {
      result.byStrategy[entry.strategy] = (result.byStrategy[entry.strategy] || 0) + 1;
    }
    if (entry.model) {
      result.byModel[entry.model] = (result.byModel[entry.model] || 0) + 1;
    }
    if (entry.taskType) {
      result.byTaskType[entry.taskType] = (result.byTaskType[entry.taskType] || 0) + 1;
    }
  }

  result.failureRate =
    result.totalOutcomes > 0
      ? Math.round((result.totalFailures / result.totalOutcomes) * 10000) / 10000
      : 0;

  // Recommendations
  if (result.totalFailures > 0) {
    const topCat = Object.entries(result.byCategory).sort((a, b) => b[1] - a[1])[0];
    if (topCat && topCat[1] >= 3) {
      result.recommendations.push({
        type: "failure_category",
        message: `Investigate ${topCat[0]} -- leading failure category (${topCat[1]} occurrences)`,
        severity: topCat[1] >= 10 ? "high" : "medium",
      });
    }
    const worstModel = Object.entries(result.byModel).sort((a, b) => b[1] - a[1])[0];
    if (worstModel && worstModel[1] >= 5) {
      result.recommendations.push({
        type: "model",
        message: `Model ${worstModel[0]} accounts for ${worstModel[1]} failures; consider routing away`,
        severity: "medium",
      });
    }
    const worstStrategy = Object.entries(result.byStrategy).sort((a, b) => b[1] - a[1])[0];
    if (worstStrategy && worstStrategy[1] >= 5) {
      result.recommendations.push({
        type: "strategy",
        message: `Strategy "${worstStrategy[0]}" is producing most failures; try alternatives`,
        severity: "medium",
      });
    }
  }

  return result;
}

// ─── recommendations ─────────────────────────────────────────────────────

/**
 * Produce actionable improvement recommendations for a workspace based on
 * outcome patterns.
 */
export async function recommendImprovements(workspaceId) {
  await loadFromDisk();
  const recommendations = [];

  const relevant = workspaceId
    ? store.outcomesLog.filter((o) => o.workspaceId === workspaceId)
    : store.outcomesLog;

  if (relevant.length < 5) {
    return [
      {
        type: "insufficient_data",
        message: "Not enough outcomes yet to recommend improvements (need at least 5)",
        severity: "info",
      },
    ];
  }

  const failures = await analyzeFailures({ sinceMs: 14 * 86_400_000 });

  // Roll up recommendations from failure analysis
  for (const r of failures.recommendations) recommendations.push(r);

  // Strategy suggestions from weights
  for (const [taskType, weights] of Object.entries(store.strategyWeights)) {
    const sorted = Object.entries(weights).sort((a, b) => b[1] - a[1]);
    if (sorted.length < 2) continue;
    const [best, worst] = [sorted[0], sorted[sorted.length - 1]];
    if (best[1] / Math.max(worst[1], WEIGHT_FLOOR) >= 2) {
      recommendations.push({
        type: "strategy_change",
        taskType,
        message: `For "${taskType}", prefer strategy "${best[0]}" over "${worst[0]}" (${best[1].toFixed(2)} vs ${worst[1].toFixed(2)})`,
        severity: "low",
      });
    }
  }

  // Model upgrade suggestions
  for (const taskType of Object.keys(store.modelPerformance)) {
    const ranking = await getBestModelForTask(taskType);
    if (ranking.length >= 2 && ranking[0].score - ranking[ranking.length - 1].score >= 0.2) {
      recommendations.push({
        type: "model_upgrade",
        taskType,
        message: `For "${taskType}", "${ranking[0].model}" outperforms "${ranking[ranking.length - 1].model}" (${ranking[0].score} vs ${ranking[ranking.length - 1].score})`,
        severity: "low",
        bestModel: ranking[0].model,
      });
    }
  }

  // Tool additions if certain tools have very high success
  const tools = await getToolRanking();
  if (tools.length > 0 && tools[0].successRate >= 0.9 && tools[0].sampleCount >= 10) {
    recommendations.push({
      type: "tool_highlight",
      message: `Tool "${tools[0].tool}" succeeds ${Math.round(tools[0].successRate * 100)}% of the time across ${tools[0].sampleCount} uses`,
      severity: "info",
    });
  }

  // System prompt refinements based on reasoning errors
  const reasoningErrors = failures.byCategory.reasoning_error || 0;
  if (reasoningErrors >= 5) {
    recommendations.push({
      type: "system_prompt",
      message: `${reasoningErrors} reasoning errors observed — consider tightening system prompt or enabling reflection`,
      severity: "medium",
    });
  }

  return recommendations;
}

// ─── Bayesian updating ───────────────────────────────────────────────────

/**
 * Update a Normal-Normal belief with observations.
 *
 * Uses the conjugate Normal prior:
 *   posterior precision = prior precision + n / sample variance
 *   posterior mean =
 *     (prior precision * prior mean + n * sample mean / sample variance)
 *     / posterior precision
 *
 * Robust to edge cases: zero sample variance uses a unit variance fallback.
 *
 * @param {{ mean: number; variance: number; count?: number }} prior
 * @param {number[]} observations
 * @returns {{ posteriorMean: number; posteriorVariance: number; sampleCount: number }}
 */
export function bayesianUpdate(prior, observations) {
  if (!prior || typeof prior.mean !== "number" || typeof prior.variance !== "number") {
    throw new Error("bayesianUpdate requires prior with numeric mean and variance");
  }
  if (!Array.isArray(observations) || observations.length === 0) {
    return {
      posteriorMean: prior.mean,
      posteriorVariance: prior.variance,
      sampleCount: prior.count || 0,
    };
  }
  const n = observations.length;
  const sampleMean = observations.reduce((s, o) => s + o, 0) / n;
  let sampleVar = 0;
  if (n > 1) {
    sampleVar =
      observations.reduce((s, o) => s + (o - sampleMean) ** 2, 0) / (n - 1);
  }
  if (!Number.isFinite(sampleVar) || sampleVar <= 0) sampleVar = 1;

  const priorVar = prior.variance > 0 ? prior.variance : 1;
  const priorPrecision = 1 / priorVar;
  const dataPrecision = n / sampleVar;
  const posteriorPrecision = priorPrecision + dataPrecision;
  const posteriorMean =
    (priorPrecision * prior.mean + dataPrecision * sampleMean) / posteriorPrecision;
  const posteriorVariance = 1 / posteriorPrecision;

  return {
    posteriorMean,
    posteriorVariance,
    sampleCount: (prior.count || 0) + n,
  };
}

/**
 * Persist a belief update under a keyed name (e.g. strategy success rate).
 */
export async function updateBelief(key, observations) {
  await loadFromDisk();
  const prior = store.beliefs[key] || { mean: 0.5, variance: 1, count: 0 };
  const result = bayesianUpdate(prior, observations);
  store.beliefs[key] = {
    mean: result.posteriorMean,
    variance: result.posteriorVariance,
    count: result.sampleCount,
  };
  markDirty();
  return store.beliefs[key];
}

export async function getBelief(key) {
  await loadFromDisk();
  return store.beliefs[key] || null;
}

// ─── exploration vs exploitation ─────────────────────────────────────────

/**
 * Decide whether to explore an alternative strategy instead of exploiting
 * the current best. Uses epsilon-greedy by default; if `alternatives`
 * include sampleCount data, falls back to UCB1 comparisons.
 *
 * @param {string} taskType
 * @param {{ key: string; score?: number; sampleCount?: number }} currentBest
 * @param {Array<{ key: string; score?: number; sampleCount?: number }>} alternatives
 * @param {{ epsilon?: number; totalPulls?: number; rng?: () => number }} [opts]
 * @returns {{ explore: boolean; choice: string; reason: string }}
 */
export function shouldExplore(taskType, currentBest, alternatives, opts = {}) {
  if (!currentBest || !currentBest.key) {
    const fallback = alternatives?.[0]?.key || null;
    return {
      explore: true,
      choice: fallback,
      reason: "no_current_best",
    };
  }
  const rng = opts.rng || Math.random;
  const epsilon = Math.max(0, Math.min(1, opts.epsilon ?? DEFAULT_EPSILON));
  const alts = Array.isArray(alternatives) ? alternatives.filter((a) => a.key !== currentBest.key) : [];
  if (alts.length === 0) {
    return { explore: false, choice: currentBest.key, reason: "no_alternatives" };
  }

  // If total pulls provided, compute UCB1 bonus and prefer alternatives with
  // higher upper confidence bound than the current best.
  if (typeof opts.totalPulls === "number" && opts.totalPulls > 0) {
    const ucb = (arm) => {
      const score = arm.score ?? 0;
      const count = Math.max(1, arm.sampleCount || 1);
      return score + Math.sqrt((2 * Math.log(opts.totalPulls)) / count);
    };
    const bestUcb = ucb(currentBest);
    let bestAlt = null;
    let bestAltUcb = -Infinity;
    for (const alt of alts) {
      const u = ucb(alt);
      if (u > bestAltUcb) {
        bestAltUcb = u;
        bestAlt = alt;
      }
    }
    if (bestAlt && bestAltUcb > bestUcb) {
      return { explore: true, choice: bestAlt.key, reason: "ucb_preferred" };
    }
  }

  // Epsilon-greedy
  if (rng() < epsilon) {
    const idx = Math.floor(rng() * alts.length);
    return { explore: true, choice: alts[Math.min(idx, alts.length - 1)].key, reason: "epsilon_greedy" };
  }
  return { explore: false, choice: currentBest.key, reason: "exploit" };
}

// ─── learning curves ─────────────────────────────────────────────────────

/**
 * Compute a learning curve for a given metric over a time period.
 * Buckets outcomes into even time slices and computes the rolling metric.
 *
 * @param {"success_rate" | "avg_duration" | "avg_cost" | "avg_rating"} metric
 * @param {{ sinceMs?: number; buckets?: number }} [period]
 * @returns {Promise<{ dataPoints: {ts: number; value: number; count: number}[]; trend: "up" | "down" | "flat"; improvementRate: number }>}
 */
export async function getLearningCurve(metric = "success_rate", period = {}) {
  await loadFromDisk();
  const now = Date.now();
  const sinceMs = typeof period.sinceMs === "number" ? period.sinceMs : 7 * 86_400_000;
  const buckets = Math.max(2, period.buckets || 10);
  const since = now - sinceMs;
  const bucketSize = sinceMs / buckets;

  const slots = Array.from({ length: buckets }, (_, i) => ({
    ts: since + i * bucketSize,
    sum: 0,
    count: 0,
  }));

  for (const entry of store.outcomesLog) {
    if (entry.ts < since || entry.ts > now) continue;
    const idx = Math.min(buckets - 1, Math.max(0, Math.floor((entry.ts - since) / bucketSize)));
    const slot = slots[idx];
    let value;
    switch (metric) {
      case "avg_duration":
        value = typeof entry.duration === "number" ? entry.duration : 0;
        break;
      case "avg_cost":
        value = typeof entry.cost === "number" ? entry.cost : 0;
        break;
      case "avg_rating":
        // approximated; rating lives on decisions store, not outcomesLog
        value = 0;
        break;
      case "success_rate":
      default:
        value = entry.success ? 1 : 0;
    }
    slot.sum += value;
    slot.count += 1;
  }

  const dataPoints = slots.map((s) => ({
    ts: Math.round(s.ts),
    value: s.count > 0 ? s.sum / s.count : 0,
    count: s.count,
  }));

  // Compute trend: linear regression slope
  const xs = dataPoints.map((_, i) => i);
  const ys = dataPoints.map((d) => d.value);
  const n = xs.length;
  const sumX = xs.reduce((a, b) => a + b, 0);
  const sumY = ys.reduce((a, b) => a + b, 0);
  const sumXY = xs.reduce((acc, x, i) => acc + x * ys[i], 0);
  const sumX2 = xs.reduce((a, b) => a + b * b, 0);
  const denom = n * sumX2 - sumX * sumX;
  const slope = denom !== 0 ? (n * sumXY - sumX * sumY) / denom : 0;
  const trend = slope > 0.001 ? "up" : slope < -0.001 ? "down" : "flat";

  // Improvement rate = first vs last non-zero bucket
  const first = dataPoints.find((d) => d.count > 0);
  const last = [...dataPoints].reverse().find((d) => d.count > 0);
  const improvementRate =
    first && last && first !== last && first.value !== 0
      ? (last.value - first.value) / Math.abs(first.value)
      : 0;

  return { dataPoints, trend, improvementRate: Math.round(improvementRate * 10000) / 10000 };
}

// ─── reset / introspection ───────────────────────────────────────────────

/**
 * Clear all meta-learning data, optionally scoped to a workspace (for now
 * workspace filtering is best-effort — outcomesLog supports it, weights/
 * performance are global).
 */
export async function resetLearning(workspaceId) {
  await loadFromDisk();
  if (!workspaceId) {
    Object.assign(store, emptyStore());
  } else {
    store.outcomesLog = store.outcomesLog.filter((o) => o.workspaceId !== workspaceId);
    for (const id of Object.keys(store.decisions)) {
      if (store.decisions[id].decision.workspaceId === workspaceId) {
        delete store.decisions[id];
      }
    }
  }
  markDirty();
  return { ok: true };
}

/**
 * Inspect current in-memory store (exposed for tests and admin tooling).
 */
export function _getStore() {
  return store;
}

export function _resetStore() {
  Object.assign(store, emptyStore());
  dirty = false;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  loaded = true; // Prevent re-loading disk state in tests
}
