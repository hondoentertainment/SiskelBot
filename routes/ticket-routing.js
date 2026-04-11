/**
 * Phase 62.2: Ticket routing routes.
 */
import {
  createQueue,
  routeTicket,
  listQueues,
  setAgentSkills,
  getQueueStats,
  listAgents,
  listTickets,
} from "../lib/ticket-routing.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "ticket-routing error");
}

export function mountTicketRoutingRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope } = deps;
  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_s) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;

  apiRoute("post", "/support/routing/queues", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.name) return apiError(res, 400, "INVALID_INPUT", "name is required");
      const q = await createQueue(body.name, body);
      return res.status(201).json({ _version: 1, queue: q });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("get", "/support/routing/queues", log, auth, scope("read"), async (_req, res) => {
    try {
      const queues = await listQueues();
      return res.json({ _version: 1, queues, count: queues.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("post", "/support/routing/agents", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.agentId) return apiError(res, 400, "INVALID_INPUT", "agentId is required");
      if (!Array.isArray(body.skills)) return apiError(res, 400, "INVALID_INPUT", "skills array required");
      const a = await setAgentSkills(body.agentId, body.skills, body);
      return res.status(201).json({ _version: 1, agent: a });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("get", "/support/routing/agents", log, auth, scope("read"), async (_req, res) => {
    try {
      const agents = await listAgents();
      return res.json({ _version: 1, agents, count: agents.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("post", "/support/routing/route", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body || typeof body !== "object") {
        return apiError(res, 400, "INVALID_INPUT", "ticket body required");
      }
      const result = await routeTicket(body);
      return res.status(201).json({ _version: 1, ticket: result });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("get", "/support/routing/stats", log, auth, scope("read"), async (req, res) => {
    try {
      const queue = typeof req.query.queue === "string" ? req.query.queue : undefined;
      const stats = await getQueueStats(queue);
      return res.json({ _version: 1, stats });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("get", "/support/routing/tickets", log, auth, scope("read"), async (req, res) => {
    try {
      const queue = typeof req.query.queue === "string" ? req.query.queue : undefined;
      const tickets = await listTickets(queue);
      return res.json({ _version: 1, tickets, count: tickets.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });
}

export default mountTicketRoutingRoutes;
