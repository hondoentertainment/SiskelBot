/**
 * Phase 46.1: LDAP / Active Directory authentication.
 *
 * Provides bind, search, and authentication helpers backed by `ldapjs`, which
 * is loaded dynamically so the dependency is optional. Modules that import
 * this file should still work (and report the missing module clearly) when
 * the host has not installed ldapjs.
 *
 * Env vars (consumed when an explicit options object is not provided):
 *   LDAP_URL              - ldap://host:389 or ldaps://host:636
 *   LDAP_BIND_DN          - service account DN used for the initial bind
 *   LDAP_BIND_PASSWORD    - service account password
 *   LDAP_BASE_DN          - base DN for user/group searches
 *   LDAP_USER_FILTER      - default search filter for users (default: (uid={username}))
 *   LDAP_GROUP_FILTER     - default search filter for groups (default: (member={dn}))
 *   LDAP_TLS_REJECT_UNAUTHORIZED - "0" to skip certificate validation (NOT recommended)
 */

import { join } from "node:path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const DEFAULT_USER_FILTER = "(uid={username})";
const DEFAULT_GROUP_FILTER = "(member={dn})";

let _ldapjsModule = null;
let _ldapjsLoadError = null;

/**
 * Dynamically import ldapjs (optional dependency).
 * @returns {Promise<any>}
 */
async function loadLdapjs() {
  if (_ldapjsModule) return _ldapjsModule;
  if (_ldapjsLoadError) throw _ldapjsLoadError;
  try {
    _ldapjsModule = await import("ldapjs");
    return _ldapjsModule;
  } catch (err) {
    _ldapjsLoadError = new Error(
      "ldapjs module is not installed. Run `npm install ldapjs` to enable LDAP authentication. " +
        `Underlying error: ${err && err.message ? err.message : String(err)}`
    );
    _ldapjsLoadError.code = "LDAPJS_NOT_INSTALLED";
    throw _ldapjsLoadError;
  }
}

/**
 * Reset the cached ldapjs module/error (used by tests).
 */
export function _resetLdapjsCache() {
  _ldapjsModule = null;
  _ldapjsLoadError = null;
}

/**
 * Allow tests to inject a fake ldapjs module without going through `import`.
 * @param {any} fake
 */
export function _setLdapjsModule(fake) {
  _ldapjsModule = fake;
  _ldapjsLoadError = null;
}

/**
 * Resolve LDAP options from explicit overrides + environment.
 * @param {object} [overrides]
 * @returns {{
 *   url: string,
 *   bindDN: string,
 *   bindPassword: string,
 *   baseDN: string,
 *   userFilter: string,
 *   groupFilter: string,
 *   tlsOptions: object,
 * } | null}
 */
export function resolveLdapOptions(overrides = {}) {
  const url = overrides.url || process.env.LDAP_URL;
  if (!url) return null;
  const bindDN = overrides.bindDN || process.env.LDAP_BIND_DN || "";
  const bindPassword =
    overrides.bindPassword || process.env.LDAP_BIND_PASSWORD || "";
  const baseDN = overrides.baseDN || process.env.LDAP_BASE_DN || "";
  const userFilter =
    overrides.userFilter || process.env.LDAP_USER_FILTER || DEFAULT_USER_FILTER;
  const groupFilter =
    overrides.groupFilter || process.env.LDAP_GROUP_FILTER || DEFAULT_GROUP_FILTER;
  const tlsOptions = overrides.tlsOptions || {
    rejectUnauthorized: process.env.LDAP_TLS_REJECT_UNAUTHORIZED !== "0",
  };
  return { url, bindDN, bindPassword, baseDN, userFilter, groupFilter, tlsOptions };
}

/**
 * Check if LDAP is configured via env vars.
 * @returns {boolean}
 */
export function isLDAPConfigured() {
  return Boolean(process.env.LDAP_URL);
}

/**
 * Promise-wrap an ldapjs client method that uses node-style callbacks.
 * @template T
 * @param {(cb: (err: Error|null, result?: T) => void) => void} fn
 * @returns {Promise<T>}
 */
