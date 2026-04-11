/**
 * Phase 52.4: Neuro-symbolic SAT/SMT bridge routes.
 *
 * POST /api/v1/neuro-symbolic/sat       -- body { formula }
 * POST /api/v1/neuro-symbolic/linear    -- body { constraints, bounds? }
 * POST /api/v1/neuro-symbolic/check     -- body { spec, model }
 * POST /api/v1/neuro-symbolic/explain   -- body { result }
 * GET  /api/v1/neuro-symbolic/runs/:id
 */
import {
  parseClauses,
  solveSAT,
  solveLinearConstraints,
  checkConstraints,
  explainModel,
  getRun,
} from "../lib/neuro-symbolic.js";

function sendError(apiError, res, err, status = 500) {
  const code =
    status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "neuro-symbolic error");
}

export function mountNeuroSymbolicRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;

  apiRoute("post", "/neuro-symbolic/sat", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      if (body.formula == null) {
        return apiError(res, 400, "INVALID_INPUT", "formula is required");
      }
      const parsed = parseClauses(body.formula);
      const result = await solveSAT(parsed, { persist: Boolean(body.persist) });
      return res.json({ _version: 1, result });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("post", "/neuro-symbolic/linear", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!Array.isArray(body.constraints)) {
        return apiError(res, 400, "INVALID_INPUT", "constraints must be an array");
      }
      const result = await solveLinearConstraints(
        { constraints: body.constraints, bounds: body.bounds || {} },
        { persist: Boolean(body.persist), maxCombinations: body.maxCombinations },
      );
      return res.json({ _version: 1, result });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("post", "/neuro-symbolic/check", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.spec || !body.model) {
        return apiError(res, 400, "INVALID_INPUT", "spec and model are required");
      }
      const report = checkConstraints(body.spec, body.model);
      return res.json({ _version: 1, report });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("post", "/neuro-symbolic/explain", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      const text = explainModel(body.result || {});
      return res.json({ _version: 1, explanation: text });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("get", "/neuro-symbolic/runs/:id", log, auth, scope("read"), async (req, res) => {
    try {
      const run = await getRun(req.params.id);
      if (!run) return apiError(res, 404, "NOT_FOUND", "run not found");
      return res.json({ _version: 1, run });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });
}

export default mountNeuroSymbolicRoutes;
