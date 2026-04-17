/**
 * Cost prediction for agent runs based on historical data.
 *
 * Maintains an in-memory history of cost records per workspace, and uses
 * that history to predict the cost of future runs. When insufficient data
 * is available (< 5 matching records), falls back to a heuristic based on
 * goal length and the model's per-1K-token cost from smart-router.
 *
 * @module cost-predictor
 */

import { getModelCost } from "./smart-router.js";

/** Maximum records retained per workspace. */
const MAX_RECORDS_PER_WORKSPACE = 2000;

/**
 * @typedef {{
 *   workspace: string;
 *   profile: string | null;
 *   model: string;
 *   goal: string | null;
 *   costUsd: number;
 *   iterations: number;
 *   tokens: number;
 *   timestamp: number;
 * }} CostRecord
 */

/**
 * Per-workspace history of cost records.
 * @type {Map<string, CostRecord[]>}
 */
const history = new Map();

/**
 * Record the cost of a completed agent run.
 *
 * @param {{
 *   workspace: string;
 *   profile?: string | null;
 *   model: string;
 *   goal?: string | null;
 *   costUsd: number;
 *   iterations?: number;
 *   tokens?: number;
 * }} record
 */
export function recordRunCost(record) {
  const workspace = String(record?.workspace || "default");
  const entry = {
    workspace,
    profile: record.profile ?? null,
    model: String(record.model || ""),
    goal: record.goal ?? null,
    costUsd: Number(record.costUsd) || 0,
    iterations: Number(record.iterations) || 0,
    tokens: Number(record.tokens) || 0,
    timestamp: Date.now(),
  };

  let records = history.get(workspace);
  if (!records) {
    records = [];
    history.set(workspace, records);
  }
  records.push(entry);

  // Evict oldest records when exceeding the cap.
  if (records.length > MAX_RECORDS_PER_WORKSPACE) {
    records.splice(0, records.length - MAX_RECORDS_PER_WORKSPACE);
  }
}

/**
 * Predict the cost of an agent run based on historical data.
 *
 * Filters history by workspace, optionally by profile and model. If at
 * least 5 matching records exist, returns p50 and p90 of costUsd as the
 * estimate. Otherwise, falls back to a heuristic:
 *   goalLength / 100 * getModelCost(model) * 15
 * which assumes ~15 iterations of ~100 tokens each.
 *
 * Confidence is `min(matchingRecords / 20, 1.0)`.
 *
 * @param {{
 *   workspace: string;
 *   profile?: string | null;
 *   model: string;
 *   goalLength?: number;
 * }} params
 * @returns {{
 *   estimatedUsd: number;
 *   confidence: number;
 *   basedOnRuns: number;
 *   p50Usd: number;
 *   p90Usd: number;
 * }}
 */
export function predictCost({ workspace, profile, model, goalLength }) {
  const ws = String(workspace || "default");
  const records = history.get(ws) || [];

  // Filter by model (required). Filter by profile only when provided.
  const matching = records.filter((r) => {
    if (r.model !== model) return false;
    if (profile != null && r.profile !== profile) return false;
    return true;
  });

  const basedOnRuns = matching.length;
  const confidence = Math.min(basedOnRuns / 20, 1.0);

  if (basedOnRuns >= 5) {
    const sorted = matching.map((r) => r.costUsd).sort((a, b) => a - b);
    const p50Usd = percentile(sorted, 0.5);
    const p90Usd = percentile(sorted, 0.9);
    return {
      estimatedUsd: p50Usd,
      confidence,
      basedOnRuns,
      p50Usd,
      p90Usd,
    };
  }

  // Heuristic fallback: goalLength/100 * getModelCost(model) * 15
  const len = Number(goalLength) || 100;
  const costPer1k = Number(getModelCost(model)) || 0;
  const heuristicUsd = (len / 100) * costPer1k * 15;

  return {
    estimatedUsd: heuristicUsd,
    confidence,
    basedOnRuns,
    p50Usd: heuristicUsd,
    p90Usd: heuristicUsd,
  };
}

/**
 * Compute a percentile from a sorted array of numbers.
 * Uses linear interpolation between the two nearest ranks.
 *
 * @param {number[]} sorted - Sorted array of values
 * @param {number} p - Percentile in [0, 1]
 * @returns {number}
 */
function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = p * (sorted.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sorted[lower];
  const frac = idx - lower;
  return sorted[lower] * (1 - frac) + sorted[upper] * frac;
}

/**
 * Reset all predictor state. Exposed only for unit tests.
 */
export function __resetPredictorForTests() {
  history.clear();
}
