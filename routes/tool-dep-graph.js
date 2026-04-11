/**
 * Phase 53.2: Tool dependency graph routes.
 *
 * POST /api/v1/tools/dep-graph/build        -- body { tools: [...], name? }
 * GET  /api/v1/tools/dep-graph/:name
 * GET  /api/v1/tools/dep-graph
 * POST /api/v1/tools/dep-graph/:name/topo
 * POST /api/v1/tools/dep-graph/:name/cycles
 * POST /api/v1/tools/dep-graph/:name/suggest -- body { from, to }
 * POST /api/v1/tools/dep-graph/:name/validate -- body { pipeline }
 */
import {
  buildGraphFromTools,
  topoSort,
  findCycles,
  suggestPipeline,
  validatePipeline,
  matchTypes,
  saveGraph,
  loadGraph,
  listGraphs,
} from "../lib/tool-dep-graph.js";

function sendError(apiError, res, err, status = 500) {
  const code =
    status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "tool-dep-graph error");
}

export function mountToolDepGraphRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;

  // POST /api/v1/tools/dep-graph/build
  apiRoute("post", "/tools/dep-graph/build", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!Array.isArray(body.tools)) {
        return apiError(res, 400, "INVALID_INPUT", "tools must be an array");
      }
      const graph = buildGraphFromTools(body.tools);
      if (typeof body.name === "string" && body.name.trim()) {
        await saveGraph(body.name.trim(), graph);
      }
      return res.status(201).json({
        _version: 1,
        graph,
        nodeCount: Object.keys(graph.nodes).length,
      });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  // GET /api/v1/tools/dep-graph
  apiRoute("get", "/tools/dep-graph", log, auth, scope("read"), async (_req, res) => {
    try {
      const names = await listGraphs();
      return res.json({ _version: 1, graphs: names, count: names.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // GET /api/v1/tools/dep-graph/:name
  apiRoute("get", "/tools/dep-graph/:name", log, auth, scope("read"), async (req, res) => {
    try {
      const g = await loadGraph(req.params.name);
      if (!g) return apiError(res, 404, "NOT_FOUND", "graph not found");
      return res.json({ _version: 1, graph: g });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/tools/dep-graph/:name/topo
  apiRoute("post", "/tools/dep-graph/:name/topo", log, auth, scope("read"), async (req, res) => {
    try {
      const g = await loadGraph(req.params.name);
      if (!g) return apiError(res, 404, "NOT_FOUND", "graph not found");
      const result = topoSort(g);
      return res.json({ _version: 1, ...result });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/tools/dep-graph/:name/cycles
  apiRoute("post", "/tools/dep-graph/:name/cycles", log, auth, scope("read"), async (req, res) => {
    try {
      const g = await loadGraph(req.params.name);
      if (!g) return apiError(res, 404, "NOT_FOUND", "graph not found");
      const cycles = findCycles(g);
      return res.json({ _version: 1, cycles, count: cycles.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/tools/dep-graph/:name/suggest
  apiRoute("post", "/tools/dep-graph/:name/suggest", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.from || !body.to) {
        return apiError(res, 400, "INVALID_INPUT", "from and to are required");
      }
      const g = await loadGraph(req.params.name);
      if (!g) return apiError(res, 404, "NOT_FOUND", "graph not found");
      const path = suggestPipeline(g, body.from, body.to);
      return res.json({ _version: 1, path });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/tools/dep-graph/:name/validate
  apiRoute("post", "/tools/dep-graph/:name/validate", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      const g = await loadGraph(req.params.name);
      if (!g) return apiError(res, 404, "NOT_FOUND", "graph not found");
      const v = validatePipeline(g, Array.isArray(body.pipeline) ? body.pipeline : []);
      return res.json({ _version: 1, validation: v });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/tools/dep-graph/match
  apiRoute("post", "/tools/dep-graph/match", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      const score = matchTypes(body.src || null, body.dst || null);
      return res.json({ _version: 1, score });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });
}

export default mountToolDepGraphRoutes;
