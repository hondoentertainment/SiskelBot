// @ts-check
/**
 * Phase 60.2: Memory leak detection.
 *
 * Simulates heap snapshot diffing without actually taking v8 heap
 * snapshots (which are too heavy and non-deterministic for tests).
 * A "snapshot" is an array of { objectType, count, size } records.
 * We persist snapshots so diffs can be computed later, and run a
 * simple leak detector that flags object types whose size / count
 * grows monotonically across a configurable window of snapshots.
 *
 * Export surface:
 *   - takeSnapshot({ label?, records? })
 *   - diffSnapshots(beforeId, afterId)
 *   - detectLeaks({ windowSize?, minGrowthBytes?, minGrowthRatio? })
 *   - listSnapshots()
 *   - clearSnapshots(id?)
 *
 * @module memory-leak
 */
import { join } from "path";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;
const MAX_STORED_SNAPSHOTS = 200;
const DEFAULT_WINDOW = 5;
const DEFAULT_MIN_GROWTH_BYTES = 1024;
const DEFAULT_MIN_GROWTH_RATIO = 1.2;

function storePath() {
  return join(getDataDir(), "memory-leak.json");
}

let _counter = 0;
function genId() {
  _counter += 1;
  return `snap_${Date.now().toString(36)}_${_counter}`;
}

/* -------------------------------------------------------------------------- */
/* Persistence                                                                */
/* -------------------------------------------------------------------------- */

async function loadStore() {
  const data = await readJsonPath(storePath(), { version: STORE_VERSION, snapshots: [] });
  if (!Array.isArray(data.snapshots)) data.snapshots = [];
  return data;
}

async function saveStore(data) {
  await writeJsonPath(storePath(), {
    version: STORE_VERSION,
    snapshots: Array.isArray(data.snapshots) ? data.snapshots : [],
  });
}

/* -------------------------------------------------------------------------- */
/* Snapshot normalization                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Normalize a snapshot's records to the canonical shape:
 *   [{ objectType, count, size }]
 *
 * @param {any[]} records
 * @returns {Array<{ objectType: string, count: number, size: number }>}
 */
export function normalizeRecords(records) {
  if (!Array.isArray(records)) return [];
  const grouped = new Map();
  for (const r of records) {
    if (!r || typeof r !== "object") continue;
    const type = String(r.objectType || r.type || "").trim();
    if (!type) continue;
    const existing = grouped.get(type) || { objectType: type, count: 0, size: 0 };
    existing.count += Number(r.count) || 0;
    existing.size += Number(r.size) || 0;
    grouped.set(type, existing);
  }
  return [...grouped.values()].sort((a, b) => b.size - a.size);
}

/**
 * Derive a synthetic snapshot from `process.memoryUsage()` when no
 * explicit records are supplied.
 *
 * @param {() => NodeJS.MemoryUsage} [memFn]
 */
export function synthesizeRecords(memFn) {
  const fn = typeof memFn === "function" ? memFn : () => process.memoryUsage();
  let mu = /** @type {any} */ ({ rss: 0, heapUsed: 0, heapTotal: 0, external: 0, arrayBuffers: 0 });
  try {
    mu = fn() || mu;
  } catch {
    // ignore
  }
  /** @type {Array<{ objectType: string, count: number, size: number }>} */
  const out = [];
  if (mu.heapUsed) out.push({ objectType: "heap_used", count: 1, size: Number(mu.heapUsed) || 0 });
  if (mu.heapTotal) out.push({ objectType: "heap_total", count: 1, size: Number(mu.heapTotal) || 0 });
  if (mu.external) out.push({ objectType: "external", count: 1, size: Number(mu.external) || 0 });
  if (mu.rss) out.push({ objectType: "rss", count: 1, size: Number(mu.rss) || 0 });
  if (mu.arrayBuffers) out.push({ objectType: "array_buffers", count: 1, size: Number(mu.arrayBuffers) || 0 });
  return out;
}

