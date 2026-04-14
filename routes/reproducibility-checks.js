/**
 * Phase 64.5: Reproducibility checks routes.
 */
import {
  createCheck,
  runCheck,
  getCheckReport,
  listChecks,
  getDefaultChecklist,
} from "../lib/reproducibility-checks.js";

export function mountReproducibilityRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  apiRoute("get", "/reproducibility/default-checklist", adminAuth, logRequest, async (req, res) => {
    try {
      res.json({ items: getDefaultChecklist() });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("post", "/reproducibility/checks", adminAuth, logRequest, async (req, res) => {
    try {
      const { workspaceId, experimentId, items } = req.body || {};
      const record = await createCheck({ workspaceId, experimentId, items });
      res.status(201).json(record);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("post", "/reproducibility/checks/:id/run", adminAuth, logRequest, async (req, res) => {
    try {
      const { results } = req.body || {};
      if (!results || typeof results !== "object") {
        return apiError(res, 400, "INVALID_INPUT", "results object is required");
      }
      const report = await runCheck({ checkId: req.params.id, results });
      res.status(200).json(report);
    } catch (err) {
      if (/not found/.test(err.message)) return apiError(res, 404, "NOT_FOUND", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/reproducibility/checks", adminAuth, logRequest, async (req, res) => {
    try {
      const entries = await listChecks({
        workspaceId: req.query?.workspaceId,
        experimentId: req.query?.experimentId,
      });
      res.json({ checks: entries });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/reproducibility/checks/:id", adminAuth, logRequest, async (req, res) => {
    try {
      const record = await getCheckReport(req.params.id);
      if (!record) return apiError(res, 404, "NOT_FOUND", `check ${req.params.id} not found`);
      res.json(record);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}

export default mountReproducibilityRoutes;
