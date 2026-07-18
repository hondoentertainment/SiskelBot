/** Phase 80.5 routes */
import { scheduleDeprecation, listDeprecations, processDueDeprecations } from "../lib/model-deprecation.js";

export function mountModelDeprecationRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  apiRoute("get", "/model-deprecations", adminAuth, logRequest, async (_req, res) => {
    try {
      res.json({ items: await listDeprecations() });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("post", "/model-deprecations", adminAuth, logRequest, async (req, res) => {
    try {
      const item = await scheduleDeprecation(req.body || {});
      res.status(201).json(item);
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  apiRoute("post", "/model-deprecations/process", adminAuth, logRequest, async (_req, res) => {
    try {
      res.json(await processDueDeprecations());
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}