/* -------------------------------------------------------------------------- */
/* Snapshot storage                                                           */
/* -------------------------------------------------------------------------- */

/**
 * @param {{ label?: string, records?: any[], memoryUsage?: () => NodeJS.MemoryUsage }} [opts]
 */
export async function takeSnapshot(opts = {}) {
  const label = typeof opts.label === "string" && opts.label.trim() ? opts.label : "snapshot";
  const records = Array.isArray(opts.records) && opts.records.length > 0
    ? normalizeRecords(opts.records)
    : normalizeRecords(synthesizeRecords(opts.memoryUsage));

  const snap = {
    id: genId(),
    label,
    takenAt: new Date().toISOString(),
    records,
    totalSize: records.reduce((a, r) => a + (Number(r.size) || 0), 0),
    totalCount: records.reduce((a, r) => a + (Number(r.count) || 0), 0),
  };

  const path = storePath();
  return withPathLock(path, async () => {
    const store = await loadStore();
    store.snapshots.push(snap);
    if (store.snapshots.length > MAX_STORED_SNAPSHOTS) {
      store.snapshots = store.snapshots.slice(-MAX_STORED_SNAPSHOTS);
    }
    await saveStore(store);
    return snap;
  });
}

/**
 * List every stored snapshot (most recent last).
 */
export async function listSnapshots() {
  const store = await loadStore();
  return store.snapshots.map((s) => ({
    id: s.id,
    label: s.label,
    takenAt: s.takenAt,
    totalSize: s.totalSize,
    totalCount: s.totalCount,
    typeCount: Array.isArray(s.records) ? s.records.length : 0,
  }));
}

/**
 * Fetch a single snapshot in full.
 * @param {string} id
 */
export async function getSnapshot(id) {
  if (!id || typeof id !== "string") return null;
  const store = await loadStore();
  return store.snapshots.find((s) => s.id === id) || null;
}

/**
 * Delete a snapshot (or every snapshot when id is omitted).
 * @param {string} [id]
 */
export async function clearSnapshots(id) {
  const path = storePath();
  return withPathLock(path, async () => {
    const store = await loadStore();
    if (!id) {
      const count = store.snapshots.length;
      store.snapshots = [];
      await saveStore(store);
      return { cleared: count };
    }
    const before = store.snapshots.length;
    store.snapshots = store.snapshots.filter((s) => s.id !== id);
    await saveStore(store);
    return { cleared: before - store.snapshots.length };
  });
}

/* -------------------------------------------------------------------------- */
/* Diffing                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Compute a per-type diff (after - before). Missing entries are treated
 * as zero. Returns sorted descending by delta.size.
 *
 * @param {string} beforeId
 * @param {string} afterId
 */
export async function diffSnapshots(beforeId, afterId) {
  if (!beforeId || !afterId) {
    throw new Error("beforeId and afterId are required");
  }
  const store = await loadStore();
  const before = store.snapshots.find((s) => s.id === beforeId);
  const after = store.snapshots.find((s) => s.id === afterId);
  if (!before) throw new Error(`snapshot ${beforeId} not found`);
  if (!after) throw new Error(`snapshot ${afterId} not found`);

  return computeDiff(before, after);
}

/**
 * Pure helper: compute a diff given two already-loaded snapshots.
 *
 * @param {{ records: any[] }} before
 * @param {{ records: any[] }} after
 */
