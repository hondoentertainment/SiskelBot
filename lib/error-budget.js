/**
 * Phase 59.5: Error budget enforcement.
 *
 * SLO-based auto-rollback and alerting. Tracks Service Level Objectives,
 * records success/failure events, computes error-budget consumption and
 * burn rate, and triggers enforcement actions (alert, throttle, freeze
 * deploys, page on-call, rollback) when consumption crosses thresholds.
 *
 * This module is complementary to lib/slo-tracker.js; the tracker is an
 * in-memory time-series SLO tracker, while this module is a persistent,
 * policy-driven error-budget enforcement layer.
 *
 * Storage layout (via json-path-store):
 *   data/error-budgets/slo-{name}.json         — SLO config
 *   data/error-budgets/events-{name}.json      — recorded events
 *   data/error-budgets/policy-{name}.json      — enforcement policy
 *   data/error-budgets/actions-{name}.json     — action history
 *   data/error-budgets/_index.json             — SLO name index
 */

import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

// ─── Constants ──────────────────────────────────────────────────────────────

export const ENFORCEMENT_ACTIONS = [
  "alert",
  "throttle",
  "freeze_deploys",
  "page_oncall",
  "rollback",
];

export const SLI_TYPES = ["availability", "latency", "error_rate"];

const MAX_EVENTS = Number(process.env.ERROR_BUDGET_MAX_EVENTS) || 20_000;
const MAX_ACTIONS = Number(process.env.ERROR_BUDGET_MAX_ACTIONS) || 1000;

// ─── Path helpers ───────────────────────────────────────────────────────────

