// @ts-check
/**
 * Phase 57.2: Data quality monitors.
 *
 * Detects data drift and enforces quality rules on streaming data.
 * Drift is computed with two standard statistics:
 *
 *   - KS (Kolmogorov–Smirnov) statistic: max absolute difference of
 *     empirical CDFs between baseline and current.
 *   - PSI (Population Stability Index): binned distribution shift,
 *     commonly used for credit-scoring model monitoring.
 *
 * Rules are stored per metric and evaluated against the latest window.
 * Built-in rule ops: gt, lt, gte, lte, eq, in_range, not_null, unique_pct.
 *
 * Exports:
 *   - computeDrift(baseline, current, opts)
 *   - addRule(name, rule)
 *   - evaluateRules(metricName, values, extraContext)
 *   - getDriftReport(name)
 *   - listRules()
 *   - recordDriftReport(name, report)
 *
 * @module data-quality
 */
import { join } from "path";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;

function storePath() {
  return join(getDataDir(), "data-quality.json");
}

function now() {
  return new Date().toISOString();
}

/* -------------------------------------------------------------------------- */
/* Statistics                                                                 */
/* -------------------------------------------------------------------------- */

function toNumbers(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map((v) => Number(v)).filter((v) => Number.isFinite(v));
}

/**
 * Empirical CDF at value x.
 * @param {number[]} sorted
 * @param {number} x
 */
function ecdf(sorted, x) {
  if (sorted.length === 0) return 0;
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo / sorted.length;
}

/**
 * KS statistic between two samples.
 * @param {number[]} a
 * @param {number[]} b
 */
export function ksStatistic(a, b) {
  const A = toNumbers(a).slice().sort((x, y) => x - y);
  const B = toNumbers(b).slice().sort((x, y) => x - y);
  if (A.length === 0 || B.length === 0) return 0;
  const points = A.concat(B);
  let maxDiff = 0;
  for (const p of points) {
    const d = Math.abs(ecdf(A, p) - ecdf(B, p));
    if (d > maxDiff) maxDiff = d;
  }
  return Math.round(maxDiff * 10000) / 10000;
}

/**
 * Population Stability Index between two distributions discretized into
 * `bins` equal-width buckets over the combined range.
 *
 * PSI = Σ ((c_i - b_i) * ln(c_i / b_i))
 *
 * Where c_i is current-proportion in bin i and b_i is baseline-proportion.
 *
 * @param {number[]} baseline
 * @param {number[]} current
 * @param {number} [bins]
 */
export function psi(baseline, current, bins = 10) {
  const A = toNumbers(baseline);
  const B = toNumbers(current);
  if (A.length === 0 || B.length === 0) return 0;
  const all = A.concat(B);
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  if (lo === hi) return 0;
  const width = (hi - lo) / bins;
  const baseCounts = new Array(bins).fill(0);
  const curCounts = new Array(bins).fill(0);
  const binOf = (v) => {
    const b = Math.floor((v - lo) / width);
    return b >= bins ? bins - 1 : b < 0 ? 0 : b;
  };
  for (const v of A) baseCounts[binOf(v)] += 1;
  for (const v of B) curCounts[binOf(v)] += 1;
  let total = 0;
  for (let i = 0; i < bins; i++) {
    const bp = (baseCounts[i] + 1) / (A.length + bins);
    const cp = (curCounts[i] + 1) / (B.length + bins);
    total += (cp - bp) * Math.log(cp / bp);
  }
  return Math.round(total * 10000) / 10000;
}

/**
 * Compute both KS and PSI in one call plus a verdict.
 * @param {number[]} baseline
 * @param {number[]} current
 * @param {object} [opts]
 */
export function computeDrift(baseline, current, opts = {}) {
  const ks = ksStatistic(baseline, current);
  const ps = psi(baseline, current, Number.isFinite(opts.bins) ? opts.bins : 10);
  const ksThreshold = Number.isFinite(opts.ksThreshold) ? opts.ksThreshold : 0.15;
  const psiThreshold = Number.isFinite(opts.psiThreshold) ? opts.psiThreshold : 0.2;
  const drifted = ks >= ksThreshold || ps >= psiThreshold;
  return {
    ks,
    psi: ps,
    ksThreshold,
    psiThreshold,
    drifted,
    baselineN: Array.isArray(baseline) ? baseline.length : 0,
    currentN: Array.isArray(current) ? current.length : 0,
    computedAt: now(),
  };
}

/* -------------------------------------------------------------------------- */
/* Rule engine                                                                */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {{ op: string, value?: any, min?: number, max?: number, metric?: string }} Rule
 */

