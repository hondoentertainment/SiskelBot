/**
 * Track and score model quality per backend.
 * Quality = f(latency, error_rate, token_throughput, user_satisfaction)
 *
 * Storage: in-memory with periodic flush to data/model-quality.json
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";

const DATA_FILE = join(process.cwd(), "data", "model-quality.json");

/** Max latency (ms) used for score normalisation */
const MAX_LATENCY = 30_000;

/** Max throughput (tokens/sec) used for score normalisation */
const MAX_THROUGHPUT = 200;

/** Flush interval — 60 seconds */
const FLUSH_INTERVAL_MS = 60_000;

/** Window size for time-bucketed history (1 hour buckets) */
const BUCKET_MS = 3_600_000;

/**
 * Per-model stats accumulator.
 * @type {Map<string, ModelStats>}
 *
 * @typedef {{
 *   latencies: number[];
 *   tokens: number[];
 *   errors: number;
 *   total: number;
 *   ratings: number[];
 *   history: { ts: number; score: number }[];
 * }} ModelStats
 */
const models = new Map();

let flushTimer = null;

// ─── helpers ────────────────────────────────────────────────────────────────

function ensureModel(model) {
  if (!models.has(model)) {
    models.set(model, {
      latencies: [],
      tokens: [],
      errors: 0,
      total: 0,
      ratings: [],
      history: [],
    });
  }
  return models.get(model);
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function computeScore(stats) {
  if (stats.total === 0) return 0;

  const errorRate = stats.errors / stats.total;
  const sorted = [...stats.latencies].sort((a, b) => a - b);
  const p95 = percentile(sorted, 95);

  // throughput = avg tokens / avg latency (tokens/sec)
  const avgTokens =
    stats.tokens.length > 0
      ? stats.tokens.reduce((s, t) => s + t, 0) / stats.tokens.length
      : 0;
  const avgLatency =
    stats.latencies.length > 0
      ? stats.latencies.reduce((s, t) => s + t, 0) / stats.latencies.length
      : 1;
  const throughput = avgLatency > 0 ? (avgTokens / avgLatency) * 1000 : 0;

  const avgRating =
    stats.ratings.length > 0
      ? stats.ratings.reduce((s, r) => s + r, 0) / stats.ratings.length
      : 3; // neutral default

  const score =
    (1 - errorRate) * 40 +
    clamp(1 - p95 / MAX_LATENCY, 0, 1) * 30 +
    clamp(throughput / MAX_THROUGHPUT, 0, 1) * 20 +
    (avgRating / 5) * 10;

  return Math.round(score * 100) / 100;
}

// ─── public API ─────────────────────────────────────────────────────────────

/**
 * Record a model response for quality tracking.
 * @param {string} model
 * @param {{ latencyMs: number; tokens: number; error: boolean; rating?: number }} metrics
 */
export function recordModelResponse(model, metrics) {
  if (!model || typeof model !== "string") return;
  const stats = ensureModel(model);
  stats.total += 1;
  if (metrics.error) stats.errors += 1;
  if (typeof metrics.latencyMs === "number" && metrics.latencyMs >= 0) {
    stats.latencies.push(metrics.latencyMs);
  }
  if (typeof metrics.tokens === "number" && metrics.tokens >= 0) {
    stats.tokens.push(metrics.tokens);
  }
  if (typeof metrics.rating === "number" && metrics.rating >= 1 && metrics.rating <= 5) {
    stats.ratings.push(metrics.rating);
  }

  // Cap arrays to last 10 000 samples
  const cap = 10_000;
  if (stats.latencies.length > cap) stats.latencies = stats.latencies.slice(-cap);
  if (stats.tokens.length > cap) stats.tokens = stats.tokens.slice(-cap);
  if (stats.ratings.length > cap) stats.ratings = stats.ratings.slice(-cap);

  // Bucket-level history entry (one per hour)
  const now = Date.now();
  const bucketTs = now - (now % BUCKET_MS);
  const last = stats.history[stats.history.length - 1];
  const score = computeScore(stats);
  if (!last || last.ts !== bucketTs) {
    stats.history.push({ ts: bucketTs, score });
  } else {
    last.score = score;
  }

  // Trim history to last 30 days
  const cutoff = now - 30 * 24 * BUCKET_MS;
  stats.history = stats.history.filter((h) => h.ts >= cutoff);

  scheduleFlush();
}

/**
 * Get quality metrics for a model.
 * @param {string} model
 * @returns {{ score: number; latencyP50: number; latencyP95: number; errorRate: number; throughput: number; sampleCount: number }}
 */
export function getModelQuality(model) {
  const stats = models.get(model);
  if (!stats || stats.total === 0) {
    return { score: 0, latencyP50: 0, latencyP95: 0, errorRate: 0, throughput: 0, sampleCount: 0 };
  }
  const sorted = [...stats.latencies].sort((a, b) => a - b);
  const p50 = percentile(sorted, 50);
  const p95 = percentile(sorted, 95);
  const errorRate = stats.errors / stats.total;

  const avgTokens =
    stats.tokens.length > 0
      ? stats.tokens.reduce((s, t) => s + t, 0) / stats.tokens.length
      : 0;
  const avgLatency =
    stats.latencies.length > 0
      ? stats.latencies.reduce((s, t) => s + t, 0) / stats.latencies.length
      : 1;
  const throughput = avgLatency > 0 ? (avgTokens / avgLatency) * 1000 : 0;

  return {
    score: computeScore(stats),
    latencyP50: Math.round(p50),
    latencyP95: Math.round(p95),
    errorRate: Math.round(errorRate * 10000) / 10000,
    throughput: Math.round(throughput * 100) / 100,
    sampleCount: stats.total,
  };
}

/**
 * Get all models ranked by quality score (descending).
 * @returns {{ model: string; score: number; latencyP50: number; latencyP95: number; errorRate: number; throughput: number; sampleCount: number }[]}
 */
export function getModelRanking() {
  const ranking = [];
  for (const model of models.keys()) {
    ranking.push({ model, ...getModelQuality(model) });
  }
  ranking.sort((a, b) => b.score - a.score);
  return ranking;
}

/**
 * Given a list of candidate model names, return the best one by quality score.
 * Falls back to the first candidate if no quality data exists.
 * @param {string[]} candidates
 * @returns {string}
 */
export function getBestModel(candidates) {
  if (!candidates || candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

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

  return hasData ? best : candidates[0];
}

/**
 * Return time-series quality history for a model.
 * @param {string} model
 * @param {string} [period="7d"] - e.g. "1d", "7d", "30d"
 * @returns {{ ts: number; score: number }[]}
 */
export function getQualityHistory(model, period) {
  const stats = models.get(model);
  if (!stats) return [];

  const match = String(period || "7d").match(/^(\d+)([dhm])$/);
  let ms = 7 * 24 * 3_600_000; // default 7d
  if (match) {
    const n = parseInt(match[1], 10);
    const unit = match[2];
    if (unit === "d") ms = n * 24 * 3_600_000;
    else if (unit === "h") ms = n * 3_600_000;
    else if (unit === "m") ms = n * 60_000;
  }

  const cutoff = Date.now() - ms;
  return stats.history.filter((h) => h.ts >= cutoff);
}

/**
 * Reset all stats for a model (or all models if no model given).
 * @param {string} [model]
 */
export function resetModelStats(model) {
  if (model) {
    models.delete(model);
  } else {
    models.clear();
  }
}

/**
 * Detect auto-promotion: if any model's score exceeds the current default
 * by 10+ points over 100+ samples, return a recommendation.
 * @param {string} currentDefault
 * @returns {{ recommended: string; currentScore: number; recommendedScore: number; sampleCount: number } | null}
 */
export function checkAutoPromotion(currentDefault) {
  const currentQ = getModelQuality(currentDefault);
  const currentScore = currentQ.score;

  for (const [model, stats] of models) {
    if (model === currentDefault) continue;
    if (stats.total < 100) continue;
    const q = getModelQuality(model);
    if (q.score >= currentScore + 10) {
      return {
        recommended: model,
        currentScore,
        recommendedScore: q.score,
        sampleCount: stats.total,
      };
    }
  }
  return null;
}

// ─── persistence ────────────────────────────────────────────────────────────

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    await flushToDisk().catch((e) =>
      console.warn("[model-quality] Flush failed:", e.message)
    );
  }, FLUSH_INTERVAL_MS);
  if (flushTimer.unref) flushTimer.unref();
}

async function flushToDisk() {
  const data = {};
  for (const [model, stats] of models) {
    data[model] = {
      latencies: stats.latencies.slice(-1000), // persist last 1000
      tokens: stats.tokens.slice(-1000),
      errors: stats.errors,
      total: stats.total,
      ratings: stats.ratings.slice(-1000),
      history: stats.history,
    };
  }
  await mkdir(dirname(DATA_FILE), { recursive: true });
  await writeFile(DATA_FILE, JSON.stringify(data, null, 2));
}

/**
 * Load persisted quality data from disk.
 */
export async function loadFromDisk() {
  try {
    const raw = await readFile(DATA_FILE, "utf8");
    const data = JSON.parse(raw);
    for (const [model, stats] of Object.entries(data)) {
      models.set(model, {
        latencies: stats.latencies || [],
        tokens: stats.tokens || [],
        errors: stats.errors || 0,
        total: stats.total || 0,
        ratings: stats.ratings || [],
        history: stats.history || [],
      });
    }
  } catch {
    // No persisted data — start fresh
  }
}

/**
 * Force flush (for graceful shutdown).
 */
export async function flush() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  await flushToDisk();
}
