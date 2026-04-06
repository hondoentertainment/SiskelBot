// Agent sessions API — durable run grouping, cancel in-process fetch (Phase roadmap).
import {
  agentSessionApiEnabled,
  createAgentSession,
  getAgentSession,
  listAgentSessionsForWorkspace,
  appendAgentSessionEvent,
  setAgentSessionStatus,
  updateAgentSessionPlan,
} from "../lib/agent-session.js";
import { cancelAgentSessionRun as cancelInProcessRun } from "../lib/agent-run-control.js";
import { resolveStorageUserId } from "../lib/teams.js";
import { getWorkspaceAgentAccess, canEditWorkspaceAgentSettings } from "../lib/workspace-agent-settings.js";
import { getMaxConcurrentRunsPerWorkspace } from "../lib/agent-run-control.js";

export function mountAgentSessionRoutes(app, deps) {
  const { apiRoute, apiError, userAuth, requireScope, logRequest, sanitizeWorkspace } = deps;

  apiRoute("post", "/agent/sessions", logRequest, userAuth, requireScope("write"), async (req, res) => {
    if (!agentSessionApiEnabled()) {
      return apiError(
        res,
        503,
        "FEATURE_DISABLED",
        "Agent sessions API disabled",
        "Unset AGENT_SESSION_API=0 to enable POST /api/v1/agent/sessions.",
      );
    }
    const workspace = sanitizeWorkspace(req.body?.workspace || "default");
    const title = req.body?.title;
    try {
      const storageUserId = await resolveStorageUserId(req.userId || "anonymous", workspace);
      const access = await getWorkspaceAgentAccess(req.userId || "anonymous", workspace);
      if (!access.allowed) {
        return apiError(res, 403, "FORBIDDEN", "Workspace not found or access denied", "Join the workspace first.");
      }
      const session = await createAgentSession({
        workspace,
        ownerStorageUserId: storageUserId,
        title,
        planSummary: req.body?.planSummary,
        planDag: req.body?.planDag,
      });
      res.status(201).json(session);
    } catch (err) {
      const pc = err?.code;
      if (
        pc &&
        (String(pc).startsWith("INVALID") ||
          pc === "EMPTY_PLAN" ||
          pc === "PLAN_DAG_TOO_LARGE" ||
          pc === "PLAN_DAG_TOO_DEEP")
      ) {
        return apiError(res, 400, pc, err.message || "Invalid plan", "Fix planSummary / planDag and retry.");
      }
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "Create failed", "See server logs.");
    }
  });

  apiRoute("get", "/agent/sessions", logRequest, userAuth, requireScope("read"), async (req, res) => {
    if (!agentSessionApiEnabled()) {
      return apiError(
        res,
        503,
        "FEATURE_DISABLED",
        "Agent sessions API disabled",
        "Unset AGENT_SESSION_API=0 to enable listing.",
      );
    }
    const workspace = sanitizeWorkspace(req.query.workspace || "default");
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 40));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    try {
      const storageUserId = await resolveStorageUserId(req.userId || "anonymous", workspace);
      const access = await getWorkspaceAgentAccess(req.userId || "anonymous", workspace);
      if (!access.allowed) {
        return apiError(res, 403, "FORBIDDEN", "Workspace not found or access denied", "Join the workspace first.");
      }
      const data = await listAgentSessionsForWorkspace({
        workspace,
        ownerStorageUserId: storageUserId,
        limit,
        offset,
      });
      res.json({ ...data, maxConcurrentRunsPerWorkspace: getMaxConcurrentRunsPerWorkspace() });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "List failed", "See server logs.");
    }
  });

  apiRoute("get", "/agent/sessions/:sessionId", logRequest, userAuth, requireScope("read"), async (req, res) => {
    if (!agentSessionApiEnabled()) {
      return apiError(res, 503, "FEATURE_DISABLED", "Agent sessions API disabled", "Enable sessions API first.");
    }
    const sessionId = String(req.params.sessionId || "").trim();
    const row = await getAgentSession(sessionId);
    if (!row) return apiError(res, 404, "NOT_FOUND", "Session not found", "Create a session or check the id.");
    try {
      const access = await getWorkspaceAgentAccess(req.userId || "anonymous", row.workspace);
      if (!access.allowed) {
        return apiError(res, 403, "FORBIDDEN", "Access denied", "You cannot read this session.");
      }
      const storageUserId = await resolveStorageUserId(req.userId || "anonymous", row.workspace);
      if (row.ownerStorageUserId !== storageUserId) {
        return apiError(res, 403, "FORBIDDEN", "Session belongs to another user", "Only the owner can inspect this session.");
      }
      res.json(row);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "Load failed", "See server logs.");
    }
  });

  apiRoute("post", "/agent/sessions/:sessionId/pause", logRequest, userAuth, requireScope("write"), async (req, res) => {
    if (!agentSessionApiEnabled()) {
      return apiError(res, 503, "FEATURE_DISABLED", "Agent sessions API disabled", "");
    }
    const sessionId = String(req.params.sessionId || "").trim();
    const row = await getAgentSession(sessionId);
    if (!row) return apiError(res, 404, "NOT_FOUND", "Session not found", "");
    const access = await getWorkspaceAgentAccess(req.userId || "anonymous", row.workspace);
    const storageUserId = await resolveStorageUserId(req.userId || "anonymous", row.workspace);
    if (!access.allowed || row.ownerStorageUserId !== storageUserId) {
      return apiError(res, 403, "FORBIDDEN", "Access denied", "");
    }
    if (!canEditWorkspaceAgentSettings(access.role)) {
      return apiError(res, 403, "FORBIDDEN", "Insufficient role", "");
    }
    const updated = await setAgentSessionStatus(sessionId, "paused");
    res.json(updated);
  });

  apiRoute("post", "/agent/sessions/:sessionId/resume", logRequest, userAuth, requireScope("write"), async (req, res) => {
    if (!agentSessionApiEnabled()) {
      return apiError(res, 503, "FEATURE_DISABLED", "Agent sessions API disabled", "");
    }
    const sessionId = String(req.params.sessionId || "").trim();
    const row = await getAgentSession(sessionId);
    if (!row) return apiError(res, 404, "NOT_FOUND", "Session not found", "");
    const access = await getWorkspaceAgentAccess(req.userId || "anonymous", row.workspace);
    const storageUserId = await resolveStorageUserId(req.userId || "anonymous", row.workspace);
    if (!access.allowed || row.ownerStorageUserId !== storageUserId) {
      return apiError(res, 403, "FORBIDDEN", "Access denied", "");
    }
    if (!canEditWorkspaceAgentSettings(access.role)) {
      return apiError(res, 403, "FORBIDDEN", "Insufficient role", "");
    }
    const updated = await setAgentSessionStatus(sessionId, "running");
    res.json(updated);
  });

  apiRoute("post", "/agent/sessions/:sessionId/plan", logRequest, userAuth, requireScope("write"), async (req, res) => {
    if (!agentSessionApiEnabled()) {
      return apiError(res, 503, "FEATURE_DISABLED", "Agent sessions API disabled", "");
    }
    const sessionId = String(req.params.sessionId || "").trim();
    const row = await getAgentSession(sessionId);
    if (!row) return apiError(res, 404, "NOT_FOUND", "Session not found", "");
    const access = await getWorkspaceAgentAccess(req.userId || "anonymous", row.workspace);
    const storageUserId = await resolveStorageUserId(req.userId || "anonymous", row.workspace);
    if (!access.allowed || row.ownerStorageUserId !== storageUserId) {
      return apiError(res, 403, "FORBIDDEN", "Access denied", "");
    }
    if (!canEditWorkspaceAgentSettings(access.role)) {
      return apiError(res, 403, "FORBIDDEN", "Insufficient role", "");
    }
    const result = await updateAgentSessionPlan(sessionId, req.body || {});
    if (!result.ok) {
      const status = result.code === "NOT_FOUND" ? 404 : 400;
      return apiError(res, status, result.code, result.message, "");
    }
    res.json(result.session);
  });

  apiRoute("post", "/agent/sessions/:sessionId/cancel", logRequest, userAuth, requireScope("write"), async (req, res) => {
    if (!agentSessionApiEnabled()) {
      return apiError(res, 503, "FEATURE_DISABLED", "Agent sessions API disabled", "");
    }
    const sessionId = String(req.params.sessionId || "").trim();
    const row = await getAgentSession(sessionId);
    if (!row) return apiError(res, 404, "NOT_FOUND", "Session not found", "");
    const access = await getWorkspaceAgentAccess(req.userId || "anonymous", row.workspace);
    const storageUserId = await resolveStorageUserId(req.userId || "anonymous", row.workspace);
    if (!access.allowed || row.ownerStorageUserId !== storageUserId) {
      return apiError(res, 403, "FORBIDDEN", "Access denied", "");
    }
    cancelInProcessRun(sessionId);
    await appendAgentSessionEvent(sessionId, { type: "cancel_requested" });
    res.json({ ok: true, sessionId });
  });
}
