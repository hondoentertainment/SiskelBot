/**
 * Phase 65.5: AI risk scoring — NIST AI RMF aligned (1.0) scoring.
 *
 * The NIST AI Risk Management Framework has four core functions:
 *   - govern  : organizational policies, accountability, culture
 *   - map     : context awareness — who/where the AI is used
 *   - measure : risk quantification, testing, monitoring
 *   - manage  : mitigation, response, continuous improvement
 *
 * Each category is scored 1-5 (1 = minimal coverage, 5 = fully established).
 * An overall score is the average (weighted by category). Per-model records
 * track scores over time and across reviewers for audit trails.
 *
 * Storage:
 *   data/ai-risk-scoring/{modelId}.json   — per-model record
 *   data/ai-risk-scoring/_index.json      — registry
 */
import { randomUUID } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

export const RMF_CATEGORIES = ["govern", "map", "measure", "manage"];
export const DEFAULT_WEIGHTS = { govern: 1, map: 1, measure: 1, manage: 1 };

function sanitize(value) {
  return String(value || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || "default";
}

function scorePath(modelId) {
  return join(getDataDir(), "ai-risk-scoring", `${sanitize(modelId)}.json`);
}

function indexPath() {
  return join(getDataDir(), "ai-risk-scoring", "_index.json");
}

async function updateIndex(modelId, remove = false, entry = null) {
  return withPathLock(indexPath(), async () => {
    const idx = await readJsonPath(indexPath(), { models: [] });
    const list = Array.isArray(idx.models) ? idx.models : [];
    const filtered = list.filter((e) => e.modelId !== modelId);
    if (!remove && entry) filtered.push(entry);
    await writeJsonPath(indexPath(), { models: filtered });
  });
}

function normalizeScores(scores) {
  const out = {};
  for (const cat of RMF_CATEGORIES) {
    const raw = scores?.[cat];
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      out[cat] = null;
      continue;
    }
    const clamped = Math.max(1, Math.min(5, Math.round(n)));
    out[cat] = clamped;
  }
  return out;
}

function computeOverall(scores, weights = DEFAULT_WEIGHTS) {
  let total = 0;
  let weight = 0;
  for (const cat of RMF_CATEGORIES) {
    const v = scores?.[cat];
    if (v == null) continue;
    const w = Number(weights?.[cat]) || 0;
    if (w <= 0) continue;
    total += v * w;
    weight += w;
  }
  if (weight === 0) return null;
  return total / weight;
}

function riskLevel(overall) {
  if (overall == null) return "unknown";
  if (overall >= 4.5) return "minimal";
  if (overall >= 3.5) return "low";
  if (overall >= 2.5) return "moderate";
  if (overall >= 1.5) return "high";
  return "critical";
}

async function loadRecord(modelId) {
  const data = await readJsonPath(scorePath(modelId), null);
  if (!data || !data.modelId || data._deleted) return null;
  return data;
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Record a new score for a model. Creates the record on first call, appends
 * on subsequent calls. `scores` must be an object with at least one of
 * govern/map/measure/manage in the 1-5 range.
 */
export async function scoreModel(modelId, { scores, reviewer, rationale, weights, evidence } = {}) {
  if (!modelId || typeof modelId !== "string") {
    throw new Error("modelId is required");
  }
  if (!scores || typeof scores !== "object") {
    throw new Error("scores object is required");
  }
  const normalized = normalizeScores(scores);
  const hasAny = RMF_CATEGORIES.some((c) => normalized[c] != null);
  if (!hasAny) {
    throw new Error("scores must include at least one RMF category value");
  }
  return withPathLock(scorePath(modelId), async () => {
    const now = new Date().toISOString();
    const existing = await loadRecord(modelId);
    const appliedWeights = weights && typeof weights === "object" ? { ...DEFAULT_WEIGHTS, ...weights } : DEFAULT_WEIGHTS;
    const entry = {
      id: randomUUID(),
      at: now,
      reviewer: reviewer || "system",
      rationale: rationale || "",
      evidence: Array.isArray(evidence) ? evidence.map(String) : [],
      scores: normalized,
      weights: appliedWeights,
      overall: computeOverall(normalized, appliedWeights),
    };
    entry.level = riskLevel(entry.overall);

    const rec = existing || {
      modelId,
      createdAt: now,
      updatedAt: now,
      latest: null,
      history: [],
    };
    rec.updatedAt = now;
    rec.latest = entry;
    rec.history.push(entry);
    await writeJsonPath(scorePath(modelId), rec);
    await updateIndex(modelId, false, {
      modelId,
      updatedAt: now,
      overall: entry.overall,
      level: entry.level,
    });
    return rec;
  });
}

export async function getScore(modelId) {
  if (!modelId) return null;
  const rec = await loadRecord(modelId);
  return rec || null;
}

export async function listScores(filter = {}) {
  const idx = await readJsonPath(indexPath(), { models: [] });
  const entries = Array.isArray(idx.models) ? idx.models : [];
  const records = [];
  for (const entry of entries) {
    const rec = await loadRecord(entry.modelId);
    if (!rec) continue;
    if (filter.level && rec.latest?.level !== filter.level) continue;
    if (filter.minOverall != null && (rec.latest?.overall ?? -Infinity) < Number(filter.minOverall)) continue;
    if (filter.maxOverall != null && (rec.latest?.overall ?? Infinity) > Number(filter.maxOverall)) continue;
    records.push(rec);
  }
  return records;
}

/**
 * Compute RMF coverage across all scored models — fraction with scores in each
 * category, plus average per-category score.
 */
export async function getRmfCoverage() {
  const records = await listScores();
  const total = records.length;
  const counts = { govern: 0, map: 0, measure: 0, manage: 0 };
  const sums = { govern: 0, map: 0, measure: 0, manage: 0 };
  const levels = { minimal: 0, low: 0, moderate: 0, high: 0, critical: 0, unknown: 0 };
  let overallSum = 0;
  let overallCount = 0;
  for (const rec of records) {
    const latest = rec.latest;
    if (!latest) continue;
    for (const cat of RMF_CATEGORIES) {
      const v = latest.scores?.[cat];
      if (v != null) {
        counts[cat] += 1;
        sums[cat] += v;
      }
    }
    const lvl = latest.level || "unknown";
    levels[lvl] = (levels[lvl] || 0) + 1;
    if (latest.overall != null) {
      overallSum += latest.overall;
      overallCount += 1;
    }
  }
  const coverage = {};
  const averages = {};
  for (const cat of RMF_CATEGORIES) {
    coverage[cat] = total > 0 ? counts[cat] / total : 0;
    averages[cat] = counts[cat] > 0 ? sums[cat] / counts[cat] : null;
  }
  return {
    totalModels: total,
    coverage,
    averages,
    distribution: levels,
    averageOverall: overallCount > 0 ? overallSum / overallCount : null,
  };
}

export const _internals = { scorePath, indexPath, computeOverall, riskLevel, normalizeScores };
