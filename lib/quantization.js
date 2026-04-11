// @ts-check
/**
 * Phase 58.5: Quantization management.
 *
 * Tracks quantized (INT4 / INT8 / FP16 / FP32) variants of a base
 * model, recording quality-evaluation scores over time and gating
 * promotion of a variant from "candidate" to "active" behind a
 * configurable quality floor.
 *
 * A variant is identified by `{modelId, precision, variantId}`. Each
 * variant accumulates a rolling list of quality scores (e.g. eval-set
 * win-rate, bleu, judge-approval). `canPromote` reports whether the
 * latest rolling average meets the configured floor. `promoteVariant`
 * marks a variant as active and demotes any prior active variant
 * for the same base model.
 *
 * The module exposes:
 *   - `registerVariant(spec)`
 *   - `listVariants(opts?)`
 *   - `recordQualityScore(variantId, score, meta?)`
 *   - `canPromote(variantId, opts?)`
 *   - `promoteVariant(variantId)`
 *
 * @module quantization
 */
import { join } from "path";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;

const ALLOWED_PRECISIONS = new Set(["int4", "int8", "fp16", "bf16", "fp32"]);

function variantsPath() {
  return join(getDataDir(), "quantization-variants.json");
}

/* -------------------------------------------------------------------------- */
/* Load / save                                                                */
/* -------------------------------------------------------------------------- */

async function loadStore() {
  const data = await readJsonPath(variantsPath(), {
    version: STORE_VERSION,
    variants: {},
  });
  if (!data.variants || typeof data.variants !== "object") data.variants = {};
  return data;
}

async function saveStore(data) {
  await writeJsonPath(variantsPath(), {
    version: STORE_VERSION,
    variants: data.variants || {},
    updatedAt: new Date().toISOString(),
  });
}

function rollingAverage(scores) {
  if (!Array.isArray(scores) || scores.length === 0) return 0;
  let sum = 0;
  for (const s of scores) sum += Number(s.value) || 0;
  return Math.round((sum / scores.length) * 10000) / 10000;
}

/* -------------------------------------------------------------------------- */
/* Registration                                                               */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} VariantSpec
 * @property {string} variantId        Globally unique id for the variant.
 * @property {string} modelId          Base model id.
 * @property {string} precision        One of int4 / int8 / fp16 / bf16 / fp32.
 * @property {string} [notes]
 * @property {number} [qualityFloor]   Required score to promote (0..1).
 * @property {number} [maxScoreWindow] Rolling window cap. Defaults 20.
 */

/**
 * Register a new quantized variant. Re-registering merges fields.
 *
 * @param {VariantSpec} spec
 * @returns {Promise<object>}
 */
export async function registerVariant(spec) {
  if (!spec || typeof spec !== "object") throw new Error("spec is required");
  if (!spec.variantId || typeof spec.variantId !== "string") {
    throw new Error("variantId is required");
  }
  if (!spec.modelId || typeof spec.modelId !== "string") {
    throw new Error("modelId is required");
  }
  if (!spec.precision || !ALLOWED_PRECISIONS.has(String(spec.precision))) {
    throw new Error(
      `precision must be one of: ${[...ALLOWED_PRECISIONS].join(", ")}`,
    );
  }
  const path = variantsPath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    const now = new Date().toISOString();
    const existing = data.variants[spec.variantId] || {
      createdAt: now,
      scores: [],
      status: "candidate",
    };
    const rec = {
      ...existing,
      variantId: spec.variantId,
      modelId: spec.modelId,
      precision: spec.precision,
      notes: spec.notes ?? existing.notes ?? null,
      qualityFloor: Number.isFinite(spec.qualityFloor)
        ? Math.max(0, Math.min(1, Number(spec.qualityFloor)))
        : existing.qualityFloor ?? 0.8,
      maxScoreWindow: Number.isFinite(spec.maxScoreWindow) && spec.maxScoreWindow > 0
        ? Math.floor(spec.maxScoreWindow)
        : existing.maxScoreWindow ?? 20,
      status: existing.status || "candidate",
      scores: Array.isArray(existing.scores) ? existing.scores : [],
      updatedAt: now,
    };
    data.variants[spec.variantId] = rec;
    await saveStore(data);
    return rec;
  });
}

/* -------------------------------------------------------------------------- */
/* Listing                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * List all variants, optionally filtering by model id or status.
 *
 * @param {{ modelId?: string, status?: string }} [opts]
 * @returns {Promise<object[]>}
 */
