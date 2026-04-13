/**
 * Phase 57.2: Data quality monitors.
 *
 * Drift detection over streams. Each monitor is identified by a name and a
 * field type (`numeric` or `categorical`). Callers feed samples in via
 * `recordSample`. At any time `checkDrift` compares the most recent window
 * against the reference (baseline) window and flags distribution shifts.
 *
 *   numeric     → Kolmogorov–Smirnov two-sample test
 *   categorical → chi-square goodness-of-fit
 *
 * Storage layout:
 *   data/data-quality/{monitor}.json — sample buffers + metadata
 *   data/data-quality/_index.json    — known monitors
 */
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

export const MONITOR_TYPES = Object.freeze(["numeric", "categorical"]);

const DEFAULT_BUFFER = 1000;
const DEFAULT_MIN_SAMPLES = 30;
const DEFAULT_SIGNIFICANCE = 0.05;

function sanitize(v) {
  return String(v || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || "default";
}

function monitorPath(name) {
  return join(getDataDir(), "data-quality", `${sanitize(name)}.json`);
}

function indexPath() {
  return join(getDataDir(), "data-quality", "_index.json");
}

async function touchIndex(name, type) {
  return withPathLock(indexPath(), async () => {
    const idx = await readJsonPath(indexPath(), { monitors: [] });
    const list = Array.isArray(idx.monitors) ? idx.monitors : [];
    const existing = list.find((m) => m.name === name);
    if (!existing) {
      list.push({ name, type });
      await writeJsonPath(indexPath(), { monitors: list });
    }
  });
}

/**
 * Register an existing monitor name or create a new empty buffer.
 */
export async function createMonitor(name, type = "numeric", options = {}) {
  if (!MONITOR_TYPES.includes(type)) {
    throw new Error(`type must be one of ${MONITOR_TYPES.join(", ")}`);
  }
  const file = monitorPath(name);
  await withPathLock(file, async () => {
    const existing = await readJsonPath(file, null);
    if (existing && existing.name) return;
    const rec = {
      name: sanitize(name),
      type,
      bufferSize: Number(options.bufferSize) || DEFAULT_BUFFER,
      reference: [],   // baseline samples (fixed)
      recent: [],      // sliding-window recent samples
      createdAt: new Date().toISOString(),
    };
    await writeJsonPath(file, rec);
  });
  await touchIndex(sanitize(name), type);
  return await readJsonPath(monitorPath(name), null);
}

/**
 * Append a sample. Auto-creates the monitor if it doesn't exist yet.
 */
export async function recordSample(name, value, options = {}) {
  if (!name) throw new Error("name is required");
  const file = monitorPath(name);
  await withPathLock(file, async () => {
    let rec = await readJsonPath(file, null);
    if (!rec || !rec.name) {
      rec = {
        name: sanitize(name),
        type: options.type || (typeof value === "number" ? "numeric" : "categorical"),
        bufferSize: Number(options.bufferSize) || DEFAULT_BUFFER,
        reference: [],
        recent: [],
        createdAt: new Date().toISOString(),
      };
    }
    if (rec.type === "numeric" && typeof value !== "number") {
      throw new Error(`numeric monitor expects numeric value, got ${typeof value}`);
    }
    if (rec.type === "categorical" && typeof value !== "string") {
      value = String(value);
    }
    rec.recent.push(value);
    if (rec.recent.length > rec.bufferSize) {
      rec.recent = rec.recent.slice(-rec.bufferSize);
    }
    if (options.asReference) {
      rec.reference.push(value);
      if (rec.reference.length > rec.bufferSize) {
        rec.reference = rec.reference.slice(-rec.bufferSize);
      }
    }
    rec.updatedAt = new Date().toISOString();
    await writeJsonPath(file, rec);
    await touchIndex(rec.name, rec.type);
  });
}

/**
 * Pin the current recent buffer as the baseline. Also resets `recent` so the
 * drift check against the new reference starts from scratch.
 */
export async function setReference(name) {
  const file = monitorPath(name);
  return withPathLock(file, async () => {
    const rec = await readJsonPath(file, null);
    if (!rec) throw new Error(`monitor ${name} not found`);
    rec.reference = [...rec.recent];
    rec.recent = [];
    await writeJsonPath(file, rec);
    return rec;
  });
}

export async function getMonitor(name) {
  return readJsonPath(monitorPath(name), null);
}

export async function listMonitors() {
  const idx = await readJsonPath(indexPath(), { monitors: [] });
  const list = Array.isArray(idx.monitors) ? idx.monitors : [];
  const out = [];
  for (const m of list) {
    const rec = await readJsonPath(monitorPath(m.name), null);
    if (rec && rec.name) out.push(rec);
  }
  return out;
}

// ─── Statistics ──────────────────────────────────────────────────────────

export function summarizeNumeric(arr) {
  const vals = arr.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (vals.length === 0) return { count: 0, mean: 0, min: 0, max: 0, stdDev: 0 };
  const sum = vals.reduce((a, b) => a + b, 0);
  const mean = sum / vals.length;
  const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
  return {
    count: vals.length,
    mean,
    min: Math.min(...vals),
    max: Math.max(...vals),
    stdDev: Math.sqrt(variance),
  };
}

export function summarizeCategorical(arr) {
  const counts = {};
  for (const v of arr) {
    const k = String(v);
    counts[k] = (counts[k] || 0) + 1;
  }
  return { count: arr.length, categories: counts };
}

/**
 * Two-sample Kolmogorov–Smirnov test. Returns the D statistic and approximate
 * p-value.
 */
export function ksTest(a, b) {
  const as = a.slice().sort((x, y) => x - y);
  const bs = b.slice().sort((x, y) => x - y);
  const n1 = as.length;
  const n2 = bs.length;
  if (n1 === 0 || n2 === 0) return { D: 0, pValue: 1 };
  // Merge the two sorted arrays, compute empirical CDF difference at each step.
  let i = 0;
  let j = 0;
  let d = 0;
  while (i < n1 && j < n2) {
    if (as[i] < bs[j]) {
      i += 1;
    } else if (as[i] > bs[j]) {
      j += 1;
    } else {
      // Equal values: advance both pointers past all ties.
      const v = as[i];
      while (i < n1 && as[i] === v) i += 1;
      while (j < n2 && bs[j] === v) j += 1;
    }
    d = Math.max(d, Math.abs((i / n1) - (j / n2)));
  }
  // Approximate p-value using the Kolmogorov distribution.
  if (d === 0) return { D: 0, pValue: 1 };
  const en = Math.sqrt((n1 * n2) / (n1 + n2));
  const lambda = (en + 0.12 + 0.11 / en) * d;
  let pValue = 0;
  for (let k = 1; k <= 100; k += 1) {
    pValue += 2 * (-1) ** (k - 1) * Math.exp(-2 * lambda * lambda * k * k);
  }
  pValue = Math.max(0, Math.min(1, pValue));
  return { D: d, pValue };
}

/**
 * Chi-square goodness-of-fit between observed and expected distributions.
 * Returns statistic + approximate p-value via a lightweight CDF.
 */
export function chiSquareTest(observed, expected) {
  const keys = new Set([...Object.keys(observed), ...Object.keys(expected)]);
  let stat = 0;
  let df = 0;
  const nObs = Object.values(observed).reduce((a, b) => a + b, 0);
  const nExp = Object.values(expected).reduce((a, b) => a + b, 0);
  if (nObs === 0 || nExp === 0) return { chi2: 0, df: 0, pValue: 1 };
  for (const k of keys) {
    const o = (observed[k] || 0) / nObs;
    const e = (expected[k] || 0) / nExp;
    if (e <= 0 && o <= 0) continue;
    const denom = e === 0 ? 1e-6 : e;
    stat += ((o - e) ** 2) / denom;
    df += 1;
  }
  df = Math.max(1, df - 1);
  // Very rough p-value using the survival function of chi-square via
  // Wilson–Hilferty approximation.
  const ratio = stat / df;
  const z = ((Math.cbrt(ratio) - (1 - 2 / (9 * df))) * Math.sqrt(9 * df)) / Math.sqrt(2);
  const pValue = 1 - 0.5 * (1 + erf(z / Math.sqrt(2)));
  return { chi2: stat * nObs, df, pValue: Math.max(0, Math.min(1, pValue)) };
}

function erf(x) {
  // Abramowitz–Stegun 7.1.26 approximation (|err| < 1.5e-7).
  const sign = x >= 0 ? 1 : -1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return sign * y;
}

/**
 * Run drift check for a monitor.
 *
 * @param {string} name
 * @param {{ minSamples?: number, significance?: number }} [options]
 * @returns {Promise<{ drifted: boolean, test: string, stat: number, pValue: number, reason?: string, recentSummary: object, referenceSummary: object }>}
 */
export async function checkDrift(name, options = {}) {
  const rec = await readJsonPath(monitorPath(name), null);
  if (!rec || !rec.name) {
    const err = new Error(`monitor ${name} not found`);
    err.code = "NOT_FOUND";
    throw err;
  }
  const minSamples = Number(options.minSamples) || DEFAULT_MIN_SAMPLES;
  const alpha = Number(options.significance) || DEFAULT_SIGNIFICANCE;
  if (rec.recent.length < minSamples || rec.reference.length < minSamples) {
    return {
      drifted: false,
      test: rec.type === "numeric" ? "ks" : "chi2",
      stat: 0,
      pValue: 1,
      reason: "not_enough_samples",
      recentSummary: rec.type === "numeric" ? summarizeNumeric(rec.recent) : summarizeCategorical(rec.recent),
      referenceSummary: rec.type === "numeric" ? summarizeNumeric(rec.reference) : summarizeCategorical(rec.reference),
    };
  }
  if (rec.type === "numeric") {
    const { D, pValue } = ksTest(rec.recent, rec.reference);
    return {
      drifted: pValue < alpha,
      test: "ks",
      stat: D,
      pValue,
      recentSummary: summarizeNumeric(rec.recent),
      referenceSummary: summarizeNumeric(rec.reference),
    };
  }
  const obs = summarizeCategorical(rec.recent).categories;
  const exp = summarizeCategorical(rec.reference).categories;
  const { chi2, df, pValue } = chiSquareTest(obs, exp);
  return {
    drifted: pValue < alpha,
    test: "chi2",
    stat: chi2,
    df,
    pValue,
    recentSummary: summarizeCategorical(rec.recent),
    referenceSummary: summarizeCategorical(rec.reference),
  };
}

/**
 * Test helper: delete a monitor.
 */
export async function _reset(name) {
  if (name) {
    await writeJsonPath(monitorPath(name), { _deleted: true });
    return;
  }
  const idx = await readJsonPath(indexPath(), { monitors: [] });
  const list = Array.isArray(idx.monitors) ? idx.monitors : [];
  for (const m of list) await writeJsonPath(monitorPath(m.name), { _deleted: true });
  await writeJsonPath(indexPath(), { monitors: [] });
}

export const _internals = { ksTest, chiSquareTest, erf };
