/**
 * Phase 63.1: Repo-level RAG routes.
 */
import {
  indexRepo,
  searchRepo,
  getFunctionByName,
  listFiles,
  rebuildIndex,
} from "../lib/repo-rag.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "repo-rag error");
}

export function mountRepoRagRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope, adminAuth } = deps;
  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_s) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;
  const admin = typeof adminAuth === "function" ? adminAuth : noopAuth;

  apiRoute("post", "/code/repo-rag/index", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!Array.isArray(body.files)) {
        return apiError(res, 400, "INVALID_INPUT", "files array required");
      }
      const result = await indexRepo(body.files);
      return res.status(201).json({ _version: 1, ...result });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("post", "/code/repo-rag/search", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.query) return apiError(res, 400, "INVALID_INPUT", "query required");
      const k = Number(body.k) || 10;
      const language = body.language;
      const results = await searchRepo(body.query, { k, language });
      return res.json({ _version: 1, query: body.query, results, count: results.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("get", "/code/repo-rag/symbol/:name", log, auth, scope("read"), async (req, res) => {
    try {
      const syms = await getFunctionByName(req.params.name);
      if (syms.length === 0) return apiError(res, 404, "NOT_FOUND", `no symbol "${req.params.name}"`);
      return res.json({ _version: 1, name: req.params.name, symbols: syms });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("get", "/code/repo-rag/files", log, auth, scope("read"), async (_req, res) => {
    try {
      const files = await listFiles();
      return res.json({ _version: 1, files, count: files.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("post", "/code/repo-rag/rebuild", log, admin, async (_req, res) => {
    try {
      const result = await rebuildIndex();
      return res.json({ _version: 1, ...result });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });
}

export default mountRepoRagRoutes;
