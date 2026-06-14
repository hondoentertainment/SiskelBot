/**
 * Phase 46.2: SCIM 2.0 server implementation (RFC 7643 / RFC 7644).
 *
 * Allows enterprise identity providers (Okta, Azure AD, OneLogin, Google
 * Workspace, etc.) to provision and deprovision users and groups
 * automatically. Persists SCIM resources via lib/json-path-store.js so the
 * data is durable across all storage backends (file, SQLite KV, Postgres KV).
 *
 * Resources are stored under:
 *   data/scim/users.json   { users: { [id]: SCIMUser } }
 *   data/scim/groups.json  { groups: { [id]: SCIMGroup } }
 *
 * @module scim
 */
import { join } from "path";
import { randomUUID } from "crypto";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

export const SCIM_SCHEMAS = {
  user: "urn:ietf:params:scim:schemas:core:2.0:User",
  group: "urn:ietf:params:scim:schemas:core:2.0:Group",
  enterpriseUser: "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User",
  listResponse: "urn:ietf:params:scim:api:messages:2.0:ListResponse",
  patchOp: "urn:ietf:params:scim:api:messages:2.0:PatchOp",
  error: "urn:ietf:params:scim:api:messages:2.0:Error",
  serviceProviderConfig: "urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig",
  resourceType: "urn:ietf:params:scim:schemas:core:2.0:ResourceType",
  schema: "urn:ietf:params:scim:schemas:core:2.0:Schema",
};

const RESOURCE_TYPES = {
  User: "User",
  Group: "Group",
};

function usersPath() {
  return join(getDataDir(), "scim", "users.json");
}

function groupsPath() {
  return join(getDataDir(), "scim", "groups.json");
}

function nowIso() {
  return new Date().toISOString();
}

function buildMeta(resourceType, id, created, updated) {
  return {
    resourceType,
    created: created || nowIso(),
    lastModified: updated || nowIso(),
    location: `/scim/v2/${resourceType}s/${id}`,
    version: `W/"${(updated || created || nowIso())}"`,
  };
}

async function loadUsers() {
  const data = await readJsonPath(usersPath(), { users: {} });
  return data.users && typeof data.users === "object" ? data.users : {};
}

async function saveUsers(users) {
  await writeJsonPath(usersPath(), { users });
}

async function loadGroups() {
  const data = await readJsonPath(groupsPath(), { groups: {} });
  return data.groups && typeof data.groups === "object" ? data.groups : {};
}

async function saveGroups(groups) {
  await writeJsonPath(groupsPath(), { groups });
}

/**
 * Normalize a SCIM user resource. Adds id and meta if missing.
 * @param {object} userData - SCIM user payload
 * @param {string} [id] - existing id (for updates)
 * @returns {object}
 */
function normalizeUser(userData, id) {
  const safe = userData && typeof userData === "object" ? userData : {};
  const finalId = id || safe.id || randomUUID();
  const schemas = Array.isArray(safe.schemas) && safe.schemas.length
    ? safe.schemas
    : [SCIM_SCHEMAS.user];
  // Ensure core User schema is always included.
  if (!schemas.includes(SCIM_SCHEMAS.user)) {
    schemas.unshift(SCIM_SCHEMAS.user);
  }
  const created = safe.meta?.created || nowIso();
  const updated = nowIso();
  const out = {
    schemas,
    id: finalId,
    externalId: safe.externalId || null,
    userName: safe.userName || "",
    name: safe.name || undefined,
    displayName: safe.displayName || undefined,
    nickName: safe.nickName || undefined,
    profileUrl: safe.profileUrl || undefined,
    title: safe.title || undefined,
    userType: safe.userType || undefined,
    preferredLanguage: safe.preferredLanguage || undefined,
    locale: safe.locale || undefined,
    timezone: safe.timezone || undefined,
    active: safe.active !== false,
    emails: Array.isArray(safe.emails) ? safe.emails : [],
    phoneNumbers: Array.isArray(safe.phoneNumbers) ? safe.phoneNumbers : undefined,
    addresses: Array.isArray(safe.addresses) ? safe.addresses : undefined,
    groups: Array.isArray(safe.groups) ? safe.groups : [],
    roles: Array.isArray(safe.roles) ? safe.roles : undefined,
    meta: buildMeta(RESOURCE_TYPES.User, finalId, created, updated),
  };
  // Enterprise extension passthrough
  if (safe[SCIM_SCHEMAS.enterpriseUser]) {
    out[SCIM_SCHEMAS.enterpriseUser] = safe[SCIM_SCHEMAS.enterpriseUser];
    if (!out.schemas.includes(SCIM_SCHEMAS.enterpriseUser)) {
      out.schemas.push(SCIM_SCHEMAS.enterpriseUser);
    }
  }
  // Strip undefined keys for cleaner SCIM output.
  for (const k of Object.keys(out)) {
    if (out[k] === undefined) delete out[k];
  }
  return out;
}

