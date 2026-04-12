/**
 * Route module: error budget enforcement (Phase 59.5).
 *
 * Separate path prefix from routes/slo.js (which uses /api/v1/slo) — this
 * module uses /api/v1/error-budget/* so the two can coexist.
 *
 * POST   /api/v1/error-budget/slo                      — admin create SLO
 * GET    /api/v1/error-budget/slos                     — list SLOs
 * GET    /api/v1/error-budget/slo/:name                — get SLO
 * PUT    /api/v1/error-budget/slo/:name                — admin update SLO
 * DELETE /api/v1/error-budget/slo/:name                — admin delete SLO
 * POST   /api/v1/error-budget/slo/:name/event          — record event
 * GET    /api/v1/error-budget/slo/:name/budget         — current budget
 * GET    /api/v1/error-budget/slo/:name/burn-rate      — single-window burn rate
 * GET    /api/v1/error-budget/slo/:name/burn-rate/history — multi-window burn rate
 * POST   /api/v1/error-budget/slo/:name/policy         — admin set policy
 * GET    /api/v1/error-budget/slo/:name/policy         — get policy
 * GET    /api/v1/error-budget/slo/:name/enforcement    — check enforcement
 * POST   /api/v1/error-budget/slo/:name/action         — record action
 * GET    /api/v1/error-budget/slo/:name/actions        — action history
 * GET    /api/v1/error-budget/slo/:name/projection     — exhaustion projection
 */

import {
  createSlo,
  getSlo,
  listSlos,
  deleteSlo,
  updateSlo,
  recordEvent,
  getErrorBudget,
  getBurnRate,
  getBurnRateHistory,
  setEnforcementPolicy,
  getEnforcementPolicy,
  checkEnforcement,
  recordBudgetAction,
  getActionHistory,
  projectExhaustion,
  ENFORCEMENT_ACTIONS,
} from "../lib/error-budget.js";

