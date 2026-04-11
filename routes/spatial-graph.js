/**
 * Phase 49.2: Spatial knowledge graph routes.
 *
 * GET  /api/v1/spatial/graph/:workspaceId                              — full spatial graph
 * POST /api/v1/spatial/layout                                          — recompute layout on provided graph
 * GET  /api/v1/spatial/graph/:workspaceId/stats                        — spatial graph stats
 * GET  /api/v1/spatial/graph/:workspaceId/node/:nodeId/neighborhood    — neighborhood subgraph
 * POST /api/v1/spatial/graph/:workspaceId/path                         — BFS shortest path
 */
import {
  buildSpatialGraph,
  forceDirectedLayout,
  computeLayoutIncremental,
  projectToSphere,
  clusterNodes,
  computeGraphStats,
  filterGraphByType,
  filterGraphByDegree,
  getNeighborhood,
  pathBetween,
} from "../lib/spatial-graph.js";

function parseTypes(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter(Boolean).map(String);
  return String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseIntQuery(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function parseLayout(value) {
  const v = String(value || "force").toLowerCase();
  return v === "sphere" || v === "grid" ? v : "force";
}

export function mountSpatialGraphRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;

  // GET /api/v1/spatial/graph/:workspaceId
  apiRoute(
    "get",
    "/spatial/graph/:workspaceId",
    log,
    auth,
    scope("read"),
    async (req, res) => {
      try {
        const layout = parseLayout(req.query?.layout);
        const iterations = parseIntQuery(req.query?.iterations, undefined);
        const seed = parseIntQuery(req.query?.seed, undefined);
        const radius = parseIntQuery(req.query?.radius, undefined);
        const types = parseTypes(req.query?.types);
        const minDegree = parseIntQuery(req.query?.minDegree, 0);

        let graph = await buildSpatialGraph(req.params.workspaceId, {
          layout,
          iterations,
          seed,
          radius,
        });

        if (types.length > 0) graph = filterGraphByType(graph, types);
        if (minDegree > 0) graph = filterGraphByDegree(graph, minDegree);

        return res.json({
          _version: 1,
          workspaceId: req.params.workspaceId,
          graph,
          count: graph.nodes.length,
        });
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err?.message || "failed to build spatial graph");
      }
    },
  );

  // POST /api/v1/spatial/layout
  apiRoute("post", "/spatial/layout", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      const nodes = Array.isArray(body.nodes) ? body.nodes : [];
      const edges = Array.isArray(body.edges) ? body.edges : [];
      const layout = parseLayout(body.layout);
      const options = body.options && typeof body.options === "object" ? body.options : {};

      let result;
      if (layout === "sphere") {
        const radius = Number.isFinite(options.radius) ? options.radius : 5;
        result = { nodes: projectToSphere(nodes, radius), edges };
      } else if (body.incremental) {
        result = computeLayoutIncremental(nodes, edges, options);
      } else {
        result = forceDirectedLayout(nodes, edges, options);
      }

      const clustered = clusterNodes(result.nodes, result.edges);
      return res.json({
        _version: 1,
        layout,
        nodes: clustered.nodes,
        edges: clustered.edges,
      });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "failed to compute layout");
    }
  });

  // GET /api/v1/spatial/graph/:workspaceId/stats
  apiRoute(
    "get",
    "/spatial/graph/:workspaceId/stats",
    log,
    auth,
    scope("read"),
    async (req, res) => {
      try {
        const layout = parseLayout(req.query?.layout);
        const graph = await buildSpatialGraph(req.params.workspaceId, { layout });
        const stats = computeGraphStats(graph);
        return res.json({
          _version: 1,
          workspaceId: req.params.workspaceId,
          stats,
        });
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err?.message || "failed to compute stats");
      }
    },
  );

  // GET /api/v1/spatial/graph/:workspaceId/node/:nodeId/neighborhood
  apiRoute(
    "get",
    "/spatial/graph/:workspaceId/node/:nodeId/neighborhood",
    log,
    auth,
    scope("read"),
    async (req, res) => {
      try {
        const depth = parseIntQuery(req.query?.depth, 1);
        const graph = await buildSpatialGraph(req.params.workspaceId, { layout: "force" });
        const neighborhood = getNeighborhood(graph, req.params.nodeId, depth);
        if (neighborhood.nodes.length === 0) {
          return apiError(
            res,
            404,
            "NOT_FOUND",
            `node ${req.params.nodeId} not found in workspace ${req.params.workspaceId}`,
          );
        }
        return res.json({
          _version: 1,
          workspaceId: req.params.workspaceId,
          nodeId: req.params.nodeId,
          depth,
          neighborhood,
        });
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err?.message || "failed to fetch neighborhood");
      }
    },
  );

  // POST /api/v1/spatial/graph/:workspaceId/path
  apiRoute(
    "post",
    "/spatial/graph/:workspaceId/path",
    log,
    auth,
    scope("read"),
    async (req, res) => {
      try {
        const { from, to } = req.body || {};
        if (!from || typeof from !== "string") {
          return apiError(res, 400, "INVALID_INPUT", "from is required");
        }
        if (!to || typeof to !== "string") {
          return apiError(res, 400, "INVALID_INPUT", "to is required");
        }
        const graph = await buildSpatialGraph(req.params.workspaceId, { layout: "force" });
        const path = pathBetween(graph, from, to);
        if (!path) {
          return res.json({
            _version: 1,
            workspaceId: req.params.workspaceId,
            from,
            to,
            found: false,
            path: null,
          });
        }
        return res.json({
          _version: 1,
          workspaceId: req.params.workspaceId,
          from,
          to,
          found: true,
          ...path,
        });
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err?.message || "failed to compute path");
      }
    },
  );
}

export default mountSpatialGraphRoutes;
