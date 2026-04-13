/**
 * Phase 68.4: Source credibility — per-source reputation scoring.
 *
 * Score inputs:
 *   - citationCount : number of references to this source (in-domain).
 *   - ageDays       : how long the source has been registered / first seen.
 *   - updateFrequencyDays : average days between updates (lower = fresher).
 *   - manualOverride : optional float 0-1 from an operator override.
 *   - penalties     : optional list of deductions (e.g. retractions).
 *
 * Score calculation produces a 0-1 credibility. Weighted components:
 *   - citations: log-scaled
 *   - freshness: 1 / (1 + updateFrequencyDays / 30)
 *   - maturity : age clamped up to ~2 years
 *   - penalty  : subtracts a fraction (capped)
 *   - override : hard-pins the score when provided (operator opinion wins).
 *
 * Storage:
 *   data/source-credibility/{sourceKey}.json   — score record
 *   data/source-credibility/_index.json        — registry
 */
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

function sanitize(value) {
  return String(value || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 150) || "default";
}

function scorePath(sourceKey) {
  return join(getDataDir(), "source-credibility", `${sanitize(sourceKey)}.json`);
}

function indexPath() {
  return join(getDataDir(), "source-credibility", "_index.json");
}

async function updateIndex(sourceKey, remove = false, entry = null) {
  return withPathLock(indexPath(), async () => {
    const idx = await readJsonPath(indexPath(), { sources: [] });
    const list = Array.isArray(idx.sources) ? idx.sources : [];
    const filtered = list.filter((e) => e.sourceKey !== sourceKey);
    if (!remove && entry) filtered.push(entry);
    await writeJsonPath(indexPath(), { sources: filtered });
  });
}

// ─── Scoring ───────────────────────────────────────────────────────────────

export function computeCredibility(inputs = {}) {
  if (inputs.manualOverride != null) {
    const n = Number(inputs.manualOverride);
    if (Number.isFinite(n)) {
      return {
        score: Math.max(0, Math.min(1, n)),
        components: { manual: true },
      };
    }
  }
  const citations = Math.max(0, Number(inputs.citationCount) || 0);
  const citationScore = citations <= 0 ? 0 : Math.min(1, Math.log10(citations + 1) / Math.log10(1001));
  const ageDays = Math.max(0, Number(inputs.ageDays) || 0);
  const maturityScore = Math.min(1, ageDays / 730); // 2 years → saturated
  const updateFreq = Math.max(0, Number(inputs.updateFrequencyDays) || 0);
  const freshnessScore = 1 / (1 + (updateFreq || 30) / 30); // 0 freq → 1, 30 → 0.5, 120 → 0.2
  const components = {
    citationScore,
    maturityScore,
    freshnessScore,
  };
  // Weighted average.
  const weights = { citationScore: 0.5, maturityScore: 0.2, freshnessScore: 0.3 };
  let total = 0;
  let weightSum = 0;
  for (const [k, w] of Object.entries(weights)) {
    total += components[k] * w;
    weightSum += w;
  }
  let score = weightSum > 0 ? total / weightSum : 0;
  const penaltyList = Array.isArray(inputs.penalties) ? inputs.penalties : [];
  const penalty = penaltyList.reduce((acc, p) => acc + (Number(p.amount) || 0), 0);
  const clampedPenalty = Math.max(0, Math.min(0.9, penalty));
  components.penalty = clampedPenalty;
  score = Math.max(0, Math.min(1, score - clampedPenalty));
  return { score, components };
}

export function credibilityLevel(score) {
  if (score == null) return "unknown";
  if (score >= 0.8) return "high";
  if (score >= 0.5) return "moderate";
  if (score >= 0.2) return "low";
  return "minimal";
}

async function loadRecord(sourceKey) {
  const rec = await readJsonPath(scorePath(sourceKey), null);
  if (!rec || !rec.sourceKey || rec._deleted) return null;
  return rec;
}

/**
 * Score a source and persist the result.
 * sourceKey is a stable identifier (URL, domain, document id).
 */
export async function scoreSource(sourceKey, inputs = {}) {
  if (!sourceKey || typeof sourceKey !== "string") {
    throw new Error("sourceKey is required");
  }
  return withPathLock(scorePath(sourceKey), async () => {
    const { score, components } = computeCredibility(inputs);
    const existing = await loadRecord(sourceKey);
    const now = new Date().toISOString();
    const rec = existing || {
      sourceKey,
      firstSeenAt: now,
      createdAt: now,
      updatedAt: now,
      inputs: {},
      score: 0,
      level: credibilityLevel(0),
      history: [],
    };
    rec.updatedAt = now;
    rec.inputs = { ...rec.inputs, ...inputs };
    rec.score = score;
    rec.level = credibilityLevel(score);
    rec.components = components;
    rec.history.push({ at: now, score, components, inputs });
    if (rec.history.length > 100) rec.history = rec.history.slice(-100);
    await writeJsonPath(scorePath(sourceKey), rec);
    await updateIndex(sourceKey, false, {
      sourceKey,
      score,
      level: rec.level,
      updatedAt: now,
    });
    return rec;
  });
}

/**
 * Apply an override for a source without recomputing components.
 */
export async function updateScore(sourceKey, { manualOverride, penalties } = {}) {
  const existing = await loadRecord(sourceKey);
  if (!existing) {
    const err = new Error(`source ${sourceKey} not scored yet`);
    err.code = "NOT_FOUND";
    throw err;
  }
  const merged = { ...existing.inputs };
  if (manualOverride != null) merged.manualOverride = Number(manualOverride);
  if (Array.isArray(penalties)) merged.penalties = penalties;
  return scoreSource(sourceKey, merged);
}

export async function getScore(sourceKey) {
  if (!sourceKey) return null;
  return loadRecord(sourceKey);
}

export async function listScores(filter = {}) {
  const idx = await readJsonPath(indexPath(), { sources: [] });
  const entries = Array.isArray(idx.sources) ? idx.sources : [];
  const records = [];
  for (const entry of entries) {
    const rec = await loadRecord(entry.sourceKey);
    if (!rec) continue;
    if (filter.level && rec.level !== filter.level) continue;
    if (filter.minScore != null && rec.score < Number(filter.minScore)) continue;
    if (filter.maxScore != null && rec.score > Number(filter.maxScore)) continue;
    records.push(rec);
  }
  records.sort((a, b) => b.score - a.score);
  return records;
}

export const _internals = { scorePath, indexPath, computeCredibility };
