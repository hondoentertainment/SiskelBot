/**
 * Phase 52.3: Graph-of-Thought reasoning routes.
 *
 * POST /api/v1/reasoning/got/reason          — run a full reasoning loop
 * POST /api/v1/reasoning/got/expand          — expand one node with an expander
 * POST /api/v1/reasoning/got/merge           — merge two or more thoughts
 * GET  /api/v1/reasoning/got/graph/:id       — fetch a stored graph
 * POST /api/v1/reasoning/got/contradictions  — find contradiction pairs
 * POST /api/v1/reasoning/got/critical-path   — highest-scoring path to a target
 */
import {
  ThoughtGraph,
  expandGraph,
  mergeThoughts,
  findContradictions,
  findCriticalPath,
  reasonWithGraph,
  graphToDot,
  graphToMermaid,
} from "../lib/graph-of-thought.js";

// Very small in-memory store for ephemeral graphs. Durable persistence
// is out of scope for this phase — callers should round-trip via JSON.
const graphStore = new Map();

function saveGraph(graph) {
  const id = `got_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  graphStore.set(id, { id, graph: graph.toJSON(), createdAt: Date.now() });
  return id;
}

function deserializeGraph(json) {
  if (!json || typeof json !== "object") {
    throw new Error("graph payload is required");
  }
  return ThoughtGraph.fromJSON(json);
}

/**
 * Build an expander from a plain-object rule set supplied by the caller.
 * Shape:
 *   { steps: [{ match: "regex", children: [{ thought, edgeType }] }], default: [...] }
 * This keeps the HTTP surface declarative and avoids letting callers
 * inject arbitrary code.
 */
function makeDeclarativeExpander(rules) {
  const steps = Array.isArray(rules?.steps) ? rules.steps : [];
  const fallback = Array.isArray(rules?.default) ? rules.default : [];
  return async (node) => {
    const thought = String(node?.thought || "");
    for (const step of steps) {
      try {
        const re = new RegExp(step.match);
        if (re.test(thought) && Array.isArray(step.children)) {
          return step.children;
        }
      } catch {
        // skip bad regex
      }
    }
    return fallback;
  };
}

export function mountGraphOfThoughtRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;

  // POST /api/v1/reasoning/got/reason
  apiRoute("post", "/reasoning/got/reason", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      const task = body.task;
      if (!task || typeof task !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "task is required");
      }
      const options = body.options || {};
      const rules = options.expander || body.expander;
      if (!rules) {
        return apiError(
          res,
          400,
          "INVALID_INPUT",
          "options.expander (declarative rules) is required",
        );
      }
      const expander = makeDeclarativeExpander(rules);
      const goalPattern = options.goalPattern ? new RegExp(options.goalPattern) : null;
      const goalCheck = goalPattern ? (node) => goalPattern.test(node?.thought || "") : undefined;

      const result = await reasonWithGraph(task, {
        expander,
        maxNodes: Number.isFinite(options.maxNodes) ? options.maxNodes : 20,
        goalCheck,
        seedThought: options.seedThought,
      });

      const graphId = saveGraph(result.graph);
      return res.status(201).json({
        _version: 1,
        graphId,
        graph: result.graph.toJSON(),
        bestPath: result.bestPath,
        answer: result.answer,
        stats: result.stats,
      });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "reasoning error");
    }
  });

  // POST /api/v1/reasoning/got/expand
  apiRoute("post", "/reasoning/got/expand", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.nodeId) return apiError(res, 400, "INVALID_INPUT", "nodeId is required");
      const rules = body.expander;
      if (!rules) return apiError(res, 400, "INVALID_INPUT", "expander rules are required");
      const graph = deserializeGraph(body.graph);
      if (!graph.hasNode(body.nodeId)) {
        return apiError(res, 404, "NOT_FOUND", `node ${body.nodeId} not found`);
      }
      const expander = makeDeclarativeExpander(rules);
      const { added } = await expandGraph(graph, body.nodeId, expander, {
        maxChildren: Number.isFinite(body.maxChildren) ? body.maxChildren : 8,
      });
      return res.json({
        _version: 1,
        graph: graph.toJSON(),
        added,
      });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "expand error");
    }
  });

  // POST /api/v1/reasoning/got/merge
  apiRoute("post", "/reasoning/got/merge", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!Array.isArray(body.nodeIds) || body.nodeIds.length < 2) {
        return apiError(res, 400, "INVALID_INPUT", "nodeIds array (length >= 2) is required");
      }
      const graph = deserializeGraph(body.graph);
      const label = typeof body.label === "string" ? body.label : null;
      const mergedId = mergeThoughts(graph, body.nodeIds, (nodes) => {
        if (label) return label;
        return `merged: ${nodes.map((n) => n.thought).join(" + ")}`;
      });
      return res.status(201).json({
        _version: 1,
        graph: graph.toJSON(),
        mergedId,
      });
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err?.message || "merge error");
    }
  });

  // GET /api/v1/reasoning/got/graph/:id
  apiRoute("get", "/reasoning/got/graph/:id", log, auth, scope("read"), async (req, res) => {
    try {
      const entry = graphStore.get(req.params.id);
      if (!entry) {
        return apiError(res, 404, "NOT_FOUND", `graph ${req.params.id} not found`);
      }
      const g = ThoughtGraph.fromJSON(entry.graph);
      return res.json({
        _version: 1,
        id: entry.id,
        createdAt: entry.createdAt,
        graph: entry.graph,
        dot: graphToDot(g),
        mermaid: graphToMermaid(g),
      });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "graph fetch error");
    }
  });

  // POST /api/v1/reasoning/got/contradictions
  apiRoute("post", "/reasoning/got/contradictions", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      const graph = deserializeGraph(body.graph);
      const contradictions = findContradictions(graph);
      return res.json({
        _version: 1,
        contradictions,
        count: contradictions.length,
      });
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err?.message || "contradictions error");
    }
  });

  // POST /api/v1/reasoning/got/critical-path
  apiRoute("post", "/reasoning/got/critical-path", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.targetId) return apiError(res, 400, "INVALID_INPUT", "targetId is required");
      const graph = deserializeGraph(body.graph);
      if (!graph.hasNode(body.targetId)) {
        return apiError(res, 404, "NOT_FOUND", `node ${body.targetId} not found`);
      }
      const { path, score } = findCriticalPath(graph, body.targetId);
      return res.json({ _version: 1, path, score });
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err?.message || "critical-path error");
    }
  });
}

export default mountGraphOfThoughtRoutes;
