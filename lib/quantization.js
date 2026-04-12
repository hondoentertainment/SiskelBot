/**
 * Phase 58.5: Quantization management — INT4/INT8 model variant registry
 * with quality gates, benchmarking, and deployment lifecycle.
 *
 * Tracks quantized model variants (GPTQ, AWQ, GGUF Q4_K_M, BF16, etc.),
 * enforces quality gates via benchmark results, and recommends variants
 * matching size/quality constraints.
 *
 * Storage: JSON at data/quantization-variants.json via json-path-store.
 *
 * @module quantization
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const DATA_FILE = () => join(getDataDir(), "quantization-variants.json");

/**
 * Quantization methods with typical size and quality characteristics.
 *
 * - bitsPerWeight: average bits used per weight (lower = smaller)
 * - sizeReduction: multiplier applied to FP32 size baseline (0.25 means 25%)
 * - qualityLoss: approximate quality drop vs FP32 (fraction, e.g. 0.03 = 3%)
 */
export const QUANT_METHODS = {
  int8: { bitsPerWeight: 8, sizeReduction: 0.25, qualityLoss: 0.01 },
  int4: { bitsPerWeight: 4, sizeReduction: 0.125, qualityLoss: 0.03 },
  gptq_int4: { bitsPerWeight: 4, sizeReduction: 0.125, qualityLoss: 0.02 },
  awq_int4: { bitsPerWeight: 4, sizeReduction: 0.125, qualityLoss: 0.015 },
  gguf_q4_k_m: { bitsPerWeight: 4.5, sizeReduction: 0.15, qualityLoss: 0.01 },
  gguf_q5_k_m: { bitsPerWeight: 5.5, sizeReduction: 0.18, qualityLoss: 0.008 },
  gguf_q8_0: { bitsPerWeight: 8, sizeReduction: 0.27, qualityLoss: 0.005 },
  bf16: { bitsPerWeight: 16, sizeReduction: 0.5, qualityLoss: 0.002 },
};

const VALID_ENVIRONMENTS = new Set(["prod", "staging", "canary", "dev"]);
const VALID_STATUSES = new Set(["registered", "promoted", "deprecated"]);
const MAX_BENCHMARKS_PER_VARIANT = 200;

/**
 * Shape of the store:
 * {
 *   variants: { [variantId]: VariantRecord },
 *   gates: { [variantId]: { minScore, updatedAt } },
 *   benchmarks: { [variantId]: Array<BenchmarkRecord> },
 *   deployments: { [variantId]: { environment, promotedAt, deprecatedAt, reason } },
 * }
 */
function defaultStore() {
  return { variants: {}, gates: {}, benchmarks: {}, deployments: {} };
}

async function loadStore() {
  const data = await readJsonPath(DATA_FILE(), defaultStore());
  if (!data || typeof data !== "object") return defaultStore();
  return {
    variants: data.variants || {},
    gates: data.gates || {},
    benchmarks: data.benchmarks || {},
    deployments: data.deployments || {},
  };
}

async function saveStore(store) {
  await writeJsonPath(DATA_FILE(), store);
}

// ────────────────────────── registration ──────────────────────────

/**
 * Register a new quantized variant.
 *
 * @param {object}   opts
 * @param {string}   opts.baseModel   Model this variant was derived from.
 * @param {string}   opts.method      Quantization method key (see QUANT_METHODS).
 * @param {number}   [opts.sizeMb]    Optional reported size on disk in MB.
 * @param {string}   [opts.url]       Optional URL to artifact (HF, local, etc.).
 * @param {object}   [opts.metadata]  Free-form metadata (calibration set, tags).
 * @returns {Promise<{id:string, registeredAt:string}>}
 */
export async function registerVariant({ baseModel, method, sizeMb, url, metadata } = {}) {
  if (!baseModel || typeof baseModel !== "string") {
    throw new Error("baseModel is required");
  }
  if (!method || typeof method !== "string") {
    throw new Error("method is required");
  }
  if (!QUANT_METHODS[method]) {
    throw new Error(`method must be one of: ${Object.keys(QUANT_METHODS).join(", ")}`);
  }
  return withPathLock(DATA_FILE(), async () => {
    const store = await loadStore();
    const id = `qvar_${randomUUID()}`;
    const record = {
      id,
      baseModel,
      method,
      sizeMb: Number.isFinite(sizeMb) ? Number(sizeMb) : null,
      url: typeof url === "string" ? url : null,
      metadata: metadata && typeof metadata === "object" ? metadata : {},
      registeredAt: new Date().toISOString(),
      status: "registered",
    };
    store.variants[id] = record;
    store.benchmarks[id] = store.benchmarks[id] || [];
    await saveStore(store);
    return { id, registeredAt: record.registeredAt };
  });
}

