// @ts-check
/**
 * Phase 66.2: Noisy neighbor detection.
 *
 * Tracks per-tenant usage samples and detects outliers using two
 * complementary methods:
 *   - Z-score (based on mean + standard deviation)
 *   - Modified Z-score (based on median + MAD, robust to outliers)
 *
 * When a tenant is flagged, it can be throttled; throttles are persisted
 * and queryable.
 *
 * Exports:
 *   - recordUsage
 *   - detectOutliers
 *   - throttleTenant
 *   - unthrottleTenant
 *   - listThrottled
 *   - isThrottled
 *   - computeStats (pure helper)
 *
 * @module noisy-neighbor
 */
import { join } from "path";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;
const MAX_SAMPLES = 500;

function storePath() {
  return join(getDataDir(), "noisy-neighbor.json");
}

function nowIso() {
  return new Date().toISOString();
}

async function loadStore() {
  const data = await readJsonPath(storePath(), {
    version: STORE_VERSION,
    tenants: {},
    throttled: {},
  });
  if (!data.tenants || typeof data.tenants !== "object") data.tenants = {};
  if (!data.throttled || typeof data.throttled !== "object") data.throttled = {};
  return data;
}

async function saveStore(data) {
  await writeJsonPath(storePath(), {
    version: STORE_VERSION,
    tenants: data.tenants || {},
    throttled: data.throttled || {},
  });
}

/**
 * Record a usage sample for a tenant. `metric` can be any string
 * (e.g. "requests_per_min", "tokens_per_sec"). Values are retained
 * up to MAX_SAMPLES (FIFO) per tenant/metric pair.
 *
 * @param {string} tenantId
 * @param {string} metric
 * @param {number} value
 * @returns {Promise<{tenantId: string, metric: string, samples: number}>}
 */
export async function recordUsage(tenantId, metric, value) {
  if (!tenantId) throw new Error("tenantId required");
  if (!metric) throw new Error("metric required");
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error("value must be a non-negative number");

  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    if (!data.tenants[tenantId]) data.tenants[tenantId] = { tenantId, metrics: {} };
    const tenant = data.tenants[tenantId];
    if (!tenant.metrics[metric]) tenant.metrics[metric] = { samples: [], lastAt: "" };
    tenant.metrics[metric].samples.push(n);
    if (tenant.metrics[metric].samples.length > MAX_SAMPLES) {
      tenant.metrics[metric].samples.splice(0, tenant.metrics[metric].samples.length - MAX_SAMPLES);
    }
    tenant.metrics[metric].lastAt = nowIso();
    data.tenants[tenantId] = tenant;
    await saveStore(data);
    return { tenantId, metric, samples: tenant.metrics[metric].samples.length };
  });
}

/**
 * Compute mean/std/median/mad for a sample set.
 *
 * @param {number[]} samples
 * @returns {{n: number, mean: number, std: number, median: number, mad: number}}
 */
