// @ts-check
/**
 * Phase 68.5: Freshness SLAs for knowledge assets.
 *
 * Tracks the last-refresh timestamp of knowledge assets and fires
 * alerts when any asset exceeds its configured max-age threshold.
 *
 * Exports:
 *   - registerAsset
 *   - recordRefresh
 *   - computeAge
 *   - listStaleAssets
 *   - alertOnStale
 *
 * @module freshness-sla
 */
import { join } from "path";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;

function assetsPath() {
  return join(getDataDir(), "freshness-sla-assets.json");
}

function alertsPath() {
  return join(getDataDir(), "freshness-sla-alerts.json");
}

async function loadAssets() {
  const data = await readJsonPath(assetsPath(), { version: STORE_VERSION, assets: {} });
  if (!data.assets || typeof data.assets !== "object") data.assets = {};
  return data;
}

async function saveAssets(data) {
  await writeJsonPath(assetsPath(), { version: STORE_VERSION, assets: data.assets || {} });
}

async function loadAlerts() {
  const data = await readJsonPath(alertsPath(), { version: STORE_VERSION, alerts: [] });
  if (!Array.isArray(data.alerts)) data.alerts = [];
  return data;
}

async function saveAlerts(data) {
  await writeJsonPath(alertsPath(), { version: STORE_VERSION, alerts: data.alerts || [] });
}

/**
 * Register a new tracked asset with a max-age SLA.
 *
 * @param {{ id: string, name?: string, maxAgeMs: number, tags?: string[] }} spec
 * @returns {Promise<object>}
 */
export async function registerAsset(spec) {
  if (!spec || typeof spec !== "object") throw new Error("spec is required");
  if (!spec.id || typeof spec.id !== "string") throw new Error("id is required");
  if (!Number.isFinite(spec.maxAgeMs) || spec.maxAgeMs <= 0) {
    throw new Error("maxAgeMs must be a positive number");
  }
  const path = assetsPath();
  return withPathLock(path, async () => {
    const data = await loadAssets();
    const now = new Date().toISOString();
    const existing = data.assets[spec.id] || { createdAt: now, refreshCount: 0 };
    const record = {
      id: spec.id,
      name: typeof spec.name === "string" ? spec.name : existing.name || spec.id,
      maxAgeMs: Math.floor(spec.maxAgeMs),
      tags: Array.isArray(spec.tags) ? spec.tags.slice() : existing.tags || [],
      lastRefreshAt: existing.lastRefreshAt || null,
      refreshCount: existing.refreshCount || 0,
      createdAt: existing.createdAt || now,
      updatedAt: now,
    };
    data.assets[spec.id] = record;
    await saveAssets(data);
    return record;
  });
}

/**
 * Mark an asset as freshly refreshed.
 *
 * @param {string} assetId
 * @param {{ at?: string }} [opts]
 * @returns {Promise<object>}
 */
export async function recordRefresh(assetId, opts = {}) {
  if (!assetId || typeof assetId !== "string") throw new Error("assetId is required");
  const path = assetsPath();
  return withPathLock(path, async () => {
    const data = await loadAssets();
    const rec = data.assets[assetId];
    if (!rec) throw new Error(`unknown asset: ${assetId}`);
    const at = typeof opts.at === "string" ? opts.at : new Date().toISOString();
    rec.lastRefreshAt = at;
    rec.refreshCount = (rec.refreshCount || 0) + 1;
    rec.updatedAt = at;
    data.assets[assetId] = rec;
    await saveAssets(data);
    return rec;
  });
}

/**
 * Compute the current age (in ms) of an asset, compared to its SLA.
 *
 * @param {string} assetId
 * @param {{ now?: number }} [opts]
 * @returns {Promise<{ id: string, ageMs: number, maxAgeMs: number, stale: boolean, lastRefreshAt: string | null }>}
 */
export async function computeAge(assetId, opts = {}) {
  if (!assetId || typeof assetId !== "string") throw new Error("assetId is required");
  const data = await loadAssets();
  const rec = data.assets[assetId];
  if (!rec) throw new Error(`unknown asset: ${assetId}`);
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const last = rec.lastRefreshAt ? Date.parse(rec.lastRefreshAt) : null;
  const ageMs = last == null ? Number.POSITIVE_INFINITY : now - last;
  const stale = ageMs >= rec.maxAgeMs;
  return {
    id: assetId,
    ageMs: Number.isFinite(ageMs) ? ageMs : -1,
    maxAgeMs: rec.maxAgeMs,
    stale,
    lastRefreshAt: rec.lastRefreshAt || null,
  };
}

/**
 * Return every asset currently over its SLA.
 *
 * @param {{ now?: number }} [opts]
 * @returns {Promise<object[]>}
 */
export async function listStaleAssets(opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const data = await loadAssets();
  /** @type {object[]} */
  const stale = [];
  for (const rec of Object.values(data.assets || {})) {
    const last = rec.lastRefreshAt ? Date.parse(rec.lastRefreshAt) : null;
    const ageMs = last == null ? Number.POSITIVE_INFINITY : now - last;
    if (ageMs >= rec.maxAgeMs) {
      stale.push({
        id: rec.id,
        name: rec.name,
        ageMs: Number.isFinite(ageMs) ? ageMs : -1,
        maxAgeMs: rec.maxAgeMs,
        lastRefreshAt: rec.lastRefreshAt || null,
      });
    }
  }
  stale.sort((a, b) => (b.ageMs || 0) - (a.ageMs || 0));
  return stale;
}

/**
 * Persist an alert for every stale asset, optionally invoking a
 * delivery function. Returns the alerts that were raised this call.
 *
 * @param {(alert: object) => (void | Promise<void>)} [deliver]
 * @returns {Promise<object[]>}
 */
export async function alertOnStale(deliver) {
  const stale = await listStaleAssets();
  if (stale.length === 0) return [];
  const now = new Date().toISOString();
  const alerts = stale.map((s) => ({
    id: `alert_${s.id}_${Date.now()}`,
    assetId: s.id,
    name: s.name,
    ageMs: s.ageMs,
    maxAgeMs: s.maxAgeMs,
    createdAt: now,
    delivered: typeof deliver === "function",
  }));
  await withPathLock(alertsPath(), async () => {
    const data = await loadAlerts();
    for (const a of alerts) data.alerts.push(a);
    if (data.alerts.length > 500) data.alerts = data.alerts.slice(-500);
    await saveAlerts(data);
  });
  if (typeof deliver === "function") {
    for (const a of alerts) {
      try {
        await deliver(a);
      } catch (err) {
        a.delivered = false;
        a.deliveryError = err && err.message ? err.message : String(err);
      }
    }
  }
  return alerts;
}
