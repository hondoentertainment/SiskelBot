/**
 * Route module: Phase 47.2 Agent Marketplace
 *
 * GET    /api/v1/agent-marketplace                      — list with filters
 * GET    /api/v1/agent-marketplace/search?q=...         — search
 * GET    /api/v1/agent-marketplace/featured             — list featured agents
 * GET    /api/v1/agent-marketplace/:id                  — get by id or slug
 * POST   /api/v1/agent-marketplace                      — publish
 * PUT    /api/v1/agent-marketplace/:id                  — update
 * DELETE /api/v1/agent-marketplace/:id                  — delete
 * POST   /api/v1/agent-marketplace/:id/install          — install into workspace
 * POST   /api/v1/agent-marketplace/:id/rate             — rate (1-5)
 * GET    /api/v1/agent-marketplace/:id/ratings          — get ratings
 * POST   /api/v1/agent-marketplace/:id/report           — report for moderation
 * GET    /api/v1/agent-marketplace/:id/stats            — aggregate stats
 * POST   /api/v1/agent-marketplace/:id/feature          — feature (admin)
 * GET    /api/v1/agent-marketplace/admin/reports        — list reports (admin)
 */
import {
  publishAgent,
  listMarketplaceAgents,
  searchMarketplaceAgents,
  getMarketplaceAgent,
  updateMarketplaceAgent,
  deleteMarketplaceAgent,
  rateAgent,
  getAgentRatings,
  installAgent,
  getAgentStats,
  reportAgent,
  listReports,
  featureAgent,
  listFeaturedAgents,
  AGENT_CATEGORIES,
  REPORT_REASONS,
} from "../lib/agent-marketplace.js";

