/**
 * Phase 63.4: Refactoring agent routes.
 */
import {
  planRefactor,
  previewRefactor,
  applyRefactor,
  listPlans,
  getPlan,
} from "../lib/refactor-agent.js";

export function mountRefactorRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  apiRoute("post", "/refactor/plan", adminAuth, logRequest, async (req, res) => {
    try {
      const { workspaceId, files, transform } = req.body || {};
      const plan = await planRefactor({ workspaceId, files, transform });
      res.status(201).json(plan);
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  apiRoute("get", "/refactor/plans", adminAuth, logRequest, async (req, res) => {
    try {
      const out = await listPlans(req.query?.workspaceId);
      res.json(out);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/refactor/plans/:id/preview", adminAuth, logRequest, async (req, res) => {
    try {
      const preview = await previewRefactor(req.params?.id, req.query?.workspaceId);
      if (!preview) return apiError(res, 404, "NOT_FOUND", "plan not found");
      res.json(preview);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("post", "/refactor/plans/:id/apply", adminAuth, logRequest, async (req, res) => {
    try {
      const dryRun = !!(req.body?.dryRun);
      const out = await applyRefactor({
        planId: req.params?.id,
        dryRun,
        workspaceId: req.body?.workspaceId || req.query?.workspaceId,
      });
      if (!out) return apiError(res, 404, "NOT_FOUND", "plan not found");
      res.json(out);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/refactor/plans/:id", adminAuth, logRequest, async (req, res) => {
    try {
      const plan = await getPlan(req.params?.id, req.query?.workspaceId);
      if (!plan) return apiError(res, 404, "NOT_FOUND", "plan not found");
      res.json(plan);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}

export default mountRefactorRoutes;
