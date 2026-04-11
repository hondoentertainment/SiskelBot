// @ts-check
/**
 * Phase 62.5: CSAT (Customer Satisfaction) tracking.
 *
 * Feedback loop with aggregated scores. Supports:
 *   - `recordFeedback(feedback)` — append a 1–5 rating with comment
 *   - `getCsatScore(opts)` — overall or agent-scoped score
 *   - `getTrend(opts)` — daily or weekly rolling averages
 *   - `listFeedback(opts)` — paginated feedback entries
 *   - `exportCsv(opts)` — CSV export for analytics tools
 *
 * @module csat
 */
import { join } from "path";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;

function feedbackPath() {
  return join(getDataDir(), "csat-feedback.json");
}

async function loadFeedback() {
  const data = await readJsonPath(feedbackPath(), { version: STORE_VERSION, feedback: [] });
  if (!Array.isArray(data.feedback)) data.feedback = [];
  return data;
}

async function saveFeedback(data) {
  await writeJsonPath(feedbackPath(), { version: STORE_VERSION, feedback: data.feedback || [] });
}

/* -------------------------------------------------------------------------- */
/* Record feedback                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Append a feedback entry. Rating must be 1–5.
 *
 * @param {object} feedback
 * @returns {Promise<object>}
 */
export async function recordFeedback(feedback) {
  if (!feedback || typeof feedback !== "object") throw new Error("feedback is required");
  const rating = Number(feedback.rating);
  if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
    throw new Error("rating must be 1-5");
  }
  const path = feedbackPath();
  return withPathLock(path, async () => {
    const data = await loadFeedback();
    const now = new Date().toISOString();
    const record = {
      id: `cs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      rating,
      ticketId: feedback.ticketId || null,
      agentId: feedback.agentId || null,
      customerId: feedback.customerId || null,
      comment: typeof feedback.comment === "string" ? feedback.comment : "",
      tags: Array.isArray(feedback.tags) ? feedback.tags.slice() : [],
      createdAt: now,
    };
    data.feedback.push(record);
    if (data.feedback.length > 100000) data.feedback = data.feedback.slice(-100000);
    await saveFeedback(data);
    return record;
  });
}

/* -------------------------------------------------------------------------- */
/* Aggregation                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Compute a single aggregate CSAT score (%% satisfied = rating >= 4).
 *
 * @param {object} [opts]
 * @param {string} [opts.agentId]
 * @param {string} [opts.from] ISO date lower bound (inclusive)
 * @param {string} [opts.to]   ISO date upper bound (inclusive)
 * @returns {Promise<{ score: number, avgRating: number, total: number, satisfied: number }>}
 */
export async function getCsatScore(opts = {}) {
  const items = await filterFeedback(opts);
  const total = items.length;
  if (total === 0) return { score: 0, avgRating: 0, total: 0, satisfied: 0 };
  let sum = 0;
  let satisfied = 0;
  for (const f of items) {
    sum += f.rating;
    if (f.rating >= 4) satisfied += 1;
  }
  return {
    score: Math.round((satisfied / total) * 10000) / 100,
    avgRating: Math.round((sum / total) * 100) / 100,
    total,
    satisfied,
  };
}

/**
 * Compute a time-series trend of CSAT scores.
 *
 * @param {object} [opts]
 * @param {"daily"|"weekly"} [opts.bucket]
 * @returns {Promise<Array<{ date: string, total: number, avgRating: number, score: number }>>}
 */
export async function getTrend(opts = {}) {
  const items = await filterFeedback(opts);
  const bucket = opts.bucket === "weekly" ? "weekly" : "daily";
  /** @type {Record<string, { sum: number, total: number, satisfied: number }>} */
  const buckets = {};
  for (const f of items) {
    const d = new Date(f.createdAt);
    if (Number.isNaN(d.getTime())) continue;
    let key;
    if (bucket === "weekly") {
      // ISO-week-ish: YYYY-W##
      const start = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
      const diff = Math.floor((d.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
      const week = Math.floor(diff / 7) + 1;
      key = `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
    } else {
      key = d.toISOString().slice(0, 10);
    }
    if (!buckets[key]) buckets[key] = { sum: 0, total: 0, satisfied: 0 };
    buckets[key].sum += f.rating;
    buckets[key].total += 1;
    if (f.rating >= 4) buckets[key].satisfied += 1;
  }
  const out = Object.entries(buckets)
    .map(([date, agg]) => ({
      date,
      total: agg.total,
      avgRating: Math.round((agg.sum / agg.total) * 100) / 100,
      score: Math.round((agg.satisfied / agg.total) * 10000) / 100,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

/**
 * List feedback entries with filters and pagination.
 *
 * @param {object} [opts]
 * @returns {Promise<{ items: Array<object>, total: number }>}
 */
export async function listFeedback(opts = {}) {
  const items = await filterFeedback(opts);
  const sorted = items.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const offset = Number.isFinite(opts.offset) ? Math.max(0, Math.floor(opts.offset)) : 0;
  const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? Math.floor(opts.limit) : 100;
  return { items: sorted.slice(offset, offset + limit), total: sorted.length };
}

/**
 * Internal: apply filter options to the raw feedback list.
 *
 * @param {object} opts
 * @returns {Promise<Array<object>>}
 */
async function filterFeedback(opts) {
  const data = await loadFeedback();
  let items = data.feedback.slice();
  if (opts.agentId) items = items.filter((f) => f.agentId === opts.agentId);
  if (opts.ticketId) items = items.filter((f) => f.ticketId === opts.ticketId);
  if (opts.customerId) items = items.filter((f) => f.customerId === opts.customerId);
  if (opts.from) items = items.filter((f) => f.createdAt >= opts.from);
  if (opts.to) items = items.filter((f) => f.createdAt <= opts.to);
  if (Array.isArray(opts.tags) && opts.tags.length > 0) {
    const wanted = new Set(opts.tags);
    items = items.filter((f) => Array.isArray(f.tags) && f.tags.some((t) => wanted.has(t)));
  }
  return items;
}

/* -------------------------------------------------------------------------- */
/* Export                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Export feedback to a CSV string.
 *
 * @param {object} [opts]
 * @returns {Promise<string>}
 */
export async function exportCsv(opts = {}) {
  const items = await filterFeedback(opts);
  const header = "id,rating,ticketId,agentId,customerId,createdAt,comment";
  const rows = items.map((f) => {
    const fields = [
      f.id,
      f.rating,
      f.ticketId || "",
      f.agentId || "",
      f.customerId || "",
      f.createdAt,
      csvEscape(f.comment || ""),
    ];
    return fields.join(",");
  });
  return [header, ...rows].join("\n");
}

function csvEscape(s) {
  const str = String(s);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}
