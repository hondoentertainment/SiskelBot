/**
 * Phase 71.1: Usage-based pricing engine.
 *
 * Supports per-token, per-call, per-outcome, per-minute, and flat pricing
 * rules. Rates are stored as integer cents internally (to avoid floating-point
 * drift) and formatted as decimal USD on output.
 *
 * Storage layout:
 *   data/pricing-engine/{workspaceId}.json — rules per workspace
 *   data/pricing-engine/_index.json        — known workspaces
 *   data/pricing-engine/_rule-index.json   — rule id -> workspace map
 */
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";
import { join } from "path";
import { randomUUID } from "crypto";

export const PRICING_UNITS = Object.freeze([
  "input_token",
  "output_token",
  "call",
  "outcome",
  "minute",
  "flat",
]);

function sanitizeId(val, fallback = "default") {
  if (typeof val !== "string" || !val.trim()) return fallback;
  return val.trim().replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || fallback;
}

function workspacePath(workspaceId) {
  return join(getDataDir(), "pricing-engine", `${sanitizeId(workspaceId, "default")}.json`);
}

function indexPath() {
  return join(getDataDir(), "pricing-engine", "_index.json");
}

function ruleIndexPath() {
  return join(getDataDir(), "pricing-engine", "_rule-index.json");
}

async function touchIndex(workspaceId) {
  const ws = sanitizeId(workspaceId, "default");
  return withPathLock(indexPath(), async () => {
    const idx = await readJsonPath(indexPath(), { workspaces: [] });
    const list = Array.isArray(idx.workspaces) ? idx.workspaces : [];
    if (!list.includes(ws)) {
      list.push(ws);
      await writeJsonPath(indexPath(), { workspaces: list });
    }
  });
}

async function updateRuleIndex(ruleId, workspaceId) {
  return withPathLock(ruleIndexPath(), async () => {
    const idx = await readJsonPath(ruleIndexPath(), { rules: {} });
    const map = idx.rules && typeof idx.rules === "object" ? idx.rules : {};
    if (workspaceId == null) {
      delete map[ruleId];
    } else {
      map[ruleId] = sanitizeId(workspaceId, "default");
    }
    await writeJsonPath(ruleIndexPath(), { rules: map });
  });
}

async function workspaceOfRule(ruleId) {
  const idx = await readJsonPath(ruleIndexPath(), { rules: {} });
  const map = idx.rules && typeof idx.rules === "object" ? idx.rules : {};
  return map[ruleId] || null;
}

/**
 * Coerce a rate expressed in USD (decimal) to integer millicents. We use
 * millicents (= 1/1000 of a cent) so token-level pricing (which is commonly
 * sub-cent per token) can be represented without rounding.
 */
function rateToMillicents(rate) {
  const num = Number(rate);
  if (!Number.isFinite(num) || num < 0) {
    throw new Error("rate must be a non-negative number (USD)");
  }
  return Math.round(num * 100_000);
}

function millicentsToUsd(mc) {
  return Math.round(mc) / 100_000;
}

function quantityForUnit(unit, usage) {
  const u = usage || {};
  switch (unit) {
    case "input_token": return Number(u.inputTokens) || 0;
    case "output_token": return Number(u.outputTokens) || 0;
    case "call": return Number(u.calls) || 0;
    case "outcome": return Number(u.outcomes) || 0;
    case "minute": return Number(u.minutes) || 0;
    case "flat": return 1;
    default: return 0;
  }
}

/**
 * Create a pricing rule.
 *
 * @param {{
 *   workspaceId?: string,
 *   ruleId?: string,
 *   unit: string,
 *   rate: number,           // USD per unit
 *   modelId?: string|null,  // null/undefined = applies to all models
 *   tier?: string|null,
 *   description?: string,
 * }} input
 */
