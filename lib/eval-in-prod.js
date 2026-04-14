/**
 * Phase 75.1: Eval-in-prod (shadow traffic).
 *
 * Records prod requests plus both the prod and a candidate model's responses
 * and stores a simple diff. Samples are never surfaced to end users — they
 * feed offline evaluation pipelines so we can safely qualify new models on
 * live-shaped traffic.
 *
 * Storage layout:
 *   data/eval-in-prod/{workspaceId}.json   — samples + config per workspace
 *   data/eval-in-prod/_index.json          — known workspaces
 */
import { randomUUID } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const DEFAULT_MAX_SAMPLES = 10_000;

function sanitizeId(val, fallback = "default") {
  if (typeof val !== "string" || !val.trim()) return fallback;
  return val.trim().replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || fallback;
}

function storePath(workspaceId) {
  return join(getDataDir(), "eval-in-prod", `${sanitizeId(workspaceId)}.json`);
}

function indexPath() {
  return join(getDataDir(), "eval-in-prod", "_index.json");
}

async function touchIndex(workspaceId) {
  const ws = sanitizeId(workspaceId);
  await withPathLock(indexPath(), async () => {
    const idx = await readJsonPath(indexPath(), { workspaces: [] });
    const list = Array.isArray(idx.workspaces) ? idx.workspaces : [];
    if (!list.includes(ws)) {
      list.push(ws);
      await writeJsonPath(indexPath(), { workspaces: list });
    }
  });
}

