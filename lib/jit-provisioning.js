/**
 * Phase 46.3: Just-in-time user provisioning.
 *
 * Creates and updates users automatically on first SSO login based on
 * IdP claims. Supports attribute mapping, group-to-role mapping, and
 * deprovisioning with audit trail.
 *
 * Storage:
 *   data/jit-users.json   — provisioned user records (provider, email, groups, role, ...)
 *   data/jit-config.json  — per-workspace JIT configuration
 *   data/jit-audit.json   — provisioning audit log
 */
import { join } from "path";
import { randomUUID } from "crypto";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";
import { setUserRole } from "./rbac.js";
import { registerWorkspaceMembers, addWorkspaceMember } from "./teams.js";

/** Default attribute mapping aligned with OIDC standard claims. */
export const DEFAULT_ATTRIBUTE_MAPPING = {
  userId: "sub",
  email: "email",
  name: "name",
  firstName: "given_name",
  lastName: "family_name",
  groups: "groups",
  picture: "picture",
  locale: "locale",
};

/** Default group-to-role mapping. */
export const DEFAULT_GROUP_MAPPING = {
  "siskelbot-owners": "owner",
  "siskelbot-admins": "admin",
  "siskelbot-members": "member",
  "siskelbot-viewers": "viewer",
};

/** Required attributes for provisioning. */
export const REQUIRED_ATTRIBUTES = ["userId", "email"];

const VALID_ROLES = new Set(["owner", "admin", "member", "viewer"]);

function jitUsersPath() {
  return join(getDataDir(), "jit-users.json");
}

function jitConfigPath() {
  return join(getDataDir(), "jit-config.json");
}

function jitAuditPath() {
  return join(getDataDir(), "jit-audit.json");
}

function sanitizeId(value) {
  return String(value || "").replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 100);
}

/**
 * Apply attribute mapping to normalize a raw IdP profile.
 * Each mapping value is a key (or dotted path) into the source profile.
 *
 * @param {Record<string,any>} profile
 * @param {Record<string,string>} [mapping]
 * @returns {Record<string,any>}
 */
export function applyMapping(profile, mapping) {
  const map = { ...DEFAULT_ATTRIBUTE_MAPPING, ...(mapping || {}) };
  const out = {};
  if (!profile || typeof profile !== "object") return out;

  for (const [target, source] of Object.entries(map)) {
    if (!source || typeof source !== "string") continue;
    const value = readPath(profile, source);
    if (value !== undefined && value !== null && value !== "") {
      out[target] = value;
    }
  }
  return out;
}

function readPath(obj, path) {
  if (!obj || !path) return undefined;
  const parts = String(path).split(".");
  let cur = obj;
  for (const part of parts) {
    if (cur == null) return undefined;
    cur = cur[part];
  }
  return cur;
}

/**
 * Validate that all required attributes are present on the normalized profile.
 *
 * @param {Record<string,any>} profile
 * @param {string[]} [required]
 * @returns {{ ok: boolean, missing: string[] }}
 */
export function validateRequiredAttributes(profile, required) {
  const list = Array.isArray(required) && required.length > 0 ? required : REQUIRED_ATTRIBUTES;
  const missing = [];
  for (const key of list) {
    const v = profile?.[key];
    if (v === undefined || v === null || v === "") missing.push(key);
  }
  return { ok: missing.length === 0, missing };
}

/**
 * Map an IdP profile (raw claims) to a normalized SiskelBot user object.
 * Returns the normalized user shape with provider/externalId set when known.
 *
 * @param {Record<string,any>} profile
 * @param {{ userIdField?: string, emailField?: string, nameField?: string, groupsField?: string, mapping?: object, provider?: string }} [mappingConfig]
 * @returns {Promise<Record<string, any>>}
 */
export async function mapSSOClaimsToUser(profile, mappingConfig = {}) {
  const cfg = mappingConfig || {};
  const baseMapping = { ...DEFAULT_ATTRIBUTE_MAPPING, ...(cfg.mapping || {}) };
  if (cfg.userIdField) baseMapping.userId = cfg.userIdField;
  if (cfg.emailField) baseMapping.email = cfg.emailField;
  if (cfg.nameField) baseMapping.name = cfg.nameField;
  if (cfg.groupsField) baseMapping.groups = cfg.groupsField;

  const normalized = applyMapping(profile, baseMapping);

  // Coerce groups to an array.
  if (normalized.groups != null && !Array.isArray(normalized.groups)) {
    if (typeof normalized.groups === "string") {
      normalized.groups = normalized.groups
        .split(/[,;\s]+/)
        .map((g) => g.trim())
        .filter(Boolean);
    } else {
      normalized.groups = [];
    }
  }
  if (!normalized.groups) normalized.groups = [];

  // Synthesize a name from first/last when missing.
  if (!normalized.name) {
    const first = normalized.firstName || "";
    const last = normalized.lastName || "";
    const combined = `${first} ${last}`.trim();
    if (combined) normalized.name = combined;
  }

  if (cfg.provider) normalized.provider = cfg.provider;
  if (normalized.userId) normalized.externalId = String(normalized.userId);

  return normalized;
}

