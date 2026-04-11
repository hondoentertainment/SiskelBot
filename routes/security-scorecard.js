/**
 * Phase 36.5: Security scorecard routes.
 *
 * GET  /api/v1/security/scorecard                 — latest scorecard
 * POST /api/v1/security/scorecard/scan            — trigger a scan (admin)
 * GET  /api/v1/security/scorecard/history?days=30 — historical scorecards
 * GET  /api/v1/security/scorecard/checks/:checkId — detail for a single check
 */

import {
  runAndSaveSecurityScan,
  getLatestScorecard,
  getScorecardHistory,
  getCheckDetail,
  SCORECARD_CHECKS,
} from "../lib/security-scorecard.js";

export function mountSecurityScorecardRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  apiRoute("get", "/security/scorecard", adminAuth, logRequest, async (req, res) => {
    try {
      const latest = await getLatestScorecard();
      if (!latest) {
        return res.json({
          scorecard: null,
          message: "No scorecard yet. POST /security/scorecard/scan to run one.",
        });
      }
      res.json({ scorecard: latest });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute("post", "/security/scorecard/scan", adminAuth, logRequest, async (req, res) => {
    try {
      const scorecard = await runAndSaveSecurityScan();
      res.status(201).json({ scorecard });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute("get", "/security/scorecard/history", adminAuth, logRequest, async (req, res) => {
    try {
      const days = Number(req.query?.days) || 30;
      if (!Number.isFinite(days) || days < 1 || days > 365) {
        return apiError(res, 400, "INVALID_INPUT", "days must be between 1 and 365.");
      }
      const history = await getScorecardHistory(days);
      res.json({
        days,
        count: history.length,
        history: history.map((s) => ({
          timestamp: s.timestamp,
          score: s.score,
          grade: s.grade,
          counts: s.counts,
        })),
      });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute("get", "/security/scorecard/checks/:checkId", adminAuth, logRequest, async (req, res) => {
    try {
      const checkId = req.params.checkId;
      const def = SCORECARD_CHECKS[checkId];
      if (!def) {
        return apiError(res, 404, "NOT_FOUND", `check "${checkId}" is not registered.`);
      }
      const detail = await getCheckDetail(checkId);
      res.json({
        id: checkId,
        category: def.category,
        weight: def.weight,
        description: def.description || "",
        remediation: def.remediation || null,
        latest: detail,
      });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });
}

export default mountSecurityScorecardRoutes;
