/**
 * Phase 62.2: Ticket router routes.
 *
 * POST   /api/v1/tickets                    — create ticket
 * POST   /api/v1/tickets/:id/assign         — assign ticket
 * GET    /api/v1/tickets                    — list tickets (filterable)
 * GET    /api/v1/tickets/:id                — fetch ticket
 * GET    /api/v1/ticket-queues              — list queues
 * POST   /api/v1/ticket-queues/skills       — configure agent skills/queues
 */
import {
  createTicket,
  assignTicket,
  listQueues,
  configureSkills,
  getTicket,
  listTickets,
} from "../lib/ticket-router.js";

function mapErr(err) {
  if (err?.code === "NOT_FOUND") return { status: 404, code: "NOT_FOUND" };
  if (/required|must be/i.test(err?.message || "")) return { status: 400, code: "INVALID_INPUT" };
  return { status: 500, code: "INTERNAL_ERROR" };
}

export function mountTicketRouterRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  // POST /tickets
  apiRoute("post", "/tickets", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      const ticket = await createTicket({
        subject: body.subject,
        body: body.body,
        priority: body.priority,
        requiredSkills: body.requiredSkills,
      });
      res.status(201).json(ticket);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  // POST /tickets/:id/assign
  apiRoute("post", "/tickets/:id/assign", adminAuth, logRequest, async (req, res) => {
    try {
      const ticket = await assignTicket(req.params.id);
      res.json(ticket);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  // GET /tickets
  apiRoute("get", "/tickets", adminAuth, logRequest, async (req, res) => {
    try {
      const tickets = await listTickets({
        status: req.query?.status ? String(req.query.status) : undefined,
        queue: req.query?.queue ? String(req.query.queue) : undefined,
        assignedTo: req.query?.assignedTo ? String(req.query.assignedTo) : undefined,
        limit: Number(req.query?.limit) || 100,
      });
      res.json({ tickets });
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  // GET /tickets/:id
  apiRoute("get", "/tickets/:id", adminAuth, logRequest, async (req, res) => {
    try {
      const t = await getTicket(req.params.id);
      if (!t) return apiError(res, 404, "NOT_FOUND", "ticket not found");
      res.json(t);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  // GET /ticket-queues
  apiRoute("get", "/ticket-queues", adminAuth, logRequest, async (_req, res) => {
    try {
      const queues = await listQueues();
      res.json({ queues });
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  // POST /ticket-queues/skills
  apiRoute("post", "/ticket-queues/skills", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.agents) return apiError(res, 400, "INVALID_INPUT", "agents map is required");
      const cfg = await configureSkills(body.agents);
      res.json(cfg);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });
}

export default mountTicketRouterRoutes;
