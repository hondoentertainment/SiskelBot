/**
 * Role-Based Access Control with hierarchical roles and custom role definitions.
 * Extends the basic admin/member roles with fine-grained permissions.
 *
 * Permission format: action:resource (e.g., write:documents, manage:users)
 * Role inheritance: owner > admin > member > viewer
 */
import { join } from "path";
import { randomUUID } from "crypto";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";
import { canAccessWorkspace } from "./teams.js";

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
  // Mapped aliases for task spec compatibility
  "read:conversations": "View conversations (alias)",
  "read:documents": "View knowledge documents (alias)",
  "read:recipes": "View recipes (alias)",
  "read:workspaces": "View workspace details (alias)",
  "view:dashboard": "View workspace dashboard",
  "write:conversations": "Create/modify conversations (alias)",
  "write:documents": "Index documents (alias)",
  "write:recipes": "Create/modify recipes (alias)",
  "execute:recipes": "Execute recipes (alias)",
  "use:agent": "Run agent loops",
  "use:swarm": "Run swarm orchestration",
  "manage:users": "Manage workspace users",
  "manage:keys": "Manage API keys",
  "manage:quotas": "Manage quotas and billing",
  "manage:settings": "Modify workspace settings",
  "view:audit": "View audit logs",
  "manage:webhooks": "Manage webhooks",
};

const ALL_PERMISSIONS = Object.keys(PERMISSIONS);

/**
 * Built-in roles with inheritance hierarchy.
 * owner > admin > member > viewer
 */
export const ROLES = {
  owner: {
    inherits: ["admin"],
    permissions: ["*"],
  },
  admin: {
    inherits: ["member"],
    permissions: [
      "manage:users", "manage:keys", "manage:quotas", "manage:settings",
      "view:audit", "manage:webhooks",
      "admin:users", "admin:billing", "admin:audit", "admin:keys",
      "workspace:write", "workspace:delete",
      "conversation:delete", "knowledge:delete", "memory:delete",
      "agent:configure",
    ],
  },
  member: {
    inherits: ["viewer"],
    permissions: [
      "write:conversations", "write:documents", "write:recipes",
      "execute:recipes", "use:agent", "use:swarm",
      "conversation:write", "knowledge:write", "recipe:write", "recipe:execute",
      "agent:execute", "memory:read", "memory:write",
    ],
  },
  viewer: {
    permissions: [
      "read:conversations", "read:documents", "read:recipes",
      "read:workspaces", "view:dashboard",
      "workspace:read", "conversation:read", "knowledge:read", "recipe:read",
    ],
  },
};

/** Legacy BUILT_IN_ROLES computed from ROLES for backward compat */
export const BUILT_IN_ROLES = {};
for (const [name] of Object.entries(ROLES)) {
  BUILT_IN_ROLES[name] = {
    permissions: listPermissions(name),
    builtin: true,
  };
}

/**
 * Resolve all permissions for a role, including inherited permissions.
 * @param {string} roleName - Role name (built-in or custom)
 * @param {Array} [customRoles] - Optional array of custom role definitions
 * @returns {string[]} All effective permissions
 */
export function listPermissions(roleName, customRoles) {
  const seen = new Set();
  const perms = new Set();

  function collect(name) {
    if (seen.has(name)) return;
    seen.add(name);

    // Check built-in roles first
    const roleDef = ROLES[name];
    if (roleDef) {
      for (const p of roleDef.permissions || []) {
        perms.add(p);
      }
      for (const parent of roleDef.inherits || []) {
        collect(parent);
      }
      return;
    }

    // Check custom roles
    if (customRoles) {
      const custom = customRoles.find(
        (r) => r.name === name || r.id === name
      );
      if (custom) {
        for (const p of custom.permissions || []) {
          perms.add(p);
        }
        for (const parent of custom.inherits || []) {
          collect(parent);
        }
      }
    }
  }

  collect(roleName);

  // Wildcard expansion: if permissions include '*', return all known permissions
  if (perms.has("*")) {
    return [...ALL_PERMISSIONS];
  }
  return [...perms];
}

/**
 * Check if a role has a specific permission.
 * @param {string} userRole - The user's role name
 * @param {string} permission - The permission to check (action:resource)
 * @param {Array} [customRoles] - Optional array of custom role definitions for the workspace
 * @returns {boolean}
 */
export function hasPermission(userRole, permission, customRoles) {
  if (!userRole || !permission) return false;
  const perms = listPermissions(userRole, customRoles);
  return perms.includes(permission) || perms.includes("*");
}

function customRolesPath() {
  return join(getDataDir(), "rbac-custom-roles.json");
}

function roleAssignmentsPath() {
  return join(getDataDir(), "rbac-role-assignments.json");
}

