/**
 * Phase 39.3: Anomaly Detection
 *
 * Statistical anomaly detection on usage, costs, errors, latency, and other operational metrics.
 *
 * Detection methods:
 *   - z-score: detect points that deviate from the mean by more than `threshold` standard deviations
 *   - IQR (interquartile range): detect points outside [Q1 - k*IQR, Q3 + k*IQR]
 *   - EWMA (exponentially weighted moving average): detect deviation from a smoothed expected value
 *   - seasonal: decompose into trend + seasonal + residual, then detect on residuals
 *
 * Anomalies are persisted to data/anomalies.json keyed by workspaceId and emit
 * webhook/notification events via emitEvent('anomaly.detected', ...).
 */
import { join } from "path";
import { randomUUID } from "crypto";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_HISTORY_RETENTION_DAYS = 30;
const ANOMALIES_KEY = "_global";

let schedulerTimer = null;

/**
 * Path for the anomalies durable store.
 */
function anomaliesPath() {
  return join(getDataDir(), "anomalies.json");
}

// ----------------------------------------------------------------------------
// Statistical helpers
// ----------------------------------------------------------------------------

function toNumericSeries(timeSeries) {
  if (!Array.isArray(timeSeries)) return [];
  return timeSeries.map((p) => {
    if (typeof p === "number") return p;
    if (p && typeof p === "object") {
      if (typeof p.value === "number") return p.value;
      if (typeof p.y === "number") return p.y;
    }
    return Number(p) || 0;
  });
}

function mean(arr) {
  if (!arr.length) return 0;
  let sum = 0;
  for (const v of arr) sum += v;
  return sum / arr.length;
}

function stdDev(arr, mu) {
  if (arr.length < 2) return 0;
  const m = typeof mu === "number" ? mu : mean(arr);
  let s = 0;
  for (const v of arr) s += (v - m) * (v - m);
  return Math.sqrt(s / (arr.length - 1));
}

function quantile(sorted, q) {
  if (!sorted.length) return 0;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  }
  return sorted[base];
}

function severityFromDeviation(deviation, threshold) {
  const ratio = Math.abs(deviation) / Math.max(threshold, 1e-9);
  if (ratio >= 3) return "critical";
  if (ratio >= 2) return "high";
  if (ratio >= 1.5) return "medium";
  return "low";
}

// ----------------------------------------------------------------------------
// Detection methods
// ----------------------------------------------------------------------------

/**
 * Z-score outlier detection. Returns indices where |value - mean| / std > threshold.
 *
 * @param {number[]|Array<{value:number}>} series
 * @param {number} [threshold=3]
 * @returns {Array<{index:number, value:number, expected:number, deviation:number, severity:string}>}
 */
export function zScoreDetection(series, threshold = 3) {
  const arr = toNumericSeries(series);
  if (arr.length < 3) return [];
  const mu = mean(arr);
  const sd = stdDev(arr, mu);
  if (sd === 0) return [];
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const z = (arr[i] - mu) / sd;
    if (Math.abs(z) > threshold) {
      out.push({
        index: i,
        value: arr[i],
        expected: mu,
        deviation: z,
        severity: severityFromDeviation(z, threshold),
        method: "zscore",
      });
    }
  }
  return out;
}

/**
 * IQR-based outlier detection. Outliers fall outside [Q1 - m*IQR, Q3 + m*IQR].
 *
 * @param {number[]|Array<{value:number}>} series
 * @param {number} [multiplier=1.5]
 * @returns {Array<{index:number, value:number, expected:number, deviation:number, severity:string}>}
 */
