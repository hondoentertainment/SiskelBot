/**
 * Wave 18C: Monthly usage aggregation, CSV export, and threshold alerting.
 * Data source: lib/usage-tracker.js records + lib/tenant-quotas.js live counters.
 */
import { getRecordsForPeriod } from "./usage-tracker.js";
import { getUsageSnapshot, getEffectiveQuotas } from "./tenant-quotas.js";
import { createLogger } from "./logger.js";

const log = createLogger("usage-reports");

const COST_PER_1K_TOKENS = 0.002;
const ALERT_THRESHOLD = 0.8;

function utcDateString(date) {
  return date.toISOString().slice(0, 10);
}

function parseDateParam(val, fallback) {
  if (!val) return fallback;
  const d = new Date(val + "T00:00:00.000Z");
  return Number.isNaN(d.getTime()) ? fallback : d;
}

function currentMonthRange() {
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59, 999));
  return { from, to };
}

function filterRecordsByRange(records, workspaceId, from, to) {
  const fromMs = from.getTime();
  const toMs = to.getTime();
  return records.filter((r) => {
    if (workspaceId && workspaceId !== "default") {
      if (!r.workspace || r.workspace !== workspaceId) return false;
    }
    const ts = new Date(r.timestamp).getTime();
    return ts >= fromMs && ts <= toMs;
  });
}

function buildTopModels(records) {
  const byModel = new Map();
  for (const r of records) {
    const m = r.model || "unknown";
    const entry = byModel.get(m) || { model: m, requests: 0, tokens: 0 };
    entry.requests += 1;
    entry.tokens += (r.inputTokens || 0) + (r.outputTokens || 0);
    byModel.set(m, entry);
  }
  return [...byModel.values()]
    .sort((a, b) => b.requests - a.requests)
    .slice(0, 3);
}

/**
 * Aggregate usage for a workspace over a date range.
 * @param {string} workspaceId
 * @param {{ from?: Date|string, to?: Date|string }} opts
 */
export async function getUsageSummary(workspaceId, { from, to } = {}) {
  const ws = String(workspaceId || "default");
  const range = currentMonthRange();
  const fromDate = from instanceof Date ? from : parseDateParam(from, range.from);
  const toDate = to instanceof Date ? to : parseDateParam(to, range.to);

  const daysDelta = Math.ceil((toDate.getTime() - fromDate.getTime()) / (24 * 60 * 60 * 1000)) + 1;
  const allRecords = await getRecordsForPeriod(Math.max(daysDelta, 1), { workspace: ws !== "default" ? ws : undefined });
  const records = filterRecordsByRange(allRecords, ws, fromDate, toDate);

  let inputTokens = 0;
  let outputTokens = 0;
  for (const r of records) {
    inputTokens += r.inputTokens || 0;
    outputTokens += r.outputTokens || 0;
  }
  const totalTokens = inputTokens + outputTokens;
  const estimatedCostUsd = (totalTokens / 1000) * COST_PER_1K_TOKENS;

  const snapshot = getUsageSnapshot(ws);

  return {
    workspaceId: ws,
    period: { from: utcDateString(fromDate), to: utcDateString(toDate) },
    requests: records.length,
    inputTokens,
    outputTokens,
    estimatedCostUsd: Math.round(estimatedCostUsd * 1e6) / 1e6,
    storageBytes: snapshot.storageBytes,
    topModels: buildTopModels(records),
  };
}

/**
 * Generate CSV of daily usage for a workspace.
 * @param {string} workspaceId
 * @param {{ from?: Date|string, to?: Date|string }} opts
 * @returns {Promise<string>} CSV string
 */
export async function generateUsageCsv(workspaceId, { from, to } = {}) {
  const ws = String(workspaceId || "default");
  const range = currentMonthRange();
  const fromDate = from instanceof Date ? from : parseDateParam(from, range.from);
  const toDate = to instanceof Date ? to : parseDateParam(to, range.to);

  const daysDelta = Math.ceil((toDate.getTime() - fromDate.getTime()) / (24 * 60 * 60 * 1000)) + 1;
  const allRecords = await getRecordsForPeriod(Math.max(daysDelta, 1), { workspace: ws !== "default" ? ws : undefined });
  const records = filterRecordsByRange(allRecords, ws, fromDate, toDate);

  const byDay = new Map();
  for (const r of records) {
    const day = r.timestamp ? r.timestamp.slice(0, 10) : utcDateString(fromDate);
    const entry = byDay.get(day) || { requests: 0, inputTokens: 0, outputTokens: 0 };
    entry.requests += 1;
    entry.inputTokens += r.inputTokens || 0;
    entry.outputTokens += r.outputTokens || 0;
    byDay.set(day, entry);
  }

  const rows = ["date,requests,input_tokens,output_tokens,estimated_cost_usd"];

  const cursor = new Date(fromDate);
  while (cursor <= toDate) {
    const day = utcDateString(cursor);
    const entry = byDay.get(day) || { requests: 0, inputTokens: 0, outputTokens: 0 };
    const totalTokens = entry.inputTokens + entry.outputTokens;
    const cost = Math.round((totalTokens / 1000) * COST_PER_1K_TOKENS * 1e6) / 1e6;
    rows.push(`${day},${entry.requests},${entry.inputTokens},${entry.outputTokens},${cost}`);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return rows.join("\n") + "\n";
}

/**
 * Check if workspace is approaching quota limits and emit alerts if needed.
 * @param {string} workspaceId
 * @param {object} [storage] - optional storage for quota lookup
 * @returns {Promise<{ alerts: Array<{ type, threshold, current, limit }> }>}
 */
export async function checkUsageThresholds(workspaceId, storage) {
  const ws = String(workspaceId || "default");
  const limits = await getEffectiveQuotas(ws, storage);
  const snapshot = getUsageSnapshot(ws);
  const alerts = [];

  const dailyBudget = limits.requestsPerMinute * 60 * 24;
  if (snapshot.requestsThisMinute > ALERT_THRESHOLD * limits.requestsPerMinute) {
    alerts.push({
      type: "requests_per_minute",
      threshold: ALERT_THRESHOLD,
      current: snapshot.requestsThisMinute,
      limit: limits.requestsPerMinute,
    });
  }

  if (limits.tokensPerDay > 0 && snapshot.tokensToday > ALERT_THRESHOLD * limits.tokensPerDay) {
    alerts.push({
      type: "tokens_per_day",
      threshold: ALERT_THRESHOLD,
      current: snapshot.tokensToday,
      limit: limits.tokensPerDay,
    });
  }

  if (alerts.length > 0 && storage && typeof storage.add === "function") {
    const key = `alerts:${ws}:${Date.now()}`;
    try {
      await storage.add("usage_alerts", { id: key, workspaceId: ws, alerts, createdAt: new Date().toISOString() }, ws, true, ws);
    } catch (e) {
      log.warn("Failed to persist usage alert", { workspaceId: ws, error: e.message });
    }
    for (const alert of alerts) {
      log.warn("Usage threshold alert", { workspaceId: ws, ...alert });
    }
  }

  return { alerts };
}

/**
 * List recent threshold alerts for a workspace.
 * @param {string} workspaceId
 * @param {object} storage
 * @returns {Promise<Array>}
 */
export async function listUsageAlerts(workspaceId, storage) {
  const ws = String(workspaceId || "default");
  if (!storage || typeof storage.list !== "function") return [];
  try {
    const items = await storage.list("usage_alerts", ws, ws);
    return Array.isArray(items) ? items.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "")).slice(0, 50) : [];
  } catch {
    return [];
  }
}
