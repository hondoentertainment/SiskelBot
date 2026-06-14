/**
 * Phase 47.1: Hierarchical agent routes.
 *
 * POST /api/v1/agent/hierarchy/execute   — run a hierarchical agent
 * GET  /api/v1/agent/hierarchy/runs/:id  — fetch the execution tree for a run
 * GET  /api/v1/agent/workers             — list available worker definitions
 * POST /api/v1/agent/workers             — register a custom worker (admin only)
 */
import {
  executeHierarchy,
  getHierarchyTree,
  formatHierarchyResult,
} from "../lib/agent-hierarchy.js";
import {
  listWorkers,
  getWorker,
  registerWorker,
} from "../lib/worker-agents.js";

export function mountHierarchyRoutes(app, deps) {
  const {
    apiRoute,
    apiError,
    sanitizeWorkspace,
    storageRateLimiter,
    adminAuth,
    backendFetch,
    buildProxyConfig,
  } = deps;

  const limiter = storageRateLimiter || ((req, res, next) => next());

  // POST /api/v1/agent/hierarchy/execute
  apiRoute("post", "/agent/hierarchy/execute", limiter, async (req, res) => {
    try {
      const body = req.body || {};
      const task = typeof body.task === "string" ? body.task.trim() : "";
      if (!task) {
        return apiError(res, 400, "INVALID_INPUT", "task is required");
      }
      const workspaceId = sanitizeWorkspace(body.workspace);
      const workers = Array.isArray(body.workers) ? body.workers.map(String) : undefined;
      const maxDepth = Number.isFinite(body.maxDepth) ? Number(body.maxDepth) : undefined;
      const timeoutMs = Number.isFinite(body.timeoutMs) ? Number(body.timeoutMs) : undefined;
      const model = typeof body.model === "string" ? body.model : undefined;
      const format = body.format === "json" ? "json" : "markdown";

      // Validate worker ids up front so we return a clean 400.
      if (workers) {
        for (const wid of workers) {
          if (!getWorker(wid)) {
            return apiError(res, 400, "INVALID_INPUT", `unknown worker: ${wid}`);
          }
        }
      }

      const result = await executeHierarchy(task, {
        workers,
        maxDepth,
        timeoutMs,
        model,
        workspaceId,
        backendFetch: typeof backendFetch === "function" ? backendFetch : undefined,
        buildProxyConfig: typeof buildProxyConfig === "function" ? buildProxyConfig : undefined,
      });

      res.json({
        _version: 1,
        runId: result.runId,
        result: result.result,
        error: result.error,
        tree: result.tree,
        formatted: formatHierarchyResult(result.tree, format),
        totalTime: result.totalTime,
        agentCount: result.agentCount,
        timedOut: result.timedOut,
      });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/agent/hierarchy/runs/:id
  apiRoute("get", "/agent/hierarchy/runs/:id", limiter, async (req, res) => {
    try {
      const id = String(req.params.id || "").trim();
      if (!id) {
        return apiError(res, 400, "INVALID_INPUT", "run id is required");
      }
      const tree = await getHierarchyTree(id);
      if (!tree) {
        return apiError(res, 404, "NOT_FOUND", "hierarchy run not found");
      }
      res.json({ _version: 1, runId: id, tree });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/agent/workers
  apiRoute("get", "/agent/workers", limiter, async (_req, res) => {
    try {
      const workers = listWorkers().map((w) => ({
        id: w.id,
        description: w.description,
        tools: w.tools,
        maxIterations: w.maxIterations,
        color: w.color,
        builtin: !!w.builtin,
      }));
      res.json({ _version: 1, workers, count: workers.length });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/agent/workers — admin only
  const adminMiddleware = typeof adminAuth === "function" ? adminAuth : (req, res, next) => next();
  apiRoute("post", "/agent/workers", limiter, adminMiddleware, async (req, res) => {
    try {
      const body = req.body || {};
      const id = typeof body.id === "string" ? body.id.trim() : "";
      if (!id) {
        return apiError(res, 400, "INVALID_INPUT", "id is required");
      }
      if (!body.systemPrompt || typeof body.systemPrompt !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "systemPrompt is required");
      }
      const worker = registerWorker(id, {
        description: body.description,
        systemPrompt: body.systemPrompt,
        tools: Array.isArray(body.tools) ? body.tools : [],
        maxIterations: body.maxIterations,
        color: body.color,
      });
      res.status(201).json({ _version: 1, worker });
    } catch (err) {
      if (
        err.message?.includes("required") ||
        err.message?.includes("override")
      ) {
        return apiError(res, 400, "INVALID_INPUT", err.message);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}

export default mountHierarchyRoutes;