export function mountAgentMarketplaceRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, chatAuth, requireScope } = deps;

  // GET /api/v1/agent-marketplace
  apiRoute("get", "/agent-marketplace", requireScope("read"), logRequest, async (req, res) => {
    try {
      const { category, tag, sortBy, author, limit, offset } = req.query || {};
      if (category && !AGENT_CATEGORIES.includes(category)) {
        return apiError(res, 400, "INVALID_CATEGORY", `category must be one of: ${AGENT_CATEGORIES.join(", ")}`);
      }
      const result = await listMarketplaceAgents({
        category: category || null,
        tag: tag || null,
        sortBy: sortBy || "newest",
        author: author || null,
        limit: limit !== undefined ? Number(limit) : 50,
        offset: offset !== undefined ? Number(offset) : 0,
      });
      res.json(result);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/agent-marketplace/search
  apiRoute("get", "/agent-marketplace/search", requireScope("read"), logRequest, async (req, res) => {
    try {
      const q = req.query?.q;
      if (!q || typeof q !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "q query parameter is required");
      }
      const items = await searchMarketplaceAgents(q);
      res.json({ items, total: items.length, query: q });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/agent-marketplace/featured
  apiRoute("get", "/agent-marketplace/featured", requireScope("read"), logRequest, async (req, res) => {
    try {
      const items = await listFeaturedAgents();
      res.json({ items, total: items.length });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/agent-marketplace/admin/reports — admin
  apiRoute("get", "/agent-marketplace/admin/reports", chatAuth, requireScope("admin"), logRequest, async (req, res) => {
    try {
      const status = typeof req.query?.status === "string" ? req.query.status : null;
      const items = await listReports(status);
      res.json({ items, total: items.length });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/agent-marketplace/:id
  apiRoute("get", "/agent-marketplace/:id", requireScope("read"), logRequest, async (req, res) => {
    try {
      const agent = await getMarketplaceAgent(req.params.id);
      if (!agent) return apiError(res, 404, "NOT_FOUND", "marketplace agent not found");
      res.json(agent);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/agent-marketplace — publish
  apiRoute("post", "/agent-marketplace", chatAuth, requireScope("write"), logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.name || typeof body.name !== "string" || !body.name.trim()) {
        return apiError(res, 400, "INVALID_INPUT", "name is required");
      }
      if (!body.systemPrompt || typeof body.systemPrompt !== "string" || !body.systemPrompt.trim()) {
        return apiError(res, 400, "INVALID_INPUT", "systemPrompt is required");
      }
      if (body.category && !AGENT_CATEGORIES.includes(body.category)) {
        return apiError(res, 400, "INVALID_CATEGORY", `category must be one of: ${AGENT_CATEGORIES.join(", ")}`);
      }
      const publisher = {
        userId: req.userId || "anonymous",
        name: req.userName || req.userId || "anonymous",
        verified: !!req.userVerified,
      };
      const result = await publishAgent(body, publisher);
      res.status(201).json(result);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // PUT /api/v1/agent-marketplace/:id
  apiRoute("put", "/agent-marketplace/:id", chatAuth, requireScope("write"), logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      if (body.category && !AGENT_CATEGORIES.includes(body.category)) {
        return apiError(res, 400, "INVALID_CATEGORY", `category must be one of: ${AGENT_CATEGORIES.join(", ")}`);
      }
      const result = await updateMarketplaceAgent(req.params.id, body, req.userId || "anonymous");
      res.json(result);
    } catch (err) {
      if (err.message === "agent not found") {
        return apiError(res, 404, "NOT_FOUND", err.message);
      }
      if (err.message.includes("only the publisher")) {
        return apiError(res, 403, "FORBIDDEN", err.message);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // DELETE /api/v1/agent-marketplace/:id
  apiRoute("delete", "/agent-marketplace/:id", chatAuth, requireScope("write"), logRequest, async (req, res) => {
    try {
      const result = await deleteMarketplaceAgent(req.params.id, req.userId || "anonymous");
      res.json(result);
    } catch (err) {
      if (err.message === "agent not found") {
        return apiError(res, 404, "NOT_FOUND", err.message);
      }
      if (err.message.includes("only the publisher")) {
        return apiError(res, 403, "FORBIDDEN", err.message);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/agent-marketplace/:id/install
  apiRoute("post", "/agent-marketplace/:id/install", chatAuth, requireScope("write"), logRequest, async (req, res) => {
    try {
      const workspaceId = req.body?.workspace || req.query?.workspace || "default";
      const result = await installAgent(req.params.id, workspaceId, req.userId || "anonymous");
      res.status(201).json(result);
    } catch (err) {
      if (err.message === "agent not found") {
        return apiError(res, 404, "NOT_FOUND", err.message);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/agent-marketplace/:id/rate
  apiRoute("post", "/agent-marketplace/:id/rate", chatAuth, requireScope("write"), logRequest, async (req, res) => {
    try {
      const userId = req.userId || req.body?.userId;
      if (!userId) {
        return apiError(res, 401, "UNAUTHORIZED", "user id required to rate an agent");
      }
      const rating = req.body?.rating;
      const review = req.body?.review;
      const result = await rateAgent(req.params.id, userId, rating, review);
      res.json(result);
    } catch (err) {
      if (err.message.includes("rating must be")) {
        return apiError(res, 400, "INVALID_INPUT", err.message);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/agent-marketplace/:id/ratings
  apiRoute("get", "/agent-marketplace/:id/ratings", requireScope("read"), logRequest, async (req, res) => {
    try {
      const result = await getAgentRatings(req.params.id);
      res.json(result);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/agent-marketplace/:id/report
  apiRoute("post", "/agent-marketplace/:id/report", chatAuth, requireScope("write"), logRequest, async (req, res) => {
    try {
      const userId = req.userId || req.body?.userId;
      if (!userId) {
        return apiError(res, 401, "UNAUTHORIZED", "user id required to report an agent");
      }
      const reason = req.body?.reason;
      if (reason && !REPORT_REASONS.includes(reason)) {
        return apiError(res, 400, "INVALID_INPUT", `reason must be one of: ${REPORT_REASONS.join(", ")}`);
      }
      const result = await reportAgent(req.params.id, userId, reason);
      res.status(201).json(result);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/agent-marketplace/:id/stats
  apiRoute("get", "/agent-marketplace/:id/stats", requireScope("read"), logRequest, async (req, res) => {
    try {
      const stats = await getAgentStats(req.params.id);
      res.json(stats);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/agent-marketplace/:id/feature — admin
  apiRoute("post", "/agent-marketplace/:id/feature", chatAuth, requireScope("admin"), logRequest, async (req, res) => {
    try {
      const result = await featureAgent(req.params.id, req.userId || "admin");
      res.json(result);
    } catch (err) {
      if (err.message === "agent not found") {
        return apiError(res, 404, "NOT_FOUND", err.message);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}

export default mountAgentMarketplaceRoutes;
