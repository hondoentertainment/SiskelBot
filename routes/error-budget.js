/**
 * Phase 59.5: Error budget routes.
 *
 * POST /api/v1/error-budget/slos              -- body { id, name, target, windowSeconds, minSample?, description? }
 * GET  /api/v1/error-budget/slos
 * GET  /api/v1/error-budget/slos/:id/budget
 * GET  /api/v1/error-budget/slos/:id/exhausted
 * POST /api/v1/error-budget/slos/:id/events   -- body { success }
 */
import {
  defineSlo,
  recordEvent,
  getBudgetRemaining,
  isBudgetExhausted,
  listSlos,
} from "../lib/error-budget.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "error-budget error");
}

export function mountErrorBudgetRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope, adminAuth } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;
  const admin = typeof adminAuth === "function" ? adminAuth : noopAuth;

  // POST /api/v1/error-budget/slos (admin-only)
  apiRoute("post", "/error-budget/slos", log, admin, async (req, res) => {
    try {
      const body = req.body || {};
      const slo = await defineSlo({
        id: body.id,
        name: body.name,
        target: body.target,
        windowSeconds: body.windowSeconds,
        minSample: body.minSample,
        description: body.description,
      });
      return res.status(201).json({ _version: 1, slo });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  // GET /api/v1/error-budget/slos
  apiRoute("get", "/error-budget/slos", log, auth, scope("read"), async (_req, res) => {
    try {
      const slos = await listSlos();
      return res.json({ _version: 1, slos, count: slos.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // GET /api/v1/error-budget/slos/:id/budget
  apiRoute("get", "/error-budget/slos/:id/budget", log, auth, scope("read"), async (req, res) => {
    try {
      const budget = await getBudgetRemaining(req.params.id);
      return res.json({ _version: 1, budget });
    } catch (err) {
      return sendError(apiError, res, err, 404);
    }
  });

  // GET /api/v1/error-budget/slos/:id/exhausted
  apiRoute("get", "/error-budget/slos/:id/exhausted", log, auth, scope("read"), async (req, res) => {
    try {
      const exhausted = await isBudgetExhausted(req.params.id);
      return res.json({ _version: 1, id: req.params.id, exhausted });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/error-budget/slos/:id/events
  apiRoute("post", "/error-budget/slos/:id/events", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (typeof body.success !== "boolean") {
        return apiError(res, 400, "INVALID_INPUT", "success (boolean) is required");
      }
      const slo = await recordEvent(req.params.id, body.success);
      return res.status(201).json({ _version: 1, slo });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });
}

export default mountErrorBudgetRoutes;
