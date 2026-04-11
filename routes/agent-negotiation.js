/**
 * Phase 47.3: Agent negotiation API.
 *
 * POST   /api/v1/negotiation/announcements           — announce a task
 * GET    /api/v1/negotiation/announcements           — list open announcements
 * POST   /api/v1/negotiation/announcements/:id/bids  — submit a bid
 * GET    /api/v1/negotiation/announcements/:id/bids  — list bids
 * POST   /api/v1/negotiation/bids/:id/accept         — accept a bid (creates contract)
 * POST   /api/v1/negotiation/bids/:id/reject         — reject a bid
 * GET    /api/v1/negotiation/contracts/:id           — fetch contract status
 * POST   /api/v1/negotiation/contracts/:id/execute   — execute and score a contract
 * GET    /api/v1/negotiation/agents/:id/stats        — agent market reputation
 * POST   /api/v1/negotiation/quotas                  — negotiate a resource quota
 */
import {
  createTaskAnnouncement,
  submitBid,
  selectBid,
  acceptBid,
  rejectBid,
  getOpenAnnouncements,
  getBidsForAnnouncement,
  recordNegotiationOutcome,
  getAgentMarketStats,
  negotiateResourceQuota,
} from "../lib/agent-negotiation.js";
import {
  executeContract,
  getContractStatus,
} from "../lib/agent-contracts.js";

export function mountAgentNegotiationRoutes(app, deps) {
  const {
    apiRoute,
    apiError,
    sanitizeWorkspace,
    storageRateLimiter,
  } = deps;

  const limiter = storageRateLimiter || ((_req, _res, next) => next());

  // POST /api/v1/negotiation/announcements
  apiRoute("post", "/negotiation/announcements", limiter, async (req, res) => {
    try {
      const workspaceId = sanitizeWorkspace(req.body?.workspace);
      const principalId = req.userId || "anonymous";
      const { description, requirements, deadline, budget, priority, id } = req.body || {};
      if (!description) {
        return apiError(res, 400, "INVALID_INPUT", "description is required");
      }
      const announcement = await createTaskAnnouncement({
        id,
        description,
        requirements,
        deadline,
        budget,
        priority,
        workspaceId,
        principalId,
      });
      res.status(201).json({ _version: 1, announcement });
    } catch (err) {
      if (/required/.test(err.message)) {
        return apiError(res, 400, "INVALID_INPUT", err.message);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/negotiation/announcements
  apiRoute("get", "/negotiation/announcements", limiter, async (req, res) => {
    try {
      const workspaceId = sanitizeWorkspace(req.query?.workspace);
      const filter = { workspaceId };
      if (req.query?.priority) filter.priority = String(req.query.priority);
      if (req.query?.requirements) {
        filter.requirements = String(req.query.requirements)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      }
      const items = await getOpenAnnouncements(filter);
      res.json({ _version: 1, items });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/negotiation/announcements/:id/bids
  apiRoute("post", "/negotiation/announcements/:id/bids", limiter, async (req, res) => {
    try {
      const workspaceId = sanitizeWorkspace(req.body?.workspace);
      const agentId = req.body?.agentId || req.userId || "anonymous";
      const bid = await submitBid(req.params.id, agentId, req.body?.bid || {}, workspaceId);
      res.status(201).json({ _version: 1, bid });
    } catch (err) {
      if (/not found/.test(err.message)) {
        return apiError(res, 404, "NOT_FOUND", err.message);
      }
      if (/required|expired|cannot accept|limit reached/.test(err.message)) {
        return apiError(res, 400, "INVALID_INPUT", err.message);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/negotiation/announcements/:id/bids
  apiRoute("get", "/negotiation/announcements/:id/bids", limiter, async (req, res) => {
    try {
      const workspaceId = sanitizeWorkspace(req.query?.workspace);
      const items = await getBidsForAnnouncement(req.params.id, workspaceId);
      let winner = null;
      if (req.query?.select && typeof req.query.select === "string") {
        try {
          winner = await selectBid(req.params.id, req.query.select, workspaceId);
        } catch (e) {
          return apiError(res, 400, "INVALID_INPUT", e.message);
        }
      }
      res.json({ _version: 1, items, winner });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/negotiation/bids/:id/accept
  apiRoute("post", "/negotiation/bids/:id/accept", limiter, async (req, res) => {
    try {
      const workspaceId = sanitizeWorkspace(req.body?.workspace);
      const principalId = req.body?.principalId || req.userId || "anonymous";
      const result = await acceptBid(req.params.id, principalId, workspaceId);
      res.status(201).json({ _version: 1, ...result });
    } catch (err) {
      if (/not found/.test(err.message)) {
        return apiError(res, 404, "NOT_FOUND", err.message);
      }
      if (/cannot accept|is /.test(err.message)) {
        return apiError(res, 400, "INVALID_INPUT", err.message);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/negotiation/bids/:id/reject
  apiRoute("post", "/negotiation/bids/:id/reject", limiter, async (req, res) => {
    try {
      const workspaceId = sanitizeWorkspace(req.body?.workspace);
      const reason = req.body?.reason || "rejected";
      const bid = await rejectBid(req.params.id, reason, workspaceId);
      res.json({ _version: 1, bid });
    } catch (err) {
      if (/not found/.test(err.message)) {
        return apiError(res, 404, "NOT_FOUND", err.message);
      }
      if (/cannot reject|is /.test(err.message)) {
        return apiError(res, 400, "INVALID_INPUT", err.message);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/negotiation/contracts/:id
  apiRoute("get", "/negotiation/contracts/:id", limiter, async (req, res) => {
    try {
      const workspaceId = sanitizeWorkspace(req.query?.workspace);
      const contract = await getContractStatus(req.params.id, workspaceId);
      if (!contract) {
        return apiError(res, 404, "NOT_FOUND", "contract not found");
      }
      res.json({ _version: 1, contract });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/negotiation/contracts/:id/execute
  apiRoute("post", "/negotiation/contracts/:id/execute", limiter, async (req, res) => {
    try {
      const workspaceId = sanitizeWorkspace(req.body?.workspace);
      const contract = await executeContract(req.params.id, req.body?.execution || {}, workspaceId);
      // Record outcome on the bid for reputation tracking.
      try {
        await recordNegotiationOutcome(
          contract.bidId,
          {
            success: contract.status === "fulfilled",
            actualCost: contract.result?.actualCost,
            actualTime: contract.result?.actualTime,
            notes: contract.result?.notes,
          },
          workspaceId
        );
      } catch (e) {
        // Outcome recording is best-effort.
      }
      res.json({ _version: 1, contract });
    } catch (err) {
      if (/not found/.test(err.message)) {
        return apiError(res, 404, "NOT_FOUND", err.message);
      }
      if (/cannot execute|is /.test(err.message)) {
        return apiError(res, 400, "INVALID_INPUT", err.message);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/negotiation/agents/:id/stats
  apiRoute("get", "/negotiation/agents/:id/stats", limiter, async (req, res) => {
    try {
      const workspaceId = sanitizeWorkspace(req.query?.workspace);
      const stats = await getAgentMarketStats(req.params.id, workspaceId);
      res.json({ _version: 1, stats });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/negotiation/quotas
  apiRoute("post", "/negotiation/quotas", limiter, async (req, res) => {
    try {
      const { agent, resourceType, amount } = req.body || {};
      if (!agent || !resourceType) {
        return apiError(res, 400, "INVALID_INPUT", "agent and resourceType are required");
      }
      const result = negotiateResourceQuota(agent, resourceType, amount);
      res.json({ _version: 1, ...result });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}

export default mountAgentNegotiationRoutes;
