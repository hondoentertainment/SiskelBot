/**
 * Phase 61.3: Integration harness routes.
 *
 * POST /api/v1/harness/create             -- body { name, steps, setup?, teardown? }
 * GET  /api/v1/harness/list
 * POST /api/v1/harness/run/:name
 * GET  /api/v1/harness/runs
 * POST /api/v1/harness/runs/:runId/outcome -- body { status, note }
 * DELETE /api/v1/harness/runs              -- admin only (clear all)
 * DELETE /api/v1/harness/runs/:name        -- admin only (clear for harness)
 */
import {
  createHarness,
  runHarness,
  listHarnesses,
  recordOutcome,
  clearHarnessRuns,
  listRuns,
} from "../lib/integration-harness.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "integration-harness error");
}

export function mountIntegrationHarnessRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope, adminAuth } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;
  const admin = typeof adminAuth === "function" ? adminAuth : noopAuth;

  apiRoute("post", "/harness/create", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      const harness = await createHarness(body);
      return res.status(201).json({ _version: 1, harness });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("get", "/harness/list", log, auth, scope("read"), async (_req, res) => {
    try {
      const harnesses = await listHarnesses();
      return res.json({ _version: 1, harnesses, count: harnesses.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("post", "/harness/run/:name", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      const run = await runHarness(req.params.name, {
        context: body.context && typeof body.context === "object" ? body.context : undefined,
        stopOnFailure: body.stopOnFailure !== false,
      });
      return res.json({ _version: 1, run });
    } catch (err) {
      const status = /not found/i.test(err?.message || "") ? 404 : 400;
      return sendError(apiError, res, err, status);
    }
  });

  apiRoute("get", "/harness/runs", log, auth, scope("read"), async (req, res) => {
    try {
      const name = typeof req.query?.name === "string" ? req.query.name : undefined;
      const runs = await listRuns(name);
      return res.json({ _version: 1, runs, count: runs.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("post", "/harness/runs/:runId/outcome", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      const run = await recordOutcome(req.params.runId, body);
      return res.json({ _version: 1, run });
    } catch (err) {
      const status = /not found/i.test(err?.message || "") ? 404 : 400;
      return sendError(apiError, res, err, status);
    }
  });

  apiRoute("delete", "/harness/runs", log, admin, async (_req, res) => {
    try {
      const result = await clearHarnessRuns();
      return res.json({ _version: 1, ...result });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("delete", "/harness/runs/:name", log, admin, async (req, res) => {
    try {
      const result = await clearHarnessRuns(req.params.name);
      return res.json({ _version: 1, ...result });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });
}

export default mountIntegrationHarnessRoutes;