function normalizeGroup(groupData, id) {
  const safe = groupData && typeof groupData === "object" ? groupData : {};
  const finalId = id || safe.id || randomUUID();
  const schemas = Array.isArray(safe.schemas) && safe.schemas.length
    ? safe.schemas
    : [SCIM_SCHEMAS.group];
  if (!schemas.includes(SCIM_SCHEMAS.group)) {
    schemas.unshift(SCIM_SCHEMAS.group);
  }
  const created = safe.meta?.created || nowIso();
  const updated = nowIso();
  const out = {
    schemas,
    id: finalId,
    externalId: safe.externalId || null,
    displayName: safe.displayName || "",
    members: Array.isArray(safe.members) ? safe.members : [],
    meta: buildMeta(RESOURCE_TYPES.Group, finalId, created, updated),
  };
  for (const k of Object.keys(out)) {
    if (out[k] === undefined) delete out[k];
  }
  return out;
}

// ─── SCIM User operations ───────────────────────────────────────────────────

/**
 * Create a SCIM user from an IdP payload.
 * @param {object} userData
 * @returns {Promise<object>} SCIM-formatted user with id and meta
 */
export async function createSCIMUser(userData) {
  if (!userData || typeof userData !== "object") {
    throw new Error("userData must be an object");
  }
  if (!userData.userName || typeof userData.userName !== "string") {
    throw new Error("userName is required");
  }
  return withPathLock(usersPath(), async () => {
    const users = await loadUsers();
    // Enforce uniqueness on userName.
    const existingByUserName = Object.values(users).find(
      (u) => u.userName === userData.userName,
    );
    if (existingByUserName) {
      const err = new Error(`User with userName '${userData.userName}' already exists`);
      err.status = 409;
      err.scimType = "uniqueness";
      throw err;
    }
    const user = normalizeUser(userData);
    users[user.id] = user;
    await saveUsers(users);
    return user;
  });
}

export async function getSCIMUser(id) {
  if (!id) return null;
  const users = await loadUsers();
  return users[id] || null;
}

/**
 * Replace a SCIM user (PUT semantics).
 * @param {string} id
 * @param {object} updates - Full user resource (PUT replaces)
 * @returns {Promise<object>}
 */
export async function updateSCIMUser(id, updates) {
  if (!id) throw new Error("id is required");
  return withPathLock(usersPath(), async () => {
    const users = await loadUsers();
    const existing = users[id];
    if (!existing) {
      const err = new Error(`User ${id} not found`);
      err.status = 404;
      throw err;
    }
    // PUT replaces the user but preserves id and created timestamp.
    const merged = {
      ...updates,
      id,
      meta: {
        ...(existing.meta || {}),
        created: existing.meta?.created,
      },
    };
    const user = normalizeUser(merged, id);
    users[id] = user;
    await saveUsers(users);
    return user;
  });
}

/**
 * Apply RFC 7644 PATCH operations to a SCIM user.
 * Operations: { op: "add"|"remove"|"replace", path?: string, value?: any }
 * @param {string} id
 * @param {Array<{op: string, path?: string, value?: any}>} operations
 * @returns {Promise<object>}
 */
export async function patchSCIMUser(id, operations) {
  if (!id) throw new Error("id is required");
  if (!Array.isArray(operations)) {
    throw new Error("operations must be an array");
  }
  return withPathLock(usersPath(), async () => {
    const users = await loadUsers();
    const existing = users[id];
    if (!existing) {
      const err = new Error(`User ${id} not found`);
      err.status = 404;
      throw err;
    }
    // Deep clone so we mutate a copy.
    const draft = JSON.parse(JSON.stringify(existing));
    for (const op of operations) {
      applyPatchOperation(draft, op);
    }
    const user = normalizeUser(draft, id);
    // preserve created
    user.meta.created = existing.meta?.created || user.meta.created;
    users[id] = user;
    await saveUsers(users);
    return user;
  });
}

/**
 * Apply a single PATCH operation in-place on a resource. Implements the
 * common subset of RFC 7644 §3.5.2 needed for IdP provisioning: add, remove,
 * replace, both with and without a path. Path supports simple dotted
 * attributes plus filter expressions like emails[type eq "work"].value.
 * @param {object} resource
 * @param {{op: string, path?: string, value?: any}} op
 */
