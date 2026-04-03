/**
 * Role-Based Access Control with custom role definitions.
 * Extends the basic admin/member roles with fine-grained permissions.
 */
import { join } from "path";
import { randomUUID } from "crypto";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";
import { canAccessWorkspace, getWorkspaceMembers } from "./teams.js";

/** All available permissions in the system */
export const PERMISSIONS = {
  // Workspace
  "workspace:read": "View workspace details",
  "workspace:write": "Modify workspace settings",
  "workspace:delete": "Delete workspace",
  // Conversations
  "conversation:read": "View conversations",
  "conversation:write": "Create/modify conversations",
  "conversation:delete": "Delete conversations",
  // Knowledge
  "knowledge:read": "Search knowledge base",
  "knowledge:write": "Index documents",
  "knowledge:delete": "Remove documents",
  // Agents
  "agent:execute": "Run agent loops and swarms",
  "agent:configure": "Modify agent settings",
  // Recipes
  "recipe:read": "View recipes",
  "recipe:write": "Create/modify recipes",
  "recipe:execute": "Execute recipes",
  // Admin
  "admin:users": "Manage users",
  "admin:billing": "Manage quotas and billing",
  "admin:audit": "View audit logs",
  "admin:keys": "Manage API keys",
  // Memory
  "memory:read": "View agent memories",
  "memory:write": "Store agent memories",
  "memory:delete": "Delete agent memories",
};

const ALL_PERMISSIONS = Object.keys(PERMISSIONS);

/** Built-in roles */
export const BUILT_IN_ROLES = {
  owner: { permissions: [...ALL_PERMISSIONS], builtin: true },
  admin: {
    permissions: ALL_PERMISSIONS.filter((p) => p !== "workspace:delete"),
    builtin: true,
  },
  member: {
    permissions: [
      "workspace:read",
      "conversation:read",
      "conversation:write",
      "knowledge:read",
      "agent:execute",
      "recipe:read",
      "memory:read",
    ],
    builtin: true,
  },
  viewer: {
    permissions: ["workspace:read", "conversation:read", "knowledge:read", "recipe:read"],
    builtin: true,
  },
};

function customRolesPath() {
  return join(getDataDir(), "rbac-custom-roles.json");
}

function roleAssignmentsPath() {
  return join(getDataDir(), "rbac-role-assignments.json");
}

/**
 * Create a custom role for a workspace.
 */
export async function createCustomRole(workspaceId, name, permissions) {
  if (!workspaceId || !name) throw new Error("workspaceId and name are required");
  const trimmedName = String(name).trim().slice(0, 100);
  if (!trimmedName) throw new Error("Role name is required");
  if (BUILT_IN_ROLES[trimmedName.toLowerCase()]) {
    throw new Error(`Cannot create role with built-in name: ${trimmedName}`);
  }
  const validPerms = (permissions || []).filter((p) => ALL_PERMISSIONS.includes(p));
  const path = customRolesPath();
  return withPathLock(path, async () => {
    const data = await readJsonPath(path, { _version: 1, byWorkspace: {} });
    if (!data.byWorkspace) data.byWorkspace = {};
    const wsKey = String(workspaceId);
    if (!data.byWorkspace[wsKey]) data.byWorkspace[wsKey] = [];
    const existing = data.byWorkspace[wsKey].find(
      (r) => r.name.toLowerCase() === trimmedName.toLowerCase(),
    );
    if (existing) throw new Error(`Role '${trimmedName}' already exists`);
    const role = {
      id: randomUUID(),
      name: trimmedName,
      permissions: validPerms,
      builtin: false,
      createdAt: new Date().toISOString(),
    };
    data.byWorkspace[wsKey].push(role);
    await writeJsonPath(path, data);
    return role;
  });
}

/**
 * Update a custom role.
 */
export async function updateCustomRole(workspaceId, roleId, updates) {
  const path = customRolesPath();
  return withPathLock(path, async () => {
    const data = await readJsonPath(path, { _version: 1, byWorkspace: {} });
    const wsKey = String(workspaceId);
    const roles = data.byWorkspace?.[wsKey] || [];
    const idx = roles.findIndex((r) => r.id === roleId);
    if (idx < 0) return null;
    if (roles[idx].builtin) throw new Error("Cannot modify built-in roles");
    if (updates.name !== undefined) {
      const trimmedName = String(updates.name).trim().slice(0, 100);
      if (BUILT_IN_ROLES[trimmedName.toLowerCase()]) {
        throw new Error(`Cannot use built-in role name: ${trimmedName}`);
      }
      roles[idx].name = trimmedName;
    }
    if (updates.permissions !== undefined) {
      roles[idx].permissions = (updates.permissions || []).filter((p) => ALL_PERMISSIONS.includes(p));
    }
    roles[idx].updatedAt = new Date().toISOString();
    data.byWorkspace[wsKey] = roles;
    await writeJsonPath(path, data);
    return roles[idx];
  });
}

/**
 * Delete a custom role.
 */
