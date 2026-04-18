/**
 * Append-only per-workspace history of evaluation metric samples.
 *
 * Backs the /api/admin/eval-history/* admin endpoints. Callers record a
 * single sample (benchmark / safety / feedback / genealogy / custom) and can
 * then query the history either as a raw list or as a bucketed time series.
 *
 * Storage pattern (same routing as lib/storage.js via json-path-store):
 *   data/eval-history/<workspace>/samples.json
 *
 * Blob shape:
 *   { version: 1, updatedAt, samples: EvalSample[] }   // newest-last, ring buffer
 *
 * Ring buffer cap: 10_000 samples per workspace.
 *
 * @module eval-history-store
 */

import { join } from "path";
import { randomUUID } from "crypto";
import { readJsonPath, writeJsonPath, getDataDir, withPathLock } from "./json-path-store.js";

const MAX_SAMPLES = 10_000;
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 1_000;
const ALLOWED_KINDS = new Set(["benchmark", "safety", "feedback", "genealogy", "custom"]);
const MAX_TAG_ENTRIES = 10;
const MAX_TAG_STR = 64;

/**
 * @typedef {object} EvalSample
 * @property {string} id
 * @property {number} ts
 * @property {string} workspace
 * @property {"benchmark" | "safety" | "feedback" | "genealogy" | "custom"} kind
 * @property {string} [suite]
 * @property {Record<string, number>} metrics
 * @property {string} [commit]
 * @property {Record<string, string>} [tags]
 */

function sanitizeSegment(s) {
  if (typeof s !== "string" || s.length === 0) return "default";
  return s.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80);
}

function storePath(workspace) {
  return join(getDataDir(), "eval-history", sanitizeSegment(workspace), "samples.json");
}

function emptyBlob() {
  return { version: 1, updatedAt: 0, samples: [] };
}

async function loadBlob(workspace) {
  const raw = await readJsonPath(storePath(workspace), emptyBlob());
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.samples)) return emptyBlob();
  return raw;
}

function truncTags(tags) {
  if (!tags || typeof tags !== "object") return undefined;
  const entries = Object.entries(tags).slice(0, MAX_TAG_ENTRIES);
  const out = {};
  for (const [k, v] of entries) {
    if (typeof k !== "string") continue;
    const key = k.slice(0, MAX_TAG_STR);
    const val = String(v == null ? "" : v).slice(0, MAX_TAG_STR);
    out[key] = val;
  }
  return out;
}

function validateSample(sample) {
  if (!sample || typeof sample !== "object") throw new Error("sample must be an object");
  if (!Number.isFinite(sample.ts)) throw new Error("sample.ts must be a finite number");
  if (!ALLOWED_KINDS.has(sample.kind)) {
    throw new Error(`sample.kind must be one of ${[...ALLOWED_KINDS].join(",")}`);
  }
  if (!sample.metrics || typeof sample.metrics !== "object" || Array.isArray(sample.metrics)) {
    throw new Error("sample.metrics must be an object");
  }
  const keys = Object.keys(sample.metrics);
  if (keys.length === 0) throw new Error("sample.metrics must be non-empty");
  for (const k of keys) {
    if (!Number.isFinite(sample.metrics[k])) {
      throw new Error(`sample.metrics.${k} must be a finite number`);
    }
  }
}

/**
 * Record a single evaluation metric sample for the workspace.
 *
 * The caller supplies ts/kind/metrics; id is generated if missing. Rejects
 * invalid samples. Applies a 10_000-sample ring buffer.
 *
 * @param {string} workspace
 * @param {Partial<EvalSample>} sample
 * @returns {Promise<EvalSample>}
 */
export async function recordSample(workspace, sample) {
  validateSample(sample);
  const ws = sanitizeSegment(workspace);
  const path = storePath(workspace);

  return withPathLock(path, async () => {
    const blob = await loadBlob(workspace);
    /** @type {EvalSample} */
    const saved = {
      id: typeof sample.id === "string" && sample.id ? sample.id : randomUUID(),
      ts: Number(sample.ts),
      workspace: ws,
      kind: sample.kind,
      metrics: { ...sample.metrics },
    };
    if (typeof sample.suite === "string" && sample.suite) saved.suite = sample.suite.slice(0, 80);
    if (typeof sample.commit === "string" && sample.commit) saved.commit = sample.commit.slice(0, 120);
    const tags = truncTags(sample.tags);
    if (tags && Object.keys(tags).length > 0) saved.tags = tags;

    blob.samples.push(saved);
    if (blob.samples.length > MAX_SAMPLES) {
      blob.samples.splice(0, blob.samples.length - MAX_SAMPLES);
    }
    blob.updatedAt = Date.now();
    blob.version = 1;
    await writeJsonPath(path, blob);
    return saved;
  });
}

/**
 * List samples for a workspace, newest-first, filterable by kind/suite/time.
 *
 * @param {string} workspace
 * @param {object} [opts]
 * @param {string} [opts.kind]
 * @param {string} [opts.suite]
 * @param {number} [opts.sinceTs]
 * @param {number} [opts.untilTs]
 * @param {number} [opts.limit]
 * @returns {Promise<EvalSample[]>}
 */
