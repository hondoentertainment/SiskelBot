// @ts-check
/**
 * Phase 58.1: Cost-aware router.
 *
 * Routes requests to the cheapest model that meets a quality floor.
 * Maintains a persisted catalog of models with per-token prices
 * (input/output) and per-model quality scores. Given a request
 * (prompt length, expected output length, optional quality floor),
 * `routeByCost` returns the model with the lowest estimated cost
 * whose quality score is >= the floor.
 *
 * Also tracks cumulative spend per model so operators can attribute
 * cost to workloads.
 *
 * The module exposes:
 *   - `registerModelPrice(id, prices)`  — persist a model price entry
 *   - `routeByCost(request, opts)`      — pick the cheapest viable model
 *   - `estimateRequestCost(model, req)` — compute USD cost of a request
 *   - `listPrices()`                    — list all persisted prices
 *   - `recordSpend(model, amount)`      — accumulate spend per model
 *
 * Storage is JSON-backed via `json-path-store.js`.
 *
 * @module cost-router
 */
import { join } from "path";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;

function pricesPath() {
  return join(getDataDir(), "cost-router-prices.json");
}

function spendPath() {
  return join(getDataDir(), "cost-router-spend.json");
}

/* -------------------------------------------------------------------------- */
/* Persistence                                                                */
/* -------------------------------------------------------------------------- */

async function loadPrices() {
  const data = await readJsonPath(pricesPath(), {
    version: STORE_VERSION,
    models: {},
  });
  if (!data.models || typeof data.models !== "object") data.models = {};
  return data;
}

async function savePrices(data) {
  await writeJsonPath(pricesPath(), {
    version: STORE_VERSION,
    models: data.models || {},
    updatedAt: new Date().toISOString(),
  });
}

async function loadSpend() {
  const data = await readJsonPath(spendPath(), {
    version: STORE_VERSION,
    spend: {},
  });
  if (!data.spend || typeof data.spend !== "object") data.spend = {};
  return data;
}

async function saveSpend(data) {
  await writeJsonPath(spendPath(), {
    version: STORE_VERSION,
    spend: data.spend || {},
    updatedAt: new Date().toISOString(),
  });
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} ModelPrice
 * @property {string} id
 * @property {number} inputPer1k   USD per 1k input tokens
 * @property {number} outputPer1k  USD per 1k output tokens
 * @property {number} [quality]    Quality score in [0,1]. Defaults to 0.5.
 * @property {string} [provider]   Provider name (openai, ollama, vllm, ...)
 * @property {string} [region]     Region label
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * Persist a model price entry. Idempotent: subsequent calls merge over
 * the previous record.
 *
 * @param {string} id
 * @param {{inputPer1k: number, outputPer1k: number, quality?: number, provider?: string, region?: string}} prices
 * @returns {Promise<ModelPrice>}
 */
export async function registerModelPrice(id, prices) {
  if (!id || typeof id !== "string") {
    throw new Error("model id is required");
  }
  if (!prices || typeof prices !== "object") {
    throw new Error("prices are required");
  }
  if (!Number.isFinite(prices.inputPer1k) || prices.inputPer1k < 0) {
    throw new Error("inputPer1k must be a non-negative number");
  }
  if (!Number.isFinite(prices.outputPer1k) || prices.outputPer1k < 0) {
    throw new Error("outputPer1k must be a non-negative number");
  }
  const path = pricesPath();
  return withPathLock(path, async () => {
    const data = await loadPrices();
    const now = new Date().toISOString();
    const existing = data.models[id] || { createdAt: now };
    const rec = {
      ...existing,
      id,
      inputPer1k: Number(prices.inputPer1k),
      outputPer1k: Number(prices.outputPer1k),
      quality: Number.isFinite(prices.quality)
        ? Math.max(0, Math.min(1, Number(prices.quality)))
        : (existing.quality ?? 0.5),
      provider: prices.provider ?? existing.provider ?? null,
      region: prices.region ?? existing.region ?? null,
      updatedAt: now,
    };
    data.models[id] = rec;
    await savePrices(data);
    return rec;
  });
}

/**
 * Compute the estimated USD cost of a request against a specific model.
 *
 * @param {ModelPrice | string} modelOrId
 * @param {{ inputTokens?: number, outputTokens?: number }} request
 * @returns {Promise<number> | number}
 */
