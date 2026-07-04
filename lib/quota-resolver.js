/**
 * Quota resolver — one authoritative view over the three quota layers that
 * grew up independently, so operators and the account UI don't have to know
 * which module enforces what:
 *
 *   1. Plan monthly tokens  — lib/billing.js#checkPlanLimits
 *      (plan.tokensPerMonth per calendar month; enforced in /v1/chat when
 *      QUOTA_ENABLED=1)
 *   2. Workspace monthly tokens — lib/quotas.js
 *      (QUOTA_TOKENS_PER_WORKSPACE + per-workspace overrides over a rolling
 *      period; enforced in /v1/chat when configured)
 *   3. Tenant rate/daily limits — lib/tenant-quotas.js
 *      (requests/min, tokens/day, storage bytes by plan tier; always
 *      enforced in /v1/chat)
 *
 * All three keep enforcing exactly as before — this module only *reports*
 * them coherently. A request is allowed only if every configured layer
 * allows it; `effectiveMonthlyTokens` is the tightest monthly cap.
 */
import { createBillingManager } from "./billing.js";
import { isQuotaConfigured, getWorkspaceQuota } from "./quotas.js";
import { getEffectiveQuotas, getUsageSnapshot } from "./tenant-quotas.js";

const _billing = createBillingManager();

/**
 * Resolve the full quota picture for a workspace.
 * @param {string} workspaceId
 * @param {{ storage?: object, userId?: string }} [opts]
 * @returns {Promise<object>}
 */
export async function resolveQuotas(workspaceId, opts = {}) {
  const ws = String(workspaceId || "default");

  // Layer 1: plan monthly cap (billing usage records, calendar month)
  let planMonthly = null;
  try {
    const p = await _billing.checkPlanLimits(ws);
    planMonthly = {
      enforced: process.env.QUOTA_ENABLED === "1",
      plan: p.plan,
      limit: Number.isFinite(p.limit) ? p.limit : null,
      used: p.used,
      remaining: Number.isFinite(p.remaining) ? p.remaining : null,
      allowed: p.allowed,
    };
  } catch { /* layer optional */ }

  // Layer 2: workspace monthly override (usage-tracker, rolling period)
  let workspaceMonthly = null;
  try {
    if (isQuotaConfigured()) {
      const q = await getWorkspaceQuota(ws, opts.userId);
      if (q) {
        workspaceMonthly = {
          enforced: true,
          limit: q.limit,
          used: q.used ?? Math.max(0, q.limit - q.remaining),
          remaining: q.remaining,
          resetAt: q.resetAt,
        };
      }
    }
  } catch { /* layer optional */ }

  // Layer 3: tenant rate/daily limits (in-memory rolling windows)
  let tenant = null;
  try {
    const eff = await getEffectiveQuotas(ws, opts.storage);
    const snap = getUsageSnapshot(ws);
    tenant = {
      enforced: true,
      plan: eff.plan,
      source: eff.source,
      requestsPerMinute: { limit: eff.requestsPerMinute, used: snap.requestsThisMinute },
      tokensPerDay: { limit: eff.tokensPerDay, used: snap.tokensToday },
      storageBytes: { limit: eff.storageBytesMax, used: snap.storageBytes },
    };
  } catch { /* layer optional */ }

  // Tightest monthly token cap across configured layers.
  const monthlyCandidates = [];
  if (planMonthly?.enforced && planMonthly.limit != null) monthlyCandidates.push(planMonthly.limit);
  if (workspaceMonthly?.limit != null) monthlyCandidates.push(workspaceMonthly.limit);
  const effectiveMonthlyTokens = monthlyCandidates.length ? Math.min(...monthlyCandidates) : null;

  const allowed =
    (planMonthly ? planMonthly.allowed || !planMonthly.enforced : true) &&
    (workspaceMonthly ? workspaceMonthly.remaining > 0 : true) &&
    (tenant
      ? tenant.requestsPerMinute.used < tenant.requestsPerMinute.limit &&
        tenant.tokensPerDay.used < tenant.tokensPerDay.limit &&
        tenant.storageBytes.used <= tenant.storageBytes.limit
      : true);

  return {
    workspaceId: ws,
    allowed,
    effectiveMonthlyTokens,
    layers: {
      planMonthly,
      workspaceMonthly,
      tenant,
    },
  };
}
