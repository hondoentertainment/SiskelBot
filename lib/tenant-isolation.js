/**
 * Phase 24: Monetization & Multi-Tenancy — Row-level security helpers.
 * Provides query scoping and workspace access validation for multi-tenant isolation.
 */
import { canAccessWorkspace } from "./teams.js";

/**
 * Scope a query or filter object by workspaceId.
 * For SQL-style queries (strings), appends a WHERE/AND clause.
 * For object-style filters, adds a workspaceId property.
 *
 * @param {string | object} query - SQL string or filter object
 * @param {string} workspaceId
 * @returns {string | object}
 */
export function scopeQuery(query, workspaceId) {
  const ws = String(workspaceId || "default").trim();

  if (typeof query === "string") {
    const normalized = query.trim();
    if (!normalized) {
      return `WHERE workspace_id = '${escapeSql(ws)}'`;
    }
    const upperQuery = normalized.toUpperCase();
    if (upperQuery.includes("WHERE")) {
      return normalized.replace(/WHERE/i, `WHERE workspace_id = '${escapeSql(ws)}' AND`);
    }
    return `${normalized} WHERE workspace_id = '${escapeSql(ws)}'`;
  }

  if (query && typeof query === "object") {
    return { ...query, workspaceId: ws };
  }

  return { workspaceId: ws };
}

/**
 * Scope a SQL query using parameterized placeholders (safe from injection).
 * Returns the modified query and an array of parameter values.
 *
 * @param {string} query - SQL query string
 * @param {Array} params - Existing parameter values
 * @param {string} workspaceId
 * @returns {{ query: string, params: Array }}
 */
export function scopeQueryParameterized(query, params, workspaceId) {
  const ws = String(workspaceId || "default").trim();
  const existingParams = Array.isArray(params) ? [...params] : [];
  const paramIndex = existingParams.length + 1;
  const normalized = (query || "").trim();

  if (!normalized) {
    return {
      query: `WHERE workspace_id = $${paramIndex}`,
      params: [...existingParams, ws],
    };
  }

  const upperQuery = normalized.toUpperCase();
  if (upperQuery.includes("WHERE")) {
    return {
      query: normalized.replace(/WHERE/i, `WHERE workspace_id = $${paramIndex} AND`),
      params: [...existingParams, ws],
    };
  }

  return {
    query: `${normalized} WHERE workspace_id = $${paramIndex}`,
    params: [...existingParams, ws],
  };
}

/**
 * Validate that a user has access to a specific workspace.
 * Uses the team membership system for authorization.
 *
 * @param {string} userId
 * @param {string} workspaceId
 * @returns {Promise<{ allowed: boolean, role?: string, error?: string }>}
 */
export async function validateWorkspaceAccess(userId, workspaceId) {
  if (!userId || typeof userId !== "string" || !userId.trim()) {
    return { allowed: false, error: "User ID is required" };
  }
  if (!workspaceId || typeof workspaceId !== "string" || !workspaceId.trim()) {
    return { allowed: false, error: "Workspace ID is required" };
  }

  // The "default" workspace is accessible to all authenticated users
  if (workspaceId.trim() === "default") {
    return { allowed: true, role: "member" };
  }

  const result = await canAccessWorkspace(workspaceId, userId);
  if (result.allowed) {
    return { allowed: true, role: result.role };
  }

  return { allowed: false, error: "User does not have access to this workspace" };
}

/**
 * Filter an array of records to only those belonging to a workspace.
 * @param {Array<object>} records
 * @param {string} workspaceId
 * @param {string} [field] - field name containing the workspace ID (default: "workspaceId")
 * @returns {Array<object>}
 */
export function filterByWorkspace(records, workspaceId, field = "workspaceId") {
  const ws = String(workspaceId || "default").trim();
  if (!Array.isArray(records)) return [];
  return records.filter((r) => r && String(r[field] || "default") === ws);
}

/**
 * Simple SQL value escaper for use in scopeQuery (non-parameterized).
 * Prefer scopeQueryParameterized for production use.
 * @param {string} value
 * @returns {string}
 */
function escapeSql(value) {
  return String(value).replace(/'/g, "''");
}
