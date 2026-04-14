/**
 * Phase 71.2: Outcome verification routes.
 *
 * POST   /api/v1/outcomes                         — define outcome
 * GET    /api/v1/outcomes?workspaceId=            — list outcomes
 * GET    /api/v1/outcomes/:id                     — get outcome
 * POST   /api/v1/outcomes/:id/verify              — verify against signals
 * GET    /api/v1/outcomes/verifications/:id       — get verification
 * GET    /api/v1/outcomes/verifications           — list verifications
 */
import {
  defineOutcome,
  listOutcomes,
  getOutcome,
  verifyOutcome,
  getVerification,
  listVerifications,
  CRITERION_TYPES,
} from "../lib/outcome-verification.js";

export function mountOutcomeRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  apiRoute("post", "/outcomes", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.name) return apiError(res, 400, "INVALID_INPUT", "name is required");
      if (!Array.isArray(body.criteria) || !body.criteria.length) {
        return apiError(res, 400, "INVALID_INPUT", "criteria must be a non-empty array");
      }
      for (const [i, c] of body.criteria.entries()) {
        if (!c || !CRITERION_TYPES.includes(c.type)) {
          return apiError(res, 400, "INVALID_INPUT", `criteria[${i}].type must be one of ${CRITERION_TYPES.join(", ")}`);
        }
      }
      const outcome = await defineOutcome(body);
      res.status(201).json(outcome);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // Note: /verifications (collection) and /verifications/:id must be declared
  // before /:id to avoid path collision.
  apiRoute("get", "/outcomes/verifications/:id", adminAuth, logRequest, async (req, res) => {
    try {
      const v = await getVerification(req.params?.id);
      if (!v) return apiError(res, 404, "NOT_FOUND", "verification not found");
      res.json(v);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/outcomes/verifications", adminAuth, logRequest, async (req, res) => {
    try {
      const list = await listVerifications({
        workspaceId: req.query?.workspaceId,
        outcomeId: req.query?.outcomeId,
      });
      res.json({ verifications: list });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/outcomes", adminAuth, logRequest, async (req, res) => {
    try {
      const workspaceId = req.query?.workspaceId || "default";
      const outcomes = await listOutcomes(workspaceId);
      res.json({ workspaceId, outcomes });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/outcomes/:id", adminAuth, logRequest, async (req, res) => {
    try {
      const o = await getOutcome(req.params?.id);
      if (!o) return apiError(res, 404, "NOT_FOUND", "outcome not found");
      res.json(o);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("post", "/outcomes/:id/verify", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      const record = await verifyOutcome({
        outcomeId: req.params?.id,
        runId: body.runId,
        signals: body.signals || {},
      });
      res.status(201).json(record);
    } catch (err) {
      if (/not found/i.test(err.message)) return apiError(res, 404, "NOT_FOUND", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}

export default mountOutcomeRoutes;