function applyPatchOperation(resource, op) {
  if (!op || typeof op !== "object") return;
  const operation = String(op.op || "").toLowerCase();
  const path = op.path ? String(op.path) : null;
  const value = op.value;

  if (!path) {
    // No path: value must be an object whose keys are top-level attributes.
    if (operation === "add" || operation === "replace") {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        for (const [k, v] of Object.entries(value)) {
          resource[k] = v;
        }
      }
    } else if (operation === "remove") {
      // remove without a path is invalid per spec; ignore.
    }
    return;
  }

  // Parse path: e.g. "emails[type eq \"work\"].value", "name.givenName", "active".
  const filterMatch = path.match(/^([a-zA-Z0-9_]+)(?:\[(.+?)\])?(?:\.(.+))?$/);
  if (!filterMatch) {
    // Fallback: treat entire path as a top-level attribute.
    if (operation === "add" || operation === "replace") {
      resource[path] = value;
    } else if (operation === "remove") {
      delete resource[path];
    }
    return;
  }
  const [, attr, filterExpr, subAttr] = filterMatch;

  if (!filterExpr) {
    // Simple path without filter: attr or attr.subAttr (subAttr may itself be dotted).
    if (subAttr) {
      const parts = subAttr.split(".");
      if (operation === "add" || operation === "replace") {
        if (!resource[attr] || typeof resource[attr] !== "object") {
          resource[attr] = {};
        }
        let cur = resource[attr];
        for (let i = 0; i < parts.length - 1; i++) {
          if (!cur[parts[i]] || typeof cur[parts[i]] !== "object") {
            cur[parts[i]] = {};
          }
          cur = cur[parts[i]];
        }
        cur[parts[parts.length - 1]] = value;
      } else if (operation === "remove") {
        if (resource[attr] && typeof resource[attr] === "object") {
          let cur = resource[attr];
          for (let i = 0; i < parts.length - 1; i++) {
            if (!cur[parts[i]]) return;
            cur = cur[parts[i]];
          }
          delete cur[parts[parts.length - 1]];
        }
      }
      return;
    }
    // attr only.
    if (operation === "add") {
      if (Array.isArray(resource[attr]) && Array.isArray(value)) {
        resource[attr] = resource[attr].concat(value);
      } else if (Array.isArray(resource[attr]) && value !== undefined) {
        resource[attr].push(value);
      } else {
        resource[attr] = value;
      }
    } else if (operation === "replace") {
      resource[attr] = value;
    } else if (operation === "remove") {
      delete resource[attr];
    }
    return;
  }

  // Filtered path: attr[filterExpr](.subAttr)?
  const filter = parseSCIMFilter(filterExpr);
  if (!Array.isArray(resource[attr])) {
    if (operation === "add") resource[attr] = [];
    else return;
  }
  const matches = (item) => filterMatches(item, filter);
  if (operation === "remove") {
    resource[attr] = resource[attr].filter((item) => !matches(item));
    return;
  }
  // add / replace on filtered items
  let touched = false;
  for (const item of resource[attr]) {
    if (matches(item)) {
      touched = true;
      if (subAttr) {
        item[subAttr] = value;
      } else if (value && typeof value === "object" && !Array.isArray(value)) {
        Object.assign(item, value);
      }
    }
  }
  if (!touched && operation === "add") {
    // For add, if no item matched, append a new one built from filter equality.
    const newItem = {};
    if (filter.op === "eq") newItem[filter.field] = filter.value;
    if (subAttr) newItem[subAttr] = value;
    else if (value && typeof value === "object" && !Array.isArray(value)) {
      Object.assign(newItem, value);
    }
    resource[attr].push(newItem);
  }
}

function filterMatches(item, filter) {
  if (!item || typeof item !== "object" || !filter) return false;
  const v = item[filter.field];
  switch (filter.op) {
    case "eq": return String(v) === String(filter.value);
    case "ne": return String(v) !== String(filter.value);
    case "co": return v != null && String(v).includes(String(filter.value));
    case "sw": return v != null && String(v).startsWith(String(filter.value));
    case "ew": return v != null && String(v).endsWith(String(filter.value));
    case "pr": return v != null && v !== "";
    case "gt": return v != null && v > filter.value;
    case "ge": return v != null && v >= filter.value;
    case "lt": return v != null && v < filter.value;
    case "le": return v != null && v <= filter.value;
    default: return false;
  }
}

export async function deleteSCIMUser(id) {
  if (!id) return false;
  return withPathLock(usersPath(), async () => {
    const users = await loadUsers();
    if (!users[id]) return false;
    delete users[id];
    await saveUsers(users);
    return true;
  });
}

