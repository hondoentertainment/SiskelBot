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
import { getWorkspaceAgentAccess, canEditWorkspaceAgentSettings } from "../lib/workspace-agent-settings.js";
import { sanitizeWorkspace } from "../lib/storage.js";

export function mountScheduledAgentRoutes(app, deps) {
  const {
    apiRoute,
    apiError,
    storageRateLimiter,
    userAuth,
    backendFetch,
    buildProxyConfig,
  } = deps;

  const limiter = storageRateLimiter || ((req, res, next) => next());
  const auth = userAuth || ((_req, _res, next) => next());

  function workspaceOf(req) {
    return sanitizeWorkspace(req.headers["x-workspace-id"] || req.query?.workspace || req.body?.workspaceId || "default");
  }

  async function canRead(req, res, workspace) {
    const gate = await getWorkspaceAgentAccess(req.userId || "anonymous", workspace);
    if (!gate.allowed) {
      apiError(res, 403, "FORBIDDEN", "Workspace not found or access denied");
      return false;
    }
    return true;
  }

  async function canWrite(req, res, workspace) {
    const gate = await getWorkspaceAgentAccess(req.userId || "anonymous", workspace);
    if (!gate.allowed || !canEditWorkspaceAgentSettings(gate.role)) {
      apiError(res, 403, "FORBIDDEN", "Workspace editor role required");
      return false;
    }
    return true;
  }

  // --- Scheduled Agents ---

  // GET /api/v1/scheduled-agents — list
  apiRoute("get", "/scheduled-agents", limiter, auth, async (req, res) => {
    try {
      const workspace = workspaceOf(req);
      if (!(await canRead(req, res, workspace))) return;
      const agents = await listScheduledAgents(workspace);
      res.json({ ok: true, agents });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/scheduled-agents — create
  apiRoute("post", "/scheduled-agents", limiter, auth, async (req, res) => {
    try {
      const workspace = workspaceOf(req);
      if (!(await canWrite(req, res, workspace))) return;
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
  apiRoute("put", "/scheduled-agents/:id", limiter, auth, async (req, res) => {
    try {
      const workspace = workspaceOf(req);
      if (!(await canWrite(req, res, workspace))) return;
      // ownerUserId is set by the advice schedule route from the authenticated user.
      const body = { ...(req.body || {}) };
      delete body.ownerUserId;
      const updated = await updateScheduledAgent(workspace, req.params.id, body);
      if (!updated) return apiError(res, 404, "NOT_FOUND", "Scheduled agent not found");
      res.json({ ok: true, agent: updated });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // DELETE /api/v1/scheduled-agents/:id
  apiRoute("delete", "/scheduled-agents/:id", limiter, auth, async (req, res) => {
    try {
      const workspace = workspaceOf(req);
      if (!(await canWrite(req, res, workspace))) return;
      const deleted = await deleteScheduledAgent(workspace, req.params.id);
      if (!deleted) return apiError(res, 404, "NOT_FOUND", "Scheduled agent not found");
      res.json({ ok: true, deleted: true });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/scheduled-agents/:id/run — manual trigger
  apiRoute("post", "/scheduled-agents/:id/run", limiter, auth, async (req, res) => {
    try {
      const workspace = workspaceOf(req);
      if (!(await canWrite(req, res, workspace))) return;
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
  apiRoute("get", "/scheduled-agents/:id/runs", limiter, auth, async (req, res) => {
    try {
      const workspace = workspaceOf(req);
      if (!(await canRead(req, res, workspace))) return;
      const limit = Math.min(Number(req.query?.limit) || 50, 200);
      const runs = await getScheduledAgentRuns(workspace, req.params.id, limit);
      res.json({ ok: true, runs });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // --- Event Triggers ---

  // GET /api/v1/triggers — list
  apiRoute("get", "/triggers", limiter, auth, async (req, res) => {
    try {
      const workspace = workspaceOf(req);
      if (!(await canRead(req, res, workspace))) return;
      const triggers = await listTriggers(workspace);
      res.json({ ok: true, triggers, allowedEvents: getAllowedEvents() });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/triggers — create
  apiRoute("post", "/triggers", limiter, auth, async (req, res) => {
    try {
      const workspace = workspaceOf(req);
      if (!(await canWrite(req, res, workspace))) return;
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
  apiRoute("delete", "/triggers/:id", limiter, auth, async (req, res) => {
    try {
      const workspace = workspaceOf(req);
      if (!(await canWrite(req, res, workspace))) return;
      const removed = await removeTrigger(workspace, req.params.id);
      if (!removed) return apiError(res, 404, "NOT_FOUND", "Trigger not found");
      res.json({ ok: true, deleted: true });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}
