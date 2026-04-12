/**
 * Phase 65.3: Budget allocation — cost centers with chargeback tracking.
 *
 * Concepts:
 *   - Cost center: named org unit ("eng-platform", "sales-emea") with a label.
 *   - Allocation: period-bound budget in USD (monthly by default).
 *   - Charge: individual cost event attributed to a cost center.
 *   - Overrun alert: emitted when consumption exceeds threshold (0-1 fraction)
 *     of the active allocation.
 *
 * Storage:
 *   data/budget-allocation/{id}.json   — cost center record
 *   data/budget-allocation/_index.json — registry
 */
import { randomUUID } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const DEFAULT_ALERT_THRESHOLDS = [0.5, 0.8, 1.0];

function sanitize(value) {
  return String(value || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || "default";
}

function costCenterPath(id) {
  return join(getDataDir(), "budget-allocation", `${sanitize(id)}.json`);
}

function indexPath() {
  return join(getDataDir(), "budget-allocation", "_index.json");
}

async function updateIndex(id, remove = false, entry = null) {
  return withPathLock(indexPath(), async () => {
    const idx = await readJsonPath(indexPath(), { costCenters: [] });
    const list = Array.isArray(idx.costCenters) ? idx.costCenters : [];
    const filtered = list.filter((e) => e.id !== id);
    if (!remove && entry) filtered.push(entry);
    await writeJsonPath(indexPath(), { costCenters: filtered });
  });
}

// ─── Cost centers ──────────────────────────────────────────────────────────

/**
 * Create a cost center.
 */
export async function createCostCenter({ name, owner, department, tags, description, alertThresholds } = {}) {
  if (!name || typeof name !== "string") {
    throw new Error("name is required");
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  const record = {
    id,
    name,
    owner: owner || "",
    department: department || "",
    tags: Array.isArray(tags) ? tags.map(String) : [],
    description: description || "",
    alertThresholds: Array.isArray(alertThresholds) && alertThresholds.length > 0
      ? alertThresholds.map(Number).filter((n) => n > 0).sort((a, b) => a - b)
      : DEFAULT_ALERT_THRESHOLDS.slice(),
    createdAt: now,
    updatedAt: now,
    allocations: [],   // { id, periodStart, periodEnd, amountUsd, createdAt }
    charges: [],        // { id, at, amountUsd, subject, description, metadata }
    alerts: [],         // { at, threshold, consumed, allocated, allocationId }
  };
  await writeJsonPath(costCenterPath(id), record);
  await updateIndex(id, false, { id, name, createdAt: now });
  return record;
}

export async function getCostCenter(id) {
  if (!id) return null;
  const data = await readJsonPath(costCenterPath(id), null);
  if (!data || !data.id || data._deleted) return null;
  return data;
}

export async function listCostCenters(filter = {}) {
  const idx = await readJsonPath(indexPath(), { costCenters: [] });
  const entries = Array.isArray(idx.costCenters) ? idx.costCenters : [];
  const records = [];
  for (const entry of entries) {
    const rec = await getCostCenter(entry.id);
    if (!rec) continue;
    if (filter.department && rec.department !== filter.department) continue;
    if (filter.name && rec.name !== filter.name) continue;
    records.push(rec);
  }
  return records;
}

async function mutateCostCenter(id, mutator) {
  return withPathLock(costCenterPath(id), async () => {
    const rec = await readJsonPath(costCenterPath(id), null);
    if (!rec || !rec.id || rec._deleted) {
      const err = new Error(`cost center ${id} not found`);
      err.code = "NOT_FOUND";
      throw err;
    }
    const updated = await mutator(rec);
    if (updated) {
      updated.updatedAt = new Date().toISOString();
      await writeJsonPath(costCenterPath(id), updated);
      return updated;
    }
    return rec;
  });
}

// ─── Allocations ───────────────────────────────────────────────────────────

function parseIsoDate(v, fallback) {
  if (!v) return fallback;
  const t = Date.parse(v);
  if (!Number.isFinite(t)) return fallback;
  return new Date(t).toISOString();
}

function monthBoundariesForDate(isoDate) {
  const d = new Date(isoDate);
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
  return { periodStart: start, periodEnd: end };
}

/**
 * Allocate a budget amount to a cost center for a period (defaults: current month).
 */
export async function allocateBudget(costCenterId, { amountUsd, periodStart, periodEnd, note } = {}) {
  const amt = Number(amountUsd);
  if (!Number.isFinite(amt) || amt <= 0) {
    throw new Error("amountUsd must be a positive number");
  }
  return mutateCostCenter(costCenterId, (rec) => {
    const now = new Date().toISOString();
    const bounds = monthBoundariesForDate(now);
    const alloc = {
      id: randomUUID(),
      amountUsd: amt,
      periodStart: parseIsoDate(periodStart, bounds.periodStart),
      periodEnd: parseIsoDate(periodEnd, bounds.periodEnd),
      note: note || "",
      createdAt: now,
    };
    rec.allocations.push(alloc);
    return rec;
  });
}

export function findActiveAllocation(record, atIso = new Date().toISOString()) {
  const at = Date.parse(atIso);
  if (!Number.isFinite(at)) return null;
  const matches = (record.allocations || []).filter((a) => {
    const s = Date.parse(a.periodStart);
    const e = Date.parse(a.periodEnd);
    return Number.isFinite(s) && Number.isFinite(e) && s <= at && at < e;
  });
  if (matches.length === 0) return null;
  // If multiple, pick highest allocation (take the latest created).
  matches.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return matches[0];
}

function consumptionForAllocation(record, allocation) {
  if (!allocation) return 0;
  const s = Date.parse(allocation.periodStart);
  const e = Date.parse(allocation.periodEnd);
  let total = 0;
  for (const c of record.charges || []) {
    const at = Date.parse(c.at);
    if (!Number.isFinite(at)) continue;
    if (at >= s && at < e) total += Number(c.amountUsd) || 0;
  }
  return total;
}

// ─── Charges ───────────────────────────────────────────────────────────────

/**
 * Record a charge against a cost center. Emits overrun alerts on threshold
 * crossings against the active allocation.
 */
export async function recordCharge(costCenterId, { amountUsd, subject, description, at, metadata } = {}) {
  const amt = Number(amountUsd);
  if (!Number.isFinite(amt) || amt < 0) {
    throw new Error("amountUsd must be a non-negative number");
  }
  return mutateCostCenter(costCenterId, (rec) => {
    const charge = {
      id: randomUUID(),
      at: parseIsoDate(at, new Date().toISOString()),
      amountUsd: amt,
      subject: subject || "",
      description: description || "",
      metadata: metadata && typeof metadata === "object" ? metadata : {},
    };
    const prevAlloc = findActiveAllocation(rec, charge.at);
    const before = consumptionForAllocation(rec, prevAlloc);
    rec.charges.push(charge);
    const after = before + amt;
    if (prevAlloc && amt > 0) {
      const thresholds = rec.alertThresholds || DEFAULT_ALERT_THRESHOLDS;
      const allocated = Number(prevAlloc.amountUsd) || 0;
      const fracBefore = allocated > 0 ? before / allocated : 0;
      const fracAfter = allocated > 0 ? after / allocated : 0;
      for (const t of thresholds) {
        if (fracBefore < t && fracAfter >= t) {
          rec.alerts.push({
            at: charge.at,
            threshold: t,
            consumed: after,
            allocated,
            allocationId: prevAlloc.id,
            chargeId: charge.id,
          });
        }
      }
    }
    return rec;
  });
}

// ─── Reports ───────────────────────────────────────────────────────────────

/**
 * Chargeback report for a cost center across a time window.
 * Returns: { costCenterId, periodStart, periodEnd, allocated, consumed, remaining, utilization, charges[], bySubject{}, alerts[] }
 */
export async function getChargebackReport(costCenterId, { periodStart, periodEnd } = {}) {
  const rec = await getCostCenter(costCenterId);
  if (!rec) {
    const err = new Error(`cost center ${costCenterId} not found`);
    err.code = "NOT_FOUND";
    throw err;
  }
  const now = new Date().toISOString();
  const bounds = monthBoundariesForDate(now);
  const start = parseIsoDate(periodStart, bounds.periodStart);
  const end = parseIsoDate(periodEnd, bounds.periodEnd);
  const s = Date.parse(start);
  const e = Date.parse(end);

  const inWindowCharges = (rec.charges || []).filter((c) => {
    const at = Date.parse(c.at);
    return Number.isFinite(at) && at >= s && at < e;
  });
  const consumed = inWindowCharges.reduce((acc, c) => acc + (Number(c.amountUsd) || 0), 0);

  const bySubject = {};
  for (const c of inWindowCharges) {
    const key = c.subject || "unknown";
    bySubject[key] = (bySubject[key] || 0) + (Number(c.amountUsd) || 0);
  }

  const allocations = (rec.allocations || []).filter((a) => {
    const as = Date.parse(a.periodStart);
    const ae = Date.parse(a.periodEnd);
    return Number.isFinite(as) && Number.isFinite(ae) && as < e && ae > s;
  });
  const allocated = allocations.reduce((acc, a) => acc + (Number(a.amountUsd) || 0), 0);
  const alerts = (rec.alerts || []).filter((al) => {
    const at = Date.parse(al.at);
    return Number.isFinite(at) && at >= s && at < e;
  });

  return {
    costCenterId: rec.id,
    costCenterName: rec.name,
    periodStart: start,
    periodEnd: end,
    allocated,
    consumed,
    remaining: Math.max(allocated - consumed, 0),
    utilization: allocated > 0 ? consumed / allocated : null,
    overrun: allocated > 0 && consumed > allocated,
    chargeCount: inWindowCharges.length,
    bySubject,
    alerts,
  };
}

export const _internals = { costCenterPath, indexPath, monthBoundariesForDate, findActiveAllocation, consumptionForAllocation };
