/**
 * Phase 53.1: Tool RAG routes.
 *
 * POST /api/v1/tools/rag/retrieve     -- body { query, k?, tags?, minScore? }
 * POST /api/v1/tools/rag/for-task     -- body { task, k?, tags?, minScore? }
 * POST /api/v1/tools/rag/register     -- body { name, metadata }
 * GET  /api/v1/tools/rag/list         -- all registered tools
 * POST /api/v1/tools/rag/usage        -- body { name, context }
 * GET  /api/v1/tools/rag/usage/:name  -- usage stats for one tool
 * POST /api/v1/tools/rag/rebuild      -- admin rebuild of the default index
 */
import {
  retrieveTools,
  retrieveToolsForTask,
  registerToolMetadata,
  listRegisteredTools,
  recordToolUsage,
  getToolUsageStats,
  getAllToolUsage,
  rebuildDefaultIndex,
  reRankByUsage,
} from "../lib/tool-rag.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "tool-rag error");
}

export function mountToolRagRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope, adminAuth } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;
  const admin = typeof adminAuth === "function" ? adminAuth : noopAuth;

  // POST /api/v1/tools/rag/retrieve
  apiRoute("post", "/tools/rag/retrieve", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      const query = typeof body.query === "string" ? body.query : "";
      if (!query.trim()) {
        return apiError(res, 400, "INVALID_INPUT", "query is required");
      }
      const k = Number.isFinite(body.k) && body.k > 0 ? Math.floor(body.k) : 5;
      const minScore = Number.isFinite(body.minScore) ? body.minScore : 0;
      const tags = Array.isArray(body.tags) ? body.tags : undefined;
      let results = await retrieveTools(query, { k, minScore, tags });
      if (body.rerankByUsage) {
        const usage = await getAllToolUsage();
        results = reRankByUsage(results, usage);
      }
      return res.json({ _version: 1, query, results, count: results.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/tools/rag/for-task
  apiRoute("post", "/tools/rag/for-task", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      const task = typeof body.task === "string" ? body.task : "";
      if (!task.trim()) {
        return apiError(res, 400, "INVALID_INPUT", "task is required");
      }
      const k = Number.isFinite(body.k) && body.k > 0 ? Math.floor(body.k) : 5;
      const minScore = Number.isFinite(body.minScore) ? body.minScore : 0;
      const tags = Array.isArray(body.tags) ? body.tags : undefined;
      let results = await retrieveToolsForTask(task, { k, minScore, tags });
      if (body.rerankByUsage) {
        const usage = await getAllToolUsage();
        results = reRankByUsage(results, usage);
      }
      return res.json({ _version: 1, task, results, count: results.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/tools/rag/register
  apiRoute("post", "/tools/rag/register", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.name || typeof body.name !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "name is required");
      }
      if (!body.metadata || typeof body.metadata !== "object") {
        return apiError(res, 400, "INVALID_INPUT", "metadata is required");
      }
      const meta = await registerToolMetadata(body.name, body.metadata);
      return res.status(201).json({ _version: 1, tool: meta });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // GET /api/v1/tools/rag/list
  apiRoute("get", "/tools/rag/list", log, auth, scope("read"), async (_req, res) => {
    try {
      const tools = await listRegisteredTools();
      return res.json({ _version: 1, tools, count: tools.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/tools/rag/usage
  apiRoute("post", "/tools/rag/usage", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.name || typeof body.name !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "name is required");
      }
      const ctx = body.context && typeof body.context === "object" ? body.context : {};
      const stats = await recordToolUsage(body.name, ctx);
      return res.status(201).json({ _version: 1, name: body.name, stats });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // GET /api/v1/tools/rag/usage/:name
  apiRoute("get", "/tools/rag/usage/:name", log, auth, scope("read"), async (req, res) => {
    try {
      const stats = await getToolUsageStats(req.params.name);
      if (!stats) {
        return apiError(res, 404, "NOT_FOUND", `no usage for tool "${req.params.name}"`);
      }
      return res.json({ _version: 1, name: req.params.name, stats });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/tools/rag/rebuild (admin only)
  apiRoute("post", "/tools/rag/rebuild", log, admin, async (_req, res) => {
    try {
      const idx = await rebuildDefaultIndex();
      return res.json({ _version: 1, rebuilt: true, size: idx.size() });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });
}

export default mountToolRagRoutes;
