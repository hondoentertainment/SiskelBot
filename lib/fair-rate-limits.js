// @ts-check
/**
 * Phase 66.3: Fair rate limits.
 *
 * Weighted round-robin with priority across tenants. Each tenant
 * registers with a `weight` (and optional `priority`). `tryAcquire`
 * returns the next tenant allowed to run, consuming a slot from a
 * per-tenant token bucket. Queue state is fully in-memory; persistence
 * is optional for weights and tenant metadata.
 *
 * Exports:
 *   - registerTenant
 *   - tryAcquire
 *   - getQueue
 *   - setWeights
 *   - listTenants
 *   - releaseSlot
 *
 * @module fair-rate-limits
 */
import { join } from "path";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;
const DEFAULT_CAPACITY = 10;
const DEFAULT_REFILL_PER_SEC = 1;

function storePath() {
  return join(getDataDir(), "fair-rate-limits.json");
}

function nowIso() {
  return new Date().toISOString();
}

/** @type {Map<string, { tenantId: string, weight: number, priority: number, tokens: number, capacity: number, refillPerSec: number, lastRefillMs: number, active: number, totalServed: number, lastServedAt: string }>} */
const tenants = new Map();
/** @type {Array<{tenantId: string, enqueuedAt: number}>} */
const queue = [];

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

async function persistTenant(tenantId) {
  const path = storePath();
  const t = tenants.get(tenantId);
  if (!t) return;
  return withPathLock(path, async () => {
    const data = await loadStore();
    data.tenants[tenantId] = {
      tenantId,
      weight: t.weight,
      priority: t.priority,
      capacity: t.capacity,
      refillPerSec: t.refillPerSec,
      totalServed: t.totalServed,
      updatedAt: nowIso(),
    };
    await saveStore(data);
  });
}

function refill(tenant, nowMs) {
  const elapsedMs = nowMs - tenant.lastRefillMs;
  if (elapsedMs <= 0) return;
  const refillCount = (elapsedMs / 1000) * tenant.refillPerSec;
  tenant.tokens = Math.min(tenant.capacity, tenant.tokens + refillCount);
  tenant.lastRefillMs = nowMs;
}

/**
 * Register a tenant. If already registered, settings are updated.
 *
 * @param {{tenantId: string, weight?: number, priority?: number, capacity?: number, refillPerSec?: number, persist?: boolean}} payload
 * @returns {Promise<object>}
 */
export async function registerTenant(payload) {
  if (!payload || typeof payload !== "object") throw new Error("payload required");
  if (!payload.tenantId) throw new Error("tenantId required");
  const weight = Number.isFinite(payload.weight) && payload.weight > 0 ? payload.weight : 1;
  const priority = Number.isFinite(payload.priority) ? payload.priority : 0;
  const capacity = Number.isFinite(payload.capacity) && payload.capacity > 0 ? payload.capacity : DEFAULT_CAPACITY;
  const refillPerSec = Number.isFinite(payload.refillPerSec) && payload.refillPerSec > 0
    ? payload.refillPerSec
    : DEFAULT_REFILL_PER_SEC;
  const existing = tenants.get(payload.tenantId);
  const record = existing || {
    tenantId: payload.tenantId,
    weight,
    priority,
    capacity,
    refillPerSec,
    tokens: capacity,
    lastRefillMs: Date.now(),
    active: 0,
    totalServed: 0,
    lastServedAt: "",
  };
  if (existing) {
    record.weight = weight;
    record.priority = priority;
    record.capacity = capacity;
    record.refillPerSec = refillPerSec;
    if (record.tokens > capacity) record.tokens = capacity;
  }
  tenants.set(payload.tenantId, record);
  if (payload.persist !== false) {
    await persistTenant(payload.tenantId);
  }
  return {
    tenantId: record.tenantId,
    weight: record.weight,
    priority: record.priority,
    capacity: record.capacity,
    refillPerSec: record.refillPerSec,
    tokens: record.tokens,
  };
}