export function iqrDetection(series, multiplier = 1.5) {
  const arr = toNumericSeries(series);
  if (arr.length < 4) return [];
  const sorted = [...arr].sort((a, b) => a - b);
  const q1 = quantile(sorted, 0.25);
  const q3 = quantile(sorted, 0.75);
  const iqr = q3 - q1;
  if (iqr === 0) return [];
  const lower = q1 - multiplier * iqr;
  const upper = q3 + multiplier * iqr;
  const median = quantile(sorted, 0.5);
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (v < lower || v > upper) {
      const distance = v < lower ? (lower - v) / Math.max(iqr, 1e-9) : (v - upper) / Math.max(iqr, 1e-9);
      out.push({
        index: i,
        value: v,
        expected: median,
        deviation: distance,
        severity: severityFromDeviation(distance, 1),
        method: "iqr",
      });
    }
  }
  return out;
}

/**
 * EWMA (exponentially weighted moving average) detection. Deviation is measured
 * relative to the running standard deviation around the smoothed value.
 *
 * @param {number[]|Array<{value:number}>} series
 * @param {number} [alpha=0.3]
 * @param {number} [threshold=3]
 * @returns {Array<{index:number, value:number, expected:number, deviation:number, severity:string}>}
 */
export function ewmaDetection(series, alpha = 0.3, threshold = 3) {
  const arr = toNumericSeries(series);
  if (arr.length < 3) return [];
  const a = Math.min(Math.max(Number(alpha) || 0.3, 0.01), 0.99);
  const out = [];
  let ewma = arr[0];
  // EWMA of squared deviation -> variance estimate
  let ewmv = 0;

  for (let i = 1; i < arr.length; i++) {
    const v = arr[i];
    const sd = Math.sqrt(ewmv);
    if (i >= 2 && sd > 0) {
      const z = (v - ewma) / sd;
      if (Math.abs(z) > threshold) {
        out.push({
          index: i,
          value: v,
          expected: ewma,
          deviation: z,
          severity: severityFromDeviation(z, threshold),
          method: "ewma",
        });
      }
    }
    const diff = v - ewma;
    ewma = ewma + a * diff;
    ewmv = (1 - a) * (ewmv + a * diff * diff);
  }
  return out;
}

/**
 * Seasonal anomaly detection. Decomposes the series into trend (rolling mean of
 * length `period`), seasonal (per-phase deviation from trend), and residual,
 * then runs z-score detection on the residual component.
 *
 * @param {number[]|Array<{value:number}>} series
 * @param {number} period - cycle length, e.g., 24 for hourly daily seasonality
 * @param {number} [threshold=3]
 * @returns {Array<{index:number, value:number, expected:number, deviation:number, severity:string}>}
 */
export function seasonalDetection(series, period, threshold = 3) {
  const arr = toNumericSeries(series);
  const p = Math.max(2, Math.floor(Number(period) || 0));
  if (arr.length < p * 2) return [];

  // Trend: centered moving average of length `period`.
  const trend = new Array(arr.length).fill(null);
  const half = Math.floor(p / 2);
  for (let i = half; i < arr.length - half; i++) {
    let s = 0;
    for (let j = i - half; j <= i + half; j++) s += arr[j];
    trend[i] = s / (half * 2 + 1);
  }

  // Detrended values per phase position.
  const phaseSums = new Array(p).fill(0);
  const phaseCounts = new Array(p).fill(0);
  for (let i = 0; i < arr.length; i++) {
    if (trend[i] != null) {
      const phase = i % p;
      phaseSums[phase] += arr[i] - trend[i];
      phaseCounts[phase] += 1;
    }
  }
  const seasonal = phaseSums.map((s, i) => (phaseCounts[i] > 0 ? s / phaseCounts[i] : 0));

  // Residuals.
  const residuals = [];
  const residualIdx = [];
  for (let i = 0; i < arr.length; i++) {
    if (trend[i] != null) {
      residuals.push(arr[i] - trend[i] - seasonal[i % p]);
      residualIdx.push(i);
    }
  }
  if (residuals.length < 3) return [];
  const mu = mean(residuals);
  const sd = stdDev(residuals, mu);
  if (sd === 0) return [];

  const out = [];
  for (let k = 0; k < residuals.length; k++) {
    const z = (residuals[k] - mu) / sd;
    if (Math.abs(z) > threshold) {
      const i = residualIdx[k];
      const expected = trend[i] + seasonal[i % p];
      out.push({
        index: i,
        value: arr[i],
        expected,
        deviation: z,
        severity: severityFromDeviation(z, threshold),
        method: "seasonal",
      });
    }
  }
  return out;
}

