/**
 * Phase 75.3: Preference collection routes.
 *
 * POST /preference/cases              — create a comparison case
 * GET  /preference/cases              — list comparison cases
 * GET  /preference/cases/:id          — get a case
 * POST /preference/cases/:id/vote     — record a preference vote
 * GET  /preference/cases/:id/stats    — stats for a case
 * GET  /preference/votes              — list votes (filter by caseId or workspaceId)
 */
import {
  createComparisonCase,
  getComparisonCase,
  listComparisonCases,
  recordPreference,
  getPreferenceStats,
  listPreferences,
} from "../lib/preference-collection.js";

export function mountPreferenceRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  apiRoute("post", "/preference/cases", adminAuth, logRequest, async (req, res) => {
    try {
      const rec = await createComparisonCase(req.body || {});
      res.status(201).json(rec);
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  apiRoute("get", "/preference/cases", adminAuth, logRequest, async (req, res) => {
    try {
      const list = await listComparisonCases(req.query?.workspaceId);
      res.json({ cases: list });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/preference/cases/:id", adminAuth, logRequest, async (req, res) => {
    try {
      const rec = await getComparisonCase(req.params.id);
      if (!rec) return apiError(res, 404, "NOT_FOUND", "case not found");
      res.json(rec);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("post", "/preference/cases/:id/vote", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      const vote = await recordPreference({
        caseId: req.params.id,
        userId: body.userId,
        preferred: body.preferred,
        reason: body.reason,
      });
      res.status(201).json(vote);
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  apiRoute("get", "/preference/cases/:id/stats", adminAuth, logRequest, async (req, res) => {
    try {
      const stats = await getPreferenceStats(req.params.id);
      res.json(stats);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/preference/votes", adminAuth, logRequest, async (req, res) => {
    try {
      const votes = await listPreferences({
        caseId: req.query?.caseId,
        workspaceId: req.query?.workspaceId,
      });
      res.json({ votes });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}

export default mountPreferenceRoutes;