export async function deleteCustomRole(workspaceId, roleId) {
  const path = customRolesPath();
  return withPathLock(path, async () => {
    const data = await readJsonPath(path, { _version: 1, byWorkspace: {} });
    const wsKey = String(workspaceId);
    const roles = data.byWorkspace?.[wsKey] || [];
    const idx = roles.findIndex((r) => r.id === roleId);
    if (idx < 0) return false;
    if (roles[idx].builtin) throw new Error("Cannot delete built-in roles");
    roles.splice(idx, 1);
    data.byWorkspace[wsKey] = roles;
    await writeJsonPath(path, data);
    // Remove assignments for this role
    await _removeAssignmentsForRole(workspaceId, roleId);
    return true;
  });
}

async function _removeAssignmentsForRole(workspaceId, roleId) {
  const path = roleAssignmentsPath();
  return withPathLock(path, async () => {
    const data = await readJsonPath(path, { _version: 1, byWorkspace: {} });
    const wsKey = String(workspaceId);
    const assignments = data.byWorkspace?.[wsKey] || {};
    for (const userId of Object.keys(assignments)) {
      if (assignments[userId] === roleId) {
        delete assignments[userId];
      }
    }
    if (!data.byWorkspace) data.byWorkspace = {};
    data.byWorkspace[wsKey] = assignments;
    await writeJsonPath(path, data);
  });
}

/**
 * List all roles (built-in + custom) for a workspace.
 */
export async function listRoles(workspaceId) {
  const builtIn = Object.entries(BUILT_IN_ROLES).map(([name, def]) => ({
    id: name,
    name,
    permissions: def.permissions,
    builtin: true,
  }));
  const data = await readJsonPath(customRolesPath(), { _version: 1, byWorkspace: {} });
  const custom = data.byWorkspace?.[String(workspaceId)] || [];
  return [...builtIn, ...custom];
}

/**
 * Assign a role to a user in a workspace.
 * roleId can be a built-in role name (owner/admin/member/viewer) or a custom role UUID.
 */
export async function assignRole(workspaceId, userId, roleId) {
  if (!workspaceId || !userId || !roleId) {
    throw new Error("workspaceId, userId, and roleId are required");
  }
  // Validate roleId exists
  const allRoles = await listRoles(workspaceId);
  const role = allRoles.find((r) => r.id === roleId);
  if (!role) throw new Error(`Role '${roleId}' not found`);
  const path = roleAssignmentsPath();
  return withPathLock(path, async () => {
    const data = await readJsonPath(path, { _version: 1, byWorkspace: {} });
    if (!data.byWorkspace) data.byWorkspace = {};
    const wsKey = String(workspaceId);
    if (!data.byWorkspace[wsKey]) data.byWorkspace[wsKey] = {};
    data.byWorkspace[wsKey][String(userId)] = roleId;
    await writeJsonPath(path, data);
    return { userId, roleId, roleName: role.name };
  });
}

/**
 * Get the effective permissions for a user in a workspace.
 */
export async function getUserPermissions(workspaceId, userId) {
  if (!workspaceId || !userId) return [];
  // Check for custom role assignment first
  const assignData = await readJsonPath(roleAssignmentsPath(), { _version: 1, byWorkspace: {} });
  const wsKey = String(workspaceId);
  const assignedRoleId = assignData.byWorkspace?.[wsKey]?.[String(userId)];
  if (assignedRoleId) {
    // Check if it's a built-in role name
    if (BUILT_IN_ROLES[assignedRoleId]) {
      return BUILT_IN_ROLES[assignedRoleId].permissions;
    }
    // Check custom roles
    const customData = await readJsonPath(customRolesPath(), { _version: 1, byWorkspace: {} });
    const customRole = (customData.byWorkspace?.[wsKey] || []).find((r) => r.id === assignedRoleId);
    if (customRole) return customRole.permissions;
  }
  // Fall back to basic team role mapping
  const access = await canAccessWorkspace(workspaceId, userId);
  if (!access.allowed) return [];
  const basicRole = access.role || "member";
  // Map basic roles to RBAC roles
  const roleMap = { admin: "admin", member: "member", viewer: "viewer" };
  const mappedRole = roleMap[basicRole] || "member";
  return BUILT_IN_ROLES[mappedRole]?.permissions || [];
}

/**
 * Middleware: check if user has required permission(s) in the workspace.
 * Requires req.userId and req.params.id (workspaceId) or req.params.workspaceId.
 */
export function requirePermission(...permissions) {
  return async (req, res, next) => {
    // Session/OAuth users with admin scope: skip fine-grained check
    if (req.session?.userId && req.apiKeyScopes?.includes("admin")) {
      return next();
    }
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ error: "Authentication required", code: "AUTH_REQUIRED" });
    }
    const workspaceId = req.params.id || req.params.workspaceId || req.query.workspace;
    if (!workspaceId) {
      return res.status(400).json({ error: "Workspace ID required", code: "WORKSPACE_REQUIRED" });
    }
    try {
      const userPerms = await getUserPermissions(workspaceId, userId);
      const missing = permissions.filter((p) => !userPerms.includes(p));
      if (missing.length > 0) {
        return res.status(403).json({
          error: "Insufficient permissions",
          code: "PERMISSION_DENIED",
          required: permissions,
          missing,
        });
      }
      req.userPermissions = userPerms;
      next();
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  };
}