function sanitize(value) {
  return String(value || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || "default";
}

function sloPath(name) {
  return join(getDataDir(), "error-budgets", `slo-${sanitize(name)}.json`);
}

function eventsPath(name) {
  return join(getDataDir(), "error-budgets", `events-${sanitize(name)}.json`);
}

function policyPath(name) {
  return join(getDataDir(), "error-budgets", `policy-${sanitize(name)}.json`);
}

function actionsPath(name) {
  return join(getDataDir(), "error-budgets", `actions-${sanitize(name)}.json`);
}

function indexPath() {
  return join(getDataDir(), "error-budgets", "_index.json");
}

async function updateIndex(name, remove = false) {
  await withPathLock(indexPath(), async () => {
    const idx = await readJsonPath(indexPath(), { names: [] });
    const list = Array.isArray(idx.names) ? idx.names : [];
    const filtered = list.filter((n) => n !== name);
    if (!remove) filtered.push(name);
    await writeJsonPath(indexPath(), { names: filtered });
  });
}

// ─── SLO validation ─────────────────────────────────────────────────────────

function validateSlo(slo) {
  if (!slo || typeof slo !== "object") {
    throw new Error("slo must be an object");
  }
  if (typeof slo.name !== "string" || !slo.name.trim()) {
    throw new Error("slo.name is required");
  }
  if (!slo.sli || typeof slo.sli !== "object") {
    throw new Error("slo.sli is required");
  }
  if (!SLI_TYPES.includes(slo.sli.type)) {
    throw new Error(`slo.sli.type must be one of: ${SLI_TYPES.join(", ")}`);
  }
  if (!Number.isFinite(Number(slo.sli.threshold))) {
    throw new Error("slo.sli.threshold must be a number");
  }
  if (!Number.isFinite(Number(slo.objective))) {
    throw new Error("slo.objective must be a number between 0 and 1");
  }
  const obj = Number(slo.objective);
  if (obj <= 0 || obj >= 1) {
    throw new Error("slo.objective must be between 0 and 1 (exclusive)");
  }
  if (!Number.isFinite(Number(slo.windowMs)) || Number(slo.windowMs) <= 0) {
    throw new Error("slo.windowMs must be a positive number");
  }
}

// ─── SLO CRUD ───────────────────────────────────────────────────────────────

export async function createSlo(slo) {
  validateSlo(slo);
  const name = slo.name.trim();
  const existing = await readJsonPath(sloPath(name), null);
  if (existing && existing.name && !existing._deleted) {
    const err = new Error(`SLO ${name} already exists`);
    err.code = "ALREADY_EXISTS";
    throw err;
  }
  const record = {
    name,
    description: typeof slo.description === "string" ? slo.description : "",
    sli: {
      type: slo.sli.type,
      threshold: Number(slo.sli.threshold),
    },
    objective: Number(slo.objective),
    windowMs: Number(slo.windowMs),
    severity: typeof slo.severity === "string" ? slo.severity : "medium",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await writeJsonPath(sloPath(name), record);
  await updateIndex(name, false);
  return record;
}

export async function getSlo(name) {
  const data = await readJsonPath(sloPath(name), null);
  if (!data || !data.name || data._deleted) return null;
  return data;
}

export async function listSlos(filter = {}) {
  const idx = await readJsonPath(indexPath(), { names: [] });
  const names = Array.isArray(idx.names) ? idx.names : [];
  const records = [];
  for (const n of names) {
    const rec = await getSlo(n);
    if (!rec) continue;
    if (filter && typeof filter === "object") {
      if (filter.severity && rec.severity !== filter.severity) continue;
      if (filter.sliType && rec.sli?.type !== filter.sliType) continue;
    }
    records.push(rec);
  }
  return records;
}

export async function deleteSlo(name) {
  const existing = await readJsonPath(sloPath(name), null);
  if (!existing || !existing.name || existing._deleted) {
    return { ok: false, code: "NOT_FOUND" };
  }
  await writeJsonPath(sloPath(name), { _deleted: true });
  await updateIndex(name, true);
  return { ok: true };
}

export async function updateSlo(name, updates) {
  if (!updates || typeof updates !== "object") {
    throw new Error("updates must be an object");
  }
  return withPathLock(sloPath(name), async () => {
    const existing = await readJsonPath(sloPath(name), null);
    if (!existing || !existing.name || existing._deleted) {
      const err = new Error(`SLO ${name} not found`);
      err.code = "NOT_FOUND";
      throw err;
    }
    const merged = {
      ...existing,
      ...updates,
      // Preserve identity fields.
      name: existing.name,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    };
    if (updates.sli) {
      merged.sli = { ...existing.sli, ...updates.sli };
    }
    // Re-validate after merge.
    validateSlo(merged);
    await writeJsonPath(sloPath(name), merged);
    return merged;
  });
}

// ─── Events ─────────────────────────────────────────────────────────────────

export async function recordEvent(sloName, event) {
  if (!event || typeof event !== "object") {
    throw new Error("event must be an object");
  }
  if (typeof event.success !== "boolean") {
    throw new Error("event.success must be a boolean");
  }
  const slo = await getSlo(sloName);
  if (!slo) {
    const err = new Error(`SLO ${sloName} not found`);
    err.code = "NOT_FOUND";
    throw err;
  }
  return withPathLock(eventsPath(sloName), async () => {
    const data = await readJsonPath(eventsPath(sloName), { events: [] });
    const list = Array.isArray(data.events) ? data.events : [];
    const record = {
      success: Boolean(event.success),
      timestamp: Number.isFinite(event.timestamp) ? Number(event.timestamp) : Date.now(),
    };
    if (Number.isFinite(event.latencyMs)) record.latencyMs = Number(event.latencyMs);
    if (typeof event.errorCode === "string") record.errorCode = event.errorCode;
    list.push(record);
    if (list.length > MAX_EVENTS) {
      list.splice(0, list.length - MAX_EVENTS);
    }
    await writeJsonPath(eventsPath(sloName), { events: list });
    return record;
  });
}

async function loadEvents(sloName) {
  const data = await readJsonPath(eventsPath(sloName), { events: [] });
  return Array.isArray(data.events) ? data.events : [];
}

// ─── Windowing helpers ──────────────────────────────────────────────────────

/**
 * Filter events to those within the rolling window ending at endTime.
 */
export function rollingWindow(events, windowMs, endTime = Date.now()) {
  if (!Array.isArray(events)) return [];
  if (!Number.isFinite(windowMs) || windowMs <= 0) return events.slice();
  const cutoff = Number(endTime) - Number(windowMs);
  return events.filter((e) => Number(e.timestamp) >= cutoff && Number(e.timestamp) <= Number(endTime));
}

/**
 * Burn rate multiplier: how fast the budget is being consumed in the window,
 * relative to the base/expected rate. A multiplier of 1 means the budget
 * will be exhausted exactly at the end of the window; >1 means earlier.
 */
export function computeBurnRateMultiplier(eventsInWindow, baseRate) {
  if (!Array.isArray(eventsInWindow) || eventsInWindow.length === 0) return 0;
  const base = Number(baseRate);
  if (!Number.isFinite(base) || base <= 0) return 0;
  const failures = eventsInWindow.reduce((n, e) => (e && e.success === false ? n + 1 : n), 0);
  const actualRate = failures / eventsInWindow.length;
  return actualRate / base;
}

// ─── SLI evaluation ─────────────────────────────────────────────────────────

/**
 * Classify an event as "good" (counts toward success) or "bad" (counts
 * against the error budget) according to the SLI definition.
 */
function classifyEvent(slo, event) {
  const type = slo?.sli?.type;
  const threshold = Number(slo?.sli?.threshold);
  if (type === "availability") {
    // Good when success is true.
    return event.success === true;
  }
  if (type === "error_rate") {
    // Same as availability: treat success===false as a failure.
    return event.success === true;
  }
  if (type === "latency") {
    // Good when success and latency under threshold.
    if (event.success === false) return false;
    if (!Number.isFinite(event.latencyMs)) return true;
    return Number(event.latencyMs) <= threshold;
  }
  return event.success === true;
}

// ─── Budget computation ────────────────────────────────────────────────────

/**
 * Compute the error budget for a named SLO. The budget is:
 *   total    = (1 - objective) * sampleSize  (or 1 when no samples)
 *   consumed = count of bad events in window
 *   remaining = max(0, total - consumed)
 *   burnRate  = consumed / total  (unitless multiplier)
 *   exhaustedAt = ISO timestamp projection when remaining hits 0
 */
export async function getErrorBudget(sloName) {
  const slo = await getSlo(sloName);
  if (!slo) {
    const err = new Error(`SLO ${sloName} not found`);
    err.code = "NOT_FOUND";
    throw err;
  }
  const events = await loadEvents(sloName);
  const now = Date.now();
  const windowed = rollingWindow(events, slo.windowMs, now);
  const sampleSize = windowed.length;
  const badCount = windowed.reduce((n, e) => (classifyEvent(slo, e) ? n : n + 1), 0);
  const allowedFailureRate = Math.max(0, 1 - Number(slo.objective));
  const total = sampleSize > 0 ? allowedFailureRate * sampleSize : Math.max(1, allowedFailureRate * 100);
  const consumed = badCount;
  const remaining = Math.max(0, total - consumed);
  const burnRate = total > 0 ? consumed / total : 0;

  let exhaustedAt = null;
  if (remaining > 0 && sampleSize > 0 && badCount > 0) {
    // Extrapolate: bad events per ms in the current window.
    const badRatePerMs = badCount / Math.max(1, slo.windowMs);
    if (badRatePerMs > 0) {
      const msUntilExhaustion = remaining / badRatePerMs;
      exhaustedAt = new Date(now + msUntilExhaustion).toISOString();
    }
  } else if (remaining <= 0) {
    exhaustedAt = new Date(now).toISOString();
  }

  return {
    name: slo.name,
    total: Number(total.toFixed(6)),
    consumed: Number(consumed.toFixed(6)),
    remaining: Number(remaining.toFixed(6)),
    consumedFraction: Number((total > 0 ? Math.min(1, consumed / total) : 0).toFixed(6)),
    remainingFraction: Number((total > 0 ? Math.max(0, 1 - consumed / total) : 1).toFixed(6)),
    burnRate: Number(burnRate.toFixed(6)),
    sampleSize,
    windowMs: slo.windowMs,
    exhaustedAt,
  };
}

/**
 * Burn rate within a sub-window of the SLO's overall window. Useful for
 * multi-burn-rate alerting (e.g. fast burn over 1h, slow burn over 6h).
 */
export async function getBurnRate(sloName, windowMs) {
  const slo = await getSlo(sloName);
  if (!slo) {
    const err = new Error(`SLO ${sloName} not found`);
    err.code = "NOT_FOUND";
    throw err;
  }
  const effective = Number.isFinite(windowMs) && windowMs > 0 ? Number(windowMs) : slo.windowMs;
  const events = await loadEvents(sloName);
  const windowed = rollingWindow(events, effective, Date.now());
  const base = Math.max(0, 1 - Number(slo.objective));
  const multiplier = computeBurnRateMultiplier(windowed, base);
  const badCount = windowed.reduce((n, e) => (classifyEvent(slo, e) ? n : n + 1), 0);
  return {
    name: slo.name,
    windowMs: effective,
    sampleSize: windowed.length,
    badCount,
    baseRate: Number(base.toFixed(6)),
    burnRate: Number(multiplier.toFixed(6)),
  };
}

/**
 * Multi-window burn-rate snapshot. Returns burn rate for several standard
 * sub-windows (5m, 1h, 6h, full) so callers can quickly see both fast and
 * slow burns.
 */
export async function getBurnRateHistory(sloName) {
  const slo = await getSlo(sloName);
  if (!slo) {
    const err = new Error(`SLO ${sloName} not found`);
    err.code = "NOT_FOUND";
    throw err;
  }
  const windows = [
    { label: "5m", ms: 5 * 60 * 1000 },
    { label: "1h", ms: 60 * 60 * 1000 },
    { label: "6h", ms: 6 * 60 * 60 * 1000 },
    { label: "full", ms: slo.windowMs },
  ];
  const out = [];
  for (const w of windows) {
    const br = await getBurnRate(sloName, Math.min(w.ms, slo.windowMs));
    out.push({ window: w.label, ...br });
  }
  return { name: slo.name, windows: out };
}

// ─── Enforcement policy ────────────────────────────────────────────────────

function validatePolicy(policy) {
  if (!policy || typeof policy !== "object") {
    throw new Error("policy must be an object");
  }
  if (!Array.isArray(policy.thresholds)) {
    throw new Error("policy.thresholds must be an array");
  }
  for (const t of policy.thresholds) {
    if (!t || typeof t !== "object") {
      throw new Error("threshold entries must be objects");
    }
    if (!Number.isFinite(Number(t.consumed))) {
      throw new Error("threshold.consumed must be a number");
    }
    const c = Number(t.consumed);
    if (c < 0 || c > 1) {
      throw new Error("threshold.consumed must be between 0 and 1");
    }
    if (!ENFORCEMENT_ACTIONS.includes(t.action)) {
      throw new Error(`threshold.action must be one of: ${ENFORCEMENT_ACTIONS.join(", ")}`);
    }
  }
}

export async function setEnforcementPolicy(sloName, policy) {
  validatePolicy(policy);
  const slo = await getSlo(sloName);
  if (!slo) {
    const err = new Error(`SLO ${sloName} not found`);
    err.code = "NOT_FOUND";
    throw err;
  }
  const normalized = {
    thresholds: policy.thresholds
      .map((t) => ({ consumed: Number(t.consumed), action: String(t.action) }))
      .sort((a, b) => a.consumed - b.consumed),
    updatedAt: new Date().toISOString(),
  };
  await writeJsonPath(policyPath(sloName), normalized);
  return normalized;
}

export async function getEnforcementPolicy(sloName) {
  const data = await readJsonPath(policyPath(sloName), null);
  if (!data || !Array.isArray(data.thresholds)) return null;
  return data;
}

export async function checkEnforcement(sloName) {
  const policy = await getEnforcementPolicy(sloName);
  if (!policy) return [];
  const budget = await getErrorBudget(sloName);
  const frac = budget.consumedFraction;
  const out = [];
  for (const t of policy.thresholds) {
    out.push({
      threshold: t.consumed,
      action: t.action,
      triggered: frac >= t.consumed,
    });
  }
  return out;
}

// ─── Action history ────────────────────────────────────────────────────────

export async function recordBudgetAction(sloName, action, context = {}) {
  if (!ENFORCEMENT_ACTIONS.includes(action)) {
    throw new Error(`action must be one of: ${ENFORCEMENT_ACTIONS.join(", ")}`);
  }
  const slo = await getSlo(sloName);
  if (!slo) {
    const err = new Error(`SLO ${sloName} not found`);
    err.code = "NOT_FOUND";
    throw err;
  }
  return withPathLock(actionsPath(sloName), async () => {
    const data = await readJsonPath(actionsPath(sloName), { actions: [] });
    const list = Array.isArray(data.actions) ? data.actions : [];
    const entry = {
      action,
      at: new Date().toISOString(),
      context: context && typeof context === "object" ? context : {},
    };
    list.push(entry);
    if (list.length > MAX_ACTIONS) {
      list.splice(0, list.length - MAX_ACTIONS);
    }
    await writeJsonPath(actionsPath(sloName), { actions: list });
    return entry;
  });
}

export async function getActionHistory(sloName) {
  const data = await readJsonPath(actionsPath(sloName), { actions: [] });
  return Array.isArray(data.actions) ? data.actions.slice() : [];
}

// ─── Reporting ─────────────────────────────────────────────────────────────

/**
 * Build an aggregate report across a list of SLO records. Pure function —
 * does not read storage. Pass in records (e.g., from listSlos) plus their
 * precomputed budgets if available; otherwise it produces a best-effort
 * summary of the SLO definitions.
 */
export function generateBudgetReport(slos) {
  const list = Array.isArray(slos) ? slos : [];
  const bySeverity = {};
  const byType = {};
  const items = [];
  for (const slo of list) {
    if (!slo || !slo.name) continue;
    const sev = slo.severity || "medium";
    bySeverity[sev] = (bySeverity[sev] || 0) + 1;
    const t = slo?.sli?.type || "unknown";
    byType[t] = (byType[t] || 0) + 1;
    items.push({
      name: slo.name,
      severity: sev,
      sliType: t,
      objective: Number(slo.objective) || null,
      windowMs: Number(slo.windowMs) || null,
    });
  }
  return {
    total: items.length,
    bySeverity,
    byType,
    items,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Project when an SLO will exhaust its budget given a current burn rate.
 * Pure function. Returns { etaMs, etaAt, willExhaust }.
 */
export function projectExhaustion(slo, currentBurnRate) {
  if (!slo || typeof slo !== "object") {
    return { etaMs: null, etaAt: null, willExhaust: false };
  }
  const br = Number(currentBurnRate);
  if (!Number.isFinite(br) || br <= 0) {
    return { etaMs: null, etaAt: null, willExhaust: false };
  }
  const windowMs = Number(slo.windowMs);
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    return { etaMs: null, etaAt: null, willExhaust: false };
  }
  // burnRate = fraction of budget per window (normalised). If br>=1 the
  // budget will be exhausted before the window ends.
  const etaMs = windowMs / br;
  const willExhaust = br >= 1 ? true : etaMs <= windowMs;
  const etaAt = new Date(Date.now() + etaMs).toISOString();
  return {
    etaMs: Math.round(etaMs),
    etaAt,
    willExhaust,
  };
}