export async function listVariants(opts = {}) {
  const data = await loadStore();
  let out = Object.values(data.variants || {});
  if (opts.modelId) out = out.filter((v) => v.modelId === opts.modelId);
  if (opts.status) out = out.filter((v) => v.status === opts.status);
  return out.map((v) => ({
    ...v,
    averageQuality: rollingAverage(v.scores || []),
    scoreCount: Array.isArray(v.scores) ? v.scores.length : 0,
  }));
}

/* -------------------------------------------------------------------------- */
/* Score recording                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Record a quality-eval score for a variant.
 *
 * @param {string} variantId
 * @param {number} score      Value in [0, 1].
 * @param {object} [meta]
 * @returns {Promise<object>}
 */
export async function recordQualityScore(variantId, score, meta = {}) {
  if (!variantId || typeof variantId !== "string") {
    throw new Error("variantId is required");
  }
  if (!Number.isFinite(score)) {
    throw new Error("score must be a finite number");
  }
  const path = variantsPath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    const v = data.variants[variantId];
    if (!v) throw new Error(`unknown variant: ${variantId}`);
    v.scores = Array.isArray(v.scores) ? v.scores : [];
    const entry = {
      value: Math.max(0, Math.min(1, Number(score))),
      meta: meta && typeof meta === "object" ? meta : {},
      recordedAt: new Date().toISOString(),
    };
    v.scores.push(entry);
    const window = Number.isFinite(v.maxScoreWindow) && v.maxScoreWindow > 0
      ? v.maxScoreWindow
      : 20;
    if (v.scores.length > window) {
      v.scores = v.scores.slice(-window);
    }
    v.averageQuality = rollingAverage(v.scores);
    v.updatedAt = new Date().toISOString();
    data.variants[variantId] = v;
    await saveStore(data);
    return { ...v, averageQuality: v.averageQuality, scoreCount: v.scores.length };
  });
}

/* -------------------------------------------------------------------------- */
/* Promotion gates                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Determine whether a variant is eligible for promotion.
 *
 * @param {string} variantId
 * @param {{ minScores?: number }} [opts]
 * @returns {Promise<{ ok: boolean, reason: string, average: number, floor: number, count: number }>}
 */
export async function canPromote(variantId, opts = {}) {
  if (!variantId || typeof variantId !== "string") {
    return { ok: false, reason: "variantId required", average: 0, floor: 0, count: 0 };
  }
  const minScores = Number.isFinite(opts.minScores) && opts.minScores > 0
    ? Math.floor(opts.minScores)
    : 3;
  const data = await loadStore();
  const v = data.variants[variantId];
  if (!v) return { ok: false, reason: "unknown variant", average: 0, floor: 0, count: 0 };
  const count = Array.isArray(v.scores) ? v.scores.length : 0;
  const average = rollingAverage(v.scores || []);
  const floor = Number.isFinite(v.qualityFloor) ? v.qualityFloor : 0.8;
  if (count < minScores) {
    return { ok: false, reason: `need at least ${minScores} scores (have ${count})`, average, floor, count };
  }
  if (average < floor) {
    return { ok: false, reason: `average ${average} below floor ${floor}`, average, floor, count };
  }
  if (v.status === "active") {
    return { ok: false, reason: "already active", average, floor, count };
  }
  return { ok: true, reason: "eligible", average, floor, count };
}

/**
 * Promote a variant to "active". Any previously active variant for
 * the same `modelId` is demoted to "deprecated".
 *
 * @param {string} variantId
 * @returns {Promise<object>}
 */
export async function promoteVariant(variantId) {
  const gate = await canPromote(variantId);
  if (!gate.ok) {
    throw new Error(`cannot promote: ${gate.reason}`);
  }
  const path = variantsPath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    const v = data.variants[variantId];
    if (!v) throw new Error(`unknown variant: ${variantId}`);
    // Demote any prior active variant for the same base model.
    for (const [id, rec] of Object.entries(data.variants)) {
      if (id === variantId) continue;
      if (rec.modelId === v.modelId && rec.status === "active") {
        rec.status = "deprecated";
        rec.updatedAt = new Date().toISOString();
      }
    }
    v.status = "active";
    v.promotedAt = new Date().toISOString();
    v.updatedAt = v.promotedAt;
    data.variants[variantId] = v;
    await saveStore(data);
    return v;
  });
}
