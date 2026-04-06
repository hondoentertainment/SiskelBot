/**
 * Phase 22: Real-time analytics API routes.
 * Provides endpoints for usage trends, top models/users, agent stats, costs, and errors.
 */
import rateLimit from "express-rate-limit";
import {
  getUsageTrends,
  getTopModels,
  getTopUsers,
  getAgentStats,
  getCostEstimate,
  getErrorBreakdown,
} from "../lib/analytics-engine.js";

export function mountAnalyticsRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, isAuthConfigured } = deps;

  const analyticsRateLimiter = rateLimit({
    windowMs: 60_000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
  });

  const handlers = [analyticsRateLimiter, logRequest];
  if (isAuthConfigured()) handlers.push(userAuth);

  apiRoute("get", "/analytics/trends", ...handlers, async (req, res) => {
    try {
      const workspace = req.query.workspace || undefined;
      const period = req.query.period || "7d";
      const granularity = req.query.granularity || "day";
      const result = await getUsageTrends(workspace, period, granularity);
      res.json(result);
    } catch (err) {
      console.error("Analytics trends error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/analytics/models", ...handlers, async (req, res) => {
    try {
      const workspace = req.query.workspace || undefined;
      const period = req.query.period || "7d";
      const result = await getTopModels(workspace, period);
      res.json(result);
    } catch (err) {
      console.error("Analytics models error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/analytics/users", ...handlers, async (req, res) => {
    try {
      const workspace = req.query.workspace || undefined;
      const period = req.query.period || "7d";
      const result = await getTopUsers(workspace, period);
      res.json(result);
    } catch (err) {
      console.error("Analytics users error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/analytics/agents", ...handlers, async (req, res) => {
    try {
      const workspace = req.query.workspace || undefined;
      const period = req.query.period || "7d";
      const result = await getAgentStats(workspace, period);
      res.json(result);
    } catch (err) {
      console.error("Analytics agents error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/analytics/costs", ...handlers, async (req, res) => {
    try {
      const workspace = req.query.workspace || undefined;
      const period = req.query.period || "7d";
      const result = await getCostEstimate(workspace, period);
      res.json(result);
    } catch (err) {
      console.error("Analytics costs error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/analytics/errors", ...handlers, async (req, res) => {
    try {
      const workspace = req.query.workspace || undefined;
      const period = req.query.period || "7d";
      const result = await getErrorBreakdown(workspace, period);
      res.json(result);
    } catch (err) {
      console.error("Analytics errors error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}
