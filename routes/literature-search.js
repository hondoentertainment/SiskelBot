/**
 * Phase 64.1: Literature search routes.
 */
import {
  searchArxiv,
  searchPubmed,
  searchSemanticScholar,
  unifiedSearch,
  recordSearch,
  listSearches,
  listSources,
  LITERATURE_SOURCES,
} from "../lib/literature-search.js";

export function mountLiteratureRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  apiRoute("get", "/literature/sources", adminAuth, logRequest, async (req, res) => {
    try {
      res.json({ sources: listSources() });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("post", "/literature/search", adminAuth, logRequest, async (req, res) => {
    try {
      const { query, sources, limit, workspaceId } = req.body || {};
      if (typeof query !== "string" || !query.trim()) {
        return apiError(res, 400, "INVALID_INPUT", "query is required");
      }
      if (sources != null && !Array.isArray(sources)) {
        return apiError(res, 400, "INVALID_INPUT", "sources must be an array");
      }
      if (Array.isArray(sources)) {
        for (const s of sources) {
          if (!LITERATURE_SOURCES.includes(s)) {
            return apiError(res, 400, "INVALID_INPUT", `invalid source: ${s}`);
          }
        }
      }
      const results = await unifiedSearch({ query, sources, limit });
      if (workspaceId) {
        await recordSearch({ workspaceId, query, results });
      }
      res.status(200).json({ query, sources: sources || LITERATURE_SOURCES.slice(), results });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("post", "/literature/arxiv", adminAuth, logRequest, async (req, res) => {
    try {
      const { query, limit } = req.body || {};
      if (typeof query !== "string" || !query.trim()) {
        return apiError(res, 400, "INVALID_INPUT", "query is required");
      }
      const results = await searchArxiv({ query, limit });
      res.json({ query, source: "arxiv", results });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("post", "/literature/pubmed", adminAuth, logRequest, async (req, res) => {
    try {
      const { query, limit } = req.body || {};
      if (typeof query !== "string" || !query.trim()) {
        return apiError(res, 400, "INVALID_INPUT", "query is required");
      }
      const results = await searchPubmed({ query, limit });
      res.json({ query, source: "pubmed", results });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("post", "/literature/s2", adminAuth, logRequest, async (req, res) => {
    try {
      const { query, limit } = req.body || {};
      if (typeof query !== "string" || !query.trim()) {
        return apiError(res, 400, "INVALID_INPUT", "query is required");
      }
      const results = await searchSemanticScholar({ query, limit });
      res.json({ query, source: "s2", results });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/literature/history", adminAuth, logRequest, async (req, res) => {
    try {
      const entries = await listSearches(req.query?.workspaceId);
      res.json({ searches: entries });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}

export default mountLiteratureRoutes;