/**
 * Detect anomalies in a numeric time series using the chosen method.
 *
 * @param {Array} timeSeries
 * @param {{method?: 'zscore'|'iqr'|'ewma'|'seasonal', threshold?: number, windowSize?: number, period?: number, alpha?: number}} [options]
 * @returns {Array<{index:number, value:number, expected:number, deviation:number, severity:string, method:string}>}
 */
export function detectAnomalies(timeSeries, options = {}) {
  const opts = options || {};
  const method = opts.method || "zscore";
  let series = toNumericSeries(timeSeries);
  // Optional sliding window: only run detection on the most recent N points.
  if (Number.isFinite(opts.windowSize) && opts.windowSize > 0 && opts.windowSize < series.length) {
    series = series.slice(-Math.floor(opts.windowSize));
  }
  switch (method) {
    case "zscore":
      return zScoreDetection(series, opts.threshold ?? 3);
    case "iqr":
      return iqrDetection(series, opts.threshold ?? 1.5);
    case "ewma":
      return ewmaDetection(series, opts.alpha ?? 0.3, opts.threshold ?? 3);
    case "seasonal":
      return seasonalDetection(series, opts.period ?? 24, opts.threshold ?? 3);
    default:
      return zScoreDetection(series, opts.threshold ?? 3);
  }
}

// ----------------------------------------------------------------------------
// Persistence
// ----------------------------------------------------------------------------

async function loadStore() {
  const data = await readJsonPath(anomaliesPath(), { _version: 1, anomalies: [] });
  const list = Array.isArray(data.anomalies) ? data.anomalies : [];
  return { _version: 1, anomalies: list };
}

async function saveStore(store) {
  await writeJsonPath(anomaliesPath(), store);
}

/**
 * Internal: persist a new anomaly record. Returns the saved entry.
 */
async function persistAnomaly(entry) {
  const path = anomaliesPath();
  return withPathLock(path, async () => {
    const store = await loadStore();
    store.anomalies.push(entry);
    // Trim records older than retention.
    const cutoff = Date.now() - DEFAULT_HISTORY_RETENTION_DAYS * 86400 * 1000;
    store.anomalies = store.anomalies.filter((a) => {
      const ts = new Date(a.detectedAt).getTime();
      return Number.isFinite(ts) && ts >= cutoff;
    });
    await saveStore(store);
    return entry;
  });
}

// ----------------------------------------------------------------------------
// Metric collection
// ----------------------------------------------------------------------------

/**
 * Build a numeric time series for a named metric over `period` days.
 * Returns { series, buckets } where series is an array of numbers and buckets
 * contains the matching timestamps for each numeric value.
 *
 * @param {string} metric - metric identifier (request_rate, error_rate, latency_p95,
 *                          token_usage, cost, agent_iterations, tool_timeout_rate)
 * @param {string|number} period - period in days (number) or '24h' / '7d' / '30d'
 * @param {{workspace?: string}} [opts]
 */
