/**
 * Phase 55.4: Filesystem agent with dry-run routes.
 *
 * POST /api/v1/filesystem-agent/plan       -- body { operations }
 * POST /api/v1/filesystem-agent/preview    -- body { plan } | { operations }
 * POST /api/v1/filesystem-agent/apply      -- body { plan, dryRun? } | { operations, dryRun? }
 */
import {
  planFsOperations,
  previewFsPlan,
  applyFsPlan,
  fsOpAllowed,
} from "../lib/filesystem-agent.js";

function sendError(apiError, res, err, status = 500) {
  const code =
    status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "filesystem-agent error");
}

function resolvePlanFromBody(body) {
  if (body && body.plan && Array.isArray(body.plan.operations)) return body.plan;
  if (body && Array.isArray(body.operations)) return planFsOperations(body.operations);
  throw new Error("plan or operations[] required");
}

export function mountFilesystemAgentRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope, adminAuth } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;
  const admin = typeof adminAuth === "function" ? adminAuth : noopAuth;

  apiRoute("post", "/filesystem-agent/plan", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!Array.isArray(body.operations)) {
        return apiError(res, 400, "INVALID_INPUT", "operations must be an array");
      }
      for (const op of body.operations) {
        if (!fsOpAllowed(op)) {
          return apiError(res, 400, "INVALID_INPUT", `operation has invalid op: ${op && op.op}`);
        }
      }
      const plan = planFsOperations(body.operations);
      return res.status(201).json({ _version: 1, plan });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("post", "/filesystem-agent/preview", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      const plan = resolvePlanFromBody(body);
      const preview = previewFsPlan(plan);
      return res.json({ _version: 1, plan, preview });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("post", "/filesystem-agent/apply", log, admin, async (req, res) => {
    try {
      const body = req.body || {};
      const plan = resolvePlanFromBody(body);
      const result = await applyFsPlan(plan, { dryRun: Boolean(body.dryRun) });
      return res.json({ _version: 1, result });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });
}

export default mountFilesystemAgentRoutes;
