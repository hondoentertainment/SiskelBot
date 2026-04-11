/**
 * Phase 64.3: Citation graph routes.
 */
import {
  addCitation,
  getCitations,
  findPath,
  computePageRank,
  exportGraph,
} from "../lib/citation-graph.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "citation-graph error");
}

export function mountCitationGraphRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope } = deps;
  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_s) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;

  apiRoute("post", "/research/citations/add", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.from || !body.to) return apiError(res, 400, "INVALID_INPUT", "from and to required");
      const edge = await addCitation(body.from, body.to, body.meta || {});
      return res.status(201).json({ _version: 1, edge });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("get", "/research/citations/:id", log, auth, scope("read"), async (req, res) => {
    try {
      const out = await getCitations(req.params.id);
      return res.json({ _version: 1, id: req.params.id, ...out });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("post", "/research/citations/path", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.from || !body.to) return apiError(res, 400, "INVALID_INPUT", "from and to required");
      const maxDepth = Number(body.maxDepth) || 6;
      const path = await findPath(body.from, body.to, maxDepth);
      return res.json({ _version: 1, path, found: !!path });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("get", "/research/citations/pagerank", log, auth, scope("read"), async (req, res) => {
    try {
      const damping = Number(req.query.damping) || 0.85;
      const iterations = Number(req.query.iterations) || 30;
      const ranks = await computePageRank({ damping, iterations });
      return res.json({ _version: 1, ranks });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("get", "/research/citations/export", log, auth, scope("read"), async (req, res) => {
    try {
      const format = req.query.format === "dot" ? "dot" : "json";
      const out = await exportGraph(format);
      if (format === "dot") {
        res.setHeader("Content-Type", "text/vnd.graphviz");
        return res.send(out);
      }
      return res.json({ _version: 1, graph: out });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });
}

export default mountCitationGraphRoutes;
