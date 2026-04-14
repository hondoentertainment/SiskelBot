/**
 * Phase 63.1: Repo-level RAG routes.
 */
import {
  indexRepository,
  searchRepo,
  getRepoStats,
  listRepos,
  removeRepo,
} from "../lib/repo-rag.js";

export function mountRepoRagRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  apiRoute("post", "/repo-rag/index", adminAuth, logRequest, async (req, res) => {
    try {
      const { workspaceId, repoId, files } = req.body || {};
      if (!repoId) return apiError(res, 400, "INVALID_INPUT", "repoId is required");
      if (!Array.isArray(files)) return apiError(res, 400, "INVALID_INPUT", "files must be an array");
      const out = await indexRepository({ workspaceId, repoId, files });
      res.status(201).json(out);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/repo-rag/search", adminAuth, logRequest, async (req, res) => {
    try {
      const out = await searchRepo({
        workspaceId: req.query?.workspaceId,
        query: req.query?.query,
        limit: req.query?.limit ? Number(req.query.limit) : undefined,
      });
      res.json(out);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/repo-rag/stats", adminAuth, logRequest, async (req, res) => {
    try {
      const out = await getRepoStats(req.query?.workspaceId);
      res.json(out);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/repo-rag/repos", adminAuth, logRequest, async (req, res) => {
    try {
      const out = await listRepos(req.query?.workspaceId);
      res.json(out);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("delete", "/repo-rag/repos/:repoId", adminAuth, logRequest, async (req, res) => {
    try {
      const result = await removeRepo({
        workspaceId: req.query?.workspaceId,
        repoId: req.params?.repoId,
      });
      if (!result.removed) return apiError(res, 404, "NOT_FOUND", "repo not found");
      res.status(204).end();
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}

export default mountRepoRagRoutes;