export function computeDiff(before, after) {
  const beforeMap = new Map();
  for (const r of before.records || []) {
    beforeMap.set(r.objectType, { count: Number(r.count) || 0, size: Number(r.size) || 0 });
  }
  const afterMap = new Map();
  for (const r of after.records || []) {
    afterMap.set(r.objectType, { count: Number(r.count) || 0, size: Number(r.size) || 0 });
  }
  /** @type {Array<{ objectType: string, deltaCount: number, deltaSize: number, beforeCount: number, afterCount: number, beforeSize: number, afterSize: number }>} */
  const rows = [];
  const allTypes = new Set([...beforeMap.keys(), ...afterMap.keys()]);
  for (const type of allTypes) {
    const b = beforeMap.get(type) || { count: 0, size: 0 };
    const a = afterMap.get(type) || { count: 0, size: 0 };
    rows.push({
      objectType: type,
      deltaCount: a.count - b.count,
      deltaSize: a.size - b.size,
      beforeCount: b.count,
      afterCount: a.count,
      beforeSize: b.size,
      afterSize: a.size,
    });
  }
  rows.sort((x, y) => y.deltaSize - x.deltaSize);
  const totalDeltaSize = rows.reduce((acc, r) => acc + r.deltaSize, 0);
  const totalDeltaCount = rows.reduce((acc, r) => acc + r.deltaCount, 0);
  return {
    rows,
    totalDeltaSize,
    totalDeltaCount,
    growingTypes: rows.filter((r) => r.deltaSize > 0).length,
    shrinkingTypes: rows.filter((r) => r.deltaSize < 0).length,
  };
}

/* -------------------------------------------------------------------------- */
/* Leak detection                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Scan the most recent N snapshots and flag object types whose size
 * grows monotonically and exceeds minGrowthBytes / minGrowthRatio.
 *
 * @param {{ windowSize?: number, minGrowthBytes?: number, minGrowthRatio?: number, snapshots?: any[] }} [opts]
 */
export async function detectLeaks(opts = {}) {
  const windowSize = Number.isFinite(opts.windowSize) && opts.windowSize > 1
    ? Math.floor(opts.windowSize)
    : DEFAULT_WINDOW;
  const minGrowthBytes = Number.isFinite(opts.minGrowthBytes)
    ? opts.minGrowthBytes
    : DEFAULT_MIN_GROWTH_BYTES;
  const minGrowthRatio = Number.isFinite(opts.minGrowthRatio)
    ? opts.minGrowthRatio
    : DEFAULT_MIN_GROWTH_RATIO;

  const store = await loadStore();
  const all = Array.isArray(opts.snapshots) && opts.snapshots.length > 0
    ? opts.snapshots
    : store.snapshots;
  if (all.length < 2) {
    return { analyzed: all.length, leaks: [], window: windowSize };
  }
  const window = all.slice(-windowSize);
  // Map type -> array of sizes across window
  /** @type {Map<string, number[]>} */
  const series = new Map();
  for (const snap of window) {
    for (const r of snap.records || []) {
      const arr = series.get(r.objectType) || [];
      arr.push(Number(r.size) || 0);
      series.set(r.objectType, arr);
    }
  }
  /** @type {Array<{ objectType: string, firstSize: number, lastSize: number, growthBytes: number, growthRatio: number, monotonic: boolean }>} */
  const leaks = [];
  for (const [type, sizes] of series.entries()) {
    // Only consider types that appear in every snapshot in the window.
    if (sizes.length < window.length) continue;
    let monotonic = true;
    for (let i = 1; i < sizes.length; i += 1) {
      if (sizes[i] < sizes[i - 1]) {
        monotonic = false;
        break;
      }
    }
    const first = sizes[0];
    const last = sizes[sizes.length - 1];
    const growthBytes = last - first;
    const growthRatio = first > 0 ? last / first : last > 0 ? Infinity : 1;
    if (!monotonic) continue;
    if (growthBytes < minGrowthBytes) continue;
    if (Number.isFinite(growthRatio) && growthRatio < minGrowthRatio) continue;
    leaks.push({
      objectType: type,
      firstSize: first,
      lastSize: last,
      growthBytes,
      growthRatio: Number.isFinite(growthRatio) ? Math.round(growthRatio * 10000) / 10000 : Infinity,
      monotonic,
    });
  }
  leaks.sort((a, b) => b.growthBytes - a.growthBytes);
  return {
    analyzed: window.length,
    window: windowSize,
    leaks,
    leakCount: leaks.length,
  };
}
