/**
 * Phase 24: Monetization & Multi-Tenancy — Usage-based billing system.
 * Tracks token consumption per workspace, computes cost breakdowns,
 * enforces plan limits, and generates invoice data.
 */
import { join } from "path";
import { readJsonPath, writeJsonPath, getDataDir } from "./json-path-store.js";
import { getPlan } from "./plans.js";

const COST_PER_1K_INPUT = Number(process.env.BILLING_COST_PER_1K_INPUT) || 0.002;
const COST_PER_1K_OUTPUT = Number(process.env.BILLING_COST_PER_1K_OUTPUT) || 0.006;
const MAX_USAGE_RECORDS = 200_000;

function billingPath() {
  return join(getDataDir(), "billing-usage.json");
}

/** In-memory cache of billing records, lazily loaded from disk. */
let _records = null;

async function ensureRecords() {
  if (_records === null) {
    const data = await readJsonPath(billingPath(), { _version: 1, records: [] });
    _records = Array.isArray(data.records) ? data.records : [];
  }
  return _records;
}

async function persistRecords() {
  if (_records === null) return;
  const trimmed = _records.length > MAX_USAGE_RECORDS ? _records.slice(-MAX_USAGE_RECORDS) : _records;
  _records = trimmed;
  await writeJsonPath(billingPath(), { _version: 1, records: trimmed });
}

/**
 * Compute cost for a usage record.
 * @param {number} inputTokens
 * @param {number} outputTokens
 * @param {string} [model]
 * @returns {number}
 */
function computeCost(inputTokens, outputTokens, model) {
  const input = Math.max(0, inputTokens || 0);
  const output = Math.max(0, outputTokens || 0);
  return Math.round(((input / 1000) * COST_PER_1K_INPUT + (output / 1000) * COST_PER_1K_OUTPUT) * 10000) / 10000;
}

/**
 * Parse a period string into a date range.
 * Supports: "30d" (days), "2026-03" (YYYY-MM month).
 * @param {string} period
 * @returns {{ start: Date, end: Date, label: string }}
 */