/** Get a variant record by id. Returns null if not found. */
export async function getVariant(variantId) {
  if (!variantId) return null;
  const store = await loadStore();
  return store.variants[variantId] || null;
}

/**
 * List variants, optionally filtered by baseModel, method, or status.
 *
 * @param {object} [filter]
 * @param {string} [filter.baseModel]
 * @param {string} [filter.method]
 * @param {string} [filter.status]
 */
export async function listVariants(filter = {}) {
  const store = await loadStore();
  let all = Object.values(store.variants);
  if (filter.baseModel) {
    all = all.filter((v) => v.baseModel === filter.baseModel);
  }
  if (filter.method) {
    all = all.filter((v) => v.method === filter.method);
  }
  if (filter.status) {
    all = all.filter((v) => v.status === filter.status);
  }
  return all;
}

/** Remove a variant, its gate, benchmarks, and deployment info. */
export async function removeVariant(variantId) {
  return withPathLock(DATA_FILE(), async () => {
    const store = await loadStore();
    if (!store.variants[variantId]) {
      return { ok: false, error: "variant not found" };
    }
    delete store.variants[variantId];
    delete store.gates[variantId];
    delete store.benchmarks[variantId];
    delete store.deployments[variantId];
    await saveStore(store);
    return { ok: true };
  });
}

// ────────────────────────── estimation ──────────────────────────

/**
 * Estimate on-disk size in MB for a variant of a given base-model size (in
 * billions of params). Uses QUANT_METHODS.sizeReduction vs an FP32 baseline
 * of 4 bytes per parameter.
 *
 * @param {number} baseModelParams Parameter count in billions (e.g. 7 for 7B)
 * @param {string} method          Quantization method key.
 * @returns {number} size in MB, rounded.
 */
export function estimateSize(baseModelParams, method) {
  const spec = QUANT_METHODS[method];
  if (!spec) throw new Error(`unknown method: ${method}`);
  if (!Number.isFinite(baseModelParams) || baseModelParams <= 0) {
    throw new Error("baseModelParams must be a positive number (in billions)");
  }
  // FP32 baseline: 4 bytes/param, params in billions → GB.
  const fp32GB = baseModelParams * 4;
  const quantGB = fp32GB * spec.sizeReduction;
  return Math.round(quantGB * 1024);
}

/**
 * Estimate peak memory usage in MB during inference, accounting for KV cache
 * growth proportional to batch size.
 *
 * @param {number} baseModelParams Parameter count in billions.
 * @param {string} method          Quantization method key.
 * @param {number} [batchSize=1]   Inference batch size.
 */
export function estimateMemoryUsage(baseModelParams, method, batchSize = 1) {
  const weights = estimateSize(baseModelParams, method);
  const bs = Math.max(1, Number(batchSize) || 1);
  // KV cache + activations scale with batch size; rough factor ~15% of weights per unit batch.
  const overhead = Math.round(weights * 0.15 * bs);
  return weights + overhead;
}

/**
 * Estimate quality loss. If calibrationQuality is a fraction in [0,1] where
 * 1.0 means "perfect calibration", the nominal loss is scaled by
 * (1 - calibrationQuality/2) so better calibration reduces reported loss.
 *
 * @param {string} method
 * @param {number|null} [calibrationQuality]
 * @returns {number} estimated loss (fraction, 0..1).
 */
export function estimateQualityLoss(method, calibrationQuality = null) {
  const spec = QUANT_METHODS[method];
  if (!spec) throw new Error(`unknown method: ${method}`);
  let loss = spec.qualityLoss;
  if (
    calibrationQuality != null &&
    Number.isFinite(calibrationQuality) &&
    calibrationQuality >= 0 &&
    calibrationQuality <= 1
  ) {
    loss = loss * (1 - calibrationQuality / 2);
  }
  return Math.round(loss * 10000) / 10000;
}

// ────────────────────────── quality gates ──────────────────────────

/**
 * Set a minimum score gate for a variant. Benchmarks below this fail the gate.
 */
export async function setQualityGate(variantId, minScore) {
  if (!variantId) throw new Error("variantId is required");
  if (!Number.isFinite(minScore)) throw new Error("minScore must be a number");
  return withPathLock(DATA_FILE(), async () => {
    const store = await loadStore();
    if (!store.variants[variantId]) throw new Error("variant not found");
    store.gates[variantId] = {
      minScore: Number(minScore),
      updatedAt: new Date().toISOString(),
    };
    await saveStore(store);
    return { variantId, minScore: Number(minScore) };
  });
}

/** Return the gate record for a variant, or null. */
export async function getQualityGate(variantId) {
  if (!variantId) return null;
  const store = await loadStore();
  return store.gates[variantId] || null;
}

/**
 * Check if a test score meets the configured gate for a variant.
 *
 * @returns {Promise<{passed:boolean, minScore:number|null, testScore:number, reason?:string}>}
 */
