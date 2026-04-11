// @ts-check
/**
 * Phase 66.1: Resource isolation (cgroup / namespace-style limits).
 *
 * Simulates per-tenant resource budgets for CPU (ms), memory (bytes),
 * IO (bytes), and concurrent requests. The module exposes helpers to set
 * limits, record ongoing usage, and check whether a request would bust
 * a quota before running it.
 *
 * Limits and usage are JSON-persisted per tenantId.
 *
 * Exports:
 *   - setLimits
 *   - getLimits
 *   - recordUsage
 *   - checkQuota
 *   - listTenantUsage
 *   - resetUsage
 *
 * @module resource-isolation
 */
import { join } from "path";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;

/** Known resource types. Anything else is accepted but not aggregated. */
export const RESOURCE_TYPES = Object.freeze(["cpu_ms", "memory_bytes", "io_bytes", "concurrent"]);

function storePath() {
  return join(getDataDir(), "resource-isolation.json");
}

function nowIso() {
  return new Date().toISOString();
}

async function loadStore() {
  const data = await readJsonPath(storePath(), {
    version: STORE_VERSION,
    tenants: {},
  });
  if (!data.tenants || typeof data.tenants !== "object") data.tenants = {};
  return data;
}

async function saveStore(data) {
  await writeJsonPath(storePath(), {
    version: STORE_VERSION,
    tenants: data.tenants || {},
  });
}

function ensureTenant(data, tenantId) {
  if (!data.tenants[tenantId]) {
    data.tenants[tenantId] = {
      tenantId,
      limits: {},
      usage: {},
      updatedAt: nowIso(),
    };
  }
  return data.tenants[tenantId];
}

/**
 * Set (or replace) tenant limits. `limits` is an object where each key is
 * a resource type and each value is a non-negative number.
 *
 * @param {string} tenantId
 * @param {Record<string, number>} limits
 * @returns {Promise<object>}
 */
export async function setLimits(tenantId, limits) {
  if (!tenantId || typeof tenantId !== "string") throw new Error("tenantId required");
  if (!limits || typeof limits !== "object") throw new Error("limits object required");
  const clean = {};
  for (const [k, v] of Object.entries(limits)) {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) {
      throw new Error(`limit for ${k} must be a non-negative number`);
    }
    clean[k] = n;
  }
  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    const tenant = ensureTenant(data, tenantId);
    tenant.limits = { ...tenant.limits, ...clean };
    tenant.updatedAt = nowIso();
    data.tenants[tenantId] = tenant;
    await saveStore(data);
    return { tenantId, limits: tenant.limits };
  });
}

/**
 * Fetch a tenant's currently configured limits.
 *
 * @param {string} tenantId
 * @returns {Promise<{tenantId: string, limits: Record<string, number>} | null>}
 */
export async function getLimits(tenantId) {
  if (!tenantId) return null;
  const data = await loadStore();
  const t = data.tenants[tenantId];
  if (!t) return null;
  return { tenantId, limits: { ...(t.limits || {}) } };
}

/**
 * Record that a tenant consumed `amount` of `resourceType`. For the
 * `concurrent` counter, pass `{delta: +1}` / `{delta: -1}` to track
 * open requests.
 *
 * @param {string} tenantId
 * @param {string} resourceType
 * @param {number} amount
 * @param {{mode?: "add"|"set"}} [options]
 * @returns {Promise<object>}
 */
export async function recordUsage(tenantId, resourceType, amount, options = {}) {
  if (!tenantId || typeof tenantId !== "string") throw new Error("tenantId required");
  if (!resourceType || typeof resourceType !== "string") throw new Error("resourceType required");
  const n = Number(amount);
  if (!Number.isFinite(n)) throw new Error("amount must be a finite number");
  const mode = options.mode === "set" ? "set" : "add";

  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    const tenant = ensureTenant(data, tenantId);
    if (mode === "set") {
      tenant.usage[resourceType] = Math.max(0, n);
    } else {
      const prior = Number(tenant.usage[resourceType]) || 0;
      tenant.usage[resourceType] = Math.max(0, prior + n);
    }
    tenant.updatedAt = nowIso();
    data.tenants[tenantId] = tenant;
    await saveStore(data);
    return { tenantId, resourceType, usage: tenant.usage[resourceType] };
  });
}

/**
 * Check whether consuming `amount` more of `resourceType` would exceed
 * the tenant's limit. Does not persist anything.
 *
 * @param {string} tenantId
 * @param {string} resourceType
 * @param {number} [amount=0]
 * @returns {Promise<{allowed: boolean, limit: number, currentUsage: number, projectedUsage: number, reason?: string}>}
 */
export async function checkQuota(tenantId, resourceType, amount = 0) {
  if (!tenantId || typeof tenantId !== "string") throw new Error("tenantId required");
  if (!resourceType || typeof resourceType !== "string") throw new Error("resourceType required");
  const n = Number(amount);
  if (!Number.isFinite(n) || n < 0) throw new Error("amount must be a non-negative number");
  const data = await loadStore();
  const tenant = data.tenants[tenantId];
  if (!tenant) {
    return { allowed: true, limit: Infinity, currentUsage: 0, projectedUsage: n };
  }
  const limit = Number(tenant.limits?.[resourceType]);
  const currentUsage = Number(tenant.usage?.[resourceType]) || 0;
  const projectedUsage = currentUsage + n;
  if (!Number.isFinite(limit) || limit <= 0) {
    return { allowed: true, limit: Infinity, currentUsage, projectedUsage };
  }
  if (projectedUsage > limit) {
    return {
      allowed: false,
      limit,
      currentUsage,
      projectedUsage,
      reason: `would exceed ${resourceType} limit`,
    };
  }
  return { allowed: true, limit, currentUsage, projectedUsage };
}

/**
 * List all known tenants with their usage snapshots.
 *
 * @param {{overLimitOnly?: boolean}} [filter]
 * @returns {Promise<Array<{tenantId: string, limits: object, usage: object, overLimit: string[]}>>}
 */
export async function listTenantUsage(filter = {}) {
  const data = await loadStore();
  const out = [];
  for (const t of Object.values(data.tenants || {})) {
    const overLimit = [];
    for (const [k, lim] of Object.entries(t.limits || {})) {
      const u = Number(t.usage?.[k]) || 0;
      const l = Number(lim);
      if (Number.isFinite(l) && l > 0 && u > l) overLimit.push(k);
    }
    if (filter.overLimitOnly && overLimit.length === 0) continue;
    out.push({
      tenantId: t.tenantId,
      limits: { ...(t.limits || {}) },
      usage: { ...(t.usage || {}) },
      overLimit,
    });
  }
  out.sort((a, b) => (a.tenantId < b.tenantId ? -1 : 1));
  return out;
}

/**
 * Reset all usage counters for a tenant (e.g. at the start of a period).
 *
 * @param {string} tenantId
 * @param {string[]} [resources]
 * @returns {Promise<object>}
 */
export async function resetUsage(tenantId, resources) {
  if (!tenantId) throw new Error("tenantId required");
  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    const tenant = data.tenants[tenantId];
    if (!tenant) return { tenantId, usage: {} };
    if (Array.isArray(resources) && resources.length > 0) {
      for (const r of resources) tenant.usage[r] = 0;
    } else {
      tenant.usage = {};
    }
    tenant.updatedAt = nowIso();
    data.tenants[tenantId] = tenant;
    await saveStore(data);
    return { tenantId, usage: tenant.usage };
  });
}
