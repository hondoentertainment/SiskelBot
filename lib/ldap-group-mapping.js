/**
 * Phase 46.1: Mapping of LDAP groups to SiskelBot roles.
 *
 * The mapping is stored per workspace in `data/ldap-group-mapping.json` via
 * the json-path-store so it follows the same persistence backend as the
 * rest of the app (file / SQLite / Postgres).
 *
 * Mapping format:
 *   { "<group dn or cn>": "<role>" }
 *
 * Roles follow the SiskelBot RBAC vocabulary: "owner", "admin", "member",
 * "viewer". When a user belongs to multiple mapped groups, the highest
 * privilege role wins.
 */

import { join } from "node:path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

/**
 * Default mapping shipped with SiskelBot. Operators may override this per
 * workspace via setGroupMapping.
 */
export const DEFAULT_GROUP_MAPPING = {
  "cn=siskelbot-admins,ou=groups,dc=example,dc=com": "admin",
  "cn=siskelbot-members,ou=groups,dc=example,dc=com": "member",
  "cn=siskelbot-viewers,ou=groups,dc=example,dc=com": "viewer",
};

/**
 * Role precedence — higher index = more privilege.
 */
const ROLE_PRECEDENCE = ["viewer", "member", "admin", "owner"];

function ldapMappingPath() {
  return join(getDataDir(), "ldap-group-mapping.json");
}

function normalizeKey(key) {
  return String(key || "").trim().toLowerCase();
}

/**
 * Resolve a SiskelBot role for a user given the LDAP groups they belong to.
 *
 * @param {Array<{ dn?: string, name?: string } | string>} groups
 * @param {Record<string, string>} [mapping]
 * @returns {Promise<string|null>} role name, or null when no group matches
 */
export async function getUserRoleFromGroups(groups, mapping) {
  if (!Array.isArray(groups) || groups.length === 0) return null;
  const map = mapping && typeof mapping === "object" ? mapping : DEFAULT_GROUP_MAPPING;
  const lowerMap = new Map();
  for (const [k, v] of Object.entries(map)) {
    lowerMap.set(normalizeKey(k), v);
  }

  let bestRole = null;
  let bestRank = -1;
  for (const group of groups) {
    if (!group) continue;
    const candidates = [];
    if (typeof group === "string") {
      candidates.push(group);
      const cn = /^cn=([^,]+)/i.exec(group);
      if (cn) candidates.push(cn[1]);
    } else {
      if (group.dn) {
        candidates.push(group.dn);
        const cn = /^cn=([^,]+)/i.exec(group.dn);
        if (cn) candidates.push(cn[1]);
      }
      if (group.name) candidates.push(group.name);
    }
    for (const candidate of candidates) {
      const role = lowerMap.get(normalizeKey(candidate));
      if (!role) continue;
      const rank = ROLE_PRECEDENCE.indexOf(role);
      if (rank > bestRank) {
        bestRank = rank;
        bestRole = role;
      }
    }
  }
  return bestRole;
}

/**
 * Set the group mapping for a workspace. Pass `null`/`undefined` for
 * `workspaceId` to update the default ("global") mapping.
 *
 * @param {string|null} workspaceId
 * @param {Record<string,string>} mapping
 * @returns {Promise<Record<string,string>>}
 */
export async function setGroupMapping(workspaceId, mapping) {
  if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) {
    throw new Error("mapping must be an object of { groupKey: role }");
  }
  // Validate values are known roles.
  for (const [key, role] of Object.entries(mapping)) {
    if (!ROLE_PRECEDENCE.includes(role)) {
      throw new Error(`unknown role "${role}" for group "${key}". Allowed: ${ROLE_PRECEDENCE.join(", ")}`);
    }
  }
  const path = ldapMappingPath();
  return withPathLock(path, async () => {
    const data = await readJsonPath(path, { _version: 1, workspaces: {} });
    const workspaces = data.workspaces && typeof data.workspaces === "object" ? { ...data.workspaces } : {};
    workspaces[workspaceId || "default"] = { ...mapping };
    await writeJsonPath(path, { _version: 1, workspaces });
    return workspaces[workspaceId || "default"];
  });
}

/**
 * Fetch the group-to-role mapping for a workspace. Returns the default
 * mapping when no override has been stored.
 *
 * @param {string|null} workspaceId
 * @returns {Promise<Record<string,string>>}
 */
export async function getGroupMapping(workspaceId) {
  const path = ldapMappingPath();
  const data = await readJsonPath(path, { _version: 1, workspaces: {} });
  const workspaces = data.workspaces || {};
  const stored = workspaces[workspaceId || "default"];
  if (stored && typeof stored === "object" && Object.keys(stored).length > 0) {
    return { ...stored };
  }
  return { ...DEFAULT_GROUP_MAPPING };
}

/**
 * List all known role names (utility for UIs).
 * @returns {string[]}
 */
export function listRoles() {
  return [...ROLE_PRECEDENCE];
}
