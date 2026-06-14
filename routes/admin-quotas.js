/**
 * Admin: per-tenant quota management.
 *
 * GET    /api/v1/admin/quotas                          — list all workspaces with overrides + usage
 * GET    /api/v1/admin/quotas/:workspaceId             — get effective quotas + live usage snapshot
 * GET    /api/v1/admin/quotas/:workspaceId/effective   — plan-tier + admin override breakdown
 * PUT    /api/v1/admin/quotas/:workspaceId             — set/override quotas for a workspace
 * DELETE /api/v1/admin/quotas/:workspaceId             — remove the override (fall back to defaults)
 */
import {
  getEffectiveQuotas,
  getUsageSnapshot,
  setQuotaOverride,
  deleteQuotaOverride,
  listQuotaOverrides,
} from "../lib/tenant-quotas.js";

export default function mountAdminQuotaRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth, requireScope, storage } = deps;

  const adminGuard = requireScope ? [adminAuth, requireScope("admin")] : [adminAuth];

  apiRoute("get", "/admin/quotas", ...adminGuard, logRequest, async (req, res) => {
    try {
      const overrides = await listQuotaOverrides(storage);
      const enriched = overrides.map((o) => ({
        ...o,
        usage: getUsageSnapshot(o.workspaceId),
      }));
      res.json({ overrides: enriched });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/admin/quotas/:workspaceId", ...adminGuard, logRequest, async (req, res) => {
    try {
      const ws = String(req.params.workspaceId || "").trim();
      if (!ws) return apiError(res, 400, "INVALID_INPUT", "workspaceId required");
      const limits = await getEffectiveQuotas(ws, storage);
      const usage = getUsageSnapshot(ws);
      res.json({ workspaceId: ws, limits, usage });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/admin/quotas/:workspaceId/effective", ...adminGuard, logRequest, async (req, res) => {
    try {
      const ws = String(req.params.workspaceId || "").trim();
      if (!ws) return apiError(res, 400, "INVALID_INPUT", "workspaceId required");
      const effective = await getEffectiveQuotas(ws, storage);

      const adminOverrides = {};
      if (effective.source === "override") {
        const TENANT_QUOTAS_TYPE = "tenant_quotas";
        try {
          const item = await storage.get(TENANT_QUOTAS_TYPE, ws, ws);
          if (item) {
            if (item.requestsPerMinute != null) adminOverrides.requestsPerMinute = item.requestsPerMinute;
            if (item.tokensPerDay != null) adminOverrides.tokensPerDay = item.tokensPerDay;
            if (item.storageBytesMax != null) adminOverrides.storageBytesMax = item.storageBytesMax;
          }
        } catch {
          // ignore — overrides just won't be listed
        }
      }

      res.json({
        workspaceId: ws,
        plan: effective.plan,
        effectiveQuotas: {
          requestsPerMinute: effective.requestsPerMinute,
          tokensPerDay: effective.tokensPerDay,
          storageBytes: effective.storageBytes,
        },
        source: effective.source,
        adminOverrides,
      });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("put", "/admin/quotas/:workspaceId", ...adminGuard, logRequest, async (req, res) => {
    try {
      const ws = String(req.params.workspaceId || "").trim();
      if (!ws) return apiError(res, 400, "INVALID_INPUT", "workspaceId required");
      const { requestsPerMinute, tokensPerDay, storageBytesMax } = req.body || {};
      const result = await setQuotaOverride(
        ws,
        { requestsPerMinute, tokensPerDay, storageBytesMax },
        storage
      );
      if (!result.ok) {
        return apiError(res, 400, "INVALID_INPUT", result.error);
      }
      const limits = await getEffectiveQuotas(ws, storage);
      res.json({ ok: true, workspaceId: ws, override: result.override, limits });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("delete", "/admin/quotas/:workspaceId", ...adminGuard, logRequest, async (req, res) => {
    try {
      const ws = String(req.params.workspaceId || "").trim();
      if (!ws) return apiError(res, 400, "INVALID_INPUT", "workspaceId required");
      const result = await deleteQuotaOverride(ws, storage);
      if (!result.ok) {
        return apiError(res, 500, "INTERNAL_ERROR", result.error);
      }
      res.status(204).send();
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}
