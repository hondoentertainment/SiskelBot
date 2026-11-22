/**
 * Usage and estimated spend grouped by user, model, and key source.
 * USER_BUDGET_USD is a per-user cap. USER_BUDGET_ACTION is warn (default) or block.
 */
import { getRecordsForPeriod } from "./usage-tracker.js";
import { estimateUsd } from "./cost-budget.js";

function bucket() {
  return { tokens: 0, usd: 0, requests: 0 };
}

function add(map, key, tokens, usd) {
  const row = map[key] || bucket();
  row.tokens += tokens;
  row.usd = Math.round((row.usd + usd) * 10000) / 10000;
  row.requests += 1;
  map[key] = row;
}

export function summarizeUsage(records) {
  const byUser = {};
  const byModel = {};
  const byKey = {};
  let tokens = 0;
  let usd = 0;
  for (const record of records || []) {
    const count = (Number(record.inputTokens) || 0) + (Number(record.outputTokens) || 0);
    const cost = estimateUsd(record.model, count);
    tokens += count;
    usd += cost;
    add(byUser, record.userId || "anonymous", count, cost);
    add(byModel, record.model || "unknown", count, cost);
    add(byKey, record.byok ? `byok:${record.byok}` : "server", count, cost);
  }
  return {
    tokens,
    usd: Math.round(usd * 10000) / 10000,
    byUser,
    byModel,
    byKey,
  };
}

export function budgetVerdict(spentUsd, limitUsd, action) {
  const limit = Number(limitUsd) || 0;
  const spent = Number(spentUsd) || 0;
  if (limit <= 0) return { state: "open", spentUsd: spent, limitUsd: 0 };
  const mode = action === "block" ? "block" : "warn";
  if (spent >= limit) return { state: mode === "block" ? "block" : "warn", spentUsd: spent, limitUsd: limit };
  if (spent >= limit * 0.8) return { state: "warn", spentUsd: spent, limitUsd: limit };
  return { state: "ok", spentUsd: spent, limitUsd: limit };
}

export async function userSpend(userId, days = 30) {
  const records = await getRecordsForPeriod(days);
  const mine = records.filter((record) => (record.userId || "anonymous") === (userId || "anonymous"));
  return summarizeUsage(mine).usd;
}

export async function userBudgetStatus(userId) {
  const spent = await userSpend(userId);
  return budgetVerdict(spent, process.env.USER_BUDGET_USD, process.env.USER_BUDGET_ACTION);
}

export async function usageDashboard(days = 30) {
  const records = await getRecordsForPeriod(days);
  return {
    days,
    ...summarizeUsage(records),
    budget: budgetVerdict(0, process.env.USER_BUDGET_USD, process.env.USER_BUDGET_ACTION),
  };
}
