/**
 * Phase 40.1: Multi-region PostgreSQL replication coordinator.
 *
 * Tracks registered regions, primary/secondary roles, replication lag, and
 * coordinates async write replication via the replication queue.
 * Conflict resolution uses last-write-wins with vector clocks.
 *
 * Region records are persisted to data/multi-region.json so the topology
 * survives restarts; in-memory caches mirror the on-disk state.
 */
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";
import {
  enqueueReplication,
  drainReplicationQueue,
  getQueueSize,
} from "./replication-queue.js";

const REGION_ID = process.env.REGION_ID || "default";
const HEALTH_TIMEOUT_MS = parseInt(process.env.MULTI_REGION_HEALTH_TIMEOUT_MS, 10) || 5_000;
const FAILOVER_THRESHOLD_MS = parseInt(process.env.MULTI_REGION_FAILOVER_THRESHOLD_MS, 10) || 60_000;
const DEFAULT_LAG_BUDGET_S = parseInt(process.env.MULTI_REGION_LAG_BUDGET_S, 10) || 30;

function regionsPath() {
  return join(getDataDir(), "multi-region.json");
}

function defaultState() {
  return {
    _version: 1,
    regions: {},
    appliedOps: {}, // regionId -> last applied op id (string)
  };
}

async function loadState() {
  const data = await readJsonPath(regionsPath(), defaultState());
  if (!data || typeof data !== "object") return defaultState();
  if (!data.regions || typeof data.regions !== "object") data.regions = {};
  if (!data.appliedOps || typeof data.appliedOps !== "object") data.appliedOps = {};
  return data;
}

async function saveState(state) {
  await writeJsonPath(regionsPath(), state);
}

/**
 * Register or update a region.
 * @param {string} regionId
 * @param {{ url: string, primary?: boolean, readOnly?: boolean, lag?: number }} config
 */
export async function registerRegion(regionId, config) {
  if (!regionId || typeof regionId !== "string") {
    throw new Error("regionId is required");
  }
  if (!config || typeof config !== "object" || !config.url) {
    throw new Error("config.url is required");
  }
  const path = regionsPath();
  return withPathLock(path, async () => {
    const state = await loadState();
    const isPrimary = !!config.primary;

    if (isPrimary) {
      // Demote any existing primary so there's only one.
      for (const r of Object.values(state.regions)) {
        if (r.primary) r.primary = false;
      }
    }

    state.regions[regionId] = {
      regionId,
      url: String(config.url).replace(/\/+$/, ""),
      primary: isPrimary,
      readOnly: config.readOnly !== undefined ? !!config.readOnly : !isPrimary,
      lag: Number.isFinite(config.lag) ? Number(config.lag) : 0,
      status: "unknown",
      registeredAt: state.regions[regionId]?.registeredAt || new Date().toISOString(),
      lastChecked: null,
      lastHealthy: null,
      lastApplied: state.regions[regionId]?.lastApplied || null,
    };
    await saveState(state);
    return state.regions[regionId];
  });
}

/** @returns {Promise<object[]>} */
export async function getRegions() {
  const state = await loadState();
  return Object.values(state.regions);
}

/** @returns {Promise<object|null>} */
export async function getPrimaryRegion() {
  const regions = await getRegions();
  return regions.find((r) => r.primary) || null;
}

/** @returns {Promise<object[]>} */
export async function getHealthyRegions() {
  const regions = await getRegions();
  return regions.filter((r) => r.status === "healthy");
}

/**
 * Replicate a write to peer regions by enqueuing it.
 * @param {string} table
 * @param {object} record
 * @returns {Promise<{ enqueued: boolean, id?: string }>}
 */
export async function replicateWrite(table, record) {
  if (!table) throw new Error("table is required");
  const result = await enqueueReplication({
    table,
    record,
    sourceRegion: REGION_ID,
    type: "upsert",
  });
  return { enqueued: true, id: result.id, dropped: result.dropped };
}

/**
 * Apply missed writes to a region by draining the queue and shipping ops.
 * @param {string} regionId
 * @returns {Promise<{ regionId: string, applied: number, failed: number, remaining: number }>}
 */
export async function catchUpRegion(regionId) {
  if (!regionId) throw new Error("regionId is required");
  const state = await loadState();
  const region = state.regions[regionId];
  if (!region) {
    throw new Error(`Unknown region: ${regionId}`);
  }

  let applied = 0;
  let failed = 0;
  const handler = async (op) => {
    // In-process catch-up: mark as applied. Real shipping happens via the
    // peer endpoint in production. We track op ids per region so callers
    // can compute lag.
    try {
      await sendOpToRegion(region, op);
      applied++;
    } catch (e) {
      failed++;
      throw e;
    }
  };

  const result = await drainReplicationQueue(handler);

  // Update last applied marker
  await withPathLock(regionsPath(), async () => {
    const fresh = await loadState();
    if (fresh.regions[regionId]) {
      fresh.regions[regionId].lastApplied = new Date().toISOString();
      fresh.regions[regionId].lag = 0;
      fresh.appliedOps[regionId] = result.drained;
    }
    await saveState(fresh);
  });

  return { regionId, applied, failed, remaining: result.remaining };
}