const VALID_OPS = new Set([
  "gt", "lt", "gte", "lte", "eq",
  "in_range", "not_null", "unique_pct", "min_count", "max_count",
]);

async function loadStore() {
  const raw = await readJsonPath(storePath(), {
    version: STORE_VERSION,
    rules: [],
    reports: {},
  });
  if (!raw || typeof raw !== "object") {
    return { version: STORE_VERSION, rules: [], reports: {} };
  }
  if (!Array.isArray(raw.rules)) raw.rules = [];
  if (!raw.reports || typeof raw.reports !== "object") raw.reports = {};
  raw.version = STORE_VERSION;
  return raw;
}

async function saveStore(store) {
  await writeJsonPath(storePath(), {
    version: STORE_VERSION,
    rules: store.rules || [],
    reports: store.reports || {},
  });
}

/**
 * Persist a quality rule.
 * @param {string} name
 * @param {Rule} rule
 */
export async function addRule(name, rule) {
  if (!name || typeof name !== "string") throw new Error("rule name required");
  if (!rule || typeof rule !== "object") throw new Error("rule required");
  if (!VALID_OPS.has(rule.op)) throw new Error(`unknown op "${rule.op}"`);
  return withPathLock(storePath(), async () => {
    const store = await loadStore();
    store.rules = store.rules.filter((r) => r.name !== name);
    store.rules.push({ ...rule, name, createdAt: now() });
    await saveStore(store);
    return store.rules[store.rules.length - 1];
  });
}

/** List all configured rules. */
export async function listRules() {
  const store = await loadStore();
  return store.rules.slice();
}

/**
 * Evaluate a single value set against all rules targeting `metricName`.
 * @param {string} metricName
 * @param {number[]} values
 */
export async function evaluateRules(metricName, values) {
  if (!metricName || typeof metricName !== "string") throw new Error("metricName required");
  const store = await loadStore();
  const rules = store.rules.filter((r) => !r.metric || r.metric === metricName);
  const nums = toNumbers(values);
  const results = [];
  for (const r of rules) {
    let passed = false;
    let observed;
    switch (r.op) {
      case "gt":
        observed = Math.min(...nums);
        passed = nums.length > 0 && observed > r.value;
        break;
      case "lt":
        observed = Math.max(...nums);
        passed = nums.length > 0 && observed < r.value;
        break;
      case "gte":
        observed = Math.min(...nums);
        passed = nums.length > 0 && observed >= r.value;
        break;
      case "lte":
        observed = Math.max(...nums);
        passed = nums.length > 0 && observed <= r.value;
        break;
      case "eq":
        passed = nums.length > 0 && nums.every((v) => v === r.value);
        observed = nums[0] ?? null;
        break;
      case "in_range":
        observed = { min: Math.min(...nums), max: Math.max(...nums) };
        passed = nums.length > 0 && nums.every((v) => v >= r.min && v <= r.max);
        break;
      case "not_null":
        observed = (values || []).filter((v) => v == null).length;
        passed = observed === 0;
        break;
      case "unique_pct": {
        const uniq = new Set(values || []);
        observed = (values && values.length > 0) ? uniq.size / values.length : 0;
        passed = observed >= r.value;
        break;
      }
      case "min_count":
        observed = values?.length || 0;
        passed = observed >= r.value;
        break;
      case "max_count":
        observed = values?.length || 0;
        passed = observed <= r.value;
        break;
      default:
        passed = false;
    }
    results.push({
      name: r.name,
      op: r.op,
      passed,
      observed,
      expected: r.value ?? (r.op === "in_range" ? { min: r.min, max: r.max } : null),
    });
  }
  const allPassed = results.every((r) => r.passed);
  return { metric: metricName, passed: allPassed, rules: results, at: now() };
}

/* -------------------------------------------------------------------------- */
/* Drift report persistence                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Persist a drift report keyed by a name (e.g., feature name).
 * @param {string} name
 * @param {object} report
 */
export async function recordDriftReport(name, report) {
  if (!name || typeof name !== "string") throw new Error("name required");
  if (!report || typeof report !== "object") throw new Error("report required");
  return withPathLock(storePath(), async () => {
    const store = await loadStore();
    store.reports[name] = store.reports[name] || { history: [] };
    store.reports[name].history.push({ ...report, at: now() });
    if (store.reports[name].history.length > 500) {
      store.reports[name].history = store.reports[name].history.slice(-500);
    }
    store.reports[name].latest = { ...report, at: now() };
    await saveStore(store);
    return store.reports[name].latest;
  });
}

/**
 * Fetch the latest drift report for a feature.
 * @param {string} name
 */
export async function getDriftReport(name) {
  if (!name) return null;
  const store = await loadStore();
  return store.reports[name] || null;
}