export async function buildMetricSeries(metric, period = 7, opts = {}) {
  const days = typeof period === "string"
    ? ({ "24h": 1, "7d": 7, "30d": 30, "90d": 90 }[period] || 7)
    : Number(period) || 7;
  const { getRecordsForPeriod } = await import("./usage-tracker.js");
  const { estimateCost } = await import("./analytics.js");
  const records = await getRecordsForPeriod(days, opts.workspace ? { workspace: opts.workspace } : {});

  // Bucket records into hourly buckets so we have enough data points to detect anomalies.
  const buckets = new Map();
  const stepMs = 3600 * 1000;
  const now = Date.now();
  const start = now - days * 86400 * 1000;
  for (let t = start; t <= now; t += stepMs) {
    const key = new Date(t).toISOString().slice(0, 13);
    buckets.set(key, { requests: 0, tokens: 0, cost: 0, errors: 0, latencyMs: [], iterations: [], toolTimeouts: 0 });
  }

  for (const r of records) {
    const key = (r.timestamp || "").slice(0, 13);
    if (!buckets.has(key)) continue;
    const b = buckets.get(key);
    b.requests += 1;
    const tokens = (r.inputTokens || 0) + (r.outputTokens || 0);
    b.tokens += tokens;
    const { cost } = estimateCost(r.inputTokens || 0, r.outputTokens || 0, r.backend);
    b.cost += cost;
    if (r.error || (typeof r.status === "number" && r.status >= 500)) b.errors += 1;
    if (typeof r.latencyMs === "number") b.latencyMs.push(r.latencyMs);
    if (typeof r.agentIterations === "number") b.iterations.push(r.agentIterations);
    if (r.toolTimeout) b.toolTimeouts += 1;
  }

  const ordered = [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b));
  const series = [];
  const tsBuckets = [];
  for (const [key, b] of ordered) {
    let v = 0;
    switch (metric) {
      case "request_rate":
        v = b.requests; // per hour
        break;
      case "error_rate":
        v = b.requests > 0 ? b.errors / b.requests : 0;
        break;
      case "latency_p95": {
        if (b.latencyMs.length) {
          const sorted = [...b.latencyMs].sort((a, c) => a - c);
          v = quantile(sorted, 0.95);
        } else v = 0;
        break;
      }
      case "token_usage":
        v = b.tokens;
        break;
      case "cost":
        v = b.cost;
        break;
      case "agent_iterations": {
        v = b.iterations.length ? b.iterations.reduce((s, x) => s + x, 0) / b.iterations.length : 0;
        break;
      }
      case "tool_timeout_rate":
        v = b.requests > 0 ? b.toolTimeouts / b.requests : 0;
        break;
      default:
        v = b.requests;
    }
    series.push(v);
    tsBuckets.push(key);
  }
  return { series, buckets: tsBuckets };
}

// ----------------------------------------------------------------------------
// Scan, alerting, and CRUD
// ----------------------------------------------------------------------------

const MONITORED_METRICS = [
  "request_rate",
  "error_rate",
  "latency_p95",
  "token_usage",
  "cost",
  "agent_iterations",
  "tool_timeout_rate",
];

/**
 * Run an anomaly scan for a single metric and persist any anomalies found.
 * Emits 'anomaly.detected' events for new findings.
 *
 * @param {string} metric
 * @param {string|number} [period=7]
 * @param {{workspace?: string, method?: string, threshold?: number}} [opts]
 * @returns {Promise<{metric:string, anomalies:Array}>}
 */
export async function runAnomalyScan(metric, period = 7, opts = {}) {
  const workspace = opts.workspace || "default";
  const method = opts.method || "zscore";
  const threshold = opts.threshold;

  const { series, buckets } = await buildMetricSeries(metric, period, { workspace });
  const anomalies = detectAnomalies(series, { method, threshold });

  const created = [];
  for (const a of anomalies) {
    const detectedAt = new Date().toISOString();
    const bucketTs = buckets[a.index] || null;
    const entry = {
      id: randomUUID(),
      metric,
      workspaceId: workspace,
      detectedAt,
      bucketTimestamp: bucketTs,
      value: a.value,
      expected: a.expected,
      deviation: a.deviation,
      severity: a.severity,
      method: a.method,
      acknowledged: false,
      acknowledgedAt: null,
    };
    await persistAnomaly(entry);
    created.push(entry);

    // Fire alert: webhook event + log line. Best-effort and non-blocking.
    try {
      const { emitEvent } = await import("./webhooks.js");
      await emitEvent("anomaly.detected", entry, { workspaceId: workspace });
    } catch (e) {
      console.warn("[anomaly-detection] emitEvent failed:", e?.message || e);
    }
    console.warn(
      `[anomaly-detection] severity=${entry.severity} metric=${metric} workspace=${workspace} value=${entry.value} expected=${entry.expected} deviation=${entry.deviation}`,
    );
  }

  return { metric, workspace, anomalies: created };
}