export async function checkQualityGate(variantId, testScore) {
  if (!Number.isFinite(testScore)) {
    throw new Error("testScore must be a number");
  }
  const gate = await getQualityGate(variantId);
  if (!gate) {
    return { passed: true, minScore: null, testScore, reason: "no gate configured" };
  }
  const passed = testScore >= gate.minScore;
  return {
    passed,
    minScore: gate.minScore,
    testScore,
    reason: passed
      ? "score meets or exceeds gate"
      : `score ${testScore} below gate ${gate.minScore}`,
  };
}

// ────────────────────────── benchmarking ──────────────────────────

/**
 * Run a benchmark: invoke targetFn for each benchmark item, record latency
 * and pass/fail. `targetFn` should return an object like
 *   { score: number, output?: any }
 * A benchmark item is { input: any, expected?: any }.
 *
 * @param {string} variantId
 * @param {(input:any) => Promise<{score:number,output?:any}>} targetFn
 * @param {{ name?: string, items: Array<{input:any, expected?:any}> }} benchmark
 */
export async function runQuantizationBenchmark(variantId, targetFn, benchmark) {
  if (!variantId) throw new Error("variantId is required");
  if (typeof targetFn !== "function") throw new Error("targetFn must be a function");
  if (!benchmark || !Array.isArray(benchmark.items) || benchmark.items.length === 0) {
    throw new Error("benchmark.items must be a non-empty array");
  }
  const variant = await getVariant(variantId);
  if (!variant) throw new Error("variant not found");
  const name = benchmark.name || "unnamed";
  const perItem = [];
  let totalScore = 0;
  let totalLatency = 0;
  let errors = 0;
  for (const item of benchmark.items) {
    const t0 = Date.now();
    try {
      const r = await targetFn(item.input);
      const score = Number(r?.score) || 0;
      const latencyMs = Date.now() - t0;
      totalScore += score;
      totalLatency += latencyMs;
      perItem.push({ ok: true, score, latencyMs });
    } catch (e) {
      errors += 1;
      perItem.push({ ok: false, error: e.message, latencyMs: Date.now() - t0 });
    }
  }
  const n = benchmark.items.length;
  const result = {
    name,
    ranAt: new Date().toISOString(),
    items: n,
    errors,
    avgScore: n > 0 ? Math.round((totalScore / n) * 10000) / 10000 : 0,
    avgLatencyMs: n > 0 ? Math.round(totalLatency / n) : 0,
    perItem,
  };
  await recordBenchmarkResult(variantId, result);
  const gateCheck = await checkQualityGate(variantId, result.avgScore);
  return { ...result, gate: gateCheck };
}

/** Persist a benchmark result. */
export async function recordBenchmarkResult(variantId, result) {
  if (!variantId) throw new Error("variantId is required");
  if (!result || typeof result !== "object") {
    throw new Error("result must be an object");
  }
  return withPathLock(DATA_FILE(), async () => {
    const store = await loadStore();
    if (!store.variants[variantId]) throw new Error("variant not found");
    const arr = store.benchmarks[variantId] || [];
    arr.push({ ...result, recordedAt: result.ranAt || new Date().toISOString() });
    // Trim history to most recent N.
    if (arr.length > MAX_BENCHMARKS_PER_VARIANT) {
      arr.splice(0, arr.length - MAX_BENCHMARKS_PER_VARIANT);
    }
    store.benchmarks[variantId] = arr;
    await saveStore(store);
    return { ok: true, count: arr.length };
  });
}

/** Fetch the full benchmark history for a variant (most recent last). */
export async function getBenchmarkHistory(variantId) {
  if (!variantId) return [];
  const store = await loadStore();
  return store.benchmarks[variantId] ? [...store.benchmarks[variantId]] : [];
}

// ────────────────────────── deployment lifecycle ──────────────────────────

/** Promote a variant to an environment. Requires variant to exist. */
export async function promoteVariant(variantId, environment = "prod") {
  if (!variantId) throw new Error("variantId is required");
  if (!VALID_ENVIRONMENTS.has(environment)) {
    throw new Error(`environment must be one of: ${[...VALID_ENVIRONMENTS].join(", ")}`);
  }
  return withPathLock(DATA_FILE(), async () => {
    const store = await loadStore();
    const variant = store.variants[variantId];
    if (!variant) throw new Error("variant not found");
    if (variant.status === "deprecated") {
      throw new Error("cannot promote a deprecated variant");
    }
    variant.status = "promoted";
    store.deployments[variantId] = {
      environment,
      promotedAt: new Date().toISOString(),
      deprecatedAt: null,
      reason: null,
    };
    await saveStore(store);
    return { variantId, environment, status: "promoted" };
  });
}