export function computeStats(samples) {
  const n = Array.isArray(samples) ? samples.length : 0;
  if (n === 0) return { n: 0, mean: 0, std: 0, median: 0, mad: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = sorted.reduce((s, x) => s + x, 0) / n;
  const variance = sorted.reduce((s, x) => s + (x - mean) * (x - mean), 0) / n;
  const std = Math.sqrt(variance);
  const median = n % 2 === 1 ? sorted[(n - 1) >> 1] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  const deviations = sorted.map((x) => Math.abs(x - median)).sort((a, b) => a - b);
  const mad = deviations[Math.floor(n / 2)] || 0;
  return { n, mean, std, median, mad };
}

/**
 * @typedef {Object} DetectOptions
 * @property {number} [zThreshold=3]
 * @property {number} [madThreshold=3.5]
 * @property {"zscore"|"mad"|"both"} [method="both"]
 * @property {string} [metric]
 * @property {number} [minSamples=5]
 */

/**
 * Detect outlier tenants for a given metric. Returns a list sorted by
 * severity (highest first). Each result includes the method and score.
 *
 * @param {DetectOptions} [options]
 * @returns {Promise<Array<{tenantId: string, metric: string, latestValue: number, score: number, method: string, stats: object}>>}
 */
export async function detectOutliers(options = {}) {
  const metric = options.metric;
  const zThreshold = Number.isFinite(options.zThreshold) ? options.zThreshold : 3;
  const madThreshold = Number.isFinite(options.madThreshold) ? options.madThreshold : 3.5;
  const method = options.method || "both";
  const minSamples = Number.isFinite(options.minSamples) ? options.minSamples : 5;

  const data = await loadStore();
  /** @type {Record<string, {values: Array<{tenantId: string, value: number}>, latest: Record<string, number>}>} */
  const byMetric = {};
  for (const t of Object.values(data.tenants || {})) {
    for (const [m, info] of Object.entries(t.metrics || {})) {
      if (metric && m !== metric) continue;
      if (!byMetric[m]) byMetric[m] = { values: [], latest: {} };
      const samples = Array.isArray(info.samples) ? info.samples : [];
      if (samples.length === 0) continue;
      const last = samples[samples.length - 1];
      byMetric[m].values.push({ tenantId: t.tenantId, value: last });
      byMetric[m].latest[t.tenantId] = last;
    }
  }

  /** @type {Array<{tenantId: string, metric: string, latestValue: number, score: number, method: string, stats: object}>} */
  const results = [];
  for (const [m, bucket] of Object.entries(byMetric)) {
    if (bucket.values.length < minSamples) continue;
    const values = bucket.values.map((v) => v.value);
    const stats = computeStats(values);
    for (const { tenantId, value } of bucket.values) {
      let zscore = 0;
      if (stats.std > 0) {
        zscore = (value - stats.mean) / stats.std;
      }
      // 0.6745 scaling per standard modified-z-score definition.
      let modZ = 0;
      if (stats.mad > 0) {
        modZ = (0.6745 * (value - stats.median)) / stats.mad;
      } else if (value > stats.median) {
        // MAD is 0 (zero dispersion in baseline); any value above the
        // median is effectively an unbounded outlier.
        modZ = madThreshold + 1;
      }
      const flagZ = method !== "mad" && zscore >= zThreshold;
      const flagMad = method !== "zscore" && modZ >= madThreshold;
      if (flagZ || flagMad) {
        const chosen = flagZ && flagMad ? "both" : flagZ ? "zscore" : "mad";
        const score = Math.max(zscore, modZ);
        results.push({
          tenantId,
          metric: m,
          latestValue: value,
          score: Math.round(score * 100) / 100,
          method: chosen,
          stats,
        });
      }
    }
  }
  results.sort((a, b) => b.score - a.score);
  return results;
}

/**
 * Throttle a tenant. `reason` is stored alongside for audit.
 *
 * @param {string} tenantId
 * @param {{reason?: string, until?: string, actor?: string}} [details]
 * @returns {Promise<object>}
 */
export async function throttleTenant(tenantId, details = {}) {
  if (!tenantId) throw new Error("tenantId required");
  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    const ts = nowIso();
    const record = {
      tenantId,
      throttledAt: ts,
      reason: details.reason ? String(details.reason) : "",
      until: details.until ? new Date(details.until).toISOString() : "",
      actor: details.actor ? String(details.actor) : "system",
    };
    data.throttled[tenantId] = record;
    await saveStore(data);
    return record;
  });
}

/**
 * Remove a throttle entry.
 *
 * @param {string} tenantId
 * @returns {Promise<boolean>}
 */
export async function unthrottleTenant(tenantId) {
  if (!tenantId) return false;
  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    if (!data.throttled[tenantId]) return false;
    delete data.throttled[tenantId];
    await saveStore(data);
    return true;
  });
}

/**
 * List currently throttled tenants. Expired entries (past `until`) are
 * returned but flagged with `expired: true`.
 *
 * @returns {Promise<object[]>}
 */
export async function listThrottled() {
  const data = await loadStore();
  const now = Date.now();
  const out = [];
  for (const rec of Object.values(data.throttled || {})) {
    const untilMs = rec.until ? Date.parse(rec.until) : Infinity;
    out.push({ ...rec, expired: Number.isFinite(untilMs) && untilMs < now });
  }
  out.sort((a, b) => (a.throttledAt < b.throttledAt ? 1 : -1));
  return out;
}

/**
 * Quick check if a tenant is actively throttled.
 *
 * @param {string} tenantId
 * @returns {Promise<boolean>}
 */
export async function isThrottled(tenantId) {
  if (!tenantId) return false;
  const data = await loadStore();
  const rec = data.throttled[tenantId];
  if (!rec) return false;
  if (rec.until) {
    const untilMs = Date.parse(rec.until);
    if (Number.isFinite(untilMs) && untilMs < Date.now()) return false;
  }
  return true;
}