/**
 * Attempt to acquire a slot for a specific tenant (returns immediately).
 * If no token is available, the tenant is enqueued and `queued: true`
 * is returned.
 *
 * @param {string} tenantId
 * @returns {{acquired: boolean, queued: boolean, tokens: number, waitCount?: number}}
 */
export function tryAcquire(tenantId) {
  if (!tenantId) throw new Error("tenantId required");
  const tenant = tenants.get(tenantId);
  if (!tenant) throw new Error(`tenant ${tenantId} not registered`);
  refill(tenant, Date.now());
  if (tenant.tokens >= 1) {
    tenant.tokens -= 1;
    tenant.active += 1;
    tenant.totalServed += 1;
    tenant.lastServedAt = nowIso();
    return { acquired: true, queued: false, tokens: tenant.tokens };
  }
  // Not enough tokens — enqueue fairly according to weight/priority.
  const weightedBoost = tenant.weight * (1 + tenant.priority);
  const enqueuedAt = Date.now() - weightedBoost;
  queue.push({ tenantId, enqueuedAt });
  queue.sort((a, b) => a.enqueuedAt - b.enqueuedAt);
  return { acquired: false, queued: true, tokens: tenant.tokens, waitCount: queue.filter((x) => x.tenantId === tenantId).length };
}

/**
 * Release a previously-acquired slot.
 *
 * @param {string} tenantId
 */
export function releaseSlot(tenantId) {
  const t = tenants.get(tenantId);
  if (!t) return false;
  if (t.active > 0) t.active -= 1;
  return true;
}

/**
 * Return the current queue snapshot.
 * @returns {{items: Array<{tenantId: string, waitMs: number}>, size: number}}
 */
export function getQueue() {
  const now = Date.now();
  const items = queue.map((q) => ({
    tenantId: q.tenantId,
    waitMs: Math.max(0, now - q.enqueuedAt),
  }));
  return { items, size: queue.length };
}

/**
 * Bulk-update weights / priorities for tenants. Unknown tenants are
 * silently registered with defaults.
 *
 * @param {Array<{tenantId: string, weight?: number, priority?: number}>} updates
 * @returns {Promise<Array<object>>}
 */
export async function setWeights(updates) {
  if (!Array.isArray(updates)) throw new Error("updates array required");
  const results = [];
  for (const u of updates) {
    if (!u || !u.tenantId) continue;
    const record = await registerTenant({
      tenantId: u.tenantId,
      weight: u.weight,
      priority: u.priority,
    });
    results.push(record);
  }
  return results;
}

/**
 * List registered tenants. When `includeStats` is true the per-tenant
 * token/active counts are included.
 *
 * @param {{includeStats?: boolean}} [options]
 * @returns {object[]}
 */
export function listTenants(options = {}) {
  const out = [];
  for (const t of tenants.values()) {
    const base = {
      tenantId: t.tenantId,
      weight: t.weight,
      priority: t.priority,
      capacity: t.capacity,
      refillPerSec: t.refillPerSec,
    };
    if (options.includeStats) {
      out.push({
        ...base,
        tokens: Math.round(t.tokens * 100) / 100,
        active: t.active,
        totalServed: t.totalServed,
        lastServedAt: t.lastServedAt,
      });
    } else {
      out.push(base);
    }
  }
  out.sort((a, b) => (a.tenantId < b.tenantId ? -1 : 1));
  return out;
}

/**
 * Testing helper: reset in-memory state.
 */
export function _resetFairRateLimits() {
  tenants.clear();
  queue.length = 0;
}

/**
 * Load previously persisted tenants into the in-memory state.
 */
export async function loadPersistedTenants() {
  const data = await loadStore();
  for (const t of Object.values(data.tenants || {})) {
    await registerTenant({ ...t, persist: false });
  }
  return listTenants();
}
