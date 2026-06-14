/**
 * Phase 32.5: Explainability routes — "Why did the agent do X?".
 *
 *   GET /api/v1/explain/runs/:runId              — raw decisions for a run
 *   GET /api/v1/explain/runs/:runId/narrative    — human-readable narrative + summary
 *   GET /api/v1/explain/runs/:runId/:index       — single decision explanation
 *   GET /api/v1/explain/stats?workspace=X&period=7d — aggregate decision statistics
 *   GET /api/v1/explain/runs                     — list known runs (most recent first)
 */
import {
  globalDecisionLog,
  formatDecisionExplanation,
  parsePeriod,
} from "../lib/explainability.js";

export function mountExplainabilityRoutes(app, deps) {
  const { apiRoute, apiError, sanitizeWorkspace, storageRateLimiter } = deps;
  const limiter = storageRateLimiter || ((req, res, next) => next());

  // GET /api/v1/explain/runs — list recent runs that have decisions logged
  apiRoute("get", "/explain/runs", limiter, async (req, res) => {
    try {
      const workspace = req.query?.workspace
        ? sanitizeWorkspace(req.query.workspace)
        : null;
      const limit = req.query?.limit ? Number(req.query.limit) : 50;
      const runs = globalDecisionLog.listRuns(workspace, limit);
      res.json({ _version: 1, runs, count: runs.length });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/explain/stats — aggregate stats
  apiRoute("get", "/explain/stats", limiter, async (req, res) => {
    try {
      const workspace = req.query?.workspace
        ? sanitizeWorkspace(req.query.workspace)
        : null;
      const periodMs = req.query?.period ? parsePeriod(String(req.query.period)) : 0;
      const stats = globalDecisionLog.getDecisionStats(workspace, periodMs);
      res.json({ _version: 1, ...stats });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/explain/runs/:runId/narrative — human-readable summary
  apiRoute("get", "/explain/runs/:runId/narrative", limiter, async (req, res) => {
    try {
      const runId = req.params.runId;
      const explanation = globalDecisionLog.generateRunExplanation(runId);
      if (!explanation) {
        return apiError(res, 404, "NOT_FOUND", `No decisions recorded for run ${runId}`);
      }
      const narrative = explanation.keyDecisions
        .map((d, i) => `${i + 1}. ${formatDecisionExplanation(d)}`)
        .join("\n");
      res.json({
        _version: 1,
        ...explanation,
        narrative,
      });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/explain/runs/:runId/:index — single decision
  apiRoute("get", "/explain/runs/:runId/:index", limiter, async (req, res) => {
    try {
      const runId = req.params.runId;
      const index = Number(req.params.index);
      if (!Number.isFinite(index) || index < 0) {
        return apiError(res, 400, "INVALID_INPUT", "index must be a non-negative integer");
      }
      const decision = globalDecisionLog.getDecision(runId, index);
      if (!decision) {
        return apiError(res, 404, "NOT_FOUND", `Decision ${index} not found for run ${runId}`);
      }
      const explanation = formatDecisionExplanation(decision);
      res.json({ _version: 1, decision, explanation });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/explain/runs/:runId — all decisions for a run
  apiRoute("get", "/explain/runs/:runId", limiter, async (req, res) => {
    try {
      const runId = req.params.runId;
      const decisions = globalDecisionLog.getDecisionsForRun(runId);
      if (decisions.length === 0) {
        return apiError(res, 404, "NOT_FOUND", `No decisions recorded for run ${runId}`);
      }
      res.json({
        _version: 1,
        runId,
        count: decisions.length,
        decisions,
      });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}

export default mountExplainabilityRoutes;
