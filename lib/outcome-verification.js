/**
 * Phase 71.2: Outcome verification.
 *
 * Defines testable outcomes (goals) for agent runs and verifies whether a
 * run's signals satisfy the criteria. Used to gate outcome-based pricing
 * rules (see `lib/pricing-engine.js` "outcome" unit) and for quality
 * reporting.
 *
 * Storage layout:
 *   data/outcome-verification/outcomes/{workspaceId}.json       — outcome defs
 *   data/outcome-verification/verifications/{workspaceId}.json  — verification records
 *   data/outcome-verification/_outcome-index.json               — outcomeId -> workspace
 *   data/outcome-verification/_workspace-index.json             — known workspaces
 */
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";
import { join } from "path";
import { randomUUID } from "crypto";

export const CRITERION_TYPES = Object.freeze([
  "contains",
  "not_contains",
  "equals",
  "regex",
  "numeric_gte",
  "numeric_lte",
]);

function sanitizeId(val, fallback = "default") {
  if (typeof val !== "string" || !val.trim()) return fallback;
  return val.trim().replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || fallback;
}

function outcomesPath(workspaceId) {
  return join(getDataDir(), "outcome-verification", "outcomes", `${sanitizeId(workspaceId)}.json`);
}

function verificationsPath(workspaceId) {
  return join(getDataDir(), "outcome-verification", "verifications", `${sanitizeId(workspaceId)}.json`);
}

function workspaceIndexPath() {
  return join(getDataDir(), "outcome-verification", "_workspace-index.json");
}

function outcomeIndexPath() {
  return join(getDataDir(), "outcome-verification", "_outcome-index.json");
}

async function touchWorkspaceIndex(workspaceId) {
  const ws = sanitizeId(workspaceId);
  await withPathLock(workspaceIndexPath(), async () => {
    const idx = await readJsonPath(workspaceIndexPath(), { workspaces: [] });
    const list = Array.isArray(idx.workspaces) ? idx.workspaces : [];
    if (!list.includes(ws)) {
      list.push(ws);
      await writeJsonPath(workspaceIndexPath(), { workspaces: list });
    }
  });
}

async function mapOutcome(outcomeId, workspaceId) {
  await withPathLock(outcomeIndexPath(), async () => {
    const idx = await readJsonPath(outcomeIndexPath(), { outcomes: {} });
    const map = idx.outcomes && typeof idx.outcomes === "object" ? idx.outcomes : {};
    if (workspaceId == null) delete map[outcomeId];
    else map[outcomeId] = sanitizeId(workspaceId);
    await writeJsonPath(outcomeIndexPath(), { outcomes: map });
  });
}

async function workspaceOfOutcome(outcomeId) {
  const idx = await readJsonPath(outcomeIndexPath(), { outcomes: {} });
  const map = idx.outcomes && typeof idx.outcomes === "object" ? idx.outcomes : {};
  return map[outcomeId] || null;
}

function normalizeCriterion(c, idx) {
  if (!c || typeof c !== "object") throw new Error(`criteria[${idx}] must be an object`);
  const type = c.type;
  if (!CRITERION_TYPES.includes(type)) {
    throw new Error(`criteria[${idx}].type must be one of ${CRITERION_TYPES.join(", ")}`);
  }
  const weight = Number(c.weight);
  return {
    id: c.id ? String(c.id) : `c${idx + 1}`,
    type,
    match: c.match !== undefined ? c.match : null,
    field: c.field ? String(c.field) : "output",
    weight: Number.isFinite(weight) && weight >= 0 ? weight : 1,
  };
}

/**
 * Define a new outcome (goal template).
 *
 * @param {{
 *   workspaceId?: string,
 *   outcomeId?: string,
 *   name: string,
 *   criteria: Array<{id?:string,type:string,match:any,weight?:number,field?:string}>,
 *   description?: string,
 * }} input
 */
export async function defineOutcome(input = {}) {
  if (!input || typeof input !== "object") throw new Error("input is required");
  if (!input.name || typeof input.name !== "string") throw new Error("name is required");
  if (!Array.isArray(input.criteria) || !input.criteria.length) {
    throw new Error("criteria must be a non-empty array");
  }
  const workspaceId = sanitizeId(input.workspaceId, "default");
  const outcomeId = input.outcomeId ? sanitizeId(input.outcomeId) : randomUUID();
  const criteria = input.criteria.map((c, i) => normalizeCriterion(c, i));
  const outcome = {
    outcomeId,
    workspaceId,
    name: String(input.name).slice(0, 200),
    description: input.description ? String(input.description).slice(0, 1000) : null,
    criteria,
    createdAt: Date.now(),
  };
  await withPathLock(outcomesPath(workspaceId), async () => {
    const store = await readJsonPath(outcomesPath(workspaceId), { outcomes: [] });
    const outcomes = Array.isArray(store.outcomes) ? store.outcomes : [];
    const existing = outcomes.findIndex((o) => o.outcomeId === outcomeId);
    if (existing >= 0) outcomes[existing] = outcome; else outcomes.push(outcome);
    await writeJsonPath(outcomesPath(workspaceId), { outcomes });
  });
  await touchWorkspaceIndex(workspaceId);
  await mapOutcome(outcomeId, workspaceId);
  return outcome;
}

export async function listOutcomes(workspaceId) {
  const ws = sanitizeId(workspaceId, "default");
  const store = await readJsonPath(outcomesPath(ws), { outcomes: [] });
  return Array.isArray(store.outcomes) ? store.outcomes : [];
}