export function mountErrorBudgetRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, chatAuth, requireScope } = deps;

  function handleKnownError(res, err) {
    if (err?.code === "ALREADY_EXISTS") {
      return apiError(res, 409, "ALREADY_EXISTS", err.message);
    }
    if (err?.code === "NOT_FOUND") {
      return apiError(res, 404, "NOT_FOUND", err.message);
    }
    return apiError(res, 500, "INTERNAL_ERROR", err.message);
  }

  // POST /api/v1/error-budget/slo — admin create
  apiRoute(
    "post",
    "/error-budget/slo",
    chatAuth,
    requireScope("admin"),
    logRequest,
    async (req, res) => {
      try {
        const body = req.body || {};
        if (!body.name || typeof body.name !== "string") {
          return apiError(res, 400, "INVALID_INPUT", "name is required.");
        }
        const rec = await createSlo(body);
        res.status(201).json(rec);
      } catch (err) {
        if (err?.code === "ALREADY_EXISTS") return handleKnownError(res, err);
        return apiError(res, 400, "INVALID_INPUT", err.message);
      }
    },
  );

  // GET /api/v1/error-budget/slos
  apiRoute(
    "get",
    "/error-budget/slos",
    chatAuth,
    requireScope("read"),
    logRequest,
    async (req, res) => {
      try {
        const filter = {};
        if (typeof req.query?.severity === "string") filter.severity = req.query.severity;
        if (typeof req.query?.sliType === "string") filter.sliType = req.query.sliType;
        const records = await listSlos(filter);
        res.json({ slos: records, count: records.length });
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message);
      }
    },
  );

  // GET /api/v1/error-budget/slo/:name
  apiRoute(
    "get",
    "/error-budget/slo/:name",
    chatAuth,
    requireScope("read"),
    logRequest,
    async (req, res) => {
      try {
        const rec = await getSlo(req.params.name);
        if (!rec) return apiError(res, 404, "NOT_FOUND", `SLO ${req.params.name} not found`);
        res.json(rec);
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message);
      }
    },
  );

  // PUT /api/v1/error-budget/slo/:name — admin update
  apiRoute(
    "put",
    "/error-budget/slo/:name",
    chatAuth,
    requireScope("admin"),
    logRequest,
    async (req, res) => {
      try {
        const updated = await updateSlo(req.params.name, req.body || {});
        res.json(updated);
      } catch (err) {
        if (err?.code === "NOT_FOUND") return handleKnownError(res, err);
        return apiError(res, 400, "INVALID_INPUT", err.message);
      }
    },
  );

  // DELETE /api/v1/error-budget/slo/:name — admin delete
  apiRoute(
    "delete",
    "/error-budget/slo/:name",
    chatAuth,
    requireScope("admin"),
    logRequest,
    async (req, res) => {
      try {
        const result = await deleteSlo(req.params.name);
        if (!result.ok) {
          return apiError(res, 404, "NOT_FOUND", `SLO ${req.params.name} not found`);
        }
        res.json(result);
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message);
      }
    },
  );

  // POST /api/v1/error-budget/slo/:name/event — record event
  apiRoute(
    "post",
    "/error-budget/slo/:name/event",
    chatAuth,
    requireScope("write"),
    logRequest,
    async (req, res) => {
      try {
        const body = req.body || {};
        if (typeof body.success !== "boolean") {
          return apiError(res, 400, "INVALID_INPUT", "success must be a boolean.");
        }
        const rec = await recordEvent(req.params.name, {
          success: body.success,
          latencyMs: body.latencyMs,
          errorCode: body.errorCode,
          timestamp: body.timestamp,
        });
        res.status(201).json(rec);
      } catch (err) {
        if (err?.code === "NOT_FOUND") return handleKnownError(res, err);
        return apiError(res, 400, "INVALID_INPUT", err.message);
      }
    },
  );

  // GET /api/v1/error-budget/slo/:name/budget
  apiRoute(
    "get",
    "/error-budget/slo/:name/budget",
    chatAuth,
    requireScope("read"),
    logRequest,
    async (req, res) => {
      try {
        const budget = await getErrorBudget(req.params.name);
        res.json(budget);
      } catch (err) {
        return handleKnownError(res, err);
      }
    },
  );

  // GET /api/v1/error-budget/slo/:name/burn-rate
  apiRoute(
    "get",
    "/error-budget/slo/:name/burn-rate",
    chatAuth,
    requireScope("read"),
    logRequest,
    async (req, res) => {
      try {
        const windowMsRaw = Number(req.query?.windowMs);
        const windowMs = Number.isFinite(windowMsRaw) && windowMsRaw > 0 ? windowMsRaw : undefined;
        const br = await getBurnRate(req.params.name, windowMs);
        res.json(br);
      } catch (err) {
        return handleKnownError(res, err);
      }
    },
  );

  // GET /api/v1/error-budget/slo/:name/burn-rate/history
  apiRoute(
    "get",
    "/error-budget/slo/:name/burn-rate/history",
    chatAuth,
    requireScope("read"),
    logRequest,
    async (req, res) => {
      try {
        const hist = await getBurnRateHistory(req.params.name);
        res.json(hist);
      } catch (err) {
        return handleKnownError(res, err);
      }
    },
  );

  // POST /api/v1/error-budget/slo/:name/policy — admin set policy
  apiRoute(
    "post",
    "/error-budget/slo/:name/policy",
    chatAuth,
    requireScope("admin"),
    logRequest,
    async (req, res) => {
      try {
        const body = req.body || {};
        if (!Array.isArray(body.thresholds)) {
          return apiError(res, 400, "INVALID_INPUT", "thresholds must be an array.");
        }
        const policy = await setEnforcementPolicy(req.params.name, body);
        res.status(201).json(policy);
      } catch (err) {
        if (err?.code === "NOT_FOUND") return handleKnownError(res, err);
        return apiError(res, 400, "INVALID_INPUT", err.message);
      }
    },
  );

  // GET /api/v1/error-budget/slo/:name/policy
  apiRoute(
    "get",
    "/error-budget/slo/:name/policy",
    chatAuth,
    requireScope("read"),
    logRequest,
    async (req, res) => {
      try {
        const slo = await getSlo(req.params.name);
        if (!slo) return apiError(res, 404, "NOT_FOUND", `SLO ${req.params.name} not found`);
        const policy = await getEnforcementPolicy(req.params.name);
        res.json(policy || { thresholds: [] });
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message);
      }
    },
  );

  // GET /api/v1/error-budget/slo/:name/enforcement
  apiRoute(
    "get",
    "/error-budget/slo/:name/enforcement",
    chatAuth,
    requireScope("read"),
    logRequest,
    async (req, res) => {
      try {
        const results = await checkEnforcement(req.params.name);
        res.json({
          name: req.params.name,
          supportedActions: ENFORCEMENT_ACTIONS,
          results,
        });
      } catch (err) {
        return handleKnownError(res, err);
      }
    },
  );

  // POST /api/v1/error-budget/slo/:name/action — record executed action
  apiRoute(
    "post",
    "/error-budget/slo/:name/action",
    chatAuth,
    requireScope("write"),
    logRequest,
    async (req, res) => {
      try {
        const body = req.body || {};
        if (!ENFORCEMENT_ACTIONS.includes(body.action)) {
          return apiError(res, 400, "INVALID_INPUT", `action must be one of: ${ENFORCEMENT_ACTIONS.join(", ")}`);
        }
        const entry = await recordBudgetAction(req.params.name, body.action, body.context || {});
        res.status(201).json(entry);
      } catch (err) {
        if (err?.code === "NOT_FOUND") return handleKnownError(res, err);
        return apiError(res, 400, "INVALID_INPUT", err.message);
      }
    },
  );

  // GET /api/v1/error-budget/slo/:name/actions
  apiRoute(
    "get",
    "/error-budget/slo/:name/actions",
    chatAuth,
    requireScope("read"),
    logRequest,
    async (req, res) => {
      try {
        const slo = await getSlo(req.params.name);
        if (!slo) return apiError(res, 404, "NOT_FOUND", `SLO ${req.params.name} not found`);
        const history = await getActionHistory(req.params.name);
        res.json({ name: req.params.name, actions: history });
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message);
      }
    },
  );

  // GET /api/v1/error-budget/slo/:name/projection
  apiRoute(
    "get",
    "/error-budget/slo/:name/projection",
    chatAuth,
    requireScope("read"),
    logRequest,
    async (req, res) => {
      try {
        const slo = await getSlo(req.params.name);
        if (!slo) return apiError(res, 404, "NOT_FOUND", `SLO ${req.params.name} not found`);
        const budget = await getErrorBudget(req.params.name);
        const projection = projectExhaustion(slo, budget.burnRate);
        res.json({
          name: slo.name,
          currentBurnRate: budget.burnRate,
          remaining: budget.remaining,
          remainingFraction: budget.remainingFraction,
          ...projection,
        });
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message);
      }
    },
  );
}

export default mountErrorBudgetRoutes;