function parsePeriod(period) {
  if (!period || typeof period !== "string") {
    const now = new Date();
    return {
      start: new Date(now.getFullYear(), now.getMonth(), 1),
      end: new Date(now.getFullYear(), now.getMonth() + 1, 1),
      label: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`,
    };
  }

  const dayMatch = period.match(/^(\d+)d$/);
  if (dayMatch) {
    const days = Math.min(365, Math.max(1, Number(dayMatch[1])));
    const end = new Date(Date.now() + 1000); // +1s to include records created just now
    const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
    return { start, end, label: `${days}d` };
  }

  const monthMatch = period.match(/^(\d{4})-(\d{2})$/);
  if (monthMatch) {
    const year = Number(monthMatch[1]);
    const month = Number(monthMatch[2]) - 1;
    return {
      start: new Date(year, month, 1),
      end: new Date(year, month + 1, 1),
      label: period,
    };
  }

  // Fallback: current month
  const now = new Date();
  return {
    start: new Date(now.getFullYear(), now.getMonth(), 1),
    end: new Date(now.getFullYear(), now.getMonth() + 1, 1),
    label: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`,
  };
}

/**
 * Create a billing manager instance.
 * @returns {object}
 */
export function createBillingManager() {
  return {
    /**
     * Record token consumption for a workspace.
     * @param {string} workspaceId
     * @param {{ inputTokens?: number, outputTokens?: number, total?: number }} tokens
     * @param {string} [model]
     * @returns {Promise<{ ok: boolean, record: object }>}
     */
    async recordUsage(workspaceId, tokens, model) {
      const inputTokens = Math.max(0, Number(tokens?.inputTokens ?? tokens?.total ?? tokens) || 0);
      const outputTokens = Math.max(0, Number(tokens?.outputTokens) || 0);
      const totalTokens = inputTokens + outputTokens;
      const cost = computeCost(inputTokens, outputTokens, model);

      const record = {
        id: `bill_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        workspaceId: String(workspaceId || "default"),
        model: String(model || "unknown"),
        inputTokens,
        outputTokens,
        totalTokens,
        cost,
        timestamp: new Date().toISOString(),
      };

      const records = await ensureRecords();
      records.push(record);
      await persistRecords();

      return { ok: true, record };
    },

    /**
     * Get usage summary for a workspace in a given period.
     * @param {string} workspaceId
     * @param {string} [period] - e.g., "30d" or "2026-03"
     * @returns {Promise<{ tokens: number, cost: number, breakdown: object, period: string }>}
     */
    async getUsageSummary(workspaceId, period) {
      const { start, end, label } = parsePeriod(period);
      const records = await ensureRecords();
      const ws = String(workspaceId || "default");

      const filtered = records.filter((r) => {
        if (r.workspaceId !== ws) return false;
        const ts = new Date(r.timestamp).getTime();
        return ts >= start.getTime() && ts < end.getTime();
      });

      let totalTokens = 0;
      let totalCost = 0;
      let totalInput = 0;
      let totalOutput = 0;
      const byModel = {};
      const byDay = {};

      for (const r of filtered) {
        totalTokens += r.totalTokens || 0;
        totalInput += r.inputTokens || 0;
        totalOutput += r.outputTokens || 0;
        totalCost += r.cost || 0;

        const m = r.model || "unknown";
        if (!byModel[m]) byModel[m] = { tokens: 0, cost: 0, requests: 0 };
        byModel[m].tokens += r.totalTokens || 0;
        byModel[m].cost += r.cost || 0;
        byModel[m].requests += 1;

        const day = r.timestamp ? r.timestamp.slice(0, 10) : "unknown";
        if (!byDay[day]) byDay[day] = { tokens: 0, cost: 0, requests: 0 };
        byDay[day].tokens += r.totalTokens || 0;
        byDay[day].cost += r.cost || 0;
        byDay[day].requests += 1;
      }

      totalCost = Math.round(totalCost * 10000) / 10000;

      return {
        tokens: totalTokens,
        inputTokens: totalInput,
        outputTokens: totalOutput,
        cost: totalCost,
        requests: filtered.length,
        breakdown: { byModel, byDay },
        period: label,
        workspaceId: ws,
      };
    },

    /**
     * Check plan limits for a workspace.
     * Compares current-month token usage against the plan's tokensPerMonth.
     * @param {string} workspaceId
     * @returns {Promise<{ allowed: boolean, remaining: number, plan: string, overage: number, used: number, limit: number }>}
     */
    async checkPlanLimits(workspaceId) {
      const plan = await getPlan(workspaceId);
      const now = new Date();
      const monthPeriod = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      const summary = await this.getUsageSummary(workspaceId, monthPeriod);

      const limit = plan.tokensPerMonth;
      const used = summary.tokens;
      const remaining = Math.max(0, limit - used);
      const overage = Math.max(0, used - limit);
      const allowed = limit === Infinity || used < limit;

      return {
        allowed,
        remaining: limit === Infinity ? Infinity : remaining,
        plan: plan.id,
        planName: plan.name,
        overage,
        used,
        limit: limit === Infinity ? Infinity : limit,
      };
    },

    /**
     * Generate invoice data for a workspace and period.
     * @param {string} workspaceId
     * @param {string} [period] - e.g., "2026-03"
     * @returns {Promise<object>}
     */
    async getInvoice(workspaceId, period) {
      const plan = await getPlan(workspaceId);
      const summary = await this.getUsageSummary(workspaceId, period);

      const lineItems = [];

      // Plan subscription fee
      if (plan.priceMonthly > 0) {
        lineItems.push({
          description: `${plan.name} Plan — Monthly Subscription`,
          quantity: 1,
          unitPrice: plan.priceMonthly,
          total: plan.priceMonthly,
        });
      }

      // Token usage
      if (summary.tokens > 0) {
        lineItems.push({
          description: `Token Usage (${summary.requests} requests, ${summary.tokens} tokens)`,
          quantity: summary.tokens,
          unitPrice: summary.cost > 0 ? Math.round((summary.cost / summary.tokens) * 1_000_000) / 1_000_000 : 0,
          total: summary.cost,
        });
      }

      const subtotal = lineItems.reduce((s, item) => s + item.total, 0);

      return {
        invoiceId: `inv_${String(workspaceId).slice(0, 12)}_${summary.period}`,
        workspaceId: String(workspaceId),
        period: summary.period,
        plan: { id: plan.id, name: plan.name },
        lineItems,
        subtotal: Math.round(subtotal * 100) / 100,
        currency: "USD",
        generatedAt: new Date().toISOString(),
        usage: {
          tokens: summary.tokens,
          inputTokens: summary.inputTokens,
          outputTokens: summary.outputTokens,
          requests: summary.requests,
          cost: summary.cost,
        },
      };
    },
  };
}
