/**
 * Agent learning system — extracts performance signals from agent trajectories
 * and builds per-profile success models for smarter routing.
 *
 * Pure in-memory store: Map<workspace, Map<profile, OutcomeRecord[]>>.
 * Capped at MAX_RECORDS_PER_PROFILE per profile per workspace (oldest evicted).
 */

const MAX_RECORDS_PER_PROFILE = 1000;
const MIN_RECORDS_FOR_SUGGESTION = 5;

/**
 * @typedef {Object} OutcomeRecord
 * @property {string} profile
 * @property {string} goal
 * @property {string[]} toolsUsed
 * @property {number} iterations
 * @property {number} costUsd
 * @property {boolean} success
 * @property {number} durationMs
 * @property {number} recordedAt
 */

/** @type {Map<string, Map<string, OutcomeRecord[]>>} */
const store = new Map();

/**
 * Retrieve or initialise the per-profile map for a workspace.
 * @param {string} workspace
 * @returns {Map<string, OutcomeRecord[]>}
 */
function ensureWorkspace(workspace) {
  let ws = store.get(workspace);
  if (!ws) {
    ws = new Map();
    store.set(workspace, ws);
  }
  return ws;
}

/**
 * Record the outcome of an agent run for learning purposes.
 *
 * @param {Object} opts
 * @param {string} opts.workspace
 * @param {string} opts.profile
 * @param {string} opts.goal
 * @param {string[]} opts.toolsUsed
 * @param {number} opts.iterations
 * @param {number} opts.costUsd
 * @param {boolean} opts.success
 * @param {number} opts.durationMs
 */
export function recordOutcome({ workspace, profile, goal, toolsUsed, iterations, costUsd, success, durationMs }) {
  const ws = ensureWorkspace(workspace);
  let records = ws.get(profile);
  if (!records) {
    records = [];
    ws.set(profile, records);
  }

  records.push({
    profile,
    goal: String(goal || ""),
    toolsUsed: Array.isArray(toolsUsed) ? [...toolsUsed] : [],
    iterations: Number(iterations) || 0,
    costUsd: Number(costUsd) || 0,
    success: Boolean(success),
    durationMs: Number(durationMs) || 0,
    recordedAt: Date.now(),
  });

  // Evict oldest when over cap
  while (records.length > MAX_RECORDS_PER_PROFILE) {
    records.shift();
  }
}

/**
 * Compute stats for a specific profile (or all profiles) in a workspace.
 *
 * @param {string} workspace
 * @param {string} [profile] - If omitted, returns stats for all profiles.
 * @returns {Object|Object[]} Single stats object or array of stats objects.
 */
export function getProfileStats(workspace, profile) {
  const ws = store.get(workspace);
  if (!ws) {
    if (profile) {
      return { profile, runs: 0, successRate: 0, avgCost: 0, avgIterations: 0, avgDuration: 0, topTools: [] };
    }
    return [];
  }

  function computeStats(profileId, records) {
    if (!records || records.length === 0) {
      return { profile: profileId, runs: 0, successRate: 0, avgCost: 0, avgIterations: 0, avgDuration: 0, topTools: [] };
    }

    const runs = records.length;
    const successes = records.filter((r) => r.success).length;
    const successRate = successes / runs;
    const avgCost = records.reduce((s, r) => s + r.costUsd, 0) / runs;
    const avgIterations = records.reduce((s, r) => s + r.iterations, 0) / runs;
    const avgDuration = records.reduce((s, r) => s + r.durationMs, 0) / runs;

    // topTools: most frequently used tools across successful runs
    const successfulRecords = records.filter((r) => r.success);
    const toolCounts = new Map();
    for (const rec of successfulRecords) {
      for (const tool of rec.toolsUsed) {
        toolCounts.set(tool, (toolCounts.get(tool) || 0) + 1);
      }
    }
    const topTools = [...toolCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([tool]) => tool);

    return { profile: profileId, runs, successRate, avgCost, avgIterations, avgDuration, topTools };
  }

  if (profile) {
    return computeStats(profile, ws.get(profile) || []);
  }

  const results = [];
  for (const [pid, records] of ws.entries()) {
    results.push(computeStats(pid, records));
  }
  return results;
}

/**
 * Suggest the best profile for a given goal based on historical performance.
 *
 * Scoring: successRate * 0.4 + (1 - normalizedCost) * 0.3 + (1 - normalizedIterations) * 0.3
 *
 * Profiles with fewer than MIN_RECORDS_FOR_SUGGESTION records are excluded.
 * If no profile qualifies, returns { profile: "default", confidence: 0, reason: "insufficient data" }.
 *
 * @param {string} workspace
 * @param {string} goal
 * @returns {{ profile: string, confidence: number, reason: string }}
 */
export function suggestProfile(workspace, goal) {
  const ws = store.get(workspace);
  if (!ws) {
    return { profile: "default", confidence: 0, reason: "insufficient data" };
  }

  // Gather stats for profiles with enough records
  const candidates = [];
  for (const [pid, records] of ws.entries()) {
    if (records.length < MIN_RECORDS_FOR_SUGGESTION) continue;
    const stats = getProfileStats(workspace, pid);
    candidates.push(stats);
  }

  if (candidates.length === 0) {
    return { profile: "default", confidence: 0, reason: "insufficient data" };
  }

  // Find max cost and max iterations for normalization
  const maxCost = Math.max(...candidates.map((c) => c.avgCost), 0.001);
  const maxIterations = Math.max(...candidates.map((c) => c.avgIterations), 1);

  let best = null;
  let bestScore = -Infinity;

  for (const c of candidates) {
    const normalizedCost = c.avgCost / maxCost;
    const normalizedIterations = c.avgIterations / maxIterations;
    const score = c.successRate * 0.4 + (1 - normalizedCost) * 0.3 + (1 - normalizedIterations) * 0.3;

    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }

  return {
    profile: best.profile,
    confidence: Math.round(bestScore * 1000) / 1000,
    reason: `best score ${Math.round(bestScore * 1000) / 1000} (${best.runs} runs, ${Math.round(best.successRate * 100)}% success)`,
  };
}

/**
 * Aggregate learning stats for an entire workspace.
 *
 * @param {string} workspace
 * @returns {{ profiles: Object[], totalRuns: number }}
 */
export function getWorkspaceLearningStats(workspace) {
  const ws = store.get(workspace);
  if (!ws) {
    return { profiles: [], totalRuns: 0 };
  }

  const profiles = getProfileStats(workspace);
  const totalRuns = profiles.reduce((s, p) => s + p.runs, 0);
  return { profiles, totalRuns };
}

/**
 * Reset all learning data. For tests only.
 */
export function __resetLearningForTests() {
  store.clear();
}
