/**
 * Phase 63.4: Refactoring routes.
 */
import {
  planRefactor,
  previewRefactor,
  applyRefactor,
  listRefactors,
  rollbackRefactor,
} from "../lib/refactoring.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "refactoring error");
}

export function mountRefactoringRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope } = deps;
  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_s) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;

  apiRoute("post", "/code/refactor/plan", log, auth, scope("write"), async (req, res) => {
    try {
      const plan = await planRefactor(req.body || {});
      return res.status(201).json({ _version: 1, plan });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("get", "/code/refactor/plans", log, auth, scope("read"), async (_req, res) => {
    try {
      const plans = await listRefactors();
      return res.json({ _version: 1, plans, count: plans.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("post", "/code/refactor/:id/preview", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.files || typeof body.files !== "object") {
        return apiError(res, 400, "INVALID_INPUT", "files required");
      }
      const out = await previewRefactor(req.params.id, body.files);
      return res.json({ _version: 1, ...out });
    } catch (err) {
      const status = /not found/i.test(err?.message || "") ? 404 : 400;
      return sendError(apiError, res, err, status);
    }
  });

  apiRoute("post", "/code/refactor/:id/apply", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.files || typeof body.files !== "object") {
        return apiError(res, 400, "INVALID_INPUT", "files required");
      }
      const out = await applyRefactor(req.params.id, body.files);
      return res.json({ _version: 1, ...out });
    } catch (err) {
      const status = /not found/i.test(err?.message || "") ? 404 : 400;
      return sendError(apiError, res, err, status);
    }
  });

  apiRoute("post", "/code/refactor/:id/rollback", log, auth, scope("write"), async (req, res) => {
    try {
      const files = await rollbackRefactor(req.params.id);
      return res.json({ _version: 1, files });
    } catch (err) {
      const status = /not found/i.test(err?.message || "") ? 404 : 400;
      return sendError(apiError, res, err, status);
    }
  });
}

export default mountRefactoringRoutes;