/**
 * Get JIT configuration for a workspace, falling back to defaults.
 *
 * @param {string} workspaceId
 * @returns {Promise<{ enabled: boolean, defaultRole: string, groupMapping: Record<string,string>, attributeMapping: Record<string,string>, requiredAttributes: string[], createWorkspace: boolean }>}
 */
export async function getJITConfig(workspaceId) {
  const data = await readJsonPath(jitConfigPath(), { _version: 1, byWorkspace: {} });
  const wsKey = String(workspaceId || "default");
  const stored = data.byWorkspace?.[wsKey] || {};
  return {
    enabled: stored.enabled !== false,
    defaultRole: stored.defaultRole || "member",
    groupMapping: { ...DEFAULT_GROUP_MAPPING, ...(stored.groupMapping || {}) },
    attributeMapping: { ...DEFAULT_ATTRIBUTE_MAPPING, ...(stored.attributeMapping || {}) },
    requiredAttributes: Array.isArray(stored.requiredAttributes) && stored.requiredAttributes.length > 0
      ? stored.requiredAttributes
      : [...REQUIRED_ATTRIBUTES],
    createWorkspace: stored.createWorkspace === true,
  };
}

/**
 * Persist JIT configuration for a workspace.
 *
 * @param {string} workspaceId
 * @param {object} config
 * @returns {Promise<object>} The merged stored configuration.
 */
export async function setJITConfig(workspaceId, config) {
  if (!workspaceId) throw new Error("workspaceId is required");
  const path = jitConfigPath();
  return withPathLock(path, async () => {
    const data = await readJsonPath(path, { _version: 1, byWorkspace: {} });
    if (!data.byWorkspace) data.byWorkspace = {};
    const wsKey = String(workspaceId);
    const prev = data.byWorkspace[wsKey] || {};
    const next = {
      ...prev,
      ...(typeof config === "object" && config ? config : {}),
      updatedAt: new Date().toISOString(),
    };
    if (next.defaultRole && !VALID_ROLES.has(next.defaultRole)) {
      throw new Error(`Invalid defaultRole: ${next.defaultRole}`);
    }
    data.byWorkspace[wsKey] = next;
    await writeJsonPath(path, data);
    return next;
  });
}

/**
 * Map IdP groups to a SiskelBot role.
 * The first matching group wins, ordered by role precedence (owner > admin > member > viewer).
 *
 * @param {string[]} groups
 * @param {string} workspaceId
 * @returns {Promise<{ role: string, workspaceId: string, matchedGroup: string|null }>}
 */
export async function applyGroupToRoleMapping(groups, workspaceId) {
  const cfg = await getJITConfig(workspaceId);
  const arr = Array.isArray(groups) ? groups : [];
  const precedence = ["owner", "admin", "member", "viewer"];

  let bestRole = null;
  let bestRank = precedence.length;
  let matchedGroup = null;

  for (const g of arr) {
    if (g == null) continue;
    const role = cfg.groupMapping[String(g)];
    if (role && VALID_ROLES.has(role)) {
      const rank = precedence.indexOf(role);
      if (rank >= 0 && rank < bestRank) {
        bestRank = rank;
        bestRole = role;
        matchedGroup = String(g);
      }
    }
  }

  return {
    role: bestRole || cfg.defaultRole || "member",
    workspaceId: String(workspaceId || "default"),
    matchedGroup,
  };
}

/**
 * Append an entry to the JIT audit log.
 *
 * @param {{ event: string, userId?: string, workspaceId?: string, provider?: string, externalId?: string, role?: string, reason?: string, meta?: object }} entry
 */
async function recordAudit(entry) {
  const path = jitAuditPath();
  return withPathLock(path, async () => {
    const data = await readJsonPath(path, { _version: 1, items: [] });
    if (!Array.isArray(data.items)) data.items = [];
    data.items.push({
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      ...entry,
    });
    if (data.items.length > 5000) {
      data.items = data.items.slice(-5000);
    }
    await writeJsonPath(path, data);
  });
}

