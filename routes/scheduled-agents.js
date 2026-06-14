/**
 * Phase 29: Scheduled agents and event triggers routes.
 * GET    /api/v1/scheduled-agents          — list scheduled agents
 * POST   /api/v1/scheduled-agents          — create scheduled agent
 * PUT    /api/v1/scheduled-agents/:id      — update scheduled agent
 * DELETE /api/v1/scheduled-agents/:id      — delete scheduled agent
 * POST   /api/v1/scheduled-agents/:id/run  — manual trigger
 * GET    /api/v1/scheduled-agents/:id/runs — run history
 * GET    /api/v1/triggers                  — list triggers
 * POST   /api/v1/triggers                  — create trigger
 * DELETE /api/v1/triggers/:id              — delete trigger
 */
import {
  createScheduledAgent,
  listScheduledAgents,
  updateScheduledAgent,
  deleteScheduledAgent,
  runScheduledAgent,
  getScheduledAgentRuns,
} from "../lib/scheduled-agents.js";
import {
  registerTrigger,
  removeTrigger,
  listTriggers,
  getAllowedEvents,
} from "../lib/event-triggers.js";

export function mountScheduledAgentRoutes(app, deps) {
  const {
    apiRoute,
    apiError,
    storageRateLimiter,
    backendFetch,
    buildProxyConfig,
  } = deps;

  const limiter = storageRateLimiter || ((req, res, next) => next());

  // --- Scheduled Agents ---

  // GET /api/v1/scheduled-agents — list
  apiRoute("get", "/scheduled-agents", limiter, async (req, res) => {
    try {
      const workspace = req.headers["x-workspace-id"] || req.query?.workspace || "default";
      const agents = await listScheduledAgents(workspace);
      res.json({ ok: true, agents });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/scheduled-agents — create
  apiRoute("post", "/scheduled-agents", limiter, async (req, res) => {
    try {
      const workspace = req.headers["x-workspace-id"] || req.body?.workspaceId || "default";
      const body = req.body || {};
      if (!body.prompt) return apiError(res, 400, "INVALID_INPUT", "prompt is required");
      if (!body.cron) return apiError(res, 400, "INVALID_INPUT", "cron expression is required");

      const agent = await createScheduledAgent({
        workspaceId: workspace,
        cron: body.cron,
        prompt: body.prompt,
        model: body.model,
        agentMode: body.agentMode,
        name: body.name,
        description: body.description,
      });
      res.status(201).json({ ok: true, agent });
    } catch (err) {
      if (err.message.includes("required") || err.message.includes("valid cron")) {
        return apiError(res, 400, "INVALID_INPUT", err.message);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // PUT /api/v1/scheduled-agents/:id — update
  apiRoute("put", "/scheduled-agents/:id", limiter, async (req, res) => {
    try {
      const workspace = req.headers["x-workspace-id"] || req.query?.workspace || "default";
      const updated = await updateScheduledAgent(workspace, req.params.id, req.body || {});
      if (!updated) return apiError(res, 404, "NOT_FOUND", "Scheduled agent not found");
      res.json({ ok: true, agent: updated });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // DELETE /api/v1/scheduled-agents/:id
  apiRoute("delete", "/scheduled-agents/:id", limiter, async (req, res) => {
    try {
      const workspace = req.headers["x-workspace-id"] || req.query?.workspace || "default";
      const deleted = await deleteScheduledAgent(workspace, req.params.id);
      if (!deleted) return apiError(res, 404, "NOT_FOUND", "Scheduled agent not found");
      res.json({ ok: true, deleted: true });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/scheduled-agents/:id/run — manual trigger
  apiRoute("post", "/scheduled-agents/:id/run", limiter, async (req, res) => {
    try {
      const workspace = req.headers["x-workspace-id"] || req.query?.workspace || "default";
      const result = await runScheduledAgent(workspace, req.params.id, {
        backendFetch,
        buildProxyConfig,
        model: req.body?.model,
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      if (err.message.includes("not found")) return apiError(res, 404, "NOT_FOUND", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/scheduled-agents/:id/runs — run history
  apiRoute("get", "/scheduled-agents/:id/runs", limiter, async (req, res) => {
    try {
      const workspace = req.headers["x-workspace-id"] || req.query?.workspace || "default";
      const limit = Math.min(Number(req.query?.limit) || 50, 200);
      const runs = await getScheduledAgentRuns(workspace, req.params.id, limit);
      res.json({ ok: true, runs });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // --- Event Triggers ---

  // GET /api/v1/triggers — list
  apiRoute("get", "/triggers", limiter, async (req, res) => {
    try {
      const workspace = req.headers["x-workspace-id"] || req.query?.workspace || "default";
      const triggers = await listTriggers(workspace);
      res.json({ ok: true, triggers, allowedEvents: getAllowedEvents() });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/triggers — create
  apiRoute("post", "/triggers", limiter, async (req, res) => {
    try {
      const workspace = req.headers["x-workspace-id"] || req.body?.workspaceId || "default";
      const body = req.body || {};
      if (!body.event) return apiError(res, 400, "INVALID_INPUT", "event is required");
      if (!body.workflowId) return apiError(res, 400, "INVALID_INPUT", "workflowId is required");

      const trigger = await registerTrigger({
        workspaceId: workspace,
        event: body.event,
        workflowId: body.workflowId,
        filter: body.filter,
        transform: body.transform,
        name: body.name,
        description: body.description,
      });
      res.status(201).json({ ok: true, trigger });
    } catch (err) {
      if (err.message.includes("Invalid event") || err.message.includes("required")) {
        return apiError(res, 400, "INVALID_INPUT", err.message);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // DELETE /api/v1/triggers/:id
  apiRoute("delete", "/triggers/:id", limiter, async (req, res) => {
    try {
      const workspace = req.headers["x-workspace-id"] || req.query?.workspace || "default";
      const removed = await removeTrigger(workspace, req.params.id);
      if (!removed) return apiError(res, 404, "NOT_FOUND", "Trigger not found");
      res.json({ ok: true, deleted: true });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}
