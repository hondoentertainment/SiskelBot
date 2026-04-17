/**
 * Phase 75.2: Judge calibration.
 *
 * Tracks LLM-as-judge predictions against human-labeled goldens to compute
 * precision, recall, F1, and a confusion matrix so we can spot drift in a
 * model's reliability as a judge.
 *
 * Storage layout:
 *   data/judge-calibration/_index.json        — list of known judgeIds
 *   data/judge-calibration/{judgeId}.json     — judgements per judge
 */
import { randomUUID } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const DEFAULT_MAX_JUDGEMENTS = 50_000;

function sanitizeId(val, fallback = "default") {
  if (typeof val !== "string" || !val.trim()) return fallback;
  return val.trim().replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || fallback;
}

function storePath(judgeId) {
  return join(getDataDir(), "judge-calibration", `${sanitizeId(judgeId)}.json`);
}

function indexPath() {
  return join(getDataDir(), "judge-calibration", "_index.json");
}

async function touchIndex(judgeId) {
  const jid = sanitizeId(judgeId);
  await withPathLock(indexPath(), async () => {
    const idx = await readJsonPath(indexPath(), { judges: [] });
    const list = Array.isArray(idx.judges) ? idx.judges : [];
    if (!list.includes(jid)) {
      list.push(jid);
      await writeJsonPath(indexPath(), { judges: list });
    }
  });
}

/**
 * Record a single judge prediction vs. ground-truth label.
 */
export async function recordJudgement({ judgeId, caseId, prediction, humanLabel, metadata } = {}) {
  if (!judgeId) throw new Error("judgeId is required");
  if (!caseId) throw new Error("caseId is required");
  if (!prediction) throw new Error("prediction is required");
  if (!humanLabel) throw new Error("humanLabel is required");
  const jid = sanitizeId(judgeId);
  const record = {
    judgementId: randomUUID(),
    judgeId: jid,
    caseId: String(caseId),
    prediction: String(prediction).toLowerCase(),
    humanLabel: String(humanLabel).toLowerCase(),
    metadata: metadata && typeof metadata === "object" ? metadata : {},
    timestamp: Date.now(),
  };
  const file = storePath(jid);
  await withPathLock(file, async () => {
    const store = await readJsonPath(file, { judgements: [] });
    const list = Array.isArray(store.judgements) ? store.judgements : [];
    list.push(record);
    const max = Number(process.env.JUDGE_CALIBRATION_MAX) || DEFAULT_MAX_JUDGEMENTS;
    const trimmed = list.length > max ? list.slice(-max) : list;
    await writeJsonPath(file, { judgements: trimmed });
  });
  await touchIndex(jid);
  return record;
}

/**
 * Compute precision/recall/F1/accuracy. For the binary "pass"/"fail" case,
 * treats "pass" as the positive class. For multi-class, returns per-label
 * stats plus macro-averages.
 */
export async function computeCalibration(judgeId) {
  const jid = sanitizeId(judgeId);
  const store = await readJsonPath(storePath(jid), { judgements: [] });
  const list = Array.isArray(store.judgements) ? store.judgements : [];
  const total = list.length;
  if (total === 0) {
    return {
      judgeId: jid,
      support: 0,
      accuracy: 0,
      precision: 0,
      recall: 0,
      f1: 0,
      perLabel: {},
    };
  }
  // Accuracy
  let correct = 0;
  const labels = new Set();
  for (const j of list) {
    labels.add(j.prediction);
    labels.add(j.humanLabel);
    if (j.prediction === j.humanLabel) correct += 1;
  }
  const accuracy = correct / total;

  // Per-label precision/recall/F1.
  const perLabel = {};
  for (const label of labels) {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    let support = 0;
    for (const j of list) {
      if (j.humanLabel === label) support += 1;
      if (j.prediction === label && j.humanLabel === label) tp += 1;
      else if (j.prediction === label && j.humanLabel !== label) fp += 1;
      else if (j.prediction !== label && j.humanLabel === label) fn += 1;
    }
    const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    perLabel[label] = {
      precision: Number(precision.toFixed(4)),
      recall: Number(recall.toFixed(4)),
      f1: Number(f1.toFixed(4)),
      support,
      tp,
      fp,
      fn,
    };
  }

  // Binary case: treat "pass" as positive if present.
  const isBinary = labels.size <= 2 && (labels.has("pass") || labels.has("true") || labels.has("yes"));
  let precision = 0;
  let recall = 0;
  let f1 = 0;
  if (isBinary) {
    const pos = labels.has("pass") ? "pass" : labels.has("true") ? "true" : "yes";
    const p = perLabel[pos] || { precision: 0, recall: 0, f1: 0 };
    precision = p.precision;
    recall = p.recall;
    f1 = p.f1;
  } else {
    // Macro-averaged across labels.
    const entries = Object.values(perLabel);
    if (entries.length) {
      precision = Number((entries.reduce((a, b) => a + b.precision, 0) / entries.length).toFixed(4));
      recall = Number((entries.reduce((a, b) => a + b.recall, 0) / entries.length).toFixed(4));
      f1 = Number((entries.reduce((a, b) => a + b.f1, 0) / entries.length).toFixed(4));
    }
  }

  return {
    judgeId: jid,
    support: total,
    accuracy: Number(accuracy.toFixed(4)),
    precision,
    recall,
    f1,
    perLabel,
  };
}

/**
 * Return a confusion matrix keyed as "predicted→actual".
 */
export async function getConfusionMatrix(judgeId) {
  const jid = sanitizeId(judgeId);
  const store = await readJsonPath(storePath(jid), { judgements: [] });
  const list = Array.isArray(store.judgements) ? store.judgements : [];
  const matrix = {};
  const labels = new Set();
  for (const j of list) {
    labels.add(j.prediction);
    labels.add(j.humanLabel);
    const key = `${j.prediction}→${j.humanLabel}`;
    matrix[key] = (matrix[key] || 0) + 1;
  }
  return {
    judgeId: jid,
    matrix,
    labels: Array.from(labels).sort(),
    total: list.length,
  };
}

/**
 * List known judge IDs.
 */
export async function listJudges() {
  const idx = await readJsonPath(indexPath(), { judges: [] });
  return Array.isArray(idx.judges) ? idx.judges.slice() : [];
}

/**
 * List judgements with pagination.
 */
export async function listJudgements({ judgeId, limit, offset } = {}) {
  if (!judgeId) throw new Error("judgeId is required");
  const jid = sanitizeId(judgeId);
  const store = await readJsonPath(storePath(jid), { judgements: [] });
  const list = Array.isArray(store.judgements) ? store.judgements.slice() : [];
  list.sort((a, b) => b.timestamp - a.timestamp);
  const off = Math.max(0, Number(offset) || 0);
  const lim = Math.max(1, Math.min(10000, Number(limit) || 100));
  return {
    total: list.length,
    offset: off,
    limit: lim,
    judgements: list.slice(off, off + lim),
  };
}

export async function _reset(judgeId) {
  if (judgeId) {
    await writeJsonPath(storePath(judgeId), { judgements: [] });
    return;
  }
  const idx = await readJsonPath(indexPath(), { judges: [] });
  const list = Array.isArray(idx.judges) ? idx.judges : [];
  for (const jid of list) {
    await writeJsonPath(storePath(jid), { judgements: [] });
  }
  await writeJsonPath(indexPath(), { judges: [] });
}

export const _internals = { sanitizeId, storePath, indexPath };
