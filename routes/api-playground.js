/**
 * Phase 61.1: API playground routes.
 *
 * POST /api/v1/playground/save            -- save a request
 * GET  /api/v1/playground/requests/:id    -- load a request
 * GET  /api/v1/playground/requests        -- list saved requests
 * POST /api/v1/playground/generate        -- body { request, language }
 * GET  /api/v1/playground/languages       -- supported languages
 * DELETE /api/v1/playground/requests/:id
 */
import {
  saveRequest,
  loadRequest,
  generateCode,
  listLanguages,
  listSavedRequests,
  deleteRequest,
} from "../lib/api-playground.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "api-playground error");
}

export function mountApiPlaygroundRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;

  apiRoute("post", "/playground/save", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      const saved = await saveRequest(body);
      return res.status(201).json({ _version: 1, request: saved });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("get", "/playground/requests", log, auth, scope("read"), async (_req, res) => {
    try {
      const reqs = await listSavedRequests();
      return res.json({ _version: 1, requests: reqs, count: reqs.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("get", "/playground/requests/:id", log, auth, scope("read"), async (req, res) => {
    try {
      const loaded = await loadRequest(req.params.id);
      if (!loaded) {
        return apiError(res, 404, "NOT_FOUND", `request ${req.params.id} not found`);
      }
      return res.json({ _version: 1, request: loaded });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("delete", "/playground/requests/:id", log, auth, scope("write"), async (req, res) => {
    try {
      const result = await deleteRequest(req.params.id);
      return res.json({ _version: 1, ...result });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("post", "/playground/generate", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.request || typeof body.request !== "object") {
        return apiError(res, 400, "INVALID_INPUT", "request is required");
      }
      if (!body.language || typeof body.language !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "language is required");
      }
      const code = generateCode(body.request, body.language);
      return res.json({ _version: 1, language: body.language, code });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("get", "/playground/languages", log, auth, scope("read"), async (_req, res) => {
    try {
      return res.json({ _version: 1, languages: listLanguages() });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });
}

export default mountApiPlaygroundRoutes;
