/**
 * Plan entitlements — turns the plan catalog (lib/plans.js) into *enforced*
 * product tiers. Plans define maxMembers / maxWorkspaces / features, but
 * nothing enforced them; this module resolves a workspace's entitlements and
 * provides limit checks + an Express feature gate.
 *
 * Enforcement is gated by ENFORCE_PLAN_LIMITS=1 (default off) so existing
 * deployments and tests are unaffected until a vendor opts in. The resolution
 * helpers and the customer-facing summary work regardless of the flag.
 *
 * All checks fail OPEN: a bug here must never block paying customers.
 */
import { getPlan, getPlanDefinition, checkFeatureAccess } from "./plans.js";

/** Whether hard limit/feature enforcement is active. */
export function enforcementEnabled() {
  return process.env.ENFORCE_PLAN_LIMITS === "1";
}

/**
 * Resolve a workspace's effective entitlements (plan + limits + features).
 * @param {string} workspaceId
 */
export async function getEntitlements(workspaceId) {
  const plan = await getPlan(workspaceId);
  return {
    planId: plan.id,
    planName: plan.name,
    tokensPerMonth: plan.tokensPerMonth,
    maxWorkspaces: plan.maxWorkspaces,
    maxMembers: plan.maxMembers,
    features: plan.features,
    priceMonthly: plan.priceMonthly,
    enforced: enforcementEnabled(),
  };
}

function limitResult({ allowed, limit, current, planId, noun }) {
  return {
    allowed,
    limit,
    current,
    planId,
    reason: allowed
      ? null
      : `Plan "${planId}" allows up to ${limit} ${noun}. Upgrade your plan to add more.`,
  };
}

/**
 * Check whether a workspace can add another member (seat limit).
 * @param {string} workspaceId
 * @param {number} currentMemberCount
 */
export async function checkMemberLimit(workspaceId, currentMemberCount) {
  const ent = await getEntitlements(workspaceId);
  const limit = ent.maxMembers;
  const current = Math.max(0, Number(currentMemberCount) || 0);
  if (!Number.isFinite(limit)) {
    return limitResult({ allowed: true, limit, current, planId: ent.planId, noun: "members" });
  }
  return limitResult({ allowed: current < limit, limit, current, planId: ent.planId, noun: "members" });
}

/**
 * Check whether an account can create another workspace, given the governing
 * plan id and the account's current workspace count.
 * @param {string} planId
 * @param {number} currentWorkspaceCount
 */
export function checkWorkspaceLimit(planId, currentWorkspaceCount) {
  const def = getPlanDefinition(planId) || getPlanDefinition("free");
  const limit = def.maxWorkspaces;
  const current = Math.max(0, Number(currentWorkspaceCount) || 0);
  if (!Number.isFinite(limit)) {
    return limitResult({ allowed: true, limit, current, planId: def.id, noun: "workspaces" });
  }
  return limitResult({ allowed: current < limit, limit, current, planId: def.id, noun: "workspaces" });
}

/**
 * Check whether a workspace's plan includes a feature.
 * @param {string} workspaceId
 * @param {string} feature
 */
export async function checkFeature(workspaceId, feature) {
  const res = await checkFeatureAccess(workspaceId, feature);
  return {
    ...res,
    reason: res.allowed
      ? null
      : `The "${feature}" feature is not available on the ${res.plan} plan. Upgrade to access it.`,
  };
}

/**
 * Express middleware factory that gates a route on a plan feature. No-op when
 * enforcement is disabled; fails open on any error.
 * @param {string} feature
 * @param {{ apiError?: Function }} [opts]
 */
export function requireFeature(feature, opts = {}) {
  const apiError = typeof opts.apiError === "function" ? opts.apiError : null;
  return async function entitlementGate(req, res, next) {
    if (!enforcementEnabled()) return next();
    try {
      const workspaceId =
        req.headers["x-workspace-id"] || req.query?.workspace || req.body?.workspaceId || "default";
      const { allowed, plan } = await checkFeature(workspaceId, feature);
      if (allowed) return next();
      const message = `The "${feature}" feature requires a higher plan (current: ${plan}). Upgrade to access it.`;
      if (apiError) return apiError(res, 402, "PLAN_UPGRADE_REQUIRED", message);
      return res.status(402).json({ error: { code: "PLAN_UPGRADE_REQUIRED", message } });
    } catch {
      return next(); // fail open — never block on enforcement errors
    }
  };
}