/**
 * Compute replication lag for a region.
 * @param {string} regionId
 * @returns {Promise<{ regionId: string, lagSeconds: number, lastApplied: string|null, behindBy: number }>}
 */
export async function getReplicationLag(regionId) {
  if (!regionId) throw new Error("regionId is required");
  const state = await loadState();
  const region = state.regions[regionId];
  if (!region) throw new Error(`Unknown region: ${regionId}`);

  const queueSize = await getQueueSize();
  const now = Date.now();
  const lastAppliedTs = region.lastApplied ? new Date(region.lastApplied).getTime() : null;
  const lagSeconds = lastAppliedTs
    ? Math.max(0, Math.floor((now - lastAppliedTs) / 1000))
    : Number.isFinite(region.lag) && region.lag > 0
      ? region.lag
      : 0;

  return {
    regionId,
    lagSeconds,
    lastApplied: region.lastApplied,
    behindBy: queueSize,
  };
}

/**
 * Promote a secondary region to primary, demoting any existing primary.
 * @param {string} regionId
 * @returns {Promise<{ regionId: string, previousPrimary: string|null, promotedAt: string }>}
 */
export async function failoverToRegion(regionId) {
  if (!regionId) throw new Error("regionId is required");
  const path = regionsPath();
  return withPathLock(path, async () => {
    const state = await loadState();
    const target = state.regions[regionId];
    if (!target) {
      throw new Error(`Unknown region: ${regionId}`);
    }
    if (target.status === "down") {
      throw new Error(`Cannot failover to region "${regionId}" (status=down)`);
    }

    let previousPrimary = null;
    for (const r of Object.values(state.regions)) {
      if (r.primary) {
        previousPrimary = r.regionId;
        r.primary = false;
        r.readOnly = true;
      }
    }
    target.primary = true;
    target.readOnly = false;
    const promotedAt = new Date().toISOString();
    target.promotedAt = promotedAt;
    await saveState(state);
    return { regionId, previousPrimary, promotedAt };
  });
}

/**
 * Resolve a conflict between two records using last-write-wins with
 * vector clocks. Each record may carry an optional `_clock` (object) and
 * `updatedAt` (ISO string) for tiebreaking.
 * @param {object} recordA
 * @param {object} recordB
 * @returns {object} The winning record (or a merged clock copy).
 */
export function resolveConflict(recordA, recordB) {
  if (!recordA && !recordB) return null;
  if (!recordA) return recordB;
  if (!recordB) return recordA;

  const clockA = recordA._clock || {};
  const clockB = recordB._clock || {};
  const sumA = Object.values(clockA).reduce((a, b) => a + Number(b || 0), 0);
  const sumB = Object.values(clockB).reduce((a, b) => a + Number(b || 0), 0);

  let winner;
  if (sumA > sumB) winner = recordA;
  else if (sumB > sumA) winner = recordB;
  else {
    const tsA = recordA.updatedAt ? new Date(recordA.updatedAt).getTime() : 0;
    const tsB = recordB.updatedAt ? new Date(recordB.updatedAt).getTime() : 0;
    winner = tsB > tsA ? recordB : recordA;
  }

  // Return a copy with merged vector clock so the caller has the latest view.
  const merged = { ...winner };
  const mergedClock = { ...clockA };
  for (const k of Object.keys(clockB)) {
    mergedClock[k] = Math.max(Number(mergedClock[k] || 0), Number(clockB[k] || 0));
  }
  for (const k of Object.keys(clockA)) {
    mergedClock[k] = Math.max(Number(mergedClock[k] || 0), Number(clockA[k] || 0));
  }
  merged._clock = mergedClock;
  return merged;
}

// ─── Health monitoring ──────────────────────────────────────────────────────

let _healthInterval = null;
let _onFailover = null;

/**
 * Start the health monitor. Pings each region's /health/ready endpoint and
 * marks regions healthy/degraded/down. If the primary stays down longer
 * than FAILOVER_THRESHOLD_MS, automatically promotes the healthiest secondary.
 *
 * @param {number} [intervalMs]
 * @param {{ onFailover?: (info: object) => void }} [opts]
 */
