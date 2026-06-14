/**
 * Phase 68.5: Freshness SLAs — knowledge-age tracking with overdue alerts.
 *
 * A freshness SLA binds a corpus key to a target update cadence and generates
 * alerts when the corpus hasn't been updated within the window.
 *
 * Usage:
 *   defineFreshnessSla(key, { targetMs, name, description })
 *   recordUpdate(key, { at?, actor?, metadata? })     — moves the clock
 *   getFreshness(key)                                  — returns status + ageMs
 *   listAlerts({ severity, corpusKey })                — enumerate alerts
 *
 * Alerts fire when ageMs > targetMs. Callers can call `evaluateAlerts()` to
 * materialize alerts for overdue corpora; subsequent calls deduplicate based
 * on ISO day so the noise stays bounded.
 *
 * Storage:
 *   data/freshness-sla/{key}.json   — SLA record
 *   data/freshness-sla/_index.json  — registry
 */
import { join } from "path";
import { randomUUID } from "crypto";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

function sanitize(value) {
  return String(value || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || "default";
}

function slaPath(key) {
  return join(getDataDir(), "freshness-sla", `${sanitize(key)}.json`);
}

function indexPath() {
  return join(getDataDir(), "freshness-sla", "_index.json");
}

async function updateIndex(corpusKey, remove = false, entry = null) {
  return withPathLock(indexPath(), async () => {
    const idx = await readJsonPath(indexPath(), { slas: [] });
    const list = Array.isArray(idx.slas) ? idx.slas : [];
    const filtered = list.filter((e) => e.corpusKey !== corpusKey);
    if (!remove && entry) filtered.push(entry);
    await writeJsonPath(indexPath(), { slas: filtered });
  });
}

// ─── CRUD ───────────────────────────────────────────────────────────────────

/**
 * Register or update the freshness SLA for a corpus.
 */
export async function defineFreshnessSla(corpusKey, { targetMs, name, description, severity, tags } = {}) {
  if (!corpusKey || typeof corpusKey !== "string") {
    throw new Error("corpusKey is required");
  }
  const tgt = Number(targetMs);
  if (!Number.isFinite(tgt) || tgt <= 0) {
    throw new Error("targetMs must be a positive number");
  }
  return withPathLock(slaPath(corpusKey), async () => {
    const existing = await readJsonPath(slaPath(corpusKey), null);
    const now = new Date().toISOString();
    const rec = existing && existing.corpusKey && !existing._deleted ? existing : {
      corpusKey,
      createdAt: now,
      updatedAt: now,
      updates: [],
      alerts: [],
    };
    rec.updatedAt = now;
    rec.name = name || rec.name || corpusKey;
    rec.description = description != null ? String(description) : (rec.description || "");
    rec.targetMs = tgt;
    rec.severity = severity && typeof severity === "string" ? severity : (rec.severity || "warn");
    rec.tags = Array.isArray(tags) ? tags.map(String) : (rec.tags || []);
    await writeJsonPath(slaPath(corpusKey), rec);
    await updateIndex(corpusKey, false, {
      corpusKey,
      name: rec.name,
      targetMs: rec.targetMs,
      updatedAt: now,
    });
    return rec;
  });
}

async function loadRecord(corpusKey) {
  const rec = await readJsonPath(slaPath(corpusKey), null);
  if (!rec || !rec.corpusKey || rec._deleted) return null;
  return rec;
}

/**
 * Record an update event for a corpus (resets the clock).
 */
export async function recordUpdate(corpusKey, { at, actor, metadata } = {}) {
  const rec = await loadRecord(corpusKey);
  if (!rec) {
    const err = new Error(`corpusKey ${corpusKey} not defined`);
    err.code = "NOT_FOUND";
    throw err;
  }
  return withPathLock(slaPath(corpusKey), async () => {
    const fresh = await readJsonPath(slaPath(corpusKey), null);
    const ev = {
      id: randomUUID(),
      at: at || new Date().toISOString(),
      actor: actor || "system",
      metadata: metadata && typeof metadata === "object" ? metadata : {},
    };
    fresh.updates.push(ev);
    if (fresh.updates.length > 500) fresh.updates = fresh.updates.slice(-500);
    fresh.lastUpdateAt = ev.at;
    fresh.updatedAt = new Date().toISOString();
    await writeJsonPath(slaPath(corpusKey), fresh);
    return fresh;
  });
}

function computeFreshness(rec, nowMs = Date.now()) {
  const last = rec.lastUpdateAt ? Date.parse(rec.lastUpdateAt) : null;
  const ageMs = last != null ? nowMs - last : null;
  const overdue = last != null && ageMs > (rec.targetMs || 0);
  const neverUpdated = last == null;
  return {
    corpusKey: rec.corpusKey,
    name: rec.name,
    targetMs: rec.targetMs,
    lastUpdateAt: rec.lastUpdateAt || null,
    ageMs,
    overdue,
    neverUpdated,
    status: neverUpdated ? "never" : (overdue ? "overdue" : "fresh"),
    severity: rec.severity,
  };
}

export async function getFreshness(corpusKey) {
  const rec = await loadRecord(corpusKey);
  if (!rec) {
    const err = new Error(`corpusKey ${corpusKey} not defined`);
    err.code = "NOT_FOUND";
    throw err;
  }
  return computeFreshness(rec);
}

/**
 * Evaluate all SLAs and emit alerts for overdue ones. Deduplicates by ISO day
 * so repeated evaluations within the same day don't spam the alerts list.
 */
export async function evaluateAlerts(nowMs = Date.now()) {
  const idx = await readJsonPath(indexPath(), { slas: [] });
  const entries = Array.isArray(idx.slas) ? idx.slas : [];
  const alerts = [];
  const today = new Date(nowMs).toISOString().slice(0, 10);
  for (const entry of entries) {
    const rec = await loadRecord(entry.corpusKey);
    if (!rec) continue;
    const fresh = computeFreshness(rec, nowMs);
    if (fresh.overdue || fresh.neverUpdated) {
      await withPathLock(slaPath(entry.corpusKey), async () => {
        const cur = await readJsonPath(slaPath(entry.corpusKey), null);
        if (!cur || !cur.corpusKey || cur._deleted) return;
        const dedupe = (cur.alerts || []).some((a) => a.dayKey === today);
        if (!dedupe) {
          const alert = {
            id: randomUUID(),
            at: new Date(nowMs).toISOString(),
            dayKey: today,
            corpusKey: cur.corpusKey,
            name: cur.name,
            status: fresh.status,
            ageMs: fresh.ageMs,
            targetMs: cur.targetMs,
            severity: cur.severity,
          };
          cur.alerts = [...(cur.alerts || []), alert];
          if (cur.alerts.length > 200) cur.alerts = cur.alerts.slice(-200);
          await writeJsonPath(slaPath(entry.corpusKey), cur);
          alerts.push(alert);
        }
      });
    }
  }
  return alerts;
}

/**
 * List all alerts from all corpora, optionally filtered.
 */
export async function listAlerts(filter = {}) {
  const idx = await readJsonPath(indexPath(), { slas: [] });
  const entries = Array.isArray(idx.slas) ? idx.slas : [];
  const out = [];
  for (const entry of entries) {
    const rec = await loadRecord(entry.corpusKey);
    if (!rec) continue;
    for (const alert of rec.alerts || []) {
      if (filter.severity && alert.severity !== filter.severity) continue;
      if (filter.corpusKey && alert.corpusKey !== filter.corpusKey) continue;
      if (filter.status && alert.status !== filter.status) continue;
      out.push(alert);
    }
  }
  out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return out;
}

/**
 * List all SLAs with computed freshness.
 */
export async function listFreshness() {
  const idx = await readJsonPath(indexPath(), { slas: [] });
  const entries = Array.isArray(idx.slas) ? idx.slas : [];
  const out = [];
  for (const entry of entries) {
    const rec = await loadRecord(entry.corpusKey);
    if (!rec) continue;
    out.push(computeFreshness(rec));
  }
  return out;
}

export const _internals = { slaPath, indexPath, computeFreshness };
