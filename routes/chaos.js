/**
 * Phase 59.1: Chaos engineering routes.
 *
 * POST /api/v1/chaos/faults         -- body { target, type, probability, ... }
 * GET  /api/v1/chaos/faults         -- ?target=...
 * POST /api/v1/chaos/inject         -- body { target }
 * DELETE /api/v1/chaos/faults/:id
 * POST /api/v1/chaos/experiments    -- body { target, type, probability, iterations? }
 * GET  /api/v1/chaos/experiments    -- list experiment history
 */
import {
  registerFault,
  injectFault,
  removeFault,
  listActiveFaults,
  runChaosExperiment,
  listChaosExperiments,
} from "../lib/chaos.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "chaos error");
}

export function mountChaosRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope, adminAuth } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;
  const admin = typeof adminAuth === "function" ? adminAuth : noopAuth;

  // POST /api/v1/chaos/faults (admin-only: destructive)
  apiRoute("post", "/chaos/faults", log, admin, async (req, res) => {
    try {
      const body = req.body || {};
      const f = await registerFault({
        target: body.target,
        type: body.type,
        probability: body.probability,
        latencyMs: body.latencyMs,
        errorMessage: body.errorMessage,
        partialRatio: body.partialRatio,
      });
      return res.status(201).json({ _version: 1, fault: f });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  // GET /api/v1/chaos/faults
  apiRoute("get", "/chaos/faults", log, auth, scope("read"), async (req, res) => {
    try {
      const target = typeof req.query?.target === "string" ? req.query.target : undefined;
      const faults = await listActiveFaults(target);
      return res.json({ _version: 1, faults, count: faults.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/chaos/inject
  apiRoute("post", "/chaos/inject", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.target || typeof body.target !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "target is required");
      }
      const decision = await injectFault(body.target, body.ctx || {});
      return res.json({ _version: 1, decision });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // DELETE /api/v1/chaos/faults/:id (admin-only)
  apiRoute("delete", "/chaos/faults/:id", log, admin, async (req, res) => {
    try {
      const rec = await removeFault(req.params.id);
      if (!rec) return apiError(res, 404, "NOT_FOUND", `fault not found: ${req.params.id}`);
      return res.json({ _version: 1, removed: rec });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/chaos/experiments (admin-only)
  apiRoute("post", "/chaos/experiments", log, admin, async (req, res) => {
    try {
      const body = req.body || {};
      const result = await runChaosExperiment(
        {
          target: body.target,
          type: body.type,
          probability: body.probability,
          latencyMs: body.latencyMs,
          errorMessage: body.errorMessage,
          partialRatio: body.partialRatio,
        },
        (decision, idx) => ({ decision, idx }),
        {
          iterations: Number.isFinite(body.iterations) ? Number(body.iterations) : 10,
        },
      );
      return res.json({ _version: 1, experiment: result });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  // GET /api/v1/chaos/experiments
  apiRoute("get", "/chaos/experiments", log, auth, scope("read"), async (_req, res) => {
    try {
      const experiments = await listChaosExperiments();
      return res.json({ _version: 1, experiments, count: experiments.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });
}

export default mountChaosRoutes;
