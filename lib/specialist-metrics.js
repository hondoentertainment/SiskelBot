/**
 * Per-specialist quality tracking. Records latency, success, and optional
 * quality (from judge) per specialist per intent category. Stored in
 * data/specialist-metrics.json (or via JSON path store) and queryable for
 * routing decisions. Routing integration is opt-in via SWARM_LEARNED_ROUTING=1.
 *
 * The store is workspace-scoped and bounded (LAST N observations per key).
 */

import { join } from "path";
import { readJsonPath, writeJsonPath, getDataDir } from "./json-path-store.js";

const MAX_OBSERVATIONS_PER_KEY = 50;

function storePath() {
  return join(getDataDir(), "specialist-metrics.json");
}

/**
 * Build the composite key for a (workspace, specialist, intent) tuple.
 */
function buildKey(workspace, specialist, intent) {
  const ws = String(workspace || "default");
  const sp = String(specialist || "unknown");
  const it = String(intent || "unknown");
  return `${ws}::${sp}::${it}`;
}

async function loadMetrics() {
  try {
    const data = await readJsonPath(storePath(), {});
    return (data && typeof data === "object") ? data : {};
  } catch {
    return {};
  }
}

async function saveMetrics(data) {
  try {
    await writeJsonPath(storePath(), data);
    return true;
  } catch {
    return false;
  }
}

/**
 * Record a specialist observation. Best-effort: never throws.
 * @param {{
 *   workspace: string,
 *   specialist: string,
 *   intent: string,
 *   latencyMs: number,
 *   success: boolean,
 *   quality?: number,
 * }} obs
 */
export async function recordSpecialistObservation(obs) {
  if (!obs || !obs.specialist) return;
  try {
    const key = buildKey(obs.workspace, obs.specialist, obs.intent);
    const data = await loadMetrics();
    const list = Array.isArray(data[key]) ? data[key] : [];
    list.push({
      t: Date.now(),
      latencyMs: Number(obs.latencyMs) || 0,
      success: obs.success === true,
      ...(typeof obs.quality === "number" && { quality: Math.max(0, Math.min(1, obs.quality)) }),
    });
    // Cap size; keep the most recent
    if (list.length > MAX_OBSERVATIONS_PER_KEY) list.splice(0, list.length - MAX_OBSERVATIONS_PER_KEY);
    data[key] = list;
    await saveMetrics(data);
  } catch {
    // Best-effort
  }
}

/**
 * Summarize observations for a (workspace, specialist, intent) key.
 * @returns {Promise<{ count: number, successRate: number, avgLatencyMs: number, avgQuality: number|null }>}
 */
export async function getSpecialistStats(workspace, specialist, intent) {
  try {
    const data = await loadMetrics();
    const list = data[buildKey(workspace, specialist, intent)];
    if (!Array.isArray(list) || list.length === 0) {
      return { count: 0, successRate: 0, avgLatencyMs: 0, avgQuality: null };
    }
    const n = list.length;
    let succ = 0, latSum = 0, qSum = 0, qN = 0;
    for (const o of list) {
      if (o.success) succ++;
      latSum += Number(o.latencyMs) || 0;
      if (typeof o.quality === "number") { qSum += o.quality; qN++; }
    }
    return {
      count: n,
      successRate: succ / n,
      avgLatencyMs: latSum / n,
      avgQuality: qN > 0 ? qSum / qN : null,
    };
  } catch {
    return { count: 0, successRate: 0, avgLatencyMs: 0, avgQuality: null };
  }
}

/**
 * Rank specialists for a given (workspace, intent) by combined score.
 * Score = 0.5 * successRate + 0.3 * (avgQuality||successRate) + 0.2 * latencyRank.
 * Only returns rankings when each specialist has at least `minObservations`
 * observations. Caller should fall back to default routing otherwise.
 *
 * @param {string} workspace
 * @param {string} intent
 * @param {string[]} specialists
 * @param {number} [minObservations]
 * @returns {Promise<Array<{ specialist: string, score: number, stats: object }> | null>}
 */
export async function rankSpecialists(workspace, intent, specialists, minObservations = 3) {
  if (!Array.isArray(specialists) || specialists.length === 0) return null;
  const rows = [];
  for (const sp of specialists) {
    const stats = await getSpecialistStats(workspace, sp, intent);
    if (stats.count < minObservations) return null;
    rows.push({ specialist: sp, stats });
  }
  // Latency rank: lower is better; normalize.
  const maxLat = Math.max(1, ...rows.map((r) => r.stats.avgLatencyMs));
  for (const r of rows) {
    const qual = r.stats.avgQuality != null ? r.stats.avgQuality : r.stats.successRate;
    const latScore = 1 - (r.stats.avgLatencyMs / maxLat);
    r.score = 0.5 * r.stats.successRate + 0.3 * qual + 0.2 * latScore;
  }
  rows.sort((a, b) => b.score - a.score);
  return rows;
}

export function learnedRoutingEnabled() {
  return process.env.SWARM_LEARNED_ROUTING === "1";
}
