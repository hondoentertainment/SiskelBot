/**
 * Phase 57.2: Data quality routes.
 *
 * POST /api/v1/data-quality/drift             -- compute drift on a pair
 * POST /api/v1/data-quality/rules              -- add a rule
 * GET  /api/v1/data-quality/rules              -- list rules
 * POST /api/v1/data-quality/evaluate/:metric   -- evaluate rules for a metric
 * GET  /api/v1/data-quality/reports/:name      -- latest drift report
 * POST /api/v1/data-quality/reports/:name      -- record a drift report
 */
import {
  computeDrift,
  addRule,
  evaluateRules,
  getDriftReport,
  recordDriftReport,
  listRules,
} from "../lib/data-quality.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "data-quality error");
}

export function mountDataQualityRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;

  apiRoute("post", "/data-quality/drift", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!Array.isArray(body.baseline) || !Array.isArray(body.current)) {
        return apiError(res, 400, "INVALID_INPUT", "baseline and current arrays required");
      }
      const report = computeDrift(body.baseline, body.current, {
        ksThreshold: body.ksThreshold,
        psiThreshold: body.psiThreshold,
        bins: body.bins,
      });
      return res.json({ _version: 1, report });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("post", "/data-quality/rules", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.name || !body.rule) {
        return apiError(res, 400, "INVALID_INPUT", "name and rule required");
      }
      const r = await addRule(body.name, body.rule);
      return res.status(201).json({ _version: 1, rule: r });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("get", "/data-quality/rules", log, auth, scope("read"), async (_req, res) => {
    try {
      const rules = await listRules();
      return res.json({ _version: 1, rules, count: rules.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("post", "/data-quality/evaluate/:metric", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!Array.isArray(body.values)) {
        return apiError(res, 400, "INVALID_INPUT", "values array required");
      }
      const out = await evaluateRules(req.params.metric, body.values);
      return res.json({ _version: 1, evaluation: out });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("get", "/data-quality/reports/:name", log, auth, scope("read"), async (req, res) => {
    try {
      const rep = await getDriftReport(req.params.name);
      if (!rep) return apiError(res, 404, "NOT_FOUND", `no report for "${req.params.name}"`);
      return res.json({ _version: 1, report: rep });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("post", "/data-quality/reports/:name", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.report) {
        return apiError(res, 400, "INVALID_INPUT", "report required");
      }
      const out = await recordDriftReport(req.params.name, body.report);
      return res.status(201).json({ _version: 1, report: out });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });
}

export default mountDataQualityRoutes;