function callbackPromise(fn) {
  return new Promise((resolve, reject) => {
    try {
      fn((err, result) => {
        if (err) reject(err);
        else resolve(/** @type {T} */ (result));
      });
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Bind to an LDAP/AD server and return a connected client.
 *
 * @param {{ url?: string, bindDN?: string, bindPassword?: string, tlsOptions?: object }} [options]
 * @returns {Promise<any>} ldapjs client (connected and bound)
 */
export async function bindToLDAP(options = {}) {
  const resolved = resolveLdapOptions(options);
  if (!resolved) {
    const err = new Error("LDAP not configured: missing LDAP_URL");
    err.code = "LDAP_NOT_CONFIGURED";
    throw err;
  }

  const ldap = await loadLdapjs();
  const createClient =
    (ldap && ldap.createClient) || (ldap && ldap.default && ldap.default.createClient);
  if (typeof createClient !== "function") {
    throw new Error("ldapjs module loaded but createClient is missing");
  }

  const client = createClient({
    url: resolved.url,
    tlsOptions: resolved.tlsOptions,
    reconnect: false,
    timeout: Number(process.env.LDAP_TIMEOUT_MS) || 10000,
    connectTimeout: Number(process.env.LDAP_CONNECT_TIMEOUT_MS) || 10000,
  });

  // Surface connection-level errors to anyone awaiting the bind.
  let connectionError = null;
  if (typeof client.on === "function") {
    client.on("error", (err) => {
      connectionError = err;
    });
  }

  if (resolved.bindDN) {
    try {
      await callbackPromise((cb) =>
        client.bind(resolved.bindDN, resolved.bindPassword, cb)
      );
    } catch (err) {
      try {
        client.unbind?.();
      } catch {
        /* noop */
      }
      throw err;
    }
  }

  if (connectionError) {
    try {
      client.unbind?.();
    } catch {
      /* noop */
    }
    throw connectionError;
  }

  return client;
}

/**
 * Substitute {placeholder} tokens in an LDAP filter, escaping per RFC 4515.
 * @param {string} template
 * @param {Record<string,string>} values
 * @returns {string}
 */
export function renderFilter(template, values) {
  return String(template).replace(/\{(\w+)\}/g, (_match, key) => {
    const value = values[key];
    if (value === undefined || value === null) return "";
    return escapeFilterValue(String(value));
  });
}

/**
 * Escape a value for safe inclusion in an LDAP filter (RFC 4515).
 * @param {string} value
 * @returns {string}
 */
export function escapeFilterValue(value) {
  return String(value).replace(/[\\*()\u0000]/g, (ch) => {
    switch (ch) {
      case "\\":
        return "\\5c";
      case "*":
        return "\\2a";
      case "(":
        return "\\28";
      case ")":
        return "\\29";
      case "\u0000":
        return "\\00";
      default:
        return ch;
    }
  });
}

/**
 * Run a search against an LDAP client. Returns all matching entries.
 *
 * @param {any} client
 * @param {string} baseDN
 * @param {object} searchOptions - ldapjs search options
 * @returns {Promise<Array<object>>}
 */
function runSearch(client, baseDN, searchOptions) {
  return new Promise((resolve, reject) => {
    if (!client || typeof client.search !== "function") {
      reject(new Error("LDAP client missing search() method"));
      return;
    }
    client.search(baseDN, searchOptions, (err, search) => {
      if (err) return reject(err);
      const entries = [];
      search.on("searchEntry", (entry) => {
        // ldapjs entries expose .object (attributes) and .objectName (DN)
        const attributes = entry.object || {};
        const dn = entry.objectName || attributes.dn || attributes.distinguishedName || null;
        entries.push({ dn, attributes });
      });
      search.on("error", reject);
      search.on("end", (result) => {
        if (result && typeof result.status === "number" && result.status !== 0) {
          // Some servers return non-zero status with an empty result set; treat as empty.
          resolve(entries);
          return;
        }
        resolve(entries);
      });
    });
  });
}

/**
 * Search for users matching a filter under the configured base DN.
 *
 * @param {string} filter - LDAP filter (already rendered) or template with placeholders
 * @param {object} [options] - resolved or override options + optional `client` to reuse
 * @param {Record<string,string>} [filterValues] - placeholder values when `filter` is a template
 * @returns {Promise<Array<object>>}
 */
export async function searchUsers(filter, options = {}, filterValues = null) {
  const resolved = resolveLdapOptions(options);
  if (!resolved) throw new Error("LDAP not configured");
  const baseDN = options.baseDN || resolved.baseDN;
  if (!baseDN) throw new Error("LDAP search requires baseDN");

  const client = options.client || (await bindToLDAP(resolved));
  const ownClient = !options.client;

  try {
    const renderedFilter = filterValues ? renderFilter(filter, filterValues) : filter;
    const entries = await runSearch(client, baseDN, {
      filter: renderedFilter,
      scope: options.scope || "sub",
      attributes: options.attributes || [
        "dn",
        "uid",
        "cn",
        "sn",
        "givenName",
        "mail",
        "displayName",
        "sAMAccountName",
        "userPrincipalName",
        "memberOf",
        "objectClass",
      ],
      sizeLimit: options.sizeLimit || 1000,
    });
    return entries;
  } finally {
    if (ownClient) {
      try {
        client.unbind?.();
      } catch {
        /* noop */
      }
    }
  }
}

/**
 * Search for all groups a user belongs to (including groups via memberOf).
 *
 * @param {string} userDN
 * @param {object} [options]
 * @returns {Promise<Array<{ dn: string, name: string }>>}
 */
export async function searchGroups(userDN, options = {}) {
  const resolved = resolveLdapOptions(options);
  if (!resolved) throw new Error("LDAP not configured");
  const baseDN = options.baseDN || resolved.baseDN;
  const groupFilter = options.groupFilter || resolved.groupFilter;

  const client = options.client || (await bindToLDAP(resolved));
  const ownClient = !options.client;

  try {
    const filter = renderFilter(groupFilter, { dn: userDN });
    const entries = await runSearch(client, baseDN, {
      filter,
      scope: options.scope || "sub",
      attributes: ["dn", "cn", "objectClass", "member"],
      sizeLimit: options.sizeLimit || 1000,
    });
    const groups = entries.map((entry) => ({
      dn: entry.dn || entry.attributes?.dn || "",
      name:
        entry.attributes?.cn ||
        entry.attributes?.name ||
        entry.dn ||
        "",
    }));

    // Also pick up groups listed in memberOf on the user entry, if provided.
    if (options.memberOf && Array.isArray(options.memberOf)) {
      for (const dn of options.memberOf) {
        if (!groups.some((g) => g.dn === dn)) {
          const cnMatch = /^cn=([^,]+)/i.exec(dn);
          groups.push({ dn, name: cnMatch ? cnMatch[1] : dn });
        }
      }
    }

    return groups;
  } finally {
    if (ownClient) {
      try {
        client.unbind?.();
      } catch {
        /* noop */
      }
    }
  }
}

/**
 * Authenticate a user against LDAP.
 *
 * Sequence:
 *   1. Bind as the configured service account.
 *   2. Search for the user by username under the configured base DN.
 *   3. Bind to a fresh connection as the user using their password.
 *   4. Collect attributes + group memberships.
 *
 * @param {string} username
 * @param {string} password
 * @param {object} [options]
 * @returns {Promise<{
 *   authenticated: boolean,
 *   userDN: string|null,
 *   attributes: object,
 *   groups: Array<{ dn: string, name: string }>,
 *   error?: string,
 * }>}
 */
export async function authenticateUser(username, password, options = {}) {
  if (!username || !password) {
    return {
      authenticated: false,
      userDN: null,
      attributes: {},
      groups: [],
      error: "username and password are required",
    };
  }

  const resolved = resolveLdapOptions(options);
  if (!resolved) {
    return {
      authenticated: false,
      userDN: null,
      attributes: {},
      groups: [],
      error: "LDAP not configured",
    };
  }

  let serviceClient;
  try {
    serviceClient = await bindToLDAP(resolved);
  } catch (err) {
    return {
      authenticated: false,
      userDN: null,
      attributes: {},
      groups: [],
      error: `service bind failed: ${err.message}`,
    };
  }

  let entries;
  try {
    entries = await searchUsers(resolved.userFilter, { ...resolved, client: serviceClient }, { username });
  } catch (err) {
    try {
      serviceClient.unbind?.();
    } catch {
      /* noop */
    }
    return {
      authenticated: false,
      userDN: null,
      attributes: {},
      groups: [],
      error: `user search failed: ${err.message}`,
    };
  }

  if (!entries || entries.length === 0) {
    try {
      serviceClient.unbind?.();
    } catch {
      /* noop */
    }
    return {
      authenticated: false,
      userDN: null,
      attributes: {},
      groups: [],
      error: "user not found",
    };
  }

  const userEntry = entries[0];
  const userDN = userEntry.dn || userEntry.attributes?.dn;
  if (!userDN) {
    try {
      serviceClient.unbind?.();
    } catch {
      /* noop */
    }
    return {
      authenticated: false,
      userDN: null,
      attributes: userEntry.attributes || {},
      groups: [],
      error: "user entry has no DN",
    };
  }

  // Bind as the user with their supplied password to validate credentials.
  let userClient;
  try {
    userClient = await bindToLDAP({ ...resolved, bindDN: userDN, bindPassword: password });
  } catch (err) {
    try {
      serviceClient.unbind?.();
    } catch {
      /* noop */
    }
    return {
      authenticated: false,
      userDN,
      attributes: userEntry.attributes || {},
      groups: [],
      error: `bind as user failed: ${err.message}`,
    };
  }

  let groups = [];
  try {
    const memberOf = normalizeArray(userEntry.attributes?.memberOf);
    groups = await searchGroups(userDN, {
      ...resolved,
      client: serviceClient,
      memberOf,
    });
  } catch (err) {
    // Group lookup failures are not fatal — record the error but still return success.
    console.warn("[ldap-auth] group lookup failed: %s", err.message);
  }

  try {
    userClient.unbind?.();
  } catch {
    /* noop */
  }
  try {
    serviceClient.unbind?.();
  } catch {
    /* noop */
  }

  return {
    authenticated: true,
    userDN,
    attributes: userEntry.attributes || {},
    groups,
  };
}

function normalizeArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function ldapUsersPath() {
  return join(getDataDir(), "ldap-users.json");
}

/**
 * Persist or update a local user record from LDAP attributes.
 *
 * Maps the common username attributes (uid, sAMAccountName, userPrincipalName)
 * to a SiskelBot userId. Email comes from `mail` and display name from
 * `displayName` or `cn`.
 *
 * @param {{ dn?: string, attributes?: object }} ldapUser
 * @param {string} [workspaceId]
 * @returns {Promise<{ userId: string, email: string|null, displayName: string|null, dn: string|null }>}
 */
export async function syncUser(ldapUser, workspaceId) {
  if (!ldapUser) throw new Error("ldapUser is required");
  const attrs = ldapUser.attributes || ldapUser || {};
  const dn = ldapUser.dn || attrs.dn || null;
  const usernameRaw =
    attrs.uid ||
    attrs.sAMAccountName ||
    attrs.userPrincipalName ||
    attrs.cn ||
    (dn && /^(?:uid|cn)=([^,]+)/i.exec(dn)?.[1]) ||
    null;
  if (!usernameRaw) throw new Error("LDAP entry missing username attributes");
  const userId = `ldap-${String(usernameRaw)
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "")}`.slice(0, 100);
  const email = attrs.mail || attrs.email || null;
  const displayName = attrs.displayName || attrs.cn || usernameRaw;

  const path = ldapUsersPath();
  return withPathLock(path, async () => {
    const data = await readJsonPath(path, { _version: 1, users: [] });
    const users = Array.isArray(data.users) ? [...data.users] : [];
    const existing = users.findIndex((u) => u.userId === userId);
    const record = {
      userId,
      dn,
      email,
      displayName,
      workspaceId: workspaceId || null,
      lastSyncedAt: new Date().toISOString(),
    };
    if (existing >= 0) {
      users[existing] = { ...users[existing], ...record };
    } else {
      users.push({ ...record, createdAt: record.lastSyncedAt });
    }
    await writeJsonPath(path, { _version: 1, users });
    return { userId, email, displayName, dn };
  });
}

/**
 * Persist a snapshot of LDAP groups for a workspace. The actual role mapping
 * lives in `lib/ldap-group-mapping.js`.
 *
 * @param {Array<{ dn: string, name: string }>} ldapGroups
 * @param {string} workspaceId
 */
export async function syncGroups(ldapGroups, workspaceId) {
  if (!Array.isArray(ldapGroups)) throw new Error("ldapGroups must be an array");
  const path = join(getDataDir(), "ldap-groups.json");
  return withPathLock(path, async () => {
    const data = await readJsonPath(path, { _version: 1, workspaces: {} });
    const workspaces = data.workspaces && typeof data.workspaces === "object" ? { ...data.workspaces } : {};
    workspaces[workspaceId || "default"] = {
      groups: ldapGroups.map((g) => ({ dn: g.dn, name: g.name })),
      lastSyncedAt: new Date().toISOString(),
    };
    await writeJsonPath(path, { _version: 1, workspaces });
    return workspaces[workspaceId || "default"];
  });
}

/**
 * List all LDAP-synced users (used by admin endpoints and tests).
 * @returns {Promise<Array<object>>}
 */
export async function listSyncedUsers() {
  const path = ldapUsersPath();
  const data = await readJsonPath(path, { _version: 1, users: [] });
  return Array.isArray(data.users) ? data.users : [];
}
