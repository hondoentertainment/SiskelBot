/**
 * In-memory metrics aggregator for the observability dashboard.
 * Collects request timing, error counts, and system stats.
 * Retains last 1 hour of per-minute buckets via a circular buffer.
 */

const MAX_BUCKETS = 60; // 1 hour of 1-minute buckets

/** Create an empty bucket for a given minute timestamp. */
function emptyBucket(minuteTs) {
  return {
    minuteTs,
    // Latency: path -> { count, sumMs, min, max, values[] }
    latency: new Map(),
    // Status code counts: statusCode -> count
    statusCodes: new Map(),
    // Agent runs: { count, totalToolCalls, totalDurationMs, stagnatedCount }
    agents: { count: 0, totalToolCalls: 0, totalDurationMs: 0, stagnatedCount: 0 },
    // Token usage: workspaceId -> { model -> tokens }
    tokens: new Map(),
  };
}

/** Circular buffer of minute-buckets. */
const buckets = new Array(MAX_BUCKETS).fill(null);
let headIndex = 0; // points to the newest bucket slot

/** Get the minute-aligned timestamp (ms) for a given time. */
function minuteTs(ts = Date.now()) {
  return Math.floor(ts / 60_000) * 60_000;
}

/** Get or create the current-minute bucket. */
function currentBucket() {
  const now = minuteTs();
  const head = buckets[headIndex];
  if (head && head.minuteTs === now) return head;

  // Advance to next slot
  headIndex = (headIndex + 1) % MAX_BUCKETS;
  const b = emptyBucket(now);
  buckets[headIndex] = b;
  return b;
}

/** Get all non-null buckets within the given window (minutes). */
function bucketsInWindow(windowMinutes = 60) {
  const cutoff = minuteTs() - windowMinutes * 60_000;
  const result = [];
  for (let i = 0; i < MAX_BUCKETS; i++) {
    const b = buckets[i];
    if (b && b.minuteTs >= cutoff) result.push(b);
  }
  result.sort((a, b) => a.minuteTs - b.minuteTs);
  return result;
}

/**
 * Record a request's latency and status code.
 * @param {string} path - Route path (e.g. "/api/v1/chat")
 * @param {string} method - HTTP method
 * @param {number} durationMs - Request duration in ms
 * @param {number} statusCode - HTTP status code
 */
export function recordLatency(path, method, durationMs, statusCode) {
  const b = currentBucket();
  const key = `${method} ${path}`;

  if (!b.latency.has(key)) {
    b.latency.set(key, { count: 0, sumMs: 0, min: Infinity, max: -Infinity, values: [] });
  }
  const entry = b.latency.get(key);
  entry.count += 1;
  entry.sumMs += durationMs;
  if (durationMs < entry.min) entry.min = durationMs;
  if (durationMs > entry.max) entry.max = durationMs;
  // Keep individual values for percentile calculation (capped per bucket)
  if (entry.values.length < 10_000) entry.values.push(durationMs);

  // Status codes
  b.statusCodes.set(statusCode, (b.statusCodes.get(statusCode) || 0) + 1);
}

/**
 * Record an agent run.
 * @param {string} workspaceId
 * @param {number} toolCalls - Number of tool calls in the run
 * @param {number} durationMs - Total run duration
 * @param {boolean} stagnated - Whether the agent stagnated
 */
export function recordAgentRun(workspaceId, toolCalls, durationMs, stagnated) {
  const b = currentBucket();
  b.agents.count += 1;
  b.agents.totalToolCalls += toolCalls;
  b.agents.totalDurationMs += durationMs;
  if (stagnated) b.agents.stagnatedCount += 1;
}

/**
 * Record token usage.
 * @param {string} workspaceId
 * @param {string} model
 * @param {number} tokens
 */
export function recordTokenUsage(workspaceId, model, tokens) {
  const b = currentBucket();
  if (!b.tokens.has(workspaceId)) {
    b.tokens.set(workspaceId, new Map());
  }
  const wsMap = b.tokens.get(workspaceId);
  wsMap.set(model, (wsMap.get(model) || 0) + tokens);
}

/**
 * Calculate percentiles from an array of values.
 * @param {number[]} values - Sorted array of numbers
 * @param {number[]} percentiles - Array of percentile values (0-100)
 * @returns {object} Map of percentile -> value
 */
function calcPercentiles(values, percentiles = [50, 95, 99]) {
  if (values.length === 0) {
    return Object.fromEntries(percentiles.map((p) => [`p${p}`, 0]));
  }
  const sorted = [...values].sort((a, b) => a - b);
  const result = {};
  for (const p of percentiles) {
    const idx = Math.min(Math.floor((p / 100) * sorted.length), sorted.length - 1);
    result[`p${p}`] = sorted[idx];
  }
  return result;
}

/**
 * Get latency percentiles across all routes.
 * @param {number} [windowMinutes=60]
 * @returns {{ overall: { p50, p95, p99, avg, count }, byRoute: Object }}
 */