export async function createPricingRule(input = {}) {
  if (!input || typeof input !== "object") {
    throw new Error("input is required");
  }
  if (!PRICING_UNITS.includes(input.unit)) {
    throw new Error(`unit must be one of ${PRICING_UNITS.join(", ")}`);
  }
  const workspaceId = sanitizeId(input.workspaceId, "default");
  const ruleId = input.ruleId ? sanitizeId(input.ruleId) : randomUUID();
  const rule = {
    ruleId,
    workspaceId,
    unit: input.unit,
    rate: Number(input.rate) || 0,
    rateMillicents: rateToMillicents(input.rate),
    modelId: input.modelId ? String(input.modelId) : null,
    tier: input.tier ? String(input.tier) : null,
    description: input.description ? String(input.description).slice(0, 500) : null,
    currency: "USD",
    createdAt: Date.now(),
  };
  const file = workspacePath(workspaceId);
  await withPathLock(file, async () => {
    const store = await readJsonPath(file, { rules: [] });
    const rules = Array.isArray(store.rules) ? store.rules : [];
    const existingIdx = rules.findIndex((r) => r.ruleId === ruleId);
    if (existingIdx >= 0) {
      rules[existingIdx] = rule;
    } else {
      rules.push(rule);
    }
    await writeJsonPath(file, { rules });
  });
  await touchIndex(workspaceId);
  await updateRuleIndex(ruleId, workspaceId);
  return rule;
}

export async function listPricingRules(workspaceId) {
  const ws = sanitizeId(workspaceId, "default");
  const store = await readJsonPath(workspacePath(ws), { rules: [] });
  return Array.isArray(store.rules) ? store.rules : [];
}

export async function getPricingRule(ruleId) {
  if (!ruleId) return null;
  const rid = sanitizeId(ruleId);
  const ws = await workspaceOfRule(rid);
  if (!ws) return null;
  const store = await readJsonPath(workspacePath(ws), { rules: [] });
  const rules = Array.isArray(store.rules) ? store.rules : [];
  return rules.find((r) => r.ruleId === rid) || null;
}

export async function deletePricingRule(ruleId) {
  if (!ruleId) return false;
  const rid = sanitizeId(ruleId);
  const ws = await workspaceOfRule(rid);
  if (!ws) return false;
  let removed = false;
  await withPathLock(workspacePath(ws), async () => {
    const store = await readJsonPath(workspacePath(ws), { rules: [] });
    const rules = Array.isArray(store.rules) ? store.rules : [];
    const next = rules.filter((r) => r.ruleId !== rid);
    removed = next.length !== rules.length;
    await writeJsonPath(workspacePath(ws), { rules: next });
  });
  if (removed) await updateRuleIndex(rid, null);
  return removed;
}

/**
 * Compute cost for a usage record against the workspace's pricing rules.
 * A rule matches when `rule.modelId == null || rule.modelId === usage.modelId`.
 */
export async function computeCost(input = {}) {
  const workspaceId = sanitizeId(input.workspaceId, "default");
  const usage = input.usage || {};
  const rules = await listPricingRules(workspaceId);
  const matching = rules.filter((r) => r.modelId == null || r.modelId === (usage.modelId || null));
  const breakdown = [];
  let totalMc = 0;
  for (const rule of matching) {
    const quantity = quantityForUnit(rule.unit, usage);
    if (quantity <= 0 && rule.unit !== "flat") continue;
    const amountMc = Math.round(rule.rateMillicents * quantity);
    totalMc += amountMc;
    breakdown.push({
      ruleId: rule.ruleId,
      unit: rule.unit,
      quantity,
      rate: rule.rate,
      amount: millicentsToUsd(amountMc),
    });
  }
  return {
    total: millicentsToUsd(totalMc),
    breakdown,
    currency: "USD",
  };
}

export async function _reset() {
  const idx = await readJsonPath(indexPath(), { workspaces: [] });
  const list = Array.isArray(idx.workspaces) ? idx.workspaces : [];
  for (const ws of list) {
    await writeJsonPath(workspacePath(ws), { rules: [] });
  }
  await writeJsonPath(indexPath(), { workspaces: [] });
  await writeJsonPath(ruleIndexPath(), { rules: {} });
}

export const _internals = { sanitizeId, workspacePath, indexPath, ruleIndexPath, rateToMillicents, millicentsToUsd };
