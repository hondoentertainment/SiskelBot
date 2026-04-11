// @ts-check
/**
 * Phase 65.3: Budget allocation & chargeback.
 *
 * Cost centers with allocated periodic budgets and recorded spend. The
 * module supports creating cost centers, allocating budget across a
 * time window, recording spend events, and computing utilization
 * (spend / allocated).
 *
 * Exports:
 *   - createCostCenter
 *   - allocateBudget
 *   - recordSpend
 *   - getUtilization
 *   - listCostCenters
 *   - getCostCenter
 *   - listAllocations
 *   - listSpend
 *
 * @module budget-allocation
 */
import { join } from "path";
import { randomBytes } from "crypto";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;

function storePath() {
  return join(getDataDir(), "budget-allocation.json");
}

function newId(prefix) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

function nowIso() {
  return new Date().toISOString();
}

async function loadStore() {
  const data = await readJsonPath(storePath(), {
    version: STORE_VERSION,
    costCenters: {},
    allocations: {},
    spend: [],
  });
  if (!data.costCenters || typeof data.costCenters !== "object") data.costCenters = {};
  if (!data.allocations || typeof data.allocations !== "object") data.allocations = {};
  if (!Array.isArray(data.spend)) data.spend = [];
  return data;
}

async function saveStore(data) {
  await writeJsonPath(storePath(), {
    version: STORE_VERSION,
    costCenters: data.costCenters || {},
    allocations: data.allocations || {},
    spend: data.spend || [],
  });
}

/**
 * @typedef {Object} CostCenter
 * @property {string} id
 * @property {string} code
 * @property {string} name
 * @property {string} [owner]
 * @property {string} [department]
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * @typedef {Object} Allocation
 * @property {string} id
 * @property {string} costCenterId
 * @property {number} amount
 * @property {string} currency
 * @property {string} periodStart
 * @property {string} periodEnd
 * @property {string} createdAt
 */

/**
 * @typedef {Object} SpendEvent
 * @property {string} id
 * @property {string} costCenterId
 * @property {number} amount
 * @property {string} currency
 * @property {string} at
 * @property {string} [description]
 * @property {object} [metadata]
 */

/**
 * Create a new cost center. `code` must be unique.
 *
 * @param {{code: string, name: string, owner?: string, department?: string}} payload
 * @returns {Promise<CostCenter>}
 */
export async function createCostCenter(payload) {
  if (!payload || typeof payload !== "object") throw new Error("payload required");
  if (!payload.code || typeof payload.code !== "string") throw new Error("code required");
  if (!payload.name || typeof payload.name !== "string") throw new Error("name required");
  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    const exists = Object.values(data.costCenters).find((c) => c.code === payload.code);
    if (exists) throw new Error(`cost center code ${payload.code} already exists`);
    const id = newId("cc");
    const ts = nowIso();
    const record = {
      id,
      code: String(payload.code),
      name: String(payload.name),
      owner: payload.owner ? String(payload.owner) : "",
      department: payload.department ? String(payload.department) : "",
      createdAt: ts,
      updatedAt: ts,
    };
    data.costCenters[id] = record;
    await saveStore(data);
    return record;
  });
}

/**
 * Allocate budget to a cost center for a period.
 *
 * @param {{costCenterId: string, amount: number, currency?: string, periodStart: string, periodEnd: string}} payload
 * @returns {Promise<Allocation>}
 */
export async function allocateBudget(payload) {
  if (!payload || typeof payload !== "object") throw new Error("payload required");
  if (!payload.costCenterId) throw new Error("costCenterId required");
  const amount = Number(payload.amount);
  if (!Number.isFinite(amount) || amount < 0) throw new Error("amount must be a non-negative number");
  if (!payload.periodStart || !payload.periodEnd) throw new Error("periodStart and periodEnd required");
  const start = Date.parse(payload.periodStart);
  const end = Date.parse(payload.periodEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error("invalid period dates");
  if (end <= start) throw new Error("periodEnd must be after periodStart");

  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    if (!data.costCenters[payload.costCenterId]) {
      throw new Error(`cost center ${payload.costCenterId} not found`);
    }
    const id = newId("alloc");
    const record = {
      id,
      costCenterId: String(payload.costCenterId),
      amount,
      currency: String(payload.currency || "USD"),
      periodStart: new Date(start).toISOString(),
      periodEnd: new Date(end).toISOString(),
      createdAt: nowIso(),
    };
    data.allocations[id] = record;
    await saveStore(data);
    return record;
  });
}

/**
 * Record a spend event against a cost center.
 *
 * @param {{costCenterId: string, amount: number, currency?: string, at?: string, description?: string, metadata?: object}} payload
 * @returns {Promise<SpendEvent>}
 */
