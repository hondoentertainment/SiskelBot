/**
 * Entitlements — customer-facing view of a workspace's plan, enforced limits,
 * and live usage. Backs an account/billing dashboard and upgrade prompts.
 * GET /api/v1/entitlements?workspace=X
 */
import { getEntitlements } from "../lib/entitlements.js";
import { getWorkspaceMembers } from "../lib/teams.js";
import { getWorkspaceTokensUsed } from "../lib/quotas.js";
import { getTrial } from "../lib/trials.js";
import { resolveQuotas } from "../lib/quota-resolver.js";

export function mountEntitlementsRoutes(app, deps) {
  const { apiRoute, apiError, storageRateLimiter } = deps;
  const limiter = storageRateLimiter || ((req, res, next) => next());

  apiRoute("get", "/entitlements", limiter, async (req, res) => {
    try {
      const workspace = req.headers["x-workspace-id"] || req.query?.workspace || "default";
      const ent = await getEntitlements(workspace);

      let memberCount = 0;
      try {
        const entry = await getWorkspaceMembers(workspace);
        memberCount = entry?.members?.length || 0;
      } catch { /* best-effort */ }

      let tokensUsed = 0;
      try {
        tokensUsed = (await getWorkspaceTokensUsed(workspace)) || 0;
      } catch { /* best-effort */ }

      let trial = null;
      try {
        trial = await getTrial(workspace);
      } catch { /* best-effort */ }

      let quotas = null;
      try {
        quotas = await resolveQuotas(workspace, { userId: req.userId });
      } catch { /* best-effort */ }

      const finite = (n) => (Number.isFinite(n) ? n : null);
      const remaining = (limit, used) => (Number.isFinite(limit) ? Math.max(0, limit - used) : null);

      res.json({
        ok: true,
        workspace,
        plan: { id: ent.planId, name: ent.planName, priceMonthly: ent.priceMonthly },
        enforced: ent.enforced,
        trial: trial && (trial.active || trial.expired) ? trial : null,
        features: ent.features,
        limits: {
          maxMembers: finite(ent.maxMembers),
          maxWorkspaces: finite(ent.maxWorkspaces),
          tokensPerMonth: finite(ent.tokensPerMonth),
        },
        usage: {
          members: memberCount,
          membersRemaining: remaining(ent.maxMembers, memberCount),
          tokensThisPeriod: tokensUsed,
          tokensRemaining: remaining(ent.tokensPerMonth, tokensUsed),
        },
        quotas,
      });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}