/** Deprecate a variant with a reason. */
export async function deprecateVariant(variantId, reason) {
  if (!variantId) throw new Error("variantId is required");
  return withPathLock(DATA_FILE(), async () => {
    const store = await loadStore();
    const variant = store.variants[variantId];
    if (!variant) throw new Error("variant not found");
    variant.status = "deprecated";
    const dep = store.deployments[variantId] || {};
    dep.deprecatedAt = new Date().toISOString();
    dep.reason = typeof reason === "string" ? reason : "deprecated";
    store.deployments[variantId] = dep;
    await saveStore(store);
    return { variantId, status: "deprecated", reason: dep.reason };
  });
}

/** Return {variant, deployment, gate} for a variant. */
export async function getVariantStatus(variantId) {
  if (!variantId) return null;
  const store = await loadStore();
  const variant = store.variants[variantId];
  if (!variant) return null;
  return {
    variant,
    deployment: store.deployments[variantId] || null,
    gate: store.gates[variantId] || null,
    benchmarkCount: (store.benchmarks[variantId] || []).length,
  };
}

// ────────────────────────── recommendations ──────────────────────────

/**
 * Recommend variants matching the supplied constraints. Returns sorted list
 * of {variant, score} where score blends quality-loss and size proximity.
 *
 * @param {object}  constraints
 * @param {number}  [constraints.targetSizeMb]     Prefer variants at or below.
 * @param {number}  [constraints.minQuality]       Minimum quality (1-qualityLoss).
 * @param {string[]} [constraints.preferredMethods] Bias toward these methods.
 */
export function recommendVariant(constraints = {}) {
  // Synchronous: operates on a synchronous snapshot obtained elsewhere.
  // For convenience, callers can pass precomputed variants via constraints.variants.
  const { targetSizeMb, minQuality, preferredMethods, variants } = constraints;
  if (!Array.isArray(variants)) {
    // Async load not possible here; return helper to indicate usage.
    throw new Error("recommendVariant requires constraints.variants (pre-loaded from listVariants)");
  }
  const preferred = Array.isArray(preferredMethods) ? new Set(preferredMethods) : null;
  const scored = [];
  for (const v of variants) {
    if (v.status === "deprecated") continue;
    const spec = QUANT_METHODS[v.method];
    if (!spec) continue;
    const quality = 1 - spec.qualityLoss;
    if (minQuality != null && quality < minQuality) continue;
    if (targetSizeMb != null && v.sizeMb != null && v.sizeMb > targetSizeMb) continue;
    let score = quality;
    if (preferred && preferred.has(v.method)) score += 0.05;
    if (targetSizeMb != null && v.sizeMb != null) {
      const fit = 1 - Math.abs(v.sizeMb - targetSizeMb) / targetSizeMb;
      score += Math.max(-0.5, Math.min(0.5, fit)) * 0.2;
    }
    scored.push({
      variant: v,
      score: Math.round(score * 10000) / 10000,
      quality: Math.round(quality * 10000) / 10000,
    });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/**
 * Compare multiple variants side by side. Returns records with size, quality,
 * latency (from most recent benchmark), and deployment status.
 *
 * @param {string[]} variantIds
 */
export function compareVariants(variantIds) {
  if (!Array.isArray(variantIds) || variantIds.length === 0) {
    throw new Error("variantIds must be a non-empty array");
  }
  // Sync wrapper: returns a promise for the actual side-by-side table.
  return _compareVariantsAsync(variantIds);
}

async function _compareVariantsAsync(variantIds) {
  const store = await loadStore();
  const rows = [];
  for (const id of variantIds) {
    const variant = store.variants[id];
    if (!variant) {
      rows.push({ id, error: "not found" });
      continue;
    }
    const spec = QUANT_METHODS[variant.method] || {};
    const hist = store.benchmarks[id] || [];
    const latest = hist.length > 0 ? hist[hist.length - 1] : null;
    rows.push({
      id,
      baseModel: variant.baseModel,
      method: variant.method,
      sizeMb: variant.sizeMb,
      status: variant.status,
      quality: spec.qualityLoss != null ? Math.round((1 - spec.qualityLoss) * 10000) / 10000 : null,
      avgScore: latest?.avgScore ?? null,
      avgLatencyMs: latest?.avgLatencyMs ?? null,
      deployment: store.deployments[id] || null,
    });
  }
  // Rank by avgScore desc, fallback to quality.
  rows.sort((a, b) => {
    const sa = a.avgScore ?? a.quality ?? -Infinity;
    const sb = b.avgScore ?? b.quality ?? -Infinity;
    return sb - sa;
  });
  return rows;
}

// ────────────────────────── test helpers ──────────────────────────

/** Test-only: wipe all quantization state. */
export async function _resetQuantStoreForTest() {
  return withPathLock(DATA_FILE(), async () => {
    await saveStore(defaultStore());
  });
}
