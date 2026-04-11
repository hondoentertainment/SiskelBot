/**
 * Phase 39.1: Cohort analysis admin routes.
 *
 * All routes are admin-only. Mounted under /api/v1 (with legacy /api mirror)
 * via the standard apiRoute() helper from server.js.
 *
 *   GET /analytics/cohorts/retention?granularity=week&periods=12&startDate=YYYY-MM-DD
 *   GET /analytics/cohorts/dau?days=30
 *   GET /analytics/cohorts/mau?months=12
 *   GET /analytics/cohorts/churn?period=30d
 *   GET /analytics/cohorts/adoption?feature=agent_mode&cohortDate=2026-W14
 */
import {
  getCohortRetention,
  getCohortFeatureAdoption,
  getChurnRate,
  getDailyActiveUsers,
  getMonthlyActiveUsers,
} from "../lib/cohort-analysis.js";

const VALID_GRANULARITIES = new Set(["day", "week", "month"]);

export function mountCohortAnalysisRoutes(app, deps) {
  const { apiRoute, apiError, adminAuth, logRequest } = deps;

  apiRoute("get", "/analytics/cohorts/retention", adminAuth, logRequest, async (req, res) => {
    try {
      const granularity = String(req.query.granularity || "week");
      if (!VALID_GRANULARITIES.has(granularity)) {
        return apiError(res, 400, "INVALID_INPUT", "granularity must be day, week, or month", null);
      }
      const periods = req.query.periods != null ? Number(req.query.periods) : 12;
      if (!Number.isFinite(periods) || periods < 1 || periods > 60) {
        return apiError(res, 400, "INVALID_INPUT", "periods must be 1..60", null);
      }
      const startDate = req.query.startDate ? String(req.query.startDate) : undefined;
      const result = await getCohortRetention({
        cohortGranularity: granularity,
        periods,
        startDate,
      });
      res.json(result);
    } catch (err) {
      console.error("Cohort retention error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, null);
    }
  });

  apiRoute("get", "/analytics/cohorts/dau", adminAuth, logRequest, async (req, res) => {
    try {
      const days = req.query.days != null ? Number(req.query.days) : 30;
      if (!Number.isFinite(days) || days < 1 || days > 365) {
        return apiError(res, 400, "INVALID_INPUT", "days must be 1..365", null);
      }
      const result = await getDailyActiveUsers(days);
      res.json(result);
    } catch (err) {
      console.error("Cohort dau error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, null);
    }
  });

  apiRoute("get", "/analytics/cohorts/mau", adminAuth, logRequest, async (req, res) => {
    try {
      const months = req.query.months != null ? Number(req.query.months) : 12;
      if (!Number.isFinite(months) || months < 1 || months > 60) {
        return apiError(res, 400, "INVALID_INPUT", "months must be 1..60", null);
      }
      const result = await getMonthlyActiveUsers(months);
      res.json(result);
    } catch (err) {
      console.error("Cohort mau error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, null);
    }
  });

  apiRoute("get", "/analytics/cohorts/churn", adminAuth, logRequest, async (req, res) => {
    try {
      const period = req.query.period ? String(req.query.period) : "30d";
      const result = await getChurnRate(period);
      res.json(result);
    } catch (err) {
      console.error("Cohort churn error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, null);
    }
  });

  apiRoute("get", "/analytics/cohorts/adoption", adminAuth, logRequest, async (req, res) => {
    try {
      const feature = req.query.feature ? String(req.query.feature) : "";
      const cohortDate = req.query.cohortDate ? String(req.query.cohortDate) : "";
      if (!feature) {
        return apiError(res, 400, "INVALID_INPUT", "feature query parameter required", null);
      }
      if (!cohortDate) {
        return apiError(res, 400, "INVALID_INPUT", "cohortDate query parameter required", null);
      }
      const result = await getCohortFeatureAdoption(feature, cohortDate);
      res.json(result);
    } catch (err) {
      console.error("Cohort adoption error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, null);
    }
  });
}

export default mountCohortAnalysisRoutes;
