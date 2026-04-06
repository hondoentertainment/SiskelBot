/**
 * Phase 22: Real-time analytics engine.
 * Comprehensive analytics: usage trends, top models/users, agent stats, cost estimates, error breakdown.
 */
import { getRecordsForPeriod } from "./usage-tracker.js";
import { estimateCost } from "./analytics.js";

const PERIOD_DAYS = { "24h": 1, "7d": 7, "30d": 30, "90d": 90 };

/** Resolve period string to number of days. */
function parsePeriod(period) {
  return PERIOD_DAYS[period] || 7;
}

/** Build time bucket keys for a period and granularity. */
function bucketKey(ts, granularity) {
  const d = new Date(ts);
  if (granularity === "hour") {
    return d.toISOString().slice(0, 13); // "2026-04-05T14"
  }
  if (granularity === "week") {
    // ISO week: floor to Monday
    const day = d.getUTCDay();
    const diff = (day === 0 ? -6 : 1) - day;
    const monday = new Date(d);
    monday.setUTCDate(monday.getUTCDate() + diff);
    return monday.toISOString().slice(0, 10);
  }
  // default: day
  return d.toISOString().slice(0, 10);
}

/** Fill missing buckets between start and end so charts have continuous data. */
function fillBuckets(buckets, periodDays, granularity) {
  const now = Date.now();
  const start = now - periodDays * 24 * 60 * 60 * 1000;
  const filled = [];
  const stepMs =
    granularity === "hour"
      ? 3600_000
      : granularity === "week"
        ? 7 * 86_400_000
        : 86_400_000;

  for (let t = start; t <= now; t += stepMs) {
    const key = bucketKey(new Date(t).toISOString(), granularity);
    if (filled.length > 0 && filled[filled.length - 1].timestamp === key) continue;
    const existing = buckets[key];
    filled.push({
      timestamp: key,
      requests: existing?.requests || 0,
      tokens: existing?.tokens || 0,
      cost: existing?.cost || 0,
      errors: existing?.errors || 0,
    });
  }
  return filled;
}

/**
 * Get usage trends over time.
 * @param {string} workspaceId
 * @param {string} period - '24h'|'7d'|'30d'|'90d'
 * @param {string} granularity - 'hour'|'day'|'week'
 * @returns {Promise<{ dataPoints: Array }>}
 */
export async function getUsageTrends(workspaceId, period, granularity) {
  const days = parsePeriod(period);
  const gran = ["hour", "day", "week"].includes(granularity) ? granularity : "day";
  const opts = workspaceId ? { workspace: workspaceId } : {};
  const records = await getRecordsForPeriod(days, opts);

  const buckets = {};
  for (const r of records) {
    const key = bucketKey(r.timestamp, gran);
    if (!buckets[key]) buckets[key] = { requests: 0, tokens: 0, cost: 0, errors: 0 };
    buckets[key].requests += 1;
    const tokens = (r.inputTokens || 0) + (r.outputTokens || 0);
    buckets[key].tokens += tokens;
    const { cost } = estimateCost(r.inputTokens || 0, r.outputTokens || 0, r.backend);
    buckets[key].cost += cost;
    if (r.error) buckets[key].errors += 1;
  }

  return { dataPoints: fillBuckets(buckets, days, gran) };
}

/**
 * Get top models by usage.
 * @param {string} workspaceId
 * @param {string} period
 * @returns {Promise<Array<{ model, requests, tokens, avgLatency }>>}
 */
export async function getTopModels(workspaceId, period) {
  const days = parsePeriod(period);
  const opts = workspaceId ? { workspace: workspaceId } : {};
  const records = await getRecordsForPeriod(days, opts);

  const models = {};
  for (const r of records) {
    const m = r.model || "unknown";
    if (!models[m]) models[m] = { requests: 0, tokens: 0, totalLatency: 0 };
    models[m].requests += 1;
    models[m].tokens += (r.inputTokens || 0) + (r.outputTokens || 0);
    models[m].totalLatency += r.durationMs || 0;
  }

  return Object.entries(models)
    .map(([model, v]) => ({
      model,
      requests: v.requests,
      tokens: v.tokens,
      avgLatency: v.requests > 0 ? Math.round(v.totalLatency / v.requests) : 0,
    }))
    .sort((a, b) => b.tokens - a.tokens);
}

