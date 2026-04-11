/**
 * Phase 65.5: AI risk scoring routes.
 *
 * GET    /api/v1/ai-risk/dimensions          -- dimension catalog
 * POST   /api/v1/ai-risk/score               -- scoreSystem (no persist)
 * POST   /api/v1/ai-risk/assessments         -- record an assessment
 * GET    /api/v1/ai-risk/assessments         -- list assessments
 * GET    /api/v1/ai-risk/report/:systemName  -- risk report
 */
import {
  scoreSystem,
  listDimensions,
  getRiskReport,
  recordAssessment,
  listAssessments,
} from "../lib/ai-risk-scoring.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "ai-risk-scoring error");
}

export function mountAiRiskScoringRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope, adminAuth } = deps;
  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;
  const admin = typeof adminAuth === "function" ? adminAuth : noopAuth;

  apiRoute("get", "/ai-risk/dimensions", log, auth, scope("read"), async (_req, res) => {
    try {
      const dims = listDimensions();
      return res.json({ _version: 1, dimensions: dims });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("post", "/ai-risk/score", log, auth, scope("read"), async (req, res) => {
    try {
      const scored = scoreSystem(req.body || {});
      return res.json({ _version: 1, result: scored });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("post", "/ai-risk/assessments", log, admin, async (req, res) => {
    try {
      const rec = await recordAssessment(req.body || {});
      return res.status(201).json({ _version: 1, assessment: rec });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("get", "/ai-risk/assessments", log, auth, scope("read"), async (req, res) => {
    try {
      const systemName = typeof req.query.systemName === "string" ? req.query.systemName : undefined;
      const level = typeof req.query.level === "string" ? req.query.level : undefined;
      const limit = Number(req.query.limit);
      const items = await listAssessments({ systemName, level, limit: Number.isFinite(limit) ? limit : undefined });
      return res.json({ _version: 1, items, count: items.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("get", "/ai-risk/report/:systemName", log, auth, scope("read"), async (req, res) => {
    try {
      const report = await getRiskReport(req.params.systemName);
      return res.json({ _version: 1, report });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });
}

export default mountAiRiskScoringRoutes;