/**
 * List SCIM users with optional filter and pagination.
 * @param {string|null} filter - SCIM filter expression
 * @param {number} startIndex - 1-based start index (RFC 7644 §3.4.2.4)
 * @param {number} count - max items per page
 * @returns {Promise<{Resources: object[], totalResults: number, startIndex: number, itemsPerPage: number, schemas: string[]}>}
 */
export async function listSCIMUsers(filter, startIndex, count) {
  const users = await loadUsers();
  let list = Object.values(users);
  const parsed = filter ? parseSCIMFilter(filter) : null;
  if (parsed) {
    list = list.filter((u) => filterMatches(u, parsed));
  }
  const total = list.length;
  const start = Math.max(1, parseInt(startIndex, 10) || 1);
  const per = Math.max(0, parseInt(count, 10) || 100);
  const slice = list.slice(start - 1, start - 1 + per);
  return {
    schemas: [SCIM_SCHEMAS.listResponse],
    totalResults: total,
    startIndex: start,
    itemsPerPage: slice.length,
    Resources: slice,
  };
}

// ─── SCIM Group operations ──────────────────────────────────────────────────

export async function createSCIMGroup(groupData) {
  if (!groupData || typeof groupData !== "object") {
    throw new Error("groupData must be an object");
  }
  if (!groupData.displayName || typeof groupData.displayName !== "string") {
    throw new Error("displayName is required");
  }
  return withPathLock(groupsPath(), async () => {
    const groups = await loadGroups();
    const existing = Object.values(groups).find(
      (g) => g.displayName === groupData.displayName,
    );
    if (existing) {
      const err = new Error(`Group with displayName '${groupData.displayName}' already exists`);
      err.status = 409;
      err.scimType = "uniqueness";
      throw err;
    }
    const group = normalizeGroup(groupData);
    groups[group.id] = group;
    await saveGroups(groups);
    return group;
  });
}

export async function getSCIMGroup(id) {
  if (!id) return null;
  const groups = await loadGroups();
  return groups[id] || null;
}

export async function updateSCIMGroup(id, updates) {
  if (!id) throw new Error("id is required");
  return withPathLock(groupsPath(), async () => {
    const groups = await loadGroups();
    const existing = groups[id];
    if (!existing) {
      const err = new Error(`Group ${id} not found`);
      err.status = 404;
      throw err;
    }
    const merged = {
      ...updates,
      id,
      meta: { ...(existing.meta || {}), created: existing.meta?.created },
    };
    const group = normalizeGroup(merged, id);
    groups[id] = group;
    await saveGroups(groups);
    return group;
  });
}

/**
 * Apply RFC 7644 PATCH operations to a SCIM group.
 */
export async function patchSCIMGroup(id, operations) {
  if (!id) throw new Error("id is required");
  if (!Array.isArray(operations)) {
    throw new Error("operations must be an array");
  }
  return withPathLock(groupsPath(), async () => {
    const groups = await loadGroups();
    const existing = groups[id];
    if (!existing) {
      const err = new Error(`Group ${id} not found`);
      err.status = 404;
      throw err;
    }
    const draft = JSON.parse(JSON.stringify(existing));
    for (const op of operations) {
      applyPatchOperation(draft, op);
    }
    const group = normalizeGroup(draft, id);
    group.meta.created = existing.meta?.created || group.meta.created;
    groups[id] = group;
    await saveGroups(groups);
    return group;
  });
}

export async function deleteSCIMGroup(id) {
  if (!id) return false;
  return withPathLock(groupsPath(), async () => {
    const groups = await loadGroups();
    if (!groups[id]) return false;
    delete groups[id];
    await saveGroups(groups);
    return true;
  });
}

export async function listSCIMGroups(filter, startIndex, count) {
  const groups = await loadGroups();
  let list = Object.values(groups);
  const parsed = filter ? parseSCIMFilter(filter) : null;
  if (parsed) {
    list = list.filter((g) => filterMatches(g, parsed));
  }
  const total = list.length;
  const start = Math.max(1, parseInt(startIndex, 10) || 1);
  const per = Math.max(0, parseInt(count, 10) || 100);
  const slice = list.slice(start - 1, start - 1 + per);
  return {
    schemas: [SCIM_SCHEMAS.listResponse],
    totalResults: total,
    startIndex: start,
    itemsPerPage: slice.length,
    Resources: slice,
  };
}

// ─── Conversion helpers ─────────────────────────────────────────────────────

