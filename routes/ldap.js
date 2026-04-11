/**
 * Phase 46.1: LDAP / Active Directory routes.
 *
 *   POST /api/v1/auth/ldap/login              - username/password login via LDAP
 *   POST /api/v1/auth/ldap/test               - test the configured LDAP connection (admin)
 *   GET  /api/v1/auth/ldap/groups             - list LDAP groups (admin)
 *   GET  /api/v1/auth/ldap/group-mapping      - get role mapping for a workspace
 *   PUT  /api/v1/auth/ldap/group-mapping      - update role mapping (admin)
 *   POST /api/v1/auth/ldap/sync               - trigger a full user sync (admin)
 */

import {
  authenticateUser,
  bindToLDAP,
  searchUsers,
  syncUser,
  syncGroups,
  isLDAPConfigured,
  resolveLdapOptions,
} from "../lib/ldap-auth.js";
import {
  getGroupMapping,
  setGroupMapping,
  getUserRoleFromGroups,
} from "../lib/ldap-group-mapping.js";

export function mountLdapRoutes(app, deps) {
  const { apiRoute, apiError, adminAuth, storageRateLimiter } = deps;
  const limiter = storageRateLimiter || ((_req, _res, next) => next());
  const admin = adminAuth || ((_req, _res, next) => next());

  // POST /auth/ldap/login — username/password login
  apiRoute("post", "/auth/ldap/login", limiter, async (req, res) => {
    if (!isLDAPConfigured()) {
      return apiError(
        res,
        503,
        "LDAP_NOT_CONFIGURED",
        "LDAP is not configured",
        "Set LDAP_URL and related env vars to enable LDAP authentication."
      );
    }
    const username = req.body?.username;
    const password = req.body?.password;
    const workspaceId = req.body?.workspace || req.body?.workspaceId || null;
    if (!username || !password) {
      return apiError(res, 400, "INVALID_INPUT", "username and password are required");
    }
    try {
      const result = await authenticateUser(username, password);
      if (!result.authenticated) {
        return apiError(res, 401, "AUTH_FAILED", result.error || "invalid credentials");
      }
      // Persist a local user record so future calls can scope storage by userId.
      const synced = await syncUser({ dn: result.userDN, attributes: result.attributes }, workspaceId);
      // Resolve role from group mapping (workspace-specific override or default).
      const mapping = await getGroupMapping(workspaceId);
      const role = await getUserRoleFromGroups(result.groups, mapping);

      if (req.session) {
        req.session.userId = synced.userId;
        req.session.ldapVerified = true;
        if (role) req.session.ldapRole = role;
      }

      res.json({
        ok: true,
        userId: synced.userId,
        email: synced.email,
        displayName: synced.displayName,
        dn: result.userDN,
        groups: result.groups,
        role,
      });
    } catch (err) {
      if (err && err.code === "LDAPJS_NOT_INSTALLED") {
        return apiError(
          res,
          503,
          "LDAPJS_NOT_INSTALLED",
          err.message,
          "Run `npm install ldapjs` and restart the server to enable LDAP."
        );
      }
      return apiError(res, 500, "LDAP_ERROR", err.message);
    }
  });

  // POST /auth/ldap/test — test the LDAP connection (admin)
  apiRoute("post", "/auth/ldap/test", admin, async (_req, res) => {
    if (!isLDAPConfigured()) {
      return apiError(res, 503, "LDAP_NOT_CONFIGURED", "LDAP is not configured");
    }
    try {
      const client = await bindToLDAP();
      try {
        client.unbind?.();
      } catch {
        /* noop */
      }
      const resolved = resolveLdapOptions();
      res.json({
        ok: true,
        url: resolved?.url,
        bindDN: resolved?.bindDN || null,
        baseDN: resolved?.baseDN || null,
      });
    } catch (err) {
      const code = err && err.code === "LDAPJS_NOT_INSTALLED" ? "LDAPJS_NOT_INSTALLED" : "LDAP_TEST_FAILED";
      return apiError(res, code === "LDAPJS_NOT_INSTALLED" ? 503 : 502, code, err.message);
    }
  });

  // GET /auth/ldap/groups — list LDAP groups (admin)
  apiRoute("get", "/auth/ldap/groups", admin, async (req, res) => {
    if (!isLDAPConfigured()) {
      return apiError(res, 503, "LDAP_NOT_CONFIGURED", "LDAP is not configured");
    }
    try {
      const filter = req.query?.filter || "(objectClass=groupOfNames)";
      const entries = await searchUsers(filter, {
        attributes: ["dn", "cn", "objectClass", "member"],
      });
      const groups = entries.map((entry) => ({
        dn: entry.dn,
        name: entry.attributes?.cn || entry.dn,
        members: Array.isArray(entry.attributes?.member)
          ? entry.attributes.member
          : entry.attributes?.member
            ? [entry.attributes.member]
            : [],
      }));
      res.json({ groups, count: groups.length });
    } catch (err) {
      if (err && err.code === "LDAPJS_NOT_INSTALLED") {
        return apiError(res, 503, "LDAPJS_NOT_INSTALLED", err.message);
      }
      return apiError(res, 502, "LDAP_GROUPS_FAILED", err.message);
    }
  });

  // GET /auth/ldap/group-mapping — get role mapping for a workspace
  apiRoute("get", "/auth/ldap/group-mapping", async (req, res) => {
    try {
      const workspaceId = req.query?.workspace || req.query?.workspaceId || null;
      const mapping = await getGroupMapping(workspaceId);
      res.json({ workspaceId: workspaceId || "default", mapping });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // PUT /auth/ldap/group-mapping — update role mapping (admin)
  apiRoute("put", "/auth/ldap/group-mapping", admin, async (req, res) => {
    try {
      const workspaceId = req.body?.workspace || req.body?.workspaceId || req.query?.workspace || null;
      const mapping = req.body?.mapping;
      if (!mapping || typeof mapping !== "object") {
        return apiError(res, 400, "INVALID_INPUT", "mapping object is required");
      }
      const stored = await setGroupMapping(workspaceId, mapping);
      res.json({ workspaceId: workspaceId || "default", mapping: stored });
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  // POST /auth/ldap/sync — trigger full user sync (admin)
  apiRoute("post", "/auth/ldap/sync", admin, async (req, res) => {
    if (!isLDAPConfigured()) {
      return apiError(res, 503, "LDAP_NOT_CONFIGURED", "LDAP is not configured");
    }
    try {
      const filter = req.body?.filter || "(objectClass=person)";
      const workspaceId = req.body?.workspace || req.body?.workspaceId || null;
      const entries = await searchUsers(filter, {});
      const synced = [];
      for (const entry of entries) {
        try {
          const result = await syncUser(entry, workspaceId);
          synced.push(result);
        } catch (err) {
          synced.push({ error: err.message, dn: entry.dn });
        }
      }
      // Also snapshot groups (best-effort).
      try {
        const groupEntries = await searchUsers("(objectClass=groupOfNames)", {
          attributes: ["dn", "cn"],
        });
        const groups = groupEntries.map((g) => ({
          dn: g.dn,
          name: g.attributes?.cn || g.dn,
        }));
        await syncGroups(groups, workspaceId || "default");
      } catch (err) {
        console.warn("[ldap] group sync failed: %s", err.message);
      }
      res.json({ ok: true, count: synced.length, users: synced });
    } catch (err) {
      if (err && err.code === "LDAPJS_NOT_INSTALLED") {
        return apiError(res, 503, "LDAPJS_NOT_INSTALLED", err.message);
      }
      return apiError(res, 502, "LDAP_SYNC_FAILED", err.message);
    }
  });
}

export default mountLdapRoutes;
