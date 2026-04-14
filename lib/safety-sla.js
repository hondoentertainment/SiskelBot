/**
 * Phase 72.5: Safety SLA dashboard.
 *
 * Tracks binary classifier outcomes over time so operators can watch
 * precision/recall vs declared SLA targets and detect regressions.
 *
 * Storage layout:
 *   data/safety-sla/classifiers.json   — { [classifierId]: { target, records: [] } }
 */
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_RECORDS = 10_000;

function sanitizeId(val, fallback = "default") {
  if (typeof val !== "string" || !val.trim()) return fallback;
  return val.trim().replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || fallback;
}

function storePath() {
  return join(getDataDir(), "safety-sla", "classifiers.json");
}

async function loadAll() {
  return readJsonPath(storePath(), { classifiers: {} });
}

function ensureClassifier(data, id) {
  data.classifiers = data.classifiers && typeof data.classifiers === "object" ? data.classifiers : {};
  if (!data.classifiers[id]) {
    data.classifiers[id] = {
      classifierId: id,
      target: { precisionTarget: null, recallTarget: null },
      records: [],
    };
  }
  return data.classifiers[id];
}

export async function recordClassification({ classifierId, prediction, actual, timestamp } = {}) {
  if (!classifierId) throw new Error("classifierId is required");
  if (prediction !== true && prediction !== false && prediction !== 0 && prediction !== 1) {
    throw new Error("prediction must be boolean");
  }
  if (actual !== true && actual !== false && actual !== 0 && actual !== 1) {
    throw new Error("actual must be boolean");
  }
  const id = sanitizeId(classifierId);
  const pred = Boolean(prediction);
  const act = Boolean(actual);
  const ts = typeof timestamp === "number" ? timestamp : Date.now();
  const file = storePath();
  let saved;
  await withPathLock(file, async () => {
    const data = await loadAll();
    const cls = ensureClassifier(data, id);
    cls.records = Array.isArray(cls.records) ? cls.records : [];
    cls.records.push({ prediction: pred, actual: act, timestamp: ts });
    const max = Number(process.env.SAFETY_SLA_MAX_RECORDS) || DEFAULT_MAX_RECORDS;
    if (cls.records.length > max) cls.records = cls.records.slice(-max);
    await writeJsonPath(file, data);
    saved = { classifierId: id, prediction: pred, actual: act, timestamp: ts };
  });
  return saved;
}

export async function setSlaTarget({ classifierId, precisionTarget, recallTarget } = {}) {
  if (!classifierId) throw new Error("classifierId is required");
  const id = sanitizeId(classifierId);
  const pt = precisionTarget == null ? null : Math.max(0, Math.min(1, Number(precisionTarget)));
  const rt = recallTarget == null ? null : Math.max(0, Math.min(1, Number(recallTarget)));
  const file = storePath();
  let saved;
  await withPathLock(file, async () => {
    const data = await loadAll();
    const cls = ensureClassifier(data, id);
    cls.target = { precisionTarget: pt, recallTarget: rt };
    await writeJsonPath(file, data);
    saved = { classifierId: id, precisionTarget: pt, recallTarget: rt };
  });
  return saved;
}

export async function getSlaTarget(classifierId) {
  const id = sanitizeId(classifierId || "");
  const data = await loadAll();
  const cls = data.classifiers?.[id];
  if (!cls) return null;
  return {
    classifierId: id,
    precisionTarget: cls.target?.precisionTarget ?? null,
    recallTarget: cls.target?.recallTarget ?? null,
  };
}

function binaryMetrics(records) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const r of records) {
    if (r.prediction && r.actual) tp += 1;
    else if (r.prediction && !r.actual) fp += 1;
    else if (!r.prediction && r.actual) fn += 1;
    else tn += 1;
  }
  const precision = tp + fp === 0 ? null : tp / (tp + fp);
  const recall = tp + fn === 0 ? null : tp / (tp + fn);
  const f1 = precision == null || recall == null || precision + recall === 0
    ? null
    : (2 * precision * recall) / (precision + recall);
  return { tp, fp, fn, tn, precision, recall, f1, total: records.length };
}

function dayBucket(ts) {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export async function computeMetrics({ classifierId, since, until } = {}) {
  if (!classifierId) throw new Error("classifierId is required");
  const id = sanitizeId(classifierId);
  const data = await loadAll();
  const cls = data.classifiers?.[id];
  if (!cls) return null;
  const records = Array.isArray(cls.records) ? cls.records : [];
  const sinceMs = typeof since === "number" ? since : 0;
  const untilMs = typeof until === "number" ? until : Date.now();
  const window = records.filter((r) => r.timestamp >= sinceMs && r.timestamp <= untilMs);
  const metrics = binaryMetrics(window);
  // Daily buckets
  const buckets = new Map();
  for (const r of window) {
    const day = dayBucket(r.timestamp);
    if (!buckets.has(day)) buckets.set(day, []);
    buckets.get(day).push(r);
  }
  const timeSeries = Array.from(buckets.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([day, list]) => ({ day, ...binaryMetrics(list) }));
  return {
    classifierId: id,
    since: sinceMs,
    until: untilMs,
    ...metrics,
    timeSeries,
  };
}

export async function getSlaStatus(classifierId) {
  if (!classifierId) throw new Error("classifierId is required");
  const id = sanitizeId(classifierId);
  const data = await loadAll();
  const cls = data.classifiers?.[id];
  if (!cls) return null;
  const now = Date.now();
  const since = now - 7 * DAY_MS;
  const metrics = await computeMetrics({ classifierId: id, since, until: now });
  const target = cls.target || {};
  const precisionTarget = target.precisionTarget ?? null;
  const recallTarget = target.recallTarget ?? null;
  const precisionMet = precisionTarget == null || (metrics.precision != null && metrics.precision >= precisionTarget);
  const recallMet = recallTarget == null || (metrics.recall != null && metrics.recall >= recallTarget);
  return {
    classifierId: id,
    meeting: precisionMet && recallMet,
    precision: metrics.precision,
    recall: metrics.recall,
    f1: metrics.f1,
    target: { precisionTarget, recallTarget },
    windowStart: since,
    windowEnd: now,
    sampleSize: metrics.total,
  };
}

export async function listClassifiers() {
  const data = await loadAll();
  return Object.values(data.classifiers || {}).map((cls) => ({
    classifierId: cls.classifierId,
    target: cls.target || { precisionTarget: null, recallTarget: null },
    recordCount: Array.isArray(cls.records) ? cls.records.length : 0,
  }));
}

export async function _reset() {
  await writeJsonPath(storePath(), { classifiers: {} });
}

export const _internals = { sanitizeId, storePath, binaryMetrics, dayBucket, DAY_MS };
