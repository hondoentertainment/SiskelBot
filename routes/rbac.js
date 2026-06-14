/**
 * RBAC route module -- role and permission management endpoints.
 *
 * Routes:
 *   GET  /api/v1/permissions                         - list all available permissions
 *   GET  /api/v1/workspaces/:id/roles                - list roles for a workspace
 *   GET  /api/v1/workspaces/:id/members/:userId/role - get user role in workspace
 *   PUT  /api/v1/workspaces/:id/members/:userId/role - set user role in workspace
 *   POST /api/v1/workspaces/:id/roles                - create custom role
 */
import {
  PERMISSIONS,
  listRoles,
  getUserRole,
  setUserRole,
  createCustomRole,
  listPermissions,
  hasPermission,
} from "../lib/rbac.js";

export function mountRbacRoutes(app, deps) {
  const {
    apiRoute,
    apiError,
    userAuth,
    requireScope,
    storageRateLimiter,
    logRequest,
  } = deps;

  // GET /api/v1/permissions - list all available permissions
  apiRoute("get", "/permissions", storageRateLimiter, userAuth, logRequest, async (_req, res) => {
    try {
      const permissions = Object.entries(PERMISSIONS).map(([key, description]) => ({
        permission: key,
        description,
      }));
      res.json({ permissions });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  // GET /api/v1/workspaces/:id/roles - list roles and their permissions
  apiRoute("get", "/workspaces/:id/roles", storageRateLimiter, userAuth, requireScope("read"), logRequest, async (req, res) => {
    try {
      const workspaceId = req.params.id;
      if (!workspaceId) return apiError(res, 400, "INVALID_INPUT", "Workspace ID required", null);
      const roles = await listRoles(workspaceId);
      res.json({ roles });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  // GET /api/v1/workspaces/:id/members/:userId/role - get user role
  apiRoute("get", "/workspaces/:id/members/:userId/role", storageRateLimiter, userAuth, requireScope("read"), logRequest, async (req, res) => {
    try {
      const { id: workspaceId, userId } = req.params;
      if (!workspaceId || !userId) {
        return apiError(res, 400, "INVALID_INPUT", "Workspace ID and user ID required", null);
      }
      const role = await getUserRole(userId, workspaceId);
      if (!role) {
        return apiError(res, 404, "NOT_FOUND", "User role not found in workspace", null);
      }
      const allRoles = await listRoles(workspaceId);
      const roleDef = allRoles.find((r) => r.id === role || r.name === role);
      res.json({
        userId,
        workspaceId,
        role,
        roleName: roleDef?.name || role,
        permissions: roleDef?.effectivePermissions || listPermissions(role),
      });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  // PUT /api/v1/workspaces/:id/members/:userId/role - set user role
  apiRoute("put", "/workspaces/:id/members/:userId/role", storageRateLimiter, userAuth, requireScope("admin"), logRequest, async (req, res) => {
    try {
      const { id: workspaceId, userId } = req.params;
      const { role } = req.body || {};
      if (!workspaceId || !userId) {
        return apiError(res, 400, "INVALID_INPUT", "Workspace ID and user ID required", null);
      }
      if (!role) {
        return apiError(res, 400, "INVALID_INPUT", "role is required in request body", null);
      }
      // Check that the requester has manage:users permission
      const requesterRole = await getUserRole(req.userId, workspaceId);
      if (!requesterRole || !hasPermission(requesterRole, "manage:users")) {
        return apiError(res, 403, "FORBIDDEN", "You need manage:users permission to change roles", null);
      }
      const result = await setUserRole(userId, workspaceId, role);
      res.json(result);
    } catch (err) {
      if (err.message?.includes("not found")) {
        return apiError(res, 404, "NOT_FOUND", err.message, null);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  // POST /api/v1/workspaces/:id/roles - create custom role
  apiRoute("post", "/workspaces/:id/roles", storageRateLimiter, userAuth, requireScope("admin"), logRequest, async (req, res) => {
    try {
      const workspaceId = req.params.id;
      const { name, permissions, inherits } = req.body || {};
      if (!workspaceId) {
        return apiError(res, 400, "INVALID_INPUT", "Workspace ID required", null);
      }
      if (!name) {
        return apiError(res, 400, "INVALID_INPUT", "name is required", null);
      }
      // Check that the requester has manage:users permission
      const requesterRole = await getUserRole(req.userId, workspaceId);
      if (!requesterRole || !hasPermission(requesterRole, "manage:users")) {
        return apiError(res, 403, "FORBIDDEN", "You need manage:users permission to create roles", null);
      }
      const role = await createCustomRole(workspaceId, name, permissions, inherits);
      res.status(201).json(role);
    } catch (err) {
      if (err.message?.includes("already exists") || err.message?.includes("built-in")) {
        return apiError(res, 409, "CONFLICT", err.message, null);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });
}