/**
 * Provision (or update) a user from an SSO profile on first or repeat login.
 *
 * @param {{ email?: string, name?: string, groups?: string[], provider?: string, externalId?: string, [k: string]: any }} ssoProfile
 * @param {{ defaultRole?: string, defaultWorkspace?: string, createWorkspace?: boolean, requiredAttributes?: string[] }} [options]
 * @returns {Promise<{ userId: string, workspaceId: string, created: boolean, role: string }>}
 */
export async function provisionUserFromSSO(ssoProfile, options = {}) {
  if (!ssoProfile || typeof ssoProfile !== "object") {
    throw new Error("ssoProfile is required");
  }
  const opts = options || {};
  const workspaceId = String(opts.defaultWorkspace || "default");
  const cfg = await getJITConfig(workspaceId);

  if (!cfg.enabled) {
    throw new Error("JIT provisioning is disabled for this workspace");
  }

  const required = Array.isArray(opts.requiredAttributes) && opts.requiredAttributes.length > 0
    ? opts.requiredAttributes
    : cfg.requiredAttributes;
  const validation = validateRequiredAttributes(
    {
      userId: ssoProfile.externalId || ssoProfile.userId,
      email: ssoProfile.email,
      name: ssoProfile.name,
      groups: ssoProfile.groups,
    },
    required
  );
  if (!validation.ok) {
    await recordAudit({
      event: "provision_failed",
      provider: ssoProfile.provider || null,
      externalId: ssoProfile.externalId || null,
      workspaceId,
      reason: `missing_attributes:${validation.missing.join(",")}`,
    });
    throw new Error(`Missing required SSO attributes: ${validation.missing.join(", ")}`);
  }

  const provider = String(ssoProfile.provider || "sso");
  const externalId = String(ssoProfile.externalId || ssoProfile.userId || ssoProfile.email);
  const groupResult = await applyGroupToRoleMapping(ssoProfile.groups || [], workspaceId);
  const resolvedRole = opts.defaultRole && VALID_ROLES.has(opts.defaultRole)
    ? opts.defaultRole
    : groupResult.role;

  const path = jitUsersPath();
  const result = await withPathLock(path, async () => {
    const data = await readJsonPath(path, { _version: 1, users: [] });
    if (!Array.isArray(data.users)) data.users = [];

    const key = `${provider}:${externalId}`;
    let existing = data.users.find((u) => `${u.provider}:${u.externalId}` === key);
    let created = false;
    let userId;

    if (existing) {
      userId = existing.userId;
      existing.email = ssoProfile.email || existing.email;
      existing.name = ssoProfile.name || existing.name;
      existing.groups = Array.isArray(ssoProfile.groups) ? [...ssoProfile.groups] : existing.groups || [];
      existing.role = resolvedRole;
      existing.workspaceId = workspaceId;
      existing.lastLoginAt = new Date().toISOString();
      existing.deprovisionedAt = null;
      existing.deprovisionedReason = null;
    } else {
      userId = `${provider}-${sanitizeId(externalId)}`;
      const record = {
        userId,
        provider,
        externalId,
        email: ssoProfile.email || null,
        name: ssoProfile.name || null,
        groups: Array.isArray(ssoProfile.groups) ? [...ssoProfile.groups] : [],
        role: resolvedRole,
        workspaceId,
        provisionedAt: new Date().toISOString(),
        lastLoginAt: new Date().toISOString(),
        deprovisionedAt: null,
        deprovisionedReason: null,
        jit: true,
      };
      data.users.push(record);
      created = true;
    }

    await writeJsonPath(path, data);
    return { userId, created };
  });

  // Ensure workspace membership.
  try {
    await addWorkspaceMember(workspaceId, result.userId, "member", result.userId);
  } catch (_) {
    // Best-effort: workspace may not exist as a team workspace.
    if (cfg.createWorkspace || opts.createWorkspace) {
      try {
        await registerWorkspaceMembers(workspaceId, result.userId, [
          { userId: result.userId, role: "admin" },
        ]);
      } catch (_) {}
    }
  }

  // Apply RBAC role assignment (best effort — role may not be assignable yet).
  try {
    await setUserRole(result.userId, workspaceId, resolvedRole);
  } catch (_) {}

  await recordAudit({
    event: result.created ? "user_provisioned" : "user_updated",
    userId: result.userId,
    workspaceId,
    provider,
    externalId,
    role: resolvedRole,
    meta: {
      matchedGroup: groupResult.matchedGroup,
      groups: ssoProfile.groups || [],
    },
  });

  return {
    userId: result.userId,
    workspaceId,
    created: result.created,
    role: resolvedRole,
  };
}