/**
 * Get top users by usage.
 * @param {string} workspaceId
 * @param {string} period
 * @returns {Promise<Array<{ userId, requests, tokens }>>}
 */
export async function getTopUsers(workspaceId, period) {
  const days = parsePeriod(period);
  const opts = workspaceId ? { workspace: workspaceId } : {};
  const records = await getRecordsForPeriod(days, opts);

  const users = {};
  for (const r of records) {
    const uid = r.userId || "anonymous";
    if (!users[uid]) users[uid] = { requests: 0, tokens: 0 };
    users[uid].requests += 1;
    users[uid].tokens += (r.inputTokens || 0) + (r.outputTokens || 0);
  }

  return Object.entries(users)
    .map(([userId, v]) => ({ userId, requests: v.requests, tokens: v.tokens }))
    .sort((a, b) => b.tokens - a.tokens);
}

/**
 * Get agent execution statistics.
 * @param {string} workspaceId
 * @param {string} period
 * @returns {Promise<{ totalRuns, avgIterations, toolUsage, successRate, avgDuration }>}
 */
export async function getAgentStats(workspaceId, period) {
  const days = parsePeriod(period);
  const opts = workspaceId ? { workspace: workspaceId } : {};
  const records = await getRecordsForPeriod(days, opts);

  const agentRecords = records.filter((r) => r.agentMode || r.isAgent);
  const totalRuns = agentRecords.length;
  let totalIterations = 0;
  let totalDuration = 0;
  let successCount = 0;
  const toolUsage = {};

  for (const r of agentRecords) {
    totalIterations += r.iterations || 1;
    totalDuration += r.durationMs || 0;
    if (!r.error) successCount += 1;
    if (Array.isArray(r.toolCalls)) {
      for (const t of r.toolCalls) {
        const name = t.name || t.function?.name || "unknown";
        toolUsage[name] = (toolUsage[name] || 0) + 1;
      }
    }
  }

  return {
    totalRuns,
    avgIterations: totalRuns > 0 ? Math.round((totalIterations / totalRuns) * 10) / 10 : 0,
    toolUsage,
    successRate: totalRuns > 0 ? Math.round((successCount / totalRuns) * 1000) / 10 : 100,
    avgDuration: totalRuns > 0 ? Math.round(totalDuration / totalRuns) : 0,
  };
}

/**
 * Get cost estimate breakdown.
 * @param {string} workspaceId
 * @param {string} period
 * @returns {Promise<{ totalTokens, estimatedCost, breakdown }>}
 */
export async function getCostEstimate(workspaceId, period) {
  const days = parsePeriod(period);
  const opts = workspaceId ? { workspace: workspaceId } : {};
  const records = await getRecordsForPeriod(days, opts);

  let totalTokens = 0;
  let totalCost = 0;
  const breakdown = {};

  for (const r of records) {
    const input = r.inputTokens || 0;
    const output = r.outputTokens || 0;
    totalTokens += input + output;
    const { cost } = estimateCost(input, output, r.backend);
    totalCost += cost;

    const model = r.model || "unknown";
    if (!breakdown[model]) breakdown[model] = 0;
    breakdown[model] += cost;
  }

  // Round breakdown values
  for (const m of Object.keys(breakdown)) {
    breakdown[m] = Math.round(breakdown[m] * 10000) / 10000;
  }

  return {
    totalTokens,
    estimatedCost: Math.round(totalCost * 10000) / 10000,
    breakdown,
  };
}

/**
 * Get error breakdown by code.
 * @param {string} workspaceId
 * @param {string} period
 * @returns {Promise<Array<{ code, count, lastOccurred }>>}
 */
export async function getErrorBreakdown(workspaceId, period) {
  const days = parsePeriod(period);
  const opts = workspaceId ? { workspace: workspaceId } : {};
  const records = await getRecordsForPeriod(days, opts);

  const errors = {};
  for (const r of records) {
    if (!r.error) continue;
    const code = r.errorCode || r.error || "UNKNOWN_ERROR";
    if (!errors[code]) errors[code] = { count: 0, lastOccurred: r.timestamp };
    errors[code].count += 1;
    if (r.timestamp > errors[code].lastOccurred) {
      errors[code].lastOccurred = r.timestamp;
    }
  }

  return Object.entries(errors)
    .map(([code, v]) => ({ code, count: v.count, lastOccurred: v.lastOccurred }))
    .sort((a, b) => b.count - a.count);
}