export async function getOutcome(outcomeId) {
  if (!outcomeId) return null;
  const id = sanitizeId(outcomeId);
  const ws = await workspaceOfOutcome(id);
  if (!ws) return null;
  const store = await readJsonPath(outcomesPath(ws), { outcomes: [] });
  const list = Array.isArray(store.outcomes) ? store.outcomes : [];
  return list.find((o) => o.outcomeId === id) || null;
}

function signalValue(signals, field) {
  if (!signals || typeof signals !== "object") return undefined;
  const direct = signals[field];
  if (direct !== undefined) return direct;
  // Tolerate nested paths like "meta.count" in the future.
  return undefined;
}

function evaluateCriterion(criterion, signals) {
  const val = signalValue(signals, criterion.field);
  const match = criterion.match;
  switch (criterion.type) {
    case "contains":
      if (val == null) return false;
      return String(val).includes(String(match));
    case "not_contains":
      if (val == null) return true;
      return !String(val).includes(String(match));
    case "equals":
      return val === match || String(val) === String(match);
    case "regex": {
      if (val == null) return false;
      try {
        const re = match instanceof RegExp ? match : new RegExp(String(match));
        return re.test(String(val));
      } catch {
        return false;
      }
    }
    case "numeric_gte": {
      const n = Number(val);
      const t = Number(match);
      return Number.isFinite(n) && Number.isFinite(t) && n >= t;
    }
    case "numeric_lte": {
      const n = Number(val);
      const t = Number(match);
      return Number.isFinite(n) && Number.isFinite(t) && n <= t;
    }
    default:
      return false;
  }
}

/**
 * Verify an outcome against observed signals.
 *
 * @param {{ outcomeId: string, runId?: string, signals?: object }} input
 */
export async function verifyOutcome(input = {}) {
  const outcome = await getOutcome(input.outcomeId);
  if (!outcome) throw new Error("outcome not found");
  const signals = input.signals || {};
  const perCriterion = [];
  let matchedWeight = 0;
  let totalWeight = 0;
  for (const c of outcome.criteria) {
    const passed = evaluateCriterion(c, signals);
    perCriterion.push({ id: c.id, type: c.type, field: c.field, passed, weight: c.weight });
    totalWeight += c.weight;
    if (passed) matchedWeight += c.weight;
  }
  const score = totalWeight > 0 ? matchedWeight / totalWeight : 0;
  // Confidence is a function of total weight assigned and criterion count;
  // more criteria with larger weights = higher confidence. Normalised to [0,1].
  const confidence = outcome.criteria.length === 0
    ? 0
    : Math.min(1, (outcome.criteria.length / 10) + Math.min(totalWeight / 10, 0.5));
  const passed = score >= 1.0;
  const record = {
    verificationId: randomUUID(),
    outcomeId: outcome.outcomeId,
    workspaceId: outcome.workspaceId,
    runId: input.runId ? String(input.runId) : null,
    passed,
    score,
    confidence,
    perCriterion,
    signals,
    timestamp: Date.now(),
  };
  await withPathLock(verificationsPath(outcome.workspaceId), async () => {
    const store = await readJsonPath(verificationsPath(outcome.workspaceId), { verifications: [] });
    const list = Array.isArray(store.verifications) ? store.verifications : [];
    list.push(record);
    await writeJsonPath(verificationsPath(outcome.workspaceId), { verifications: list });
  });
  return record;
}

export async function getVerification(verificationId) {
  if (!verificationId) return null;
  const idx = await readJsonPath(workspaceIndexPath(), { workspaces: [] });
  const workspaces = Array.isArray(idx.workspaces) ? idx.workspaces : [];
  for (const ws of workspaces) {
    const store = await readJsonPath(verificationsPath(ws), { verifications: [] });
    const list = Array.isArray(store.verifications) ? store.verifications : [];
    const found = list.find((v) => v.verificationId === verificationId);
    if (found) return found;
  }
  return null;
}

export async function listVerifications(filter = {}) {
  const ws = filter.workspaceId ? sanitizeId(filter.workspaceId) : null;
  let workspaces;
  if (ws) workspaces = [ws];
  else {
    const idx = await readJsonPath(workspaceIndexPath(), { workspaces: [] });
    workspaces = Array.isArray(idx.workspaces) ? idx.workspaces.slice() : [];
  }
  const out = [];
  for (const w of workspaces) {
    const store = await readJsonPath(verificationsPath(w), { verifications: [] });
    const list = Array.isArray(store.verifications) ? store.verifications : [];
    for (const v of list) {
      if (filter.outcomeId && v.outcomeId !== filter.outcomeId) continue;
      out.push(v);
    }
  }
  out.sort((a, b) => b.timestamp - a.timestamp);
  return out;
}

export async function _reset() {
  const idx = await readJsonPath(workspaceIndexPath(), { workspaces: [] });
  const list = Array.isArray(idx.workspaces) ? idx.workspaces : [];
  for (const ws of list) {
    await writeJsonPath(outcomesPath(ws), { outcomes: [] });
    await writeJsonPath(verificationsPath(ws), { verifications: [] });
  }
  await writeJsonPath(workspaceIndexPath(), { workspaces: [] });
  await writeJsonPath(outcomeIndexPath(), { outcomes: {} });
}

export const _internals = { sanitizeId, outcomesPath, verificationsPath, evaluateCriterion };