/**
 * Update an existing JIT-provisioned user with the latest SSO profile.
 *
 * @param {string} userId
 * @param {{ email?: string, name?: string, groups?: string[], role?: string }} ssoProfile
 * @returns {Promise<object|null>}
 */
export async function updateUserFromSSO(userId, ssoProfile) {
  if (!userId) throw new Error("userId is required");
  const path = jitUsersPath();
  return withPathLock(path, async () => {
    const data = await readJsonPath(path, { _version: 1, users: [] });
    if (!Array.isArray(data.users)) data.users = [];
    const idx = data.users.findIndex((u) => u.userId === userId);
    if (idx < 0) return null;
    const user = data.users[idx];
    if (ssoProfile?.email) user.email = ssoProfile.email;
    if (ssoProfile?.name) user.name = ssoProfile.name;
    if (Array.isArray(ssoProfile?.groups)) user.groups = [...ssoProfile.groups];
    if (ssoProfile?.role && VALID_ROLES.has(ssoProfile.role)) {
      user.role = ssoProfile.role;
      try {
        await setUserRole(userId, user.workspaceId || "default", ssoProfile.role);
      } catch (_) {}
    }
    user.lastLoginAt = new Date().toISOString();
    user.updatedAt = new Date().toISOString();
    data.users[idx] = user;
    await writeJsonPath(path, data);

    await recordAudit({
      event: "user_updated",
      userId,
      workspaceId: user.workspaceId || null,
      provider: user.provider || null,
      role: user.role || null,
    });

    return user;
  });
}

/**
 * Soft-delete a JIT user. Preserves the audit trail and revokes role assignments.
 *
 * @param {string} userId
 * @param {string} [reason]
 * @returns {Promise<{ userId: string, deprovisioned: boolean }>}
 */
export async function deprovisionUser(userId, reason) {
  if (!userId) throw new Error("userId is required");
  const path = jitUsersPath();
  const result = await withPathLock(path, async () => {
    const data = await readJsonPath(path, { _version: 1, users: [] });
    if (!Array.isArray(data.users)) data.users = [];
    const idx = data.users.findIndex((u) => u.userId === userId);
    if (idx < 0) return { userId, deprovisioned: false };
    const user = data.users[idx];
    user.deprovisionedAt = new Date().toISOString();
    user.deprovisionedReason = reason || "manual";
    user.active = false;
    data.users[idx] = user;
    await writeJsonPath(path, data);
    return { userId, deprovisioned: true, workspaceId: user.workspaceId || null, provider: user.provider || null };
  });

  await recordAudit({
    event: "user_deprovisioned",
    userId,
    workspaceId: result.workspaceId || null,
    provider: result.provider || null,
    reason: reason || "manual",
  });

  return { userId, deprovisioned: result.deprovisioned };
}

/**
 * List JIT-provisioned users for a workspace (or all if not specified).
 *
 * @param {string} [workspaceId]
 * @returns {Promise<object[]>}
 */
export async function listProvisionedUsers(workspaceId) {
  const data = await readJsonPath(jitUsersPath(), { _version: 1, users: [] });
  const all = Array.isArray(data.users) ? data.users : [];
  if (!workspaceId) return all;
  const wsKey = String(workspaceId);
  return all.filter((u) => String(u.workspaceId || "default") === wsKey);
}

/**
 * Read the JIT provisioning audit log, optionally scoped to a workspace.
 *
 * @param {string} [workspaceId]
 * @param {number} [limit]
 * @returns {Promise<object[]>}
 */
export async function listAuditLog(workspaceId, limit = 100) {
  const data = await readJsonPath(jitAuditPath(), { _version: 1, items: [] });
  const items = Array.isArray(data.items) ? data.items : [];
  const filtered = workspaceId
    ? items.filter((i) => String(i.workspaceId || "") === String(workspaceId))
    : items;
  const n = Math.max(1, Math.min(1000, Number(limit) || 100));
  return filtered.slice(-n).reverse();
}

/**
 * Look up a JIT user by provider + external ID. Used by OAuth/SAML callbacks
 * to detect repeat logins.
 *
 * @param {string} provider
 * @param {string} externalId
 * @returns {Promise<object|null>}
 */
export async function findJITUser(provider, externalId) {
  const data = await readJsonPath(jitUsersPath(), { _version: 1, users: [] });
  const users = Array.isArray(data.users) ? data.users : [];
  return users.find((u) => u.provider === provider && u.externalId === String(externalId)) || null;
}
