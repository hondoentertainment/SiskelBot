/**
 * Revenue analytics — operator-facing business metrics (MRR, ARR, plan mix,
 * churn, customer list) computed from data the billing stack already writes.
 *
 * Because subscription snapshots live at billing-subscriptions/{ws}.json
 * (unenumerable on KV backends), this module maintains a small index of every
 * workspace that has ever had a subscription snapshot. lib/billing.js calls
 * registerBillingWorkspace() after each webhook write.
 *
 * Storage: data/billing-subscriptions/index.json -> { workspaces: [...] }
 */
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";
import { getWorkspaceSubscription, createBillingManager } from "./billing.js";
import { getPlanDefinition } from "./plans.js";
import { getChurnRate } from "./cohort-analysis.js";

const MAX_INDEXED = 10_000;

function indexPath() {
  return join(getDataDir(), "billing-subscriptions", "index.json");
}

function normalize(raw) {
  if (raw && typeof raw === "object" && Array.isArray(raw.workspaces)) return raw;
  return { workspaces: [] };
}

/**
 * Record that a workspace has a subscription snapshot. Idempotent; called by
 * the billing webhook path. Best-effort: never throws.
 * @param {string} workspaceId
 */
export async function registerBillingWorkspace(workspaceId) {
  const ws = String(workspaceId || "").trim();
  if (!ws) return;
  try {
    const path = indexPath();
    await withPathLock(path, async () => {
      const data = normalize(await readJsonPath(path, null));
      if (!data.workspaces.includes(ws)) {
        if (data.workspaces.length >= MAX_INDEXED) return;
        data.workspaces.push(ws);
        await writeJsonPath(path, data);
      }
    });
  } catch {
    /* analytics indexing must never break billing */
  }
}

/** All workspaces that have (or had) a subscription snapshot. */
export async function listBillingWorkspaces() {
  const data = normalize(await readJsonPath(indexPath(), null));
  return data.workspaces;
}

/**
 * Customer list: one row per indexed workspace with plan, status, price, and
 * current-month usage.
 * @param {{ includeUsage?: boolean }} [opts]
 */
export async function listCustomers(opts = {}) {
  const includeUsage = opts.includeUsage !== false;
  const workspaces = await listBillingWorkspaces();
  const billing = includeUsage ? createBillingManager() : null;
  const now = new Date();
  const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  const customers = [];
  for (const ws of workspaces) {
    const sub = await getWorkspaceSubscription(ws);
    const paying = (sub.status === "active" || sub.status === "past_due") && sub.plan !== "free";
    const def = getPlanDefinition(sub.plan) || getPlanDefinition("free");
    const row = {
      workspaceId: ws,
      plan: sub.plan,
      status: sub.status,
      paying,
      priceMonthly: paying && Number.isFinite(def.priceMonthly) ? def.priceMonthly : 0,
      stripeCustomerId: sub.stripeCustomerId,
      updatedAt: sub.updatedAt,
    };
    if (includeUsage && billing) {
      try {
        const usage = await billing.getUsageSummary(ws, period);
        row.tokensThisMonth = usage.tokens;
        row.costThisMonth = usage.cost;
      } catch {
        row.tokensThisMonth = null;
        row.costThisMonth = null;
      }
    }
    customers.push(row);
  }
  customers.sort((a, b) => b.priceMonthly - a.priceMonthly || String(a.workspaceId).localeCompare(String(b.workspaceId)));
  return customers;
}

/**
 * Revenue summary: MRR/ARR from active paid subscriptions, plan mix, and
 * churn from cohort analysis.
 */
export async function getRevenueSummary() {
  const customers = await listCustomers({ includeUsage: false });

  let mrr = 0;
  const byPlan = {};
  let payingCount = 0;
  let pastDueCount = 0;
  let canceledCount = 0;

  for (const c of customers) {
    byPlan[c.plan] = (byPlan[c.plan] || 0) + 1;
    if (c.paying) {
      payingCount++;
      mrr += c.priceMonthly;
      if (c.status === "past_due") pastDueCount++;
    } else if (c.status === "canceled") {
      canceledCount++;
    }
  }

  let churn = null;
  try {
    churn = await getChurnRate();
  } catch {
    /* cohort data optional */
  }

  return {
    mrr,
    arr: mrr * 12,
    customers: {
      indexed: customers.length,
      paying: payingCount,
      pastDue: pastDueCount,
      canceled: canceledCount,
    },
    byPlan,
    churn,
    generatedAt: new Date().toISOString(),
  };
}
