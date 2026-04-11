/**
 * Phase 64.1: Literature search routes.
 */
import {
  searchLiterature,
  getPaper,
  listProviders,
  cachePaper,
  clearCache,
  listCached,
} from "../lib/literature-search.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "literature-search error");
}

export function mountLiteratureSearchRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope, adminAuth } = deps;
  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_s) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;
  const admin = typeof adminAuth === "function" ? adminAuth : noopAuth;

  apiRoute("get", "/research/literature/providers", log, auth, scope("read"), async (_req, res) => {
    try {
      return res.json({ _version: 1, providers: listProviders() });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("post", "/research/literature/search", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.query) return apiError(res, 400, "INVALID_INPUT", "query required");
      const out = await searchLiterature(body.query, {
        providers: Array.isArray(body.providers) ? body.providers : undefined,
      });
      return res.json({ _version: 1, ...out });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("get", "/research/literature/papers/:id", log, auth, scope("read"), async (req, res) => {
    try {
      const paper = await getPaper(req.params.id);
      if (!paper) return apiError(res, 404, "NOT_FOUND", "paper not found");
      return res.json({ _version: 1, paper });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("post", "/research/literature/cache", log, auth, scope("write"), async (req, res) => {
    try {
      const rec = await cachePaper(req.body || {});
      return res.status(201).json({ _version: 1, paper: rec });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("get", "/research/literature/cache", log, auth, scope("read"), async (_req, res) => {
    try {
      const list = await listCached();
      return res.json({ _version: 1, papers: list, count: list.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("delete", "/research/literature/cache", log, admin, async (_req, res) => {
    try {
      const out = await clearCache();
      return res.json({ _version: 1, ...out });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });
}

export default mountLiteratureSearchRoutes;
