/**
 * Phase 62.5: CSAT tracking — feedback loop with aggregated scores.
 *
 * Stores post-ticket surveys (1–5 CSAT) and NPS (0–10), derives per-agent
 * rollups, overall CSAT average, NPS score (promoters − detractors), and a
 * time-bucketed trend. All aggregation is computed from raw entries at read
 * time so deletes/corrections are reflected immediately.
 *
 * Storage layout (via json-path-store):
 *   data/csat/feedback.json   — append-only feedback entries (ring-buffered)
 */
import { join } from "path";
import { randomUUID } from "crypto";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

// ─── Paths ─────────────────────────────────────────────────────────────────

function feedbackPath() {
  return join(getDataDir(), "csat", "feedback.json");
}

const MAX_ENTRIES = 10_000;

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Record a piece of customer feedback.
 *
 * @param {{
 *   ticketId: string,
 *   agentId?: string,
 *   csat?: number,       // 1..5
 *   nps?: number,        // 0..10
 *   comment?: string,
 *   tags?: string[],
 * }} opts
 */
export async function recordFeedback(opts = {}) {
  if (!opts || typeof opts !== "object") throw new Error("opts is required");
  if (!opts.ticketId || typeof opts.ticketId !== "string") throw new Error("ticketId is required");
  if (opts.csat == null && opts.nps == null) {
    throw new Error("csat or nps is required");
  }
  const csat = opts.csat != null ? validateRange(opts.csat, 1, 5, "csat") : null;
  const nps = opts.nps != null ? validateRange(opts.nps, 0, 10, "nps") : null;
  const entry = {
    id: randomUUID(),
    ticketId: opts.ticketId,
    agentId: opts.agentId || null,
    csat,
    nps,
    comment: typeof opts.comment === "string" ? opts.comment : null,
    tags: Array.isArray(opts.tags) ? opts.tags.map((t) => String(t)) : [],
    recordedAt: new Date().toISOString(),
  };
  await withPathLock(feedbackPath(), async () => {
    const data = await readJsonPath(feedbackPath(), { entries: [] });
    const list = Array.isArray(data.entries) ? data.entries : [];
    list.unshift(entry);
    if (list.length > MAX_ENTRIES) list.length = MAX_ENTRIES;
    await writeJsonPath(feedbackPath(), { entries: list });
  });
  return entry;
}

function validateRange(value, min, max, field) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`${field} must be between ${min} and ${max}`);
  }
  return n;
}

export async function listFeedback(opts = {}) {
  const data = await readJsonPath(feedbackPath(), { entries: [] });
  const list = Array.isArray(data.entries) ? data.entries : [];
  const limit = Math.max(1, Math.min(MAX_ENTRIES, Number(opts.limit) || 100));
  let filtered = list;
  if (opts.agentId) filtered = filtered.filter((e) => e.agentId === opts.agentId);
  if (opts.ticketId) filtered = filtered.filter((e) => e.ticketId === opts.ticketId);
  if (opts.since) {
    const s = Date.parse(opts.since);
    filtered = filtered.filter((e) => Date.parse(e.recordedAt) >= s);
  }
  return filtered.slice(0, limit);
}

/**
 * Compute an aggregated CSAT/NPS report. Includes:
 *   - overall CSAT average
 *   - NPS score (promoters − detractors) / total
 *   - per-agent rollup
 *   - daily trend (last 30 days by default)
 */
export async function getCsatReport(opts = {}) {
  const data = await readJsonPath(feedbackPath(), { entries: [] });
  const list = Array.isArray(data.entries) ? data.entries : [];
  const since = opts.since ? Date.parse(opts.since) : 0;
  const filtered = since > 0
    ? list.filter((e) => Date.parse(e.recordedAt) >= since)
    : list;

  const csatValues = filtered.map((e) => e.csat).filter((v) => typeof v === "number");
  const npsValues = filtered.map((e) => e.nps).filter((v) => typeof v === "number");

  const overall = {
    totalFeedback: filtered.length,
    csatResponses: csatValues.length,
    csatAverage: avg(csatValues),
    csatDistribution: distribution(csatValues, 1, 5),
    npsResponses: npsValues.length,
    npsScore: computeNps(npsValues),
    promoters: npsValues.filter((v) => v >= 9).length,
    passives: npsValues.filter((v) => v >= 7 && v <= 8).length,
    detractors: npsValues.filter((v) => v <= 6).length,
  };

  const byAgent = {};
  for (const entry of filtered) {
    if (!entry.agentId) continue;
    const bucket = byAgent[entry.agentId] || {
      agentId: entry.agentId,
      totalFeedback: 0,
      csatValues: [],
      npsValues: [],
    };
    bucket.totalFeedback += 1;
    if (typeof entry.csat === "number") bucket.csatValues.push(entry.csat);
    if (typeof entry.nps === "number") bucket.npsValues.push(entry.nps);
    byAgent[entry.agentId] = bucket;
  }
  const perAgent = Object.values(byAgent).map((b) => ({
    agentId: b.agentId,
    totalFeedback: b.totalFeedback,
    csatAverage: avg(b.csatValues),
    csatResponses: b.csatValues.length,
    npsScore: computeNps(b.npsValues),
    npsResponses: b.npsValues.length,
  })).sort((a, b) => (b.csatAverage || 0) - (a.csatAverage || 0));

  const trend = buildTrend(filtered, opts.trendDays || 30);

  return { overall, perAgent, trend };
}

function avg(arr) {
  if (!arr.length) return null;
  const s = arr.reduce((a, b) => a + b, 0);
  return Math.round((s / arr.length) * 1000) / 1000;
}

function distribution(arr, min, max) {
  const d = {};
  for (let i = min; i <= max; i++) d[i] = 0;
  for (const v of arr) {
    const n = Math.round(v);
    if (d[n] != null) d[n] += 1;
  }
  return d;
}

function computeNps(values) {
  if (!values.length) return null;
  const promoters = values.filter((v) => v >= 9).length;
  const detractors = values.filter((v) => v <= 6).length;
  return Math.round(((promoters - detractors) / values.length) * 100);
}

function buildTrend(entries, days) {
  const buckets = new Map();
  const now = Date.now();
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  for (const e of entries) {
    const t = Date.parse(e.recordedAt);
    if (!Number.isFinite(t) || t < cutoff) continue;
    const day = new Date(t).toISOString().slice(0, 10);
    const b = buckets.get(day) || { day, total: 0, csat: [], nps: [] };
    b.total += 1;
    if (typeof e.csat === "number") b.csat.push(e.csat);
    if (typeof e.nps === "number") b.nps.push(e.nps);
    buckets.set(day, b);
  }
  return [...buckets.values()]
    .map((b) => ({
      day: b.day,
      total: b.total,
      csatAverage: avg(b.csat),
      npsScore: computeNps(b.nps),
    }))
    .sort((a, b) => a.day.localeCompare(b.day));
}

export const _internals = {
  feedbackPath,
  avg,
  computeNps,
  distribution,
  buildTrend,
  MAX_ENTRIES,
};