function tokenize(val) {
  if (val == null) return [];
  const s = typeof val === "string" ? val : JSON.stringify(val);
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Very cheap diff over string/JSON-serialized responses.
 * - tokensProd / tokensCandidate — token counts
 * - sharedTokens / uniqueProd / uniqueCandidate — set-based counts
 * - lengthDelta — candidate - prod length in chars
 * - jaccard — approximate Jaccard similarity
 */
export function computeDiff(prodResponse, candidateResponse) {
  const prodStr = prodResponse == null ? "" : (typeof prodResponse === "string" ? prodResponse : JSON.stringify(prodResponse));
  const candStr = candidateResponse == null ? "" : (typeof candidateResponse === "string" ? candidateResponse : JSON.stringify(candidateResponse));
  const prodToks = tokenize(prodStr);
  const candToks = tokenize(candStr);
  const prodSet = new Set(prodToks);
  const candSet = new Set(candToks);
  let shared = 0;
  for (const t of prodSet) if (candSet.has(t)) shared += 1;
  const uniqueProd = prodSet.size - shared;
  const uniqueCandidate = candSet.size - shared;
  const union = prodSet.size + candSet.size - shared;
  const jaccard = union === 0 ? 1 : shared / union;
  return {
    tokensProd: prodToks.length,
    tokensCandidate: candToks.length,
    uniqueTokensProd: prodSet.size,
    uniqueTokensCandidate: candSet.size,
    sharedTokens: shared,
    uniqueProd,
    uniqueCandidate,
    lengthDelta: candStr.length - prodStr.length,
    jaccard: Number(jaccard.toFixed(4)),
    identical: prodStr === candStr,
  };
}

async function loadStore(workspaceId) {
  return readJsonPath(storePath(workspaceId), {
    samples: [],
    config: { enabled: false, candidateModel: null, sampleRate: 0 },
  });
}

/**
 * Record a single shadow sample.
 */
export async function recordShadowSample({
  workspaceId,
  request,
  prodResponse,
  candidateResponse,
  candidateModel,
  prodModel,
  metadata,
} = {}) {
  const ws = sanitizeId(workspaceId);
  const diff = computeDiff(prodResponse, candidateResponse);
  const sample = {
    sampleId: randomUUID(),
    workspaceId: ws,
    prodModel: prodModel ? String(prodModel) : null,
    candidateModel: candidateModel ? String(candidateModel) : null,
    request: request == null ? null : request,
    prodResponse: prodResponse == null ? null : prodResponse,
    candidateResponse: candidateResponse == null ? null : candidateResponse,
    diff,
    metadata: metadata && typeof metadata === "object" ? metadata : {},
    timestamp: Date.now(),
  };
  const file = storePath(ws);
  await withPathLock(file, async () => {
    const store = await loadStore(ws);
    const samples = Array.isArray(store.samples) ? store.samples : [];
    samples.push(sample);
    const max = Number(process.env.EVAL_IN_PROD_MAX_SAMPLES) || DEFAULT_MAX_SAMPLES;
    const trimmed = samples.length > max ? samples.slice(-max) : samples;
    await writeJsonPath(file, { ...store, samples: trimmed });
  });
  await touchIndex(ws);
  return sample;
}

/**
 * Query shadow samples for a workspace. Supports candidateModel filter and
 * pagination.
 */
export async function querySamples({ workspaceId, candidateModel, limit, offset } = {}) {
  const ws = sanitizeId(workspaceId);
  const store = await loadStore(ws);
  const samples = Array.isArray(store.samples) ? store.samples.slice() : [];
  const filtered = candidateModel
    ? samples.filter((s) => s.candidateModel === String(candidateModel))
    : samples;
  filtered.sort((a, b) => b.timestamp - a.timestamp);
  const off = Math.max(0, Number(offset) || 0);
  const lim = Math.max(1, Math.min(10000, Number(limit) || 100));
  return {
    total: filtered.length,
    offset: off,
    limit: lim,
    samples: filtered.slice(off, off + lim),
  };
}

/**
 * Aggregate stats over shadow samples.
 */
export async function getShadowStats({ workspaceId, candidateModel } = {}) {
  const ws = sanitizeId(workspaceId);
  const store = await loadStore(ws);
  const samples = Array.isArray(store.samples) ? store.samples : [];
  const filtered = candidateModel
    ? samples.filter((s) => s.candidateModel === String(candidateModel))
    : samples;
  if (filtered.length === 0) {
    return {
      total: 0,
      identical: 0,
      identicalRatio: 0,
      avgJaccard: 0,
      avgLengthDelta: 0,
      minJaccard: 0,
      maxJaccard: 0,
      byCandidateModel: {},
    };
  }
  let identical = 0;
  let jaccardSum = 0;
  let lengthDeltaSum = 0;
  let minJ = Infinity;
  let maxJ = -Infinity;
  const byModel = {};
  for (const s of filtered) {
    const d = s.diff || {};
    if (d.identical) identical += 1;
    const j = typeof d.jaccard === "number" ? d.jaccard : 0;
    jaccardSum += j;
    lengthDeltaSum += typeof d.lengthDelta === "number" ? d.lengthDelta : 0;
    if (j < minJ) minJ = j;
    if (j > maxJ) maxJ = j;
    const key = s.candidateModel || "unknown";
    byModel[key] = (byModel[key] || 0) + 1;
  }
  return {
    total: filtered.length,
    identical,
    identicalRatio: Number((identical / filtered.length).toFixed(4)),
    avgJaccard: Number((jaccardSum / filtered.length).toFixed(4)),
    avgLengthDelta: Number((lengthDeltaSum / filtered.length).toFixed(2)),
    minJaccard: Number(minJ.toFixed(4)),
    maxJaccard: Number(maxJ.toFixed(4)),
    byCandidateModel: byModel,
  };
}

/**
 * Update shadow-traffic config for a workspace.
 */
export async function setShadowConfig({ workspaceId, enabled, candidateModel, sampleRate } = {}) {
  const ws = sanitizeId(workspaceId);
  const file = storePath(ws);
  let updated;
  await withPathLock(file, async () => {
    const store = await loadStore(ws);
    const current = store.config || {};
    const next = {
      enabled: typeof enabled === "boolean" ? enabled : !!current.enabled,
      candidateModel:
        candidateModel === undefined
          ? current.candidateModel || null
          : candidateModel
          ? String(candidateModel)
          : null,
      sampleRate:
        sampleRate === undefined
          ? typeof current.sampleRate === "number"
            ? current.sampleRate
            : 0
          : Math.max(0, Math.min(1, Number(sampleRate) || 0)),
      updatedAt: Date.now(),
    };
    updated = next;
    await writeJsonPath(file, { ...store, config: next });
  });
  await touchIndex(ws);
  return updated;
}

export async function getShadowConfig(workspaceId) {
  const ws = sanitizeId(workspaceId);
  const store = await loadStore(ws);
  const cfg = store.config || {};
  return {
    enabled: !!cfg.enabled,
    candidateModel: cfg.candidateModel || null,
    sampleRate: typeof cfg.sampleRate === "number" ? cfg.sampleRate : 0,
    updatedAt: cfg.updatedAt || null,
  };
}

export async function _reset(workspaceId) {
  if (workspaceId) {
    await writeJsonPath(storePath(workspaceId), {
      samples: [],
      config: { enabled: false, candidateModel: null, sampleRate: 0 },
    });
    return;
  }
  const idx = await readJsonPath(indexPath(), { workspaces: [] });
  const list = Array.isArray(idx.workspaces) ? idx.workspaces : [];
  for (const ws of list) {
    await writeJsonPath(storePath(ws), {
      samples: [],
      config: { enabled: false, candidateModel: null, sampleRate: 0 },
    });
  }
  await writeJsonPath(indexPath(), { workspaces: [] });
}

export const _internals = { sanitizeId, storePath, indexPath, tokenize };
