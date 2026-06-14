// API v2 workspaces routes
import { randomUUID } from "crypto";
import { apiV2Route } from "../../lib/api-version.js";
import { apiV2Error } from "../../lib/api-v2-errors.js";

function parsePagination(query) {
  const cursor = query.cursor || null;
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), 100);
  return { cursor, limit };
}

function paginate(items, cursor, limit) {
  let startIdx = 0;
  if (cursor) {
    try {
      const decoded = Buffer.from(cursor, "base64").toString("utf8");
      const idx = items.findIndex((i) => i.id === decoded);
      if (idx >= 0) startIdx = idx + 1;
    } catch {
      // invalid cursor, start from beginning
    }
  }
  const page = items.slice(startIdx, startIdx + limit);
  const hasMore = startIdx + limit < items.length;
  const nextCursor = page.length > 0 && hasMore
    ? Buffer.from(page[page.length - 1].id).toString("base64")
    : null;
  return { items: page, cursor: nextCursor, hasMore };
}

export function mountV2WorkspaceRoutes(app, deps) {
  const {
    requireScope,
    logRequest,
    storageRateLimiter,
    sanitizeWorkspace,
    storage,
    v2BearerAuth,
    v2RateHeaders,
  } = deps;

  const prefix = "/workspaces";
  const mw = [storageRateLimiter, v2BearerAuth, v2RateHeaders, logRequest];

  // GET /api/v2/workspaces — list with cursor pagination
  apiV2Route(app, "get", prefix, ...mw, requireScope("read"), async (req, res) => {
    try {
      const { cursor, limit } = parsePagination(req.query);
      const workspaces = await storage.listWorkspaces(req.userId);
      const result = paginate(workspaces, cursor, limit);
      res.json(result);
    } catch (err) {
      console.error("v2 workspaces list error:", err.message);
      return apiV2Error(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v2/workspaces — create
  apiV2Route(app, "post", prefix, ...mw, requireScope("write"), async (req, res) => {
    try {
      const { name, type } = req.body || {};
      if (typeof name !== "string" || !name.trim()) {
        return apiV2Error(res, 400, "INVALID_INPUT", "Workspace name is required");
      }
      const wsType = type === "team" ? "team" : "personal";
      const ws = await storage.createWorkspace(req.userId, name.trim().slice(0, 100), wsType);
      res.status(201).json(ws);
    } catch (err) {
      console.error("v2 workspaces create error:", err.message);
      return apiV2Error(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v2/workspaces/:id — get single
  apiV2Route(app, "get", `${prefix}/:id`, ...mw, requireScope("read"), async (req, res) => {
    try {
      const workspaceId = sanitizeWorkspace(req.params.id);
      const workspaces = await storage.listWorkspaces(req.userId);
      const ws = workspaces.find((w) => w.id === workspaceId);
      if (!ws) return apiV2Error(res, 404, "NOT_FOUND", "Workspace not found");
      res.json(ws);
    } catch (err) {
      console.error("v2 workspaces get error:", err.message);
      return apiV2Error(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // DELETE /api/v2/workspaces/:id
  apiV2Route(app, "delete", `${prefix}/:id`, ...mw, requireScope("write"), async (req, res) => {
    try {
      const workspaceId = sanitizeWorkspace(req.params.id);
      if (req.body?.confirm !== "DELETE" && req.query?.confirm !== "DELETE") {
        return apiV2Error(res, 400, "CONFIRM_REQUIRED", 'Send { "confirm": "DELETE" } or ?confirm=DELETE to delete a workspace');
      }
      const { deleteWorkspaceForUser } = deps;
      const result = await deleteWorkspaceForUser(req.userId, workspaceId);
      if (!result.ok) {
        const code = result.error?.includes("owner") || result.error?.includes("Only") ? "FORBIDDEN" : "DELETE_FAILED";
        const status = code === "FORBIDDEN" ? 403 : 400;
        return apiV2Error(res, status, code, result.error);
      }
      res.status(204).send();
    } catch (err) {
      console.error("v2 workspaces delete error:", err.message);
      return apiV2Error(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v2/workspaces/:id/members — list members
  apiV2Route(app, "get", `${prefix}/:id/members`, ...mw, requireScope("read"), async (req, res) => {
    try {
      const workspaceId = sanitizeWorkspace(req.params.id);
      const { getWorkspaceAgentAccess } = deps;
      const access = await getWorkspaceAgentAccess(req.userId, workspaceId);
      if (!access.allowed) {
        return apiV2Error(res, 403, "FORBIDDEN", "Workspace not found or access denied");
      }
      const { listTeamMembers } = deps;
      const members = listTeamMembers ? await listTeamMembers(workspaceId) : [];
      res.json({ items: members, cursor: null, hasMore: false });
    } catch (err) {
      console.error("v2 workspaces members error:", err.message);
      return apiV2Error(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v2/workspaces/:id/invite — invite a member
  apiV2Route(app, "post", `${prefix}/:id/invite`, ...mw, requireScope("write"), async (req, res) => {
    try {
      const workspaceId = sanitizeWorkspace(req.params.id);
      const { getWorkspaceAgentAccess } = deps;
      const access = await getWorkspaceAgentAccess(req.userId, workspaceId);
      if (!access.allowed) {
        return apiV2Error(res, 403, "FORBIDDEN", "Workspace not found or access denied");
      }
      const { email, role } = req.body || {};
      if (!email || typeof email !== "string") {
        return apiV2Error(res, 400, "INVALID_INPUT", "email is required");
      }
      const inviteRole = ["admin", "member", "viewer"].includes(role) ? role : "member";
      const inviteCode = randomUUID().slice(0, 8);
      const invite = {
        id: randomUUID(),
        workspaceId,
        email: email.trim(),
        role: inviteRole,
        code: inviteCode,
        createdBy: req.userId || "anonymous",
        createdAt: new Date().toISOString(),
        status: "pending",
      };
      // Store invite if storage supports it
      try {
        await storage.mergeItems("invites", workspaceId, [invite]);
      } catch {
        // invites collection may not exist in all backends
      }
      res.status(201).json(invite);
    } catch (err) {
      console.error("v2 workspaces invite error:", err.message);
      return apiV2Error(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}