/**
 * Convert a SiskelBot local user to a SCIM 2.0 user resource.
 * @param {object} localUser - { userId, email, displayName, active?, ... }
 * @returns {object}
 */
export function toSCIMUser(localUser) {
  if (!localUser || typeof localUser !== "object") {
    throw new Error("localUser must be an object");
  }
  const id = localUser.id || localUser.userId || randomUUID();
  const userName = localUser.userName || localUser.email || localUser.userId || id;
  const emails = [];
  if (localUser.email) {
    emails.push({
      value: localUser.email,
      type: "work",
      primary: true,
    });
  }
  const name = (localUser.givenName || localUser.familyName || localUser.fullName)
    ? {
        givenName: localUser.givenName,
        familyName: localUser.familyName,
        formatted: localUser.fullName || [localUser.givenName, localUser.familyName].filter(Boolean).join(" "),
      }
    : undefined;
  const out = {
    schemas: [SCIM_SCHEMAS.user],
    id,
    externalId: localUser.externalId || localUser.userId || null,
    userName,
    name,
    displayName: localUser.displayName || localUser.fullName || userName,
    active: localUser.active !== false,
    emails,
    meta: buildMeta(
      RESOURCE_TYPES.User,
      id,
      localUser.createdAt,
      localUser.updatedAt,
    ),
  };
  if (out.name === undefined) delete out.name;
  return out;
}

/**
 * Convert a SCIM user resource into a SiskelBot local user shape.
 * @param {object} scimUser
 * @returns {object}
 */
export function fromSCIMUser(scimUser) {
  if (!scimUser || typeof scimUser !== "object") {
    throw new Error("scimUser must be an object");
  }
  const primaryEmail =
    Array.isArray(scimUser.emails) && scimUser.emails.length
      ? (scimUser.emails.find((e) => e.primary) || scimUser.emails[0]).value
      : null;
  return {
    id: scimUser.id,
    userId: scimUser.externalId || scimUser.id,
    userName: scimUser.userName,
    email: primaryEmail,
    givenName: scimUser.name?.givenName || null,
    familyName: scimUser.name?.familyName || null,
    fullName: scimUser.name?.formatted || scimUser.displayName || null,
    displayName: scimUser.displayName || scimUser.userName,
    active: scimUser.active !== false,
    createdAt: scimUser.meta?.created || null,
    updatedAt: scimUser.meta?.lastModified || null,
  };
}

// ─── SCIM Filter parser ─────────────────────────────────────────────────────

/**
 * Parse a SCIM filter expression. Implements the most commonly used subset
 * needed for provisioning: simple `attr op value` filters with quoted string
 * literals or numeric/boolean literals. Operators: eq, ne, co, sw, ew, pr,
 * gt, ge, lt, le.
 *
 * Examples:
 *   userName eq "alice"          → { field: "userName", op: "eq", value: "alice" }
 *   active eq true               → { field: "active", op: "eq", value: true }
 *   userName co "ali"            → { field: "userName", op: "co", value: "ali" }
 *   userName pr                  → { field: "userName", op: "pr", value: null }
 *
 * @param {string} filterString
 * @returns {{field: string, op: string, value: any}|null}
 */
export function parseSCIMFilter(filterString) {
  if (!filterString || typeof filterString !== "string") return null;
  const s = filterString.trim();
  if (!s) return null;
  // Present operator: "field pr"
  const prMatch = s.match(/^([a-zA-Z][a-zA-Z0-9._:-]*)\s+pr$/i);
  if (prMatch) {
    return { field: prMatch[1], op: "pr", value: null };
  }
  // Standard binary operator: field op value
  const m = s.match(
    /^([a-zA-Z][a-zA-Z0-9._:-]*)\s+(eq|ne|co|sw|ew|gt|ge|lt|le)\s+(.+)$/i,
  );
  if (!m) return null;
  const field = m[1];
  const op = m[2].toLowerCase();
  let raw = m[3].trim();
  let value;
  if (raw.startsWith('"') && raw.endsWith('"')) {
    value = raw.slice(1, -1);
  } else if (raw === "true") {
    value = true;
  } else if (raw === "false") {
    value = false;
  } else if (raw === "null") {
    value = null;
  } else if (/^-?\d+(\.\d+)?$/.test(raw)) {
    value = Number(raw);
  } else {
    value = raw;
  }
  return { field, op, value };
}

// ─── Test helpers ───────────────────────────────────────────────────────────

/**
 * Reset all SCIM stores. Test helper.
 */
export async function _resetSCIMForTesting() {
  await writeJsonPath(usersPath(), { users: {} });
  await writeJsonPath(groupsPath(), { groups: {} });
}
