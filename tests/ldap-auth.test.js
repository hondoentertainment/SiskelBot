/**
 * Phase 46.1: LDAP authentication and group mapping tests.
 *
 * The ldapjs module is loaded dynamically by lib/ldap-auth.js, so these
 * tests inject a fake module via _setLdapjsModule() to exercise the bind,
 * search, and authentication code paths without a real directory.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Isolate storage before importing modules that read STORAGE_PATH.
const tempDir = mkdtempSync(join(tmpdir(), "ldap-test-"));
const origEnv = { ...process.env };
process.env.STORAGE_PATH = tempDir;
delete process.env.STORAGE_BACKEND;

test.after(() => {
  rmSync(tempDir, { recursive: true, force: true });
  process.env = origEnv;
});

// ─── Fake ldapjs module ─────────────────────────────────────────────────────

class FakeSearch {
  constructor() {
    this.handlers = {};
  }
  on(event, fn) {
    this.handlers[event] = fn;
    return this;
  }
  emit(event, ...args) {
    if (this.handlers[event]) this.handlers[event](...args);
  }
}

function makeFakeClient(state) {
  const client = {
    bound: false,
    boundDN: null,
    bind(dn, password, cb) {
      const expected = state.users.find((u) => u.dn === dn);
      if (expected && expected.password === password) {
        client.bound = true;
        client.boundDN = dn;
        return cb(null);
      }
      // Special: service bind with empty password during test setup.
      if (state.serviceDN && dn === state.serviceDN && password === state.servicePassword) {
        client.bound = true;
        client.boundDN = dn;
        return cb(null);
      }
      const err = new Error("InvalidCredentialsError");
      err.code = 49;
      return cb(err);
    },
    search(_baseDN, options, cb) {
      const search = new FakeSearch();
      // Defer entries to the next tick so the caller has a chance to attach handlers.
      setImmediate(() => {
        const filter = options.filter || "";
        const matches = state.users.filter((user) => userMatchesFilter(user, filter));
        const groupMatches = state.groups.filter((group) => groupMatchesFilter(group, filter));
        for (const user of matches) {
          search.emit("searchEntry", {
            objectName: user.dn,
            object: user.attributes,
          });
        }
        for (const group of groupMatches) {
          search.emit("searchEntry", {
            objectName: group.dn,
            object: group.attributes,
          });
        }
        search.emit("end", { status: 0 });
      });
      cb(null, search);
    },
    unbind(cb) {
      client.bound = false;
      if (cb) cb(null);
    },
    on() { return client; },
  };
  return client;
}

function userMatchesFilter(user, filter) {
  // Support filters like (uid=alice), (sAMAccountName=alice), (objectClass=person)
  const m = /^\(([^=()]+)=([^)]+)\)$/.exec(filter);
  if (!m) return false;
  const [, attr, value] = m;
  if (attr === "objectClass") {
    return Array.isArray(user.attributes.objectClass)
      ? user.attributes.objectClass.includes(value)
      : user.attributes.objectClass === value;
  }
  return user.attributes[attr] === value;
}

function groupMatchesFilter(group, filter) {
  // Support (member=<dn>) and (objectClass=groupOfNames)
  const memberMatch = /^\(member=(.+)\)$/.exec(filter);
  if (memberMatch) {
    const dn = memberMatch[1];
    const members = Array.isArray(group.attributes.member)
      ? group.attributes.member
      : [group.attributes.member];
    return members.includes(dn);
  }
  const oc = /^\(objectClass=(.+)\)$/.exec(filter);
  if (oc) {
    const value = oc[1];
    return Array.isArray(group.attributes.objectClass)
      ? group.attributes.objectClass.includes(value)
      : group.attributes.objectClass === value;
  }
  return false;
}

function buildFakeModule(state) {
  return {
    createClient(_opts) {
      return makeFakeClient(state);
    },
  };
}

// ─── isLDAPConfigured ───────────────────────────────────────────────────────

test("isLDAPConfigured returns false when LDAP_URL is unset", async () => {
  const orig = process.env.LDAP_URL;
  delete process.env.LDAP_URL;
  const { isLDAPConfigured } = await import("../lib/ldap-auth.js");
  assert.equal(isLDAPConfigured(), false);
  if (orig !== undefined) process.env.LDAP_URL = orig;
});

test("isLDAPConfigured returns true when LDAP_URL is set", async () => {
  const orig = process.env.LDAP_URL;
  process.env.LDAP_URL = "ldap://example.com:389";
  const { isLDAPConfigured } = await import("../lib/ldap-auth.js");
  assert.equal(isLDAPConfigured(), true);
  if (orig !== undefined) process.env.LDAP_URL = orig;
  else delete process.env.LDAP_URL;
});

// ─── resolveLdapOptions ─────────────────────────────────────────────────────

test("resolveLdapOptions reads from env and applies defaults", async () => {
  const orig = { ...process.env };
  process.env.LDAP_URL = "ldap://ldap.example.com";
  process.env.LDAP_BIND_DN = "cn=svc,dc=example,dc=com";
  process.env.LDAP_BIND_PASSWORD = "secret";
  process.env.LDAP_BASE_DN = "dc=example,dc=com";
  delete process.env.LDAP_USER_FILTER;
  delete process.env.LDAP_GROUP_FILTER;
  const { resolveLdapOptions } = await import("../lib/ldap-auth.js");
  const opts = resolveLdapOptions();
  assert.equal(opts.url, "ldap://ldap.example.com");
  assert.equal(opts.bindDN, "cn=svc,dc=example,dc=com");
  assert.equal(opts.bindPassword, "secret");
  assert.equal(opts.baseDN, "dc=example,dc=com");
  assert.equal(opts.userFilter, "(uid={username})");
  assert.equal(opts.groupFilter, "(member={dn})");
  process.env = { ...orig };
});

test("resolveLdapOptions returns null when LDAP_URL is missing", async () => {
  const orig = process.env.LDAP_URL;
  delete process.env.LDAP_URL;
  const { resolveLdapOptions } = await import("../lib/ldap-auth.js");
  assert.equal(resolveLdapOptions(), null);
  if (orig !== undefined) process.env.LDAP_URL = orig;
});

// ─── escapeFilterValue ──────────────────────────────────────────────────────

test("escapeFilterValue escapes special LDAP characters", async () => {
  const { escapeFilterValue } = await import("../lib/ldap-auth.js");
  assert.equal(escapeFilterValue("alice"), "alice");
  assert.equal(escapeFilterValue("a*b"), "a\\2ab");
  assert.equal(escapeFilterValue("a(b)"), "a\\28b\\29");
  assert.equal(escapeFilterValue("a\\b"), "a\\5cb");
});

test("renderFilter substitutes placeholders with escaped values", async () => {
  const { renderFilter } = await import("../lib/ldap-auth.js");
  assert.equal(renderFilter("(uid={username})", { username: "alice" }), "(uid=alice)");
  assert.equal(
    renderFilter("(uid={username})", { username: "alice*" }),
    "(uid=alice\\2a)"
  );
});

// ─── authenticateUser via fake module ───────────────────────────────────────

test("authenticateUser succeeds and returns groups for valid credentials", async () => {
  const orig = { ...process.env };
  process.env.LDAP_URL = "ldap://example.com";
  process.env.LDAP_BIND_DN = "cn=svc,dc=example,dc=com";
  process.env.LDAP_BIND_PASSWORD = "svc-pass";
  process.env.LDAP_BASE_DN = "dc=example,dc=com";

  const { authenticateUser, _setLdapjsModule, _resetLdapjsCache } = await import(
    "../lib/ldap-auth.js"
  );

  const state = {
    serviceDN: "cn=svc,dc=example,dc=com",
    servicePassword: "svc-pass",
    users: [
      {
        dn: "uid=alice,ou=people,dc=example,dc=com",
        password: "alice-pass",
        attributes: {
          uid: "alice",
          cn: "Alice Smith",
          displayName: "Alice Smith",
          mail: "alice@example.com",
          memberOf: ["cn=siskelbot-admins,ou=groups,dc=example,dc=com"],
          objectClass: ["person", "inetOrgPerson"],
        },
      },
      {
        dn: "cn=svc,dc=example,dc=com",
        password: "svc-pass",
        attributes: { cn: "svc", objectClass: "person" },
      },
    ],
    groups: [
      {
        dn: "cn=siskelbot-admins,ou=groups,dc=example,dc=com",
        attributes: {
          cn: "siskelbot-admins",
          objectClass: "groupOfNames",
          member: ["uid=alice,ou=people,dc=example,dc=com"],
        },
      },
    ],
  };
  _setLdapjsModule(buildFakeModule(state));

  const result = await authenticateUser("alice", "alice-pass");
  assert.equal(result.authenticated, true);
  assert.equal(result.userDN, "uid=alice,ou=people,dc=example,dc=com");
  assert.equal(result.attributes.mail, "alice@example.com");
  assert.ok(result.groups.length >= 1);
  assert.ok(
    result.groups.some(
      (g) => g.dn === "cn=siskelbot-admins,ou=groups,dc=example,dc=com"
    )
  );

  _resetLdapjsCache();
  process.env = { ...orig };
});

test("authenticateUser returns authenticated:false on bad password", async () => {
  const orig = { ...process.env };
  process.env.LDAP_URL = "ldap://example.com";
  process.env.LDAP_BIND_DN = "cn=svc,dc=example,dc=com";
  process.env.LDAP_BIND_PASSWORD = "svc-pass";
  process.env.LDAP_BASE_DN = "dc=example,dc=com";

  const { authenticateUser, _setLdapjsModule, _resetLdapjsCache } = await import(
    "../lib/ldap-auth.js"
  );
  const state = {
    serviceDN: "cn=svc,dc=example,dc=com",
    servicePassword: "svc-pass",
    users: [
      {
        dn: "uid=bob,ou=people,dc=example,dc=com",
        password: "correct",
        attributes: { uid: "bob", cn: "Bob", objectClass: "person" },
      },
      {
        dn: "cn=svc,dc=example,dc=com",
        password: "svc-pass",
        attributes: { cn: "svc", objectClass: "person" },
      },
    ],
    groups: [],
  };
  _setLdapjsModule(buildFakeModule(state));

  const result = await authenticateUser("bob", "wrong");
  assert.equal(result.authenticated, false);
  assert.match(result.error, /bind as user failed/);

  _resetLdapjsCache();
  process.env = { ...orig };
});

test("authenticateUser returns authenticated:false when user not found", async () => {
  const orig = { ...process.env };
  process.env.LDAP_URL = "ldap://example.com";
  process.env.LDAP_BIND_DN = "cn=svc,dc=example,dc=com";
  process.env.LDAP_BIND_PASSWORD = "svc-pass";
  process.env.LDAP_BASE_DN = "dc=example,dc=com";

  const { authenticateUser, _setLdapjsModule, _resetLdapjsCache } = await import(
    "../lib/ldap-auth.js"
  );
  _setLdapjsModule(
    buildFakeModule({
      serviceDN: "cn=svc,dc=example,dc=com",
      servicePassword: "svc-pass",
      users: [
        {
          dn: "cn=svc,dc=example,dc=com",
          password: "svc-pass",
          attributes: { cn: "svc", objectClass: "person" },
        },
      ],
      groups: [],
    })
  );

  const result = await authenticateUser("ghost", "pwd");
  assert.equal(result.authenticated, false);
  assert.match(result.error, /not found/);

  _resetLdapjsCache();
  process.env = { ...orig };
});

test("authenticateUser fails fast when LDAP not configured", async () => {
  const orig = process.env.LDAP_URL;
  delete process.env.LDAP_URL;
  const { authenticateUser } = await import("../lib/ldap-auth.js");
  const result = await authenticateUser("a", "b");
  assert.equal(result.authenticated, false);
  assert.match(result.error, /not configured/);
  if (orig !== undefined) process.env.LDAP_URL = orig;
});

test("authenticateUser requires both username and password", async () => {
  const { authenticateUser } = await import("../lib/ldap-auth.js");
  const r1 = await authenticateUser("", "pw");
  assert.equal(r1.authenticated, false);
  const r2 = await authenticateUser("alice", "");
  assert.equal(r2.authenticated, false);
});

// ─── User sync ──────────────────────────────────────────────────────────────

test("syncUser persists a local record from LDAP attributes", async () => {
  const { syncUser, listSyncedUsers } = await import("../lib/ldap-auth.js");
  const result = await syncUser({
    dn: "uid=carol,ou=people,dc=example,dc=com",
    attributes: {
      uid: "carol",
      mail: "carol@example.com",
      displayName: "Carol Jones",
      cn: "Carol Jones",
    },
  }, "ws-1");
  assert.equal(result.userId, "ldap-carol");
  assert.equal(result.email, "carol@example.com");
  assert.equal(result.displayName, "Carol Jones");
  const users = await listSyncedUsers();
  assert.ok(users.some((u) => u.userId === "ldap-carol" && u.workspaceId === "ws-1"));
});

test("syncUser falls back to sAMAccountName for AD-style entries", async () => {
  const { syncUser } = await import("../lib/ldap-auth.js");
  const result = await syncUser({
    dn: "CN=Dave,OU=People,DC=corp,DC=example,DC=com",
    attributes: {
      sAMAccountName: "dave",
      mail: "dave@corp.example.com",
      cn: "Dave Smith",
    },
  });
  assert.equal(result.userId, "ldap-dave");
  assert.equal(result.email, "dave@corp.example.com");
});

test("syncUser throws when no username attribute is present", async () => {
  const { syncUser } = await import("../lib/ldap-auth.js");
  await assert.rejects(
    () => syncUser({ dn: null, attributes: { mail: "x@y.z" } }),
    /missing username/
  );
});

// ─── Group sync ─────────────────────────────────────────────────────────────

test("syncGroups persists a snapshot for a workspace", async () => {
  const { syncGroups } = await import("../lib/ldap-auth.js");
  const result = await syncGroups(
    [
      { dn: "cn=admins,ou=groups,dc=example,dc=com", name: "admins" },
      { dn: "cn=users,ou=groups,dc=example,dc=com", name: "users" },
    ],
    "ws-1"
  );
  assert.equal(result.groups.length, 2);
  assert.equal(result.groups[0].dn, "cn=admins,ou=groups,dc=example,dc=com");
});

// ─── Group mapping & role resolution ────────────────────────────────────────

test("DEFAULT_GROUP_MAPPING contains the expected roles", async () => {
  const { DEFAULT_GROUP_MAPPING } = await import("../lib/ldap-group-mapping.js");
  assert.equal(
    DEFAULT_GROUP_MAPPING["cn=siskelbot-admins,ou=groups,dc=example,dc=com"],
    "admin"
  );
  assert.equal(
    DEFAULT_GROUP_MAPPING["cn=siskelbot-members,ou=groups,dc=example,dc=com"],
    "member"
  );
  assert.equal(
    DEFAULT_GROUP_MAPPING["cn=siskelbot-viewers,ou=groups,dc=example,dc=com"],
    "viewer"
  );
});

test("getUserRoleFromGroups picks the highest privilege role", async () => {
  const { getUserRoleFromGroups, DEFAULT_GROUP_MAPPING } = await import(
    "../lib/ldap-group-mapping.js"
  );
  const role = await getUserRoleFromGroups(
    [
      { dn: "cn=siskelbot-viewers,ou=groups,dc=example,dc=com", name: "siskelbot-viewers" },
      { dn: "cn=siskelbot-admins,ou=groups,dc=example,dc=com", name: "siskelbot-admins" },
    ],
    DEFAULT_GROUP_MAPPING
  );
  assert.equal(role, "admin");
});

test("getUserRoleFromGroups matches by CN when DN is not in mapping", async () => {
  const { getUserRoleFromGroups } = await import("../lib/ldap-group-mapping.js");
  const role = await getUserRoleFromGroups(
    [{ dn: "cn=engineering,ou=groups,dc=acme,dc=com", name: "engineering" }],
    { engineering: "member" }
  );
  assert.equal(role, "member");
});

test("getUserRoleFromGroups returns null when no group matches", async () => {
  const { getUserRoleFromGroups } = await import("../lib/ldap-group-mapping.js");
  const role = await getUserRoleFromGroups(
    [{ dn: "cn=other,dc=example,dc=com", name: "other" }],
    { "cn=admins,dc=example,dc=com": "admin" }
  );
  assert.equal(role, null);
});

test("getUserRoleFromGroups returns null on empty input", async () => {
  const { getUserRoleFromGroups } = await import("../lib/ldap-group-mapping.js");
  assert.equal(await getUserRoleFromGroups([]), null);
  assert.equal(await getUserRoleFromGroups(null), null);
});

test("getUserRoleFromGroups handles plain string DNs", async () => {
  const { getUserRoleFromGroups } = await import("../lib/ldap-group-mapping.js");
  const role = await getUserRoleFromGroups(
    ["cn=siskelbot-members,ou=groups,dc=example,dc=com"],
    { "cn=siskelbot-members,ou=groups,dc=example,dc=com": "member" }
  );
  assert.equal(role, "member");
});

test("setGroupMapping and getGroupMapping persist per workspace", async () => {
  const { setGroupMapping, getGroupMapping, DEFAULT_GROUP_MAPPING } = await import(
    "../lib/ldap-group-mapping.js"
  );
  const mapping = {
    "cn=acme-admins,ou=Groups,dc=acme,dc=com": "admin",
    "cn=acme-eng,ou=Groups,dc=acme,dc=com": "member",
  };
  await setGroupMapping("ws-acme", mapping);
  const fetched = await getGroupMapping("ws-acme");
  assert.deepEqual(fetched, mapping);

  // Other workspaces fall back to the default mapping.
  const other = await getGroupMapping("ws-unknown");
  assert.deepEqual(other, { ...DEFAULT_GROUP_MAPPING });
});

test("setGroupMapping rejects unknown roles", async () => {
  const { setGroupMapping } = await import("../lib/ldap-group-mapping.js");
  await assert.rejects(
    () => setGroupMapping("ws-bad", { "cn=x,dc=example,dc=com": "superuser" }),
    /unknown role/
  );
});

test("setGroupMapping rejects non-object mapping", async () => {
  const { setGroupMapping } = await import("../lib/ldap-group-mapping.js");
  await assert.rejects(() => setGroupMapping("ws-x", null), /mapping must be an object/);
  await assert.rejects(() => setGroupMapping("ws-x", []), /mapping must be an object/);
});

// ─── Error handling when ldapjs is unavailable ──────────────────────────────

test("bindToLDAP surfaces LDAPJS_NOT_INSTALLED when module load fails", async () => {
  const orig = { ...process.env };
  process.env.LDAP_URL = "ldap://example.com";

  const { bindToLDAP, _setLdapjsModule, _resetLdapjsCache } = await import(
    "../lib/ldap-auth.js"
  );
  // Simulate the load error path by injecting a "module" without createClient.
  _resetLdapjsCache();
  _setLdapjsModule({ default: {} });
  await assert.rejects(() => bindToLDAP(), /createClient is missing/);

  _resetLdapjsCache();
  process.env = { ...orig };
});

test("bindToLDAP throws LDAP_NOT_CONFIGURED when env is missing", async () => {
  const orig = process.env.LDAP_URL;
  delete process.env.LDAP_URL;
  const { bindToLDAP } = await import("../lib/ldap-auth.js");
  await assert.rejects(() => bindToLDAP(), /not configured/);
  if (orig !== undefined) process.env.LDAP_URL = orig;
});