export function estimateRequestCost(modelOrId, request) {
  const inputTokens = Number(request?.inputTokens) || 0;
  const outputTokens = Number(request?.outputTokens) || 0;
  if (typeof modelOrId === "string") {
    return (async () => {
      const data = await loadPrices();
      const m = data.models[modelOrId];
      if (!m) throw new Error(`unknown model: ${modelOrId}`);
      return computeCost(m, inputTokens, outputTokens);
    })();
  }
  if (!modelOrId || typeof modelOrId !== "object") {
    throw new Error("model is required");
  }
  return computeCost(modelOrId, inputTokens, outputTokens);
}

function computeCost(model, inputTokens, outputTokens) {
  const inCost = (inputTokens / 1000) * Number(model.inputPer1k || 0);
  const outCost = (outputTokens / 1000) * Number(model.outputPer1k || 0);
  return Math.round((inCost + outCost) * 1_000_000) / 1_000_000;
}

/**
 * @typedef {Object} RouteOptions
 * @property {number} [qualityFloor]      Minimum quality score (0..1). Default 0.
 * @property {string[]} [candidates]      Restrict routing to these model ids.
 * @property {string} [provider]          Only consider this provider.
 * @property {string} [region]            Only consider this region.
 * @property {ModelPrice[]} [modelsOverride] Use this list instead of the catalog.
 */

/**
 * Choose the cheapest model that meets the quality floor.
 *
 * @param {{ inputTokens?: number, outputTokens?: number }} request
 * @param {RouteOptions} [options]
 * @returns {Promise<{ model: string, cost: number, quality: number, provider: string|null, region: string|null } | null>}
 */
export async function routeByCost(request, options = {}) {
  const qualityFloor = Number.isFinite(options.qualityFloor)
    ? Number(options.qualityFloor)
    : 0;

  /** @type {ModelPrice[]} */
  let models;
  if (Array.isArray(options.modelsOverride)) {
    models = options.modelsOverride;
  } else {
    const data = await loadPrices();
    models = Object.values(data.models || {});
  }

  if (Array.isArray(options.candidates) && options.candidates.length > 0) {
    const allow = new Set(options.candidates.map(String));
    models = models.filter((m) => allow.has(m.id));
  }
  if (options.provider) {
    models = models.filter((m) => m.provider === options.provider);
  }
  if (options.region) {
    models = models.filter((m) => m.region === options.region);
  }
  models = models.filter((m) => (Number(m.quality) || 0) >= qualityFloor);

  if (models.length === 0) return null;

  const inputTokens = Number(request?.inputTokens) || 0;
  const outputTokens = Number(request?.outputTokens) || 0;

  let best = null;
  let bestCost = Infinity;
  for (const m of models) {
    const cost = computeCost(m, inputTokens, outputTokens);
    if (cost < bestCost) {
      bestCost = cost;
      best = m;
    }
  }
  if (!best) return null;
  return {
    model: best.id,
    cost: bestCost,
    quality: Number(best.quality) || 0,
    provider: best.provider || null,
    region: best.region || null,
  };
}

/**
 * List all registered model prices.
 * @returns {Promise<ModelPrice[]>}
 */
export async function listPrices() {
  const data = await loadPrices();
  return Object.values(data.models || {});
}

/**
 * Accumulate spend against a model. `amount` is USD dollars.
 * Returns the new cumulative total for the model.
 *
 * @param {string} model
 * @param {number} amount
 * @returns {Promise<{ model: string, total: number, uses: number, updatedAt: string }>}
 */
export async function recordSpend(model, amount) {
  if (!model || typeof model !== "string") {
    throw new Error("model is required");
  }
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt < 0) {
    throw new Error("amount must be a non-negative number");
  }
  const path = spendPath();
  return withPathLock(path, async () => {
    const data = await loadSpend();
    const cur = data.spend[model] || { model, total: 0, uses: 0 };
    cur.total = Math.round((Number(cur.total || 0) + amt) * 1_000_000) / 1_000_000;
    cur.uses = Number(cur.uses || 0) + 1;
    cur.updatedAt = new Date().toISOString();
    data.spend[model] = cur;
    await saveSpend(data);
    return cur;
  });
}

/**
 * Convenience: get all spend entries.
 */
export async function listSpend() {
  const data = await loadSpend();
  return Object.values(data.spend || {});
}
