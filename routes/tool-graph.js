/**
 * Phase 53.2: Tool dependency graph routes.
 *
 * POST /api/v1/tools/graph/build      — build a graph from a tool catalog
 * POST /api/v1/tools/graph/pipeline   — infer a pipeline toward a goal type
 * POST /api/v1/tools/graph/execute    — run a pipeline with a user-echo executor
 * POST /api/v1/tools/graph/validate   — validate a pipeline against the graph
 * POST /api/v1/tools/graph/save       — persist a named pipeline
 * GET  /api/v1/tools/graph/:name      — fetch a saved pipeline by name
 * GET  /api/v1/tools/graph            — list saved pipelines
 */
import {
  ToolGraph,
  buildPipeline,
  validatePipeline,
  executePipeline,
  graphToMermaid,
  savePipeline,
  getPipeline,
  listPipelines,
} from "../lib/tool-graph.js";

function mapErrorStatus(message) {
  const m = String(message || "");
  if (/not found/i.test(m)) return 404;
  if (/required|must be|invalid|unknown|incompatible|cycle|empty/i.test(m)) return 400;
  return 500;
}

function sendError(apiError, res, err) {
  const status = mapErrorStatus(err?.message);
  const code = status === 404 ? "NOT_FOUND" : status === 400 ? "INVALID_INPUT" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "tool-graph error");
}

function buildGraphFromBody(tools) {
  if (!Array.isArray(tools) || tools.length === 0) {
    throw new Error("tools array is required");
  }
  const g = new ToolGraph();
  for (const t of tools) g.addTool(t);
  g.autoConnect();
  return g;
}

export function mountToolGraphRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;

  // POST /api/v1/tools/graph/build
  apiRoute("post", "/tools/graph/build", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      const graph = buildGraphFromBody(body.tools);
      let order = null;
      try {
        order = graph.topoSort();
      } catch (_) {
        order = null;
      }
      return res.json({
        _version: 1,
        graph: graph.toJSON(),
        order,
        hasCycle: graph.hasCycle(),
        mermaid: graphToMermaid(graph),
      });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/tools/graph/pipeline
  apiRoute("post", "/tools/graph/pipeline", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.goal) {
        return apiError(res, 400, "INVALID_INPUT", "goal is required");
      }
      if (!Array.isArray(body.tools) || body.tools.length === 0) {
        return apiError(res, 400, "INVALID_INPUT", "tools array is required");
      }
      const pipeline = buildPipeline(body.goal, body.tools);
      if (!pipeline) {
        return res.json({ _version: 1, pipeline: null, reachable: false });
      }
      return res.json({ _version: 1, pipeline, reachable: true });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/tools/graph/execute
  //
  // Because real tool execution requires workspace-scoped credentials and
  // backend routing, this endpoint runs a pipeline through an echo executor
  // that records the handoff shape. It is primarily a dry-run / debugging
  // surface, not an agent-loop replacement.
  apiRoute("post", "/tools/graph/execute", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!Array.isArray(body.pipeline) || body.pipeline.length === 0) {
        return apiError(res, 400, "INVALID_INPUT", "pipeline must be a non-empty array");
      }
      const echoExecutor = async (toolName, input) => ({ tool: toolName, echo: input });
      const result = await executePipeline(body.pipeline, body.input ?? null, echoExecutor);
      return res.json({ _version: 1, ...result });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/tools/graph/validate
  apiRoute("post", "/tools/graph/validate", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!Array.isArray(body.pipeline)) {
        return apiError(res, 400, "INVALID_INPUT", "pipeline must be an array");
      }
      let graph;
      if (Array.isArray(body.tools) && body.tools.length > 0) {
        graph = buildGraphFromBody(body.tools);
      } else if (body.graph && typeof body.graph === "object") {
        graph = ToolGraph.fromJSON(body.graph);
      } else {
        return apiError(res, 400, "INVALID_INPUT", "tools or graph is required");
      }
      const result = validatePipeline(body.pipeline, graph);
      return res.json({ _version: 1, ...result });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/tools/graph/save
  apiRoute("post", "/tools/graph/save", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.name || typeof body.name !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "name is required");
      }
      if (!Array.isArray(body.pipeline)) {
        return apiError(res, 400, "INVALID_INPUT", "pipeline must be an array");
      }
      let graph = null;
      if (body.graph && typeof body.graph === "object") {
        graph = ToolGraph.fromJSON(body.graph);
      } else if (Array.isArray(body.tools) && body.tools.length > 0) {
        graph = buildGraphFromBody(body.tools);
      }
      const saved = await savePipeline(body.name, body.pipeline, graph);
      return res.status(201).json({ _version: 1, pipeline: saved });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // GET /api/v1/tools/graph — list saved pipelines
  // Registered before /:name so Express does not capture "graph" as :name.
  apiRoute("get", "/tools/graph", log, auth, scope("read"), async (_req, res) => {
    try {
      const items = await listPipelines();
      return res.json({ _version: 1, pipelines: items, count: items.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // GET /api/v1/tools/graph/:name
  apiRoute("get", "/tools/graph/:name", log, auth, scope("read"), async (req, res) => {
    try {
      const item = await getPipeline(req.params.name);
      if (!item) {
        return apiError(res, 404, "NOT_FOUND", `pipeline ${req.params.name} not found`);
      }
      return res.json({ _version: 1, pipeline: item });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });
}

export default mountToolGraphRoutes;
