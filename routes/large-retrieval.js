/**
 * Route module: large-scale retrieval (Phase 68.2).
 *
 * POST   /api/v1/large-retrieval/:index/documents    — indexDocument
 * POST   /api/v1/large-retrieval/:index/search       — searchIndex
 * GET    /api/v1/large-retrieval/:index/stats        — getIndexStats
 * GET    /api/v1/large-retrieval                     — listIndexes
 */
import {
  indexDocument,
  searchIndex,
  getIndexStats,
  listIndexes,
} from "../lib/large-retrieval.js";

function mapErr(err) {
  if (err?.code === "NOT_FOUND") return { status: 404, code: "NOT_FOUND" };
  if (/required/i.test(err?.message || "") || /must/i.test(err?.message || "")) {
    return { status: 400, code: "INVALID_INPUT" };
  }
  return { status: 500, code: "INTERNAL_ERROR" };
}

export function mountLargeRetrievalRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  apiRoute("get", "/large-retrieval", adminAuth, logRequest, async (req, res) => {
    try {
      const indexes = await listIndexes();
      res.json({ indexes });
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("post", "/large-retrieval/:index/documents", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      const result = await indexDocument(req.params.index, {
        id: body.id,
        title: body.title,
        text: body.text,
        metadata: body.metadata,
      }, {
        chunkTokens: body.chunkTokens,
        clusterCount: body.clusterCount,
      });
      res.status(201).json(result);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("post", "/large-retrieval/:index/search", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      const result = await searchIndex(req.params.index, {
        query: body.query,
        topK: body.topK,
        probeClusters: body.probeClusters,
      });
      res.json(result);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("get", "/large-retrieval/:index/stats", adminAuth, logRequest, async (req, res) => {
    try {
      const stats = await getIndexStats(req.params.index);
      if (!stats) return apiError(res, 404, "NOT_FOUND", "index not found");
      res.json(stats);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });
}

export default mountLargeRetrievalRoutes;
