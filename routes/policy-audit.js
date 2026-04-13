/**
 * Phase 51.4: Policy audit trail routes.
 *
 * POST   /api/v1/policy-audit/decisions        — record a decision
 * GET    /api/v1/policy-audit/decisions        — query decisions (with filters)
 * GET    /api/v1/policy-audit/stats            — summary stats
 * GET    /api/v1/policy-audit/export           — export (?format=json|csv)
 *
 * All endpoints require admin auth.
 */
import {
  recordDecision,
  queryDecisions,
  exportDecisions,
  getDecisionStats,
  DECISION_ACTIONS,
} from "../lib/policy-audit.js";

export function mountPolicyAuditRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  apiRoute("post", "/policy-audit/decisions", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      if (body.action && !DECISION_ACTIONS.includes(body.action)) {
        return apiError(res, 400, "INVALID_INPUT", `action must be one of ${DECISION_ACTIONS.join(", ")}`);
      }
      const record = await recordDecision(body);
      if (!record) return apiError(res, 500, "INTERNAL_ERROR", "failed to record decision");
      res.status(201).json(record);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/policy-audit/decisions", adminAuth, logRequest, async (req, res) => {
    try {
      const filter = {
        workspaceId: req.query?.workspaceId,
        policyId: req.query?.policyId,
        source: req.query?.source,
        action: req.query?.action,
        userId: req.query?.userId,
        since: req.query?.since ? Number(req.query.since) : undefined,
        until: req.query?.until ? Number(req.query.until) : undefined,
        limit: req.query?.limit ? Number(req.query.limit) : undefined,
        offset: req.query?.offset ? Number(req.query.offset) : undefined,
      };
      const result = await queryDecisions(filter);
      res.json(result);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/policy-audit/stats", adminAuth, logRequest, async (req, res) => {
    try {
      const filter = {
        workspaceId: req.query?.workspaceId,
        policyId: req.query?.policyId,
        source: req.query?.source,
        since: req.query?.since ? Number(req.query.since) : undefined,
        until: req.query?.until ? Number(req.query.until) : undefined,
      };
      const stats = await getDecisionStats(filter);
      res.json(stats);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/policy-audit/export", adminAuth, logRequest, async (req, res) => {
    try {
      const format = req.query?.format === "csv" ? "csv" : "json";
      const filter = {
        workspaceId: req.query?.workspaceId,
        policyId: req.query?.policyId,
        source: req.query?.source,
        action: req.query?.action,
        since: req.query?.since ? Number(req.query.since) : undefined,
        until: req.query?.until ? Number(req.query.until) : undefined,
      };
      const result = await exportDecisions(filter, format);
      if (format === "csv") {
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", 'attachment; filename="policy-audit.csv"');
        return res.send(result.body);
      }
      res.setHeader("Content-Type", "application/json");
      return res.send(result.body);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}

export default mountPolicyAuditRoutes;
