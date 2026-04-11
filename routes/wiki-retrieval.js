/**
 * Phase 68.2: Wiki retrieval routes.
 *
 * POST /api/v1/wiki/articles        -- index an article
 * GET  /api/v1/wiki/articles        -- list articles
 * GET  /api/v1/wiki/articles/:id    -- fetch one article
 * POST /api/v1/wiki/search          -- body { query, k?, tag? }
 * DELETE /api/v1/wiki/articles      -- clear index (admin)
 */
import {
  indexArticle,
  searchArticles,
  getArticle,
  listArticles,
  clearIndex,
} from "../lib/wiki-retrieval.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "wiki-retrieval error");
}

export function mountWikiRetrievalRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope, adminAuth } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;
  const admin = typeof adminAuth === "function" ? adminAuth : noopAuth;

  apiRoute("post", "/wiki/articles", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      const rec = await indexArticle(body);
      return res.status(201).json({ _version: 1, article: { id: rec.id, title: rec.title, updatedAt: rec.updatedAt } });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("get", "/wiki/articles", log, auth, scope("read"), async (_req, res) => {
    try {
      const items = await listArticles();
      return res.json({ _version: 1, articles: items, count: items.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("get", "/wiki/articles/:id", log, auth, scope("read"), async (req, res) => {
    try {
      const rec = await getArticle(req.params.id);
      if (!rec) return apiError(res, 404, "NOT_FOUND", "article not found");
      return res.json({ _version: 1, article: rec });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("post", "/wiki/search", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      const query = typeof body.query === "string" ? body.query : "";
      if (!query.trim()) return apiError(res, 400, "INVALID_INPUT", "query is required");
      const k = Number.isFinite(body.k) && body.k > 0 ? Math.floor(body.k) : 5;
      const tag = typeof body.tag === "string" ? body.tag : undefined;
      const results = await searchArticles(query, { k, tag });
      return res.json({ _version: 1, query, results, count: results.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("delete", "/wiki/articles", log, admin, async (_req, res) => {
    try {
      const r = await clearIndex();
      return res.json({ _version: 1, ...r });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });
}

export default mountWikiRetrievalRoutes;