export function getLatencyPercentiles(windowMinutes = 60) {
  const bs = bucketsInWindow(windowMinutes);
  const allValues = [];
  const byRoute = new Map();

  for (const b of bs) {
    for (const [key, entry] of b.latency) {
      allValues.push(...entry.values);
      if (!byRoute.has(key)) byRoute.set(key, []);
      byRoute.get(key).push(...entry.values);
    }
  }

  const overall = {
    ...calcPercentiles(allValues),
    avg: allValues.length > 0 ? Math.round(allValues.reduce((s, v) => s + v, 0) / allValues.length) : 0,
    count: allValues.length,
  };

  const routes = {};
  for (const [key, vals] of byRoute) {
    routes[key] = {
      ...calcPercentiles(vals),
      avg: vals.length > 0 ? Math.round(vals.reduce((s, v) => s + v, 0) / vals.length) : 0,
      count: vals.length,
    };
  }

  return { overall, byRoute: routes };
}

/**
 * Get error rates (4xx, 5xx).
 * @param {number} [windowMinutes=60]
 * @returns {{ total: number, errors4xx: number, errors5xx: number, rate4xx: number, rate5xx: number, byMinute: Array }}
 */
export function getErrorRates(windowMinutes = 60) {
  const bs = bucketsInWindow(windowMinutes);
  let total = 0;
  let errors4xx = 0;
  let errors5xx = 0;
  const byMinute = [];

  for (const b of bs) {
    let bucketTotal = 0;
    let bucket4xx = 0;
    let bucket5xx = 0;
    for (const [code, count] of b.statusCodes) {
      bucketTotal += count;
      if (code >= 400 && code < 500) bucket4xx += count;
      if (code >= 500) bucket5xx += count;
    }
    total += bucketTotal;
    errors4xx += bucket4xx;
    errors5xx += bucket5xx;
    byMinute.push({
      minute: new Date(b.minuteTs).toISOString(),
      total: bucketTotal,
      errors4xx: bucket4xx,
      errors5xx: bucket5xx,
    });
  }

  return {
    total,
    errors4xx,
    errors5xx,
    rate4xx: total > 0 ? +(errors4xx / total).toFixed(4) : 0,
    rate5xx: total > 0 ? +(errors5xx / total).toFixed(4) : 0,
    byMinute,
  };
}

/**
 * Get agent statistics.
 * @param {number} [windowMinutes=60]
 * @returns {{ totalRuns, avgToolCalls, avgDurationMs, stagnationRate, byMinute }}
 */
export function getAgentStats(windowMinutes = 60) {
  const bs = bucketsInWindow(windowMinutes);
  let totalRuns = 0;
  let totalToolCalls = 0;
  let totalDurationMs = 0;
  let totalStagnated = 0;
  const byMinute = [];

  for (const b of bs) {
    totalRuns += b.agents.count;
    totalToolCalls += b.agents.totalToolCalls;
    totalDurationMs += b.agents.totalDurationMs;
    totalStagnated += b.agents.stagnatedCount;
    byMinute.push({
      minute: new Date(b.minuteTs).toISOString(),
      runs: b.agents.count,
      toolCalls: b.agents.totalToolCalls,
      stagnated: b.agents.stagnatedCount,
    });
  }

  return {
    totalRuns,
    avgToolCalls: totalRuns > 0 ? +(totalToolCalls / totalRuns).toFixed(2) : 0,
    avgDurationMs: totalRuns > 0 ? Math.round(totalDurationMs / totalRuns) : 0,
    stagnationRate: totalRuns > 0 ? +(totalStagnated / totalRuns).toFixed(4) : 0,
    byMinute,
  };
}

/**
 * Get token usage by workspace.
 * @param {number} [windowMinutes=60]
 * @returns {{ byWorkspace: Object, byModel: Object, total: number }}
 */
export function getTokenUsageByWorkspace(windowMinutes = 60) {
  const bs = bucketsInWindow(windowMinutes);
  const byWorkspace = {};
  const byModel = {};
  let total = 0;

  for (const b of bs) {
    for (const [wsId, modelMap] of b.tokens) {
      if (!byWorkspace[wsId]) byWorkspace[wsId] = { total: 0, byModel: {} };
      for (const [model, tokens] of modelMap) {
        byWorkspace[wsId].total += tokens;
        byWorkspace[wsId].byModel[model] = (byWorkspace[wsId].byModel[model] || 0) + tokens;
        byModel[model] = (byModel[model] || 0) + tokens;
        total += tokens;
      }
    }
  }

  return { byWorkspace, byModel, total };
}

/**
 * Get full metrics summary for the dashboard.
 * @param {number} [windowMinutes=60]
 * @returns {object}
 */
export function getMetricsSummary(windowMinutes = 60) {
  const bs = bucketsInWindow(windowMinutes);

  // Compute requests/sec from total requests across window
  let totalRequests = 0;
  for (const b of bs) {
    for (const [, count] of b.statusCodes) {
      totalRequests += count;
    }
  }
  const windowSec = Math.max(windowMinutes * 60, 1);
  const requestsPerSec = +(totalRequests / windowSec).toFixed(2);

  return {
    windowMinutes,
    requestsPerSec,
    totalRequests,
    latency: getLatencyPercentiles(windowMinutes),
    errors: getErrorRates(windowMinutes),
    agents: getAgentStats(windowMinutes),
    tokens: getTokenUsageByWorkspace(windowMinutes),
  };
}

/**
 * Reset all buckets (for testing).
 */
export function _resetBuckets() {
  for (let i = 0; i < MAX_BUCKETS; i++) buckets[i] = null;
  headIndex = 0;
}

// Export internals for testing
export { MAX_BUCKETS, minuteTs };