export function startHealthMonitor(intervalMs = 15_000, opts = {}) {
  stopHealthMonitor();
  _onFailover = opts.onFailover || null;
  const tick = async () => {
    try {
      await checkAllRegions();
      await maybeAutoFailover();
    } catch (e) {
      console.warn("[multi-region] Health monitor error:", e.message);
    }
  };
  _healthInterval = setInterval(tick, intervalMs);
  if (_healthInterval.unref) _healthInterval.unref();
  // Initial check
  tick().catch(() => {});
}

/** Stop the health monitor. */
export function stopHealthMonitor() {
  if (_healthInterval) {
    clearInterval(_healthInterval);
    _healthInterval = null;
  }
}

/**
 * Ping all registered regions and update their health status.
 * @returns {Promise<object[]>}
 */
export async function checkAllRegions() {
  const path = regionsPath();
  const state = await loadState();
  const regions = Object.values(state.regions);
  const results = await Promise.all(regions.map((r) => checkOne(r)));

  return withPathLock(path, async () => {
    const fresh = await loadState();
    const now = new Date().toISOString();
    for (const r of results) {
      if (fresh.regions[r.regionId]) {
        fresh.regions[r.regionId].status = r.status;
        fresh.regions[r.regionId].lastChecked = now;
        if (r.status === "healthy") {
          fresh.regions[r.regionId].lastHealthy = now;
        }
        if (r.latencyMs != null) {
          fresh.regions[r.regionId].latencyMs = r.latencyMs;
        }
        if (r.error) {
          fresh.regions[r.regionId].error = r.error;
        } else {
          fresh.regions[r.regionId].error = null;
        }
      }
    }
    await saveState(fresh);
    return Object.values(fresh.regions);
  });
}

async function checkOne(region) {
  const url = `${region.url}/health/ready`;
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": `SiskelBot-MultiRegion/${REGION_ID}` },
    }).catch((e) => { throw e; });
    clearTimeout(timeout);
    const latencyMs = Date.now() - start;
    if (res.ok) {
      return { regionId: region.regionId, status: "healthy", latencyMs, error: null };
    }
    return { regionId: region.regionId, status: "degraded", latencyMs, error: `HTTP ${res.status}` };
  } catch (e) {
    return {
      regionId: region.regionId,
      status: "down",
      latencyMs: Date.now() - start,
      error: e?.name === "AbortError" ? "timeout" : e?.message || "error",
    };
  }
}

async function maybeAutoFailover() {
  const state = await loadState();
  const primary = Object.values(state.regions).find((r) => r.primary);
  if (!primary) return;
  if (primary.status === "healthy") return;
  if (!primary.lastHealthy) return;
  const downForMs = Date.now() - new Date(primary.lastHealthy).getTime();
  if (downForMs < FAILOVER_THRESHOLD_MS) return;

  // Pick the healthiest non-primary region.
  const candidates = Object.values(state.regions).filter(
    (r) => !r.primary && r.status === "healthy"
  );
  if (candidates.length === 0) return;
  candidates.sort((a, b) => (a.latencyMs || Infinity) - (b.latencyMs || Infinity));
  const next = candidates[0];

  try {
    const result = await failoverToRegion(next.regionId);
    console.warn(
      `[multi-region] Auto-failover: primary "${primary.regionId}" down for ${downForMs}ms; promoted "${next.regionId}"`
    );
    if (_onFailover) {
      try { _onFailover({ ...result, automatic: true, reason: `primary_down_${downForMs}ms` }); }
      catch (_) { /* ignore */ }
    }
  } catch (e) {
    console.warn("[multi-region] Auto-failover failed:", e.message);
  }
}

/**
 * Best-effort: ship an op to a peer region's internal sync endpoint.
 * Throws on network failure so the queue retains the op for retry.
 * @param {object} region
 * @param {object} op
 */
async function sendOpToRegion(region, op) {
  // Self-targeting: just succeed (used in tests and single-node deployments).
  if (region.regionId === REGION_ID) return;

  const internalSecret = process.env.INTERNAL_SECRET;
  if (!internalSecret) {
    // No secret configured — accept locally so the queue can drain in dev.
    return;
  }

  const url = `${region.url}/api/internal/sync`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${internalSecret}`,
        "X-Source-Region": REGION_ID,
      },
      body: JSON.stringify({
        key: `${op.table}:${op.id}`,
        value: op.record,
        sourceRegion: op.sourceRegion,
        timestamp: op.enqueuedAt,
      }),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Reset all in-memory state and on-disk topology (test helper).
 */
export async function _resetMultiRegion() {
  stopHealthMonitor();
  _onFailover = null;
  await writeJsonPath(regionsPath(), defaultState());
}

export const _internals = {
  defaultLagBudgetSeconds: DEFAULT_LAG_BUDGET_S,
  failoverThresholdMs: FAILOVER_THRESHOLD_MS,
  regionsPath,
};
