/**
 * Phase 64.3: Citation graph routes.
 */
import {
  addPaper,
  addCitation,
  getNeighbors,
  getSubgraph,
  findShortestPath,
  listPapers,
  getCitationCount,
  VALID_DIRECTIONS,
} from "../lib/citation-graph.js";

export function mountCitationGraphRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  apiRoute("post", "/citation-graph/papers", adminAuth, logRequest, async (req, res) => {
    try {
      const { workspaceId, paperId, metadata } = req.body || {};
      if (!paperId) return apiError(res, 400, "INVALID_INPUT", "paperId is required");
      const record = await addPaper({ workspaceId, paperId, metadata });
      res.status(201).json(record);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("post", "/citation-graph/citations", adminAuth, logRequest, async (req, res) => {
    try {
      const { workspaceId, citerId, citedId } = req.body || {};
      if (!citerId) return apiError(res, 400, "INVALID_INPUT", "citerId is required");
      if (!citedId) return apiError(res, 400, "INVALID_INPUT", "citedId is required");
      const record = await addCitation({ workspaceId, citerId, citedId });
      res.status(201).json(record);
    } catch (err) {
      if (/must differ/.test(err.message)) {
        return apiError(res, 400, "INVALID_INPUT", err.message);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/citation-graph/papers", adminAuth, logRequest, async (req, res) => {
    try {
      const entries = await listPapers(req.query?.workspaceId);
      res.json({ papers: entries });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/citation-graph/path", adminAuth, logRequest, async (req, res) => {
    try {
      const { workspaceId, from, to } = req.query || {};
      if (!from) return apiError(res, 400, "INVALID_INPUT", "from is required");
      if (!to) return apiError(res, 400, "INVALID_INPUT", "to is required");
      const path = await findShortestPath({ workspaceId, fromId: from, toId: to });
      res.json({ from, to, path, found: Array.isArray(path) });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/citation-graph/:paperId/neighbors", adminAuth, logRequest, async (req, res) => {
    try {
      const direction = req.query?.direction;
      if (direction && !VALID_DIRECTIONS.includes(direction)) {
        return apiError(res, 400, "INVALID_INPUT", `direction must be one of ${VALID_DIRECTIONS.join(", ")}`);
      }
      const neighbors = await getNeighbors({
        workspaceId: req.query?.workspaceId,
        paperId: req.params.paperId,
        direction,
      });
      res.json({ paperId: req.params.paperId, direction: direction || "both", neighbors });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/citation-graph/:paperId/subgraph", adminAuth, logRequest, async (req, res) => {
    try {
      const depth = req.query?.depth ? Number(req.query.depth) : 1;
      const graph = await getSubgraph({
        workspaceId: req.query?.workspaceId,
        paperId: req.params.paperId,
        depth,
      });
      res.json({ paperId: req.params.paperId, depth, ...graph });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/citation-graph/:paperId/count", adminAuth, logRequest, async (req, res) => {
    try {
      const count = await getCitationCount({
        workspaceId: req.query?.workspaceId,
        paperId: req.params.paperId,
      });
      res.json(count);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}

export default mountCitationGraphRoutes;