export async function listSamples(workspace, opts = {}) {
  const blob = await loadBlob(workspace);
  let out = blob.samples.slice();
  if (opts.kind) out = out.filter((s) => s.kind === opts.kind);
  if (opts.suite) out = out.filter((s) => s.suite === opts.suite);
  if (Number.isFinite(opts.sinceTs)) out = out.filter((s) => s.ts >= Number(opts.sinceTs));
  if (Number.isFinite(opts.untilTs)) out = out.filter((s) => s.ts <= Number(opts.untilTs));
  out.sort((a, b) => b.ts - a.ts);
  const limit = Math.max(1, Math.min(MAX_LIST_LIMIT, Number(opts.limit) || DEFAULT_LIST_LIMIT));
  return out.slice(0, limit);
}

const MS_HOUR = 3600_000;
const MS_DAY = 86_400_000;
const MS_WEEK = 7 * MS_DAY;

/**
 * Bucket boundary (ms, UTC). "day" and "hour" snap to their UTC boundaries.
 * "week" snaps to UTC Monday 00:00 (ISO week start).
 */
function bucketKey(ts, bucket) {
  if (bucket === "hour") return Math.floor(ts / MS_HOUR) * MS_HOUR;
  if (bucket === "day") return Math.floor(ts / MS_DAY) * MS_DAY;
  if (bucket === "week") {
    // 1970-01-01 was a Thursday. Shift so Monday is the anchor: +3 days → Thu aligned to week start.
    const shift = 4 * MS_DAY; // shift so week buckets start on Monday 00:00 UTC
    return Math.floor((ts - shift) / MS_WEEK) * MS_WEEK + shift;
  }
  return ts;
}

/**
 * Build a bucketed time series for a single metric.
 *
 * If bucket === "raw" (or omitted), returns each sample's value as-is.
 * Otherwise aggregates by UTC bucket boundary, returning the mean value and
 * the sample count per bucket. Oldest-first.
 *
 * @param {string} workspace
 * @param {object} opts
 * @param {string} opts.kind
 * @param {string} opts.metric
 * @param {string} [opts.suite]
 * @param {number} [opts.sinceTs]
 * @param {number} [opts.untilTs]
 * @param {"hour"|"day"|"week"|"raw"} [opts.bucket]
 * @returns {Promise<Array<{ts: number, value: number, count: number}>>}
 */
export async function getSeries(workspace, opts) {
  if (!opts || typeof opts !== "object") throw new Error("getSeries: opts required");
  if (typeof opts.kind !== "string" || !opts.kind) throw new Error("getSeries: kind required");
  if (typeof opts.metric !== "string" || !opts.metric) throw new Error("getSeries: metric required");
  const bucket = opts.bucket && opts.bucket !== "raw" ? opts.bucket : "raw";
  const blob = await loadBlob(workspace);

  const matching = blob.samples.filter((s) => {
    if (s.kind !== opts.kind) return false;
    if (opts.suite && s.suite !== opts.suite) return false;
    if (Number.isFinite(opts.sinceTs) && s.ts < Number(opts.sinceTs)) return false;
    if (Number.isFinite(opts.untilTs) && s.ts > Number(opts.untilTs)) return false;
    const v = s.metrics?.[opts.metric];
    return Number.isFinite(v);
  });

  if (bucket === "raw") {
    return matching
      .map((s) => ({ ts: s.ts, value: Number(s.metrics[opts.metric]), count: 1 }))
      .sort((a, b) => a.ts - b.ts);
  }

  const buckets = new Map();
  for (const s of matching) {
    const key = bucketKey(s.ts, bucket);
    const v = Number(s.metrics[opts.metric]);
    const entry = buckets.get(key);
    if (entry) {
      entry.sum += v;
      entry.count += 1;
    } else {
      buckets.set(key, { sum: v, count: 1 });
    }
  }
  return [...buckets.entries()]
    .map(([ts, { sum, count }]) => ({ ts, value: sum / count, count }))
    .sort((a, b) => a.ts - b.ts);
}

/**
 * Wipe a workspace's history.
 * @param {string} workspace
 */
export async function clearHistory(workspace) {
  const path = storePath(workspace);
  await withPathLock(path, async () => {
    await writeJsonPath(path, emptyBlob());
  });
}

/**
 * Return the most recent sample matching kind (+ optional suite).
 *
 * @param {string} workspace
 * @param {{kind: string, suite?: string}} opts
 * @returns {Promise<EvalSample | null>}
 */
export async function latest(workspace, opts) {
  if (!opts || typeof opts.kind !== "string" || !opts.kind) {
    throw new Error("latest: kind required");
  }
  const blob = await loadBlob(workspace);
  let best = null;
  for (const s of blob.samples) {
    if (s.kind !== opts.kind) continue;
    if (opts.suite && s.suite !== opts.suite) continue;
    if (!best || s.ts > best.ts) best = s;
  }
  return best;
}
