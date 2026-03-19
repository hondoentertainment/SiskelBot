/**
 * Phase 18: Conversation Analytics & Insights.
 * Dashboard aggregation, cost estimation, and export for SiskelBot.
 */
import { getSummary, getRecordsForPeriod } from "./usage-tracker.js";
import * as storage from "./storage.js";

const COST_INPUT = Number(process.env.ANALYTICS_COST_PER_1K_INPUT) || 0.002; // $/1K tokens (OpenAI gpt-4o-mini approx)
const COST_OUTPUT = Number(process.env.ANALYTICS_COST_PER_1K_OUTPUT) || 0.006;

/**
 * Estimate cost from token counts. OpenAI uses env rates; ollama/vllm = local ($0).
 * @param {number} inputTokens
 * @param {number} outputTokens
 * @param {string} backend - ollama | vllm | openai
 * @returns {{ cost: number, source: string }}
 */
export function estimateCost(inputTokens, outputTokens, backend = "unknown") {
  const src = String(backend || "unknown").toLowerCase();
  if (src === "ollama" || src === "vllm") {
    return { cost: 0, source: "local" };
  }
  const cost = (inputTokens / 1000) * COST_INPUT + (outputTokens / 1000) * COST_OUTPUT;
  return { cost: Math.round(cost * 10000) / 10000, source: "openai" };
}

/**
 * Get analytics dashboard data.
 * @param {number} days - number of days (default 7)
 * @param {{ workspace?: string, userId?: string }} opts
 * @returns {Promise<Object>}
 */
export async function getDashboard(days = 7, opts = {}) {
  const records = getRecordsForPeriod(days, opts);
  const summary = getSummary(days);
  // When workspace filter is applied, recompute from records
  let byModel = summary.byModel;
  let byDay = summary.byDay;
  let byWorkspace = {};
  let totalRequests = records.length;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  if (opts.workspace || opts.userId) {
    byModel = {};
    byDay = {};
    for (const r of records) {
      totalInputTokens += r.inputTokens || 0;
      totalOutputTokens += r.outputTokens || 0;
      const m = r.model || "unknown";
      if (!byModel[m]) byModel[m] = { requests: 0, inputTokens: 0, outputTokens: 0 };
      byModel[m].requests += 1;
      byModel[m].inputTokens += r.inputTokens || 0;
      byModel[m].outputTokens += r.outputTokens || 0;
      const dayKey = r.timestamp ? r.timestamp.slice(0, 10) : "unknown";
      if (!byDay[dayKey]) byDay[dayKey] = { requests: 0, inputTokens: 0, outputTokens: 0 };
      byDay[dayKey].requests += 1;
      byDay[dayKey].inputTokens += r.inputTokens || 0;
      byDay[dayKey].outputTokens += r.outputTokens || 0;
      if (r.workspace) {
        if (!byWorkspace[r.workspace]) byWorkspace[r.workspace] = { requests: 0, inputTokens: 0, outputTokens: 0 };
        byWorkspace[r.workspace].requests += 1;
        byWorkspace[r.workspace].inputTokens += r.inputTokens || 0;
        byWorkspace[r.workspace].outputTokens += r.outputTokens || 0;
      }
    }
  } else {
    totalInputTokens = summary.totalInputTokens;
    totalOutputTokens = summary.totalOutputTokens;
    for (const r of records) {
      if (r.workspace) {
        if (!byWorkspace[r.workspace]) byWorkspace[r.workspace] = { requests: 0, inputTokens: 0, outputTokens: 0 };
        byWorkspace[r.workspace].requests += 1;
        byWorkspace[r.workspace].inputTokens += r.inputTokens || 0;
        byWorkspace[r.workspace].outputTokens += r.outputTokens || 0;
      }
    }
  }

  const totalCostByBackend = {};
  let totalCost = 0;
  for (const r of records) {
    const be = r.backend || "unknown";
    if (!totalCostByBackend[be]) totalCostByBackend[be] = 0;
    const { cost } = estimateCost(r.inputTokens || 0, r.outputTokens || 0, be);
    totalCostByBackend[be] += cost;
    totalCost += cost;
  }

  const byModelWithCost = {};
  for (const [m, v] of Object.entries(byModel)) {
    const backend = records.find((r) => r.model === m)?.backend || "unknown";
    const { cost, source } = estimateCost(v.inputTokens, v.outputTokens, backend);
    byModelWithCost[m] = { ...v, cost, source };
  }

  // Conversation stats from storage
  const convStats = await getConversationStats(days, opts);

  const topModels = Object.entries(byModel)
    .map(([model, v]) => ({ model, requests: v.requests, tokens: (v.inputTokens || 0) + (v.outputTokens || 0) }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 5);

  const modelComparison =
    Object.keys(byModel).length > 1
      ? topModels.map((m) => ({
          model: m.model,
          requests: m.requests,
          tokens: m.tokens,
          cost: byModelWithCost[m.model]?.cost ?? 0,
        }))
      : null;

  return {
    days,
    workspace: opts.workspace || null,
    totalRequests,
    totalInputTokens,
    totalOutputTokens,
    totalTokens: totalInputTokens + totalOutputTokens,
    totalCost: Math.round(totalCost * 10000) / 10000,
    totalCostByBackend,
    byModel: byModelWithCost,
    byDay,
    byWorkspace: Object.keys(byWorkspace).length > 0 ? byWorkspace : undefined,
    requestsPerDay: byDay,
    conversationStats: convStats,
    topModels,
    modelComparison,
    costSource: records.some((r) => ["openai"].includes(String(r.backend || "").toLowerCase()))
      ? "openai"
      : "local",
  };
}

/**
 * Get conversation count and avg length from storage.
 */
async function getConversationStats(days, opts) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const userId = opts.userId || "anonymous";
  const workspaces = opts.workspace ? [opts.workspace] : ["default", ...storage.listWorkspaces(userId).map((w) => w.id).filter((id) => id !== "default")];
  let totalConvs = 0;
  let totalMessages = 0;

  for (const ws of workspaces) {
    try {
      const items = storage.list("conversations", ws, userId);
      for (const c of items) {
        const created = new Date(c.createdAt || 0).getTime();
        if (created >= cutoff) {
          totalConvs += 1;
          totalMessages += Array.isArray(c.messages) ? c.messages.length : 0;
        }
      }
    } catch (_) {
      // skip invalid workspace
    }
  }

  return {
    count: totalConvs,
    avgLength: totalConvs > 0 ? Math.round((totalMessages / totalConvs) * 10) / 10 : 0,
  };
}

/**
 * Export usage/analytics to CSV.
 * @param {Array} records
 * @returns {string}
 */
export function exportToCsv(records) {
  const headers = ["timestamp", "model", "inputTokens", "outputTokens", "backend", "workspace", "userId"];
  const rows = records.map((r) =>
    headers.map((h) => {
      const v = r[h];
      if (v == null) return "";
      const s = String(v);
      return s.includes(",") || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(",")
  );
  return [headers.join(","), ...rows].join("\n");
}

/**
 * Export analytics data to JSON.
 * @param {Object} data
 * @returns {string}
 */
export function exportToJson(data) {
  return JSON.stringify(data, null, 2);
}
