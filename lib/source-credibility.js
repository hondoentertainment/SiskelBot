// @ts-check
/**
 * Phase 68.4: Source credibility scoring.
 *
 * Tracks per-source reputation composed of accuracy, bias, and recency
 * signals. A simple blended score is produced for routing/display:
 *
 *   overall = 0.5 * accuracy + 0.3 * (1 - bias) + 0.2 * recency
 *
 * where `recency` decays from 1 down to 0 over a configurable horizon
 * (default 180 days).
 *
 * Exports:
 *   - scoreSource
 *   - updateReputation
 *   - listSources
 *   - getReputation
 *   - exportScorecard
 *
 * @module source-credibility
 */
import { join } from "path";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;
const DEFAULT_HORIZON_DAYS = 180;

function storePath() {
  return join(getDataDir(), "source-credibility.json");
}

async function loadStore() {
  const data = await readJsonPath(storePath(), { version: STORE_VERSION, sources: {} });
  if (!data.sources || typeof data.sources !== "object") data.sources = {};
  return data;
}

async function saveStore(data) {
  await writeJsonPath(storePath(), { version: STORE_VERSION, sources: data.sources || {} });
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Compute the recency factor from a timestamp.
 * @param {string | undefined} lastUpdatedAt
 * @param {number} horizonDays
 * @returns {number}
 */
function recencyFactor(lastUpdatedAt, horizonDays = DEFAULT_HORIZON_DAYS) {
  if (!lastUpdatedAt) return 0;
  const parsed = Date.parse(lastUpdatedAt);
  if (!Number.isFinite(parsed)) return 0;
  const ageMs = Date.now() - parsed;
  if (ageMs < 0) return 1;
  const horizonMs = horizonDays * 24 * 60 * 60 * 1000;
  if (ageMs >= horizonMs) return 0;
  return 1 - ageMs / horizonMs;
}

/**
 * Compute a blended credibility score from components.
 *
 * @param {{ accuracy?: number, bias?: number, lastUpdatedAt?: string }} inputs
 * @param {{ horizonDays?: number }} [opts]
 * @returns {{ accuracy: number, bias: number, recency: number, overall: number }}
 */
export function scoreSource(inputs, opts = {}) {
  const accuracy = clamp01(inputs?.accuracy);
  const bias = clamp01(inputs?.bias);
  const recency = clamp01(recencyFactor(inputs?.lastUpdatedAt, opts.horizonDays || DEFAULT_HORIZON_DAYS));
  const overall = 0.5 * accuracy + 0.3 * (1 - bias) + 0.2 * recency;
  return {
    accuracy: Math.round(accuracy * 10000) / 10000,
    bias: Math.round(bias * 10000) / 10000,
    recency: Math.round(recency * 10000) / 10000,
    overall: Math.round(overall * 10000) / 10000,
  };
}

/**
 * Update or create a source reputation entry. Partial updates are
 * merged with existing values; score is re-computed after each update.
 *
 * @param {string} sourceId
 * @param {{ name?: string, accuracy?: number, bias?: number, lastUpdatedAt?: string, notes?: string }} updates
 * @returns {Promise<object>}
 */
export async function updateReputation(sourceId, updates) {
  if (!sourceId || typeof sourceId !== "string") {
    throw new Error("sourceId is required");
  }
  if (!updates || typeof updates !== "object") {
    throw new Error("updates is required");
  }
  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    const now = new Date().toISOString();
    const existing = data.sources[sourceId] || {
      id: sourceId,
      accuracy: 0.5,
      bias: 0.5,
      lastUpdatedAt: now,
      history: [],
      createdAt: now,
    };
    const nextAccuracy = Number.isFinite(updates.accuracy) ? clamp01(updates.accuracy) : existing.accuracy;
    const nextBias = Number.isFinite(updates.bias) ? clamp01(updates.bias) : existing.bias;
    const merged = {
      ...existing,
      id: sourceId,
      name: typeof updates.name === "string" ? updates.name : existing.name || sourceId,
      accuracy: nextAccuracy,
      bias: nextBias,
      lastUpdatedAt: typeof updates.lastUpdatedAt === "string" ? updates.lastUpdatedAt : now,
      notes: typeof updates.notes === "string" ? updates.notes : existing.notes || "",
      updatedAt: now,
    };
    const score = scoreSource(merged);
    merged.score = score;
    const history = Array.isArray(existing.history) ? existing.history : [];
    history.push({ at: now, accuracy: merged.accuracy, bias: merged.bias, overall: score.overall });
    if (history.length > 100) history.splice(0, history.length - 100);
    merged.history = history;
    data.sources[sourceId] = merged;
    await saveStore(data);
    return merged;
  });
}

/**
 * Return every tracked source with its current score.
 * @returns {Promise<object[]>}
 */
export async function listSources() {
  const data = await loadStore();
  const all = Object.values(data.sources || {});
  all.sort((a, b) => (b.score?.overall || 0) - (a.score?.overall || 0));
  return all;
}

/**
 * Get the reputation record for a single source.
 * @param {string} sourceId
 * @returns {Promise<object | null>}
 */
export async function getReputation(sourceId) {
  if (!sourceId || typeof sourceId !== "string") return null;
  const data = await loadStore();
  return data.sources[sourceId] || null;
}

/**
 * Export a scorecard for all sources, suitable for display.
 * Includes rank, score components, and notes.
 *
 * @returns {Promise<object>}
 */
export async function exportScorecard() {
  const sources = await listSources();
  const rows = sources.map((s, i) => ({
    rank: i + 1,
    id: s.id,
    name: s.name || s.id,
    accuracy: s.score?.accuracy ?? 0,
    bias: s.score?.bias ?? 0,
    recency: s.score?.recency ?? 0,
    overall: s.score?.overall ?? 0,
    notes: s.notes || "",
    lastUpdatedAt: s.lastUpdatedAt || null,
  }));
  return {
    version: STORE_VERSION,
    generatedAt: new Date().toISOString(),
    count: rows.length,
    rows,
  };
}