export async function recordSpend(payload) {
  if (!payload || typeof payload !== "object") throw new Error("payload required");
  if (!payload.costCenterId) throw new Error("costCenterId required");
  const amount = Number(payload.amount);
  if (!Number.isFinite(amount) || amount < 0) throw new Error("amount must be a non-negative number");

  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    if (!data.costCenters[payload.costCenterId]) {
      throw new Error(`cost center ${payload.costCenterId} not found`);
    }
    const event = {
      id: newId("sp"),
      costCenterId: String(payload.costCenterId),
      amount,
      currency: String(payload.currency || "USD"),
      at: payload.at ? new Date(payload.at).toISOString() : nowIso(),
      description: payload.description ? String(payload.description) : "",
      metadata: payload.metadata && typeof payload.metadata === "object" ? { ...payload.metadata } : {},
    };
    data.spend.push(event);
    await saveStore(data);
    return event;
  });
}

/**
 * Compute utilization for a cost center within an optional window.
 *
 * @param {string} costCenterId
 * @param {{periodStart?: string, periodEnd?: string}} [opts]
 * @returns {Promise<{costCenterId: string, allocated: number, spent: number, remaining: number, utilization: number, events: number, overBudget: boolean}>}
 */
export async function getUtilization(costCenterId, opts = {}) {
  if (!costCenterId) throw new Error("costCenterId required");
  const data = await loadStore();
  if (!data.costCenters[costCenterId]) {
    throw new Error(`cost center ${costCenterId} not found`);
  }
  let windowStart = -Infinity;
  let windowEnd = Infinity;
  if (opts.periodStart) {
    const t = Date.parse(opts.periodStart);
    if (!Number.isFinite(t)) throw new Error("invalid periodStart");
    windowStart = t;
  }
  if (opts.periodEnd) {
    const t = Date.parse(opts.periodEnd);
    if (!Number.isFinite(t)) throw new Error("invalid periodEnd");
    windowEnd = t;
  }

  let allocated = 0;
  for (const a of Object.values(data.allocations)) {
    if (a.costCenterId !== costCenterId) continue;
    const s = Date.parse(a.periodStart);
    const e = Date.parse(a.periodEnd);
    if (e < windowStart || s > windowEnd) continue;
    allocated += Number(a.amount) || 0;
  }

  let spent = 0;
  let events = 0;
  for (const ev of data.spend) {
    if (ev.costCenterId !== costCenterId) continue;
    const t = Date.parse(ev.at);
    if (t < windowStart || t > windowEnd) continue;
    spent += Number(ev.amount) || 0;
    events += 1;
  }

  const utilization = allocated > 0 ? spent / allocated : 0;
  const remaining = allocated - spent;
  return {
    costCenterId,
    allocated: Math.round(allocated * 100) / 100,
    spent: Math.round(spent * 100) / 100,
    remaining: Math.round(remaining * 100) / 100,
    utilization: Math.round(utilization * 10000) / 10000,
    events,
    overBudget: spent > allocated,
  };
}

/**
 * List cost centers, optionally filtered by department.
 *
 * @param {{department?: string}} [filter]
 * @returns {Promise<CostCenter[]>}
 */
export async function listCostCenters(filter = {}) {
  const data = await loadStore();
  let all = Object.values(data.costCenters || {});
  if (filter.department) {
    all = all.filter((c) => c.department === filter.department);
  }
  all.sort((a, b) => (a.code < b.code ? -1 : 1));
  return all;
}

/**
 * Fetch a single cost center.
 * @param {string} id
 */
export async function getCostCenter(id) {
  if (!id) return null;
  const data = await loadStore();
  return data.costCenters[id] || null;
}

/**
 * List allocations, optionally filtered by cost center.
 *
 * @param {{costCenterId?: string}} [filter]
 * @returns {Promise<Allocation[]>}
 */
export async function listAllocations(filter = {}) {
  const data = await loadStore();
  let all = Object.values(data.allocations || {});
  if (filter.costCenterId) {
    all = all.filter((a) => a.costCenterId === filter.costCenterId);
  }
  all.sort((a, b) => (a.periodStart < b.periodStart ? 1 : -1));
  return all;
}

/**
 * List spend events, optionally filtered.
 *
 * @param {{costCenterId?: string, limit?: number}} [filter]
 * @returns {Promise<SpendEvent[]>}
 */
export async function listSpend(filter = {}) {
  const data = await loadStore();
  let all = [...(data.spend || [])];
  if (filter.costCenterId) {
    all = all.filter((e) => e.costCenterId === filter.costCenterId);
  }
  all.sort((a, b) => (a.at < b.at ? 1 : -1));
  if (Number.isFinite(filter.limit) && filter.limit > 0) {
    all = all.slice(0, Math.floor(filter.limit));
  }
  return all;
}