/**
 * Create a custom role for a workspace.
 * @param {string} workspaceId
 * @param {string} name - Role name
 * @param {string[]} permissions - Array of permission strings
 * @param {string[]} [inherits] - Optional array of role names to inherit from
 */
export async function createCustomRole(workspaceId, name, permissions, inherits) {
  if (!workspaceId || !name) throw new Error("workspaceId and name are required");
  const trimmedName = String(name).trim().slice(0, 100);
  if (!trimmedName) throw new Error("Role name is required");
  if (ROLES[trimmedName.toLowerCase()]) {
    throw new Error(`Cannot create role with built-in name: ${trimmedName}`);
  }
  const validPerms = (permissions || []).filter((p) => ALL_PERMISSIONS.includes(p));
  const validInherits = (inherits || []).filter((r) => {
    // Allow inheriting from built-in roles or other custom roles (validated later)
    return typeof r === "string" && r.trim().length > 0;
  });
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
      inherits: validInherits,
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
      if (ROLES[trimmedName.toLowerCase()]) {
        throw new Error(`Cannot use built-in role name: ${trimmedName}`);
      }
      roles[idx].name = trimmedName;
    }
    if (updates.permissions !== undefined) {
      roles[idx].permissions = (updates.permissions || []).filter((p) => ALL_PERMISSIONS.includes(p));
    }
    if (updates.inherits !== undefined) {
      roles[idx].inherits = (updates.inherits || []).filter((r) => typeof r === "string" && r.trim().length > 0);
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
  const builtIn = Object.entries(ROLES).map(([name, def]) => ({
    id: name,
    name,
    permissions: def.permissions,
    inherits: def.inherits || [],
    effectivePermissions: listPermissions(name),
    builtin: true,
  }));
  const data = await readJsonPath(customRolesPath(), { _version: 1, byWorkspace: {} });
  const custom = (data.byWorkspace?.[String(workspaceId)] || []).map((r) => ({
    ...r,
    effectivePermissions: listPermissions(r.name, data.byWorkspace?.[String(workspaceId)] || []),
  }));
  return [...builtIn, ...custom];
}

/**
 * Get the role name/id for a user in a workspace.
 * @param {string} userId
 * @param {string} workspaceId
 * @returns {Promise<string|null>} Role name or custom role ID, or null if not found
 */
export async function getUserRole(userId, workspaceId) {
  if (!workspaceId || !userId) return null;
  // Check explicit RBAC assignment first
  const assignData = await readJsonPath(roleAssignmentsPath(), { _version: 1, byWorkspace: {} });
  const wsKey = String(workspaceId);
  const assignedRoleId = assignData.byWorkspace?.[wsKey]?.[String(userId)];
  if (assignedRoleId) return assignedRoleId;
  // Fall back to team role mapping
  const access = await canAccessWorkspace(workspaceId, userId);
  if (!access.allowed) return null;
  const basicRole = access.role || "member";
  const roleMap = { admin: "admin", member: "member", viewer: "viewer" };
  return roleMap[basicRole] || "member";
}

/**
 * Set (assign) a role to a user in a workspace.
 * Alias for assignRole with (userId, workspaceId, role) signature.
 * @param {string} userId
 * @param {string} workspaceId
 * @param {string} role - Built-in role name or custom role ID
 */
export async function setUserRole(userId, workspaceId, role) {
  return assignRole(workspaceId, userId, role);
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
    if (ROLES[assignedRoleId]) {
      return listPermissions(assignedRoleId);
    }
    // Check custom roles
    const customData = await readJsonPath(customRolesPath(), { _version: 1, byWorkspace: {} });
    const customRoles = customData.byWorkspace?.[wsKey] || [];
    const customRole = customRoles.find((r) => r.id === assignedRoleId);
    if (customRole) return listPermissions(customRole.name, customRoles);
  }
  // Fall back to basic team role mapping
  const access = await canAccessWorkspace(workspaceId, userId);
  if (!access.allowed) return [];
  const basicRole = access.role || "member";
  // Map basic roles to RBAC roles
  const roleMap = { admin: "admin", member: "member", viewer: "viewer" };
  const mappedRole = roleMap[basicRole] || "member";
  return listPermissions(mappedRole);
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
      const role = await getUserRole(userId, workspaceId);
      const customData = await readJsonPath(customRolesPath(), { _version: 1, byWorkspace: {} });
      const customRoles = customData.byWorkspace?.[String(workspaceId)] || [];
      for (const perm of permissions) {
        if (!hasPermission(role, perm, customRoles)) {
          return res.status(403).json({
            error: "Insufficient permissions",
            code: "FORBIDDEN",
            required: perm,
            missing: [perm],
          });
        }
      }
      req.userPermissions = await getUserPermissions(workspaceId, userId);
      req.userRole = role;
      next();
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  };
}
