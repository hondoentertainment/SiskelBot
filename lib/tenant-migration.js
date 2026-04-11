// @ts-check
/**
 * Phase 66.5: Tenant migration (zero-downtime region moves).
 *
 * A migration is a staged plan with four phases:
 *   1. plan      — capture source/target, validate, reserve slot
 *   2. replicate — copy data (or simulated steps) to target
 *   3. cutover   — redirect traffic, flip source to readonly
 *   4. verify    — confirm health, mark complete
 *
 * Failures at any step can trigger a rollback that reverts the last
 * successful phase. State transitions are persisted so runs are
 * observable and resumable.
 *
 * Exports:
 *   - planMigration
 *   - executeMigration
 *   - rollbackMigration
 *   - getMigrationStatus
 *   - listMigrations
 *
 * @module tenant-migration
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

const PHASES = ["plan", "replicate", "cutover", "verify"];

function storePath() {
  return join(getDataDir(), "tenant-migration.json");
}

function newId() {
  return `mig_${randomBytes(8).toString("hex")}`;
}

function nowIso() {
  return new Date().toISOString();
}

async function loadStore() {
  const data = await readJsonPath(storePath(), {
    version: STORE_VERSION,
    migrations: {},
  });
  if (!data.migrations || typeof data.migrations !== "object") data.migrations = {};
  return data;
}

async function saveStore(data) {
  await writeJsonPath(storePath(), {
    version: STORE_VERSION,
    migrations: data.migrations || {},
  });
}

/**
 * Create a migration plan (does not perform any work).
 *
 * @param {{tenantId: string, fromRegion: string, toRegion: string, owner?: string, options?: object}} payload
 * @returns {Promise<object>}
 */
export async function planMigration(payload) {
  if (!payload || typeof payload !== "object") throw new Error("payload required");
  if (!payload.tenantId) throw new Error("tenantId required");
  if (!payload.fromRegion || !payload.toRegion) throw new Error("fromRegion and toRegion required");
  if (payload.fromRegion === payload.toRegion) throw new Error("fromRegion and toRegion must differ");

  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    // Only one active migration per tenant
    for (const m of Object.values(data.migrations || {})) {
      if (m.tenantId === payload.tenantId && m.status !== "completed" && m.status !== "rolled_back" && m.status !== "failed") {
        throw new Error(`migration already in progress for ${payload.tenantId}`);
      }
    }
    const id = newId();
    const ts = nowIso();
    const record = {
      id,
      tenantId: String(payload.tenantId),
      fromRegion: String(payload.fromRegion),
      toRegion: String(payload.toRegion),
      owner: payload.owner ? String(payload.owner) : "",
      options: payload.options && typeof payload.options === "object" ? { ...payload.options } : {},
      status: "planned",
      currentPhase: "plan",
      completedPhases: ["plan"],
      history: [{ at: ts, phase: "plan", status: "completed", notes: "plan created" }],
      createdAt: ts,
      updatedAt: ts,
    };
    data.migrations[id] = record;
    await saveStore(data);
    return record;
  });
}

async function advanceMigration(id, targetPhase, { notes = "", hooks } = {}) {
  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    const m = data.migrations[id];
    if (!m) throw new Error(`migration ${id} not found`);
    if (m.status === "completed" || m.status === "rolled_back" || m.status === "failed") {
      throw new Error(`migration ${id} is ${m.status}`);
    }
    const idx = PHASES.indexOf(targetPhase);
    if (idx < 0) throw new Error(`unknown phase ${targetPhase}`);
    const currentIdx = PHASES.indexOf(m.currentPhase);
    if (idx !== currentIdx + 1) {
      throw new Error(`cannot advance from ${m.currentPhase} to ${targetPhase}`);
    }
    try {
      if (hooks && typeof hooks[targetPhase] === "function") {
        await hooks[targetPhase](m);
      }
    } catch (err) {
      m.status = "failed";
      m.updatedAt = nowIso();
      m.history.push({ at: nowIso(), phase: targetPhase, status: "failed", notes: String(err?.message || err) });
      data.migrations[id] = m;
      await saveStore(data);
      throw err;
    }
    m.currentPhase = targetPhase;
    m.completedPhases.push(targetPhase);
    m.history.push({ at: nowIso(), phase: targetPhase, status: "completed", notes });
    if (targetPhase === "verify") {
      m.status = "completed";
    } else {
      m.status = "in_progress";
    }
    m.updatedAt = nowIso();
    data.migrations[id] = m;
    await saveStore(data);
    return m;
  });
}

/**
 * Execute a migration through all remaining phases in order.
 * `hooks` is an optional object `{ replicate, cutover, verify }`
 * that can throw to simulate failures or perform real work.
 *
 * @param {string} id
 * @param {{hooks?: object, untilPhase?: string}} [options]
 * @returns {Promise<object>}
 */
export async function executeMigration(id, options = {}) {
  if (!id) throw new Error("id required");
  const untilPhase = options.untilPhase || "verify";
  const stopIdx = PHASES.indexOf(untilPhase);
  if (stopIdx < 0) throw new Error(`unknown untilPhase ${untilPhase}`);
  let current;
  // Walk phases from current+1 up to stopIdx, one transition per loop iter.
  while (true) {
    const data = await loadStore();
    const m = data.migrations[id];
    if (!m) throw new Error(`migration ${id} not found`);
    current = m;
    const curIdx = PHASES.indexOf(m.currentPhase);
    if (curIdx >= stopIdx) break;
    if (m.status === "failed" || m.status === "rolled_back") break;
    const next = PHASES[curIdx + 1];
    current = await advanceMigration(id, next, {
      notes: `advanced to ${next}`,
      hooks: options.hooks || {},
    });
  }
  return current;
}

/**
 * Roll back a migration by reverting the most recent completed phase.
 * Re-walks phases backwards until only "plan" remains.
 *
 * @param {string} id
 * @param {{reason?: string}} [options]
 * @returns {Promise<object>}
 */
export async function rollbackMigration(id, options = {}) {
  if (!id) throw new Error("id required");
  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    const m = data.migrations[id];
    if (!m) throw new Error(`migration ${id} not found`);
    if (m.status === "rolled_back") return m;
    m.completedPhases = ["plan"];
    m.currentPhase = "plan";
    m.status = "rolled_back";
    m.updatedAt = nowIso();
    m.history.push({
      at: nowIso(),
      phase: "rollback",
      status: "completed",
      notes: String(options.reason || "rollback requested"),
    });
    data.migrations[id] = m;
    await saveStore(data);
    return m;
  });
}

/**
 * Get the current status of a migration.
 *
 * @param {string} id
 * @returns {Promise<object | null>}
 */
export async function getMigrationStatus(id) {
  if (!id) return null;
  const data = await loadStore();
  return data.migrations[id] || null;
}

/**
 * List migrations, optionally filtered.
 *
 * @param {{tenantId?: string, status?: string, limit?: number}} [filter]
 * @returns {Promise<object[]>}
 */
export async function listMigrations(filter = {}) {
  const data = await loadStore();
  let all = Object.values(data.migrations || {});
  if (filter.tenantId) all = all.filter((m) => m.tenantId === filter.tenantId);
  if (filter.status) all = all.filter((m) => m.status === filter.status);
  all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  if (Number.isFinite(filter.limit) && filter.limit > 0) {
    all = all.slice(0, Math.floor(filter.limit));
  }
  return all;
}

export { PHASES };
