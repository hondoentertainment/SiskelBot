/**
 * Phase 32.4: Reasoning memory routes.
 *
 * GET /api/v1/reasoning/search                       — find related reasoning across a workspace
 * GET /api/v1/reasoning/:conversationId              — get reasoning chain
 * GET /api/v1/reasoning/:conversationId/summary      — narrative summary
 * GET /api/v1/reasoning/:conversationId/contradictions — detect contradictions
 * GET /api/v1/reasoning/:conversationId/export       — export to markdown/graphviz/json
 */
import {
  getReasoningChain,
  summarizeReasoning,
  detectContradictions,
  exportReasoning,
  findRelatedReasoning,
} from "../lib/reasoning-memory.js";

export function mountReasoningMemoryRoutes(app, deps) {
  const {
    apiRoute,
    apiError,
    sanitizeWorkspace,
    storageRateLimiter,
  } = deps;

  const limiter = storageRateLimiter || ((req, res, next) => next());

  // GET /api/v1/reasoning/search?q=...&workspace=...
  // Must be declared before the /:conversationId route so "search" is not
  // treated as a conversationId.
  apiRoute("get", "/reasoning/search", limiter, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.query?.workspace);
      const q = req.query?.q || "";
      if (!q || typeof q !== "string" || !q.trim()) {
        return apiError(res, 400, "INVALID_INPUT", "q query parameter is required");
      }
      const limit = req.query?.limit ? Number(req.query.limit) : undefined;
      const results = await findRelatedReasoning(q, workspace, { limit });
      res.json({ _version: 1, query: q, results, count: results.length });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/reasoning/:conversationId
  apiRoute("get", "/reasoning/:conversationId", limiter, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.query?.workspace);
      const chain = await getReasoningChain(req.params.conversationId, workspace);
      res.json({ _version: 1, ...chain });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/reasoning/:conversationId/summary
  apiRoute("get", "/reasoning/:conversationId/summary", limiter, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.query?.workspace);
      const summary = await summarizeReasoning(req.params.conversationId, workspace);
      res.json({
        _version: 1,
        conversationId: req.params.conversationId,
        ...summary,
      });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/reasoning/:conversationId/contradictions
  apiRoute("get", "/reasoning/:conversationId/contradictions", limiter, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.query?.workspace);
      const contradictions = await detectContradictions(
        req.params.conversationId,
        workspace
      );
      res.json({
        _version: 1,
        conversationId: req.params.conversationId,
        contradictions,
        count: contradictions.length,
      });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/reasoning/:conversationId/export?format=markdown|graphviz|json
  apiRoute("get", "/reasoning/:conversationId/export", limiter, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.query?.workspace);
      const format = (req.query?.format || "markdown").toString();
      if (!["markdown", "graphviz", "json"].includes(format)) {
        return apiError(
          res,
          400,
          "INVALID_INPUT",
          "format must be one of: markdown, graphviz, json"
        );
      }
      const out = await exportReasoning(req.params.conversationId, format, workspace);
      if (format === "json") {
        res.type("application/json").send(out);
      } else if (format === "graphviz") {
        res.type("text/vnd.graphviz").send(out);
      } else {
        res.type("text/markdown").send(out);
      }
    } catch (err) {
      if (err.message && err.message.includes("format")) {
        return apiError(res, 400, "INVALID_INPUT", err.message);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}