/**
 * Run a scan across every monitored metric for the given workspace.
 *
 * @param {{workspace?: string, period?: string|number, method?: string}} [opts]
 * @returns {Promise<{ scanned:number, total:number, anomalies:Array }>}
 */
export async function runFullScan(opts = {}) {
  let total = 0;
  const all = [];
  for (const metric of MONITORED_METRICS) {
    try {
      const { anomalies } = await runAnomalyScan(metric, opts.period ?? 7, {
        workspace: opts.workspace,
        method: opts.method,
      });
      total += anomalies.length;
      all.push(...anomalies);
    } catch (e) {
      console.warn(`[anomaly-detection] scan failed for ${metric}:`, e?.message || e);
    }
  }
  return { scanned: MONITORED_METRICS.length, total, anomalies: all };
}

/**
 * List currently active (unacknowledged) anomalies, optionally filtered by workspace.
 */
export async function getActiveAnomalies(workspaceId) {
  const store = await loadStore();
  const list = store.anomalies.filter((a) => !a.acknowledged);
  if (workspaceId) return list.filter((a) => a.workspaceId === workspaceId);
  return list;
}

/**
 * Acknowledge an anomaly by id, marking it inactive.
 */
export async function acknowledgeAnomaly(anomalyId) {
  const path = anomaliesPath();
  return withPathLock(path, async () => {
    const store = await loadStore();
    const entry = store.anomalies.find((a) => a.id === anomalyId);
    if (!entry) return null;
    entry.acknowledged = true;
    entry.acknowledgedAt = new Date().toISOString();
    await saveStore(store);
    return entry;
  });
}

/**
 * Get historical anomalies (acknowledged + active) within the last `days` days.
 */
export async function getAnomalyHistory(days = 30, workspaceId) {
  const store = await loadStore();
  const cutoff = Date.now() - Math.max(1, Number(days) || 30) * 86400 * 1000;
  let list = store.anomalies.filter((a) => {
    const ts = new Date(a.detectedAt).getTime();
    return Number.isFinite(ts) && ts >= cutoff;
  });
  if (workspaceId) list = list.filter((a) => a.workspaceId === workspaceId);
  return list.sort((a, b) => b.detectedAt.localeCompare(a.detectedAt));
}

/**
 * Reset internal store (for tests).
 */
export async function _resetAnomalyStoreForTests() {
  await writeJsonPath(anomaliesPath(), { _version: 1, anomalies: [] });
}

// ----------------------------------------------------------------------------
// Scheduler
// ----------------------------------------------------------------------------

/**
 * Start the periodic anomaly scan. Idempotent — calling twice replaces the timer.
 *
 * @param {number} [intervalMs] - default 5 minutes
 */
export function startAnomalyScheduler(intervalMs) {
  stopAnomalyScheduler();
  const period = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : DEFAULT_INTERVAL_MS;
  schedulerTimer = setInterval(() => {
    runFullScan().catch((e) => {
      console.warn("[anomaly-detection] scheduled scan failed:", e?.message || e);
    });
  }, period);
  if (schedulerTimer && typeof schedulerTimer.unref === "function") schedulerTimer.unref();
}

/**
 * Stop the periodic anomaly scan.
 */
export function stopAnomalyScheduler() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}

/**
 * Test helper: returns whether the scheduler timer is currently running.
 */
export function isAnomalySchedulerRunning() {
  return schedulerTimer != null;
}

export { MONITORED_METRICS };
