/**
 * Tests for Phase 46.3 just-in-time SSO user provisioning (lib/jit-provisioning.js).
 *
 * Covers:
 *   - Attribute mapping (default + custom)
 *   - mapSSOClaimsToUser normalization (groups, names, provider)
 *   - validateRequiredAttributes
 *   - applyGroupToRoleMapping precedence
 *   - provisionUserFromSSO create + repeat-login update
 *   - updateUserFromSSO syncing
 *   - deprovisionUser soft-delete + audit
 *   - JIT config get/set
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "siskelbot-jit-"));
process.env.STORAGE_PATH = tempDir;

const {
  DEFAULT_ATTRIBUTE_MAPPING,
  DEFAULT_GROUP_MAPPING,
  REQUIRED_ATTRIBUTES,
  applyMapping,
  validateRequiredAttributes,
  mapSSOClaimsToUser,
  applyGroupToRoleMapping,
  provisionUserFromSSO,
  updateUserFromSSO,
  deprovisionUser,
  getJITConfig,
  setJITConfig,
  listProvisionedUsers,
  listAuditLog,
  findJITUser,
} = await import("../lib/jit-provisioning.js");

test.after(() => {
  try {
    rmSync(tempDir, { recursive: true });
  } catch (_) {}
});

// --- DEFAULTS ---

test("DEFAULT_ATTRIBUTE_MAPPING contains OIDC standard claims", () => {
  assert.equal(DEFAULT_ATTRIBUTE_MAPPING.userId, "sub");
  assert.equal(DEFAULT_ATTRIBUTE_MAPPING.email, "email");
  assert.equal(DEFAULT_ATTRIBUTE_MAPPING.firstName, "given_name");
  assert.equal(DEFAULT_ATTRIBUTE_MAPPING.lastName, "family_name");
  assert.equal(DEFAULT_ATTRIBUTE_MAPPING.groups, "groups");
});

test("REQUIRED_ATTRIBUTES contains userId and email", () => {
  assert.ok(REQUIRED_ATTRIBUTES.includes("userId"));
  assert.ok(REQUIRED_ATTRIBUTES.includes("email"));
});

test("DEFAULT_GROUP_MAPPING maps siskelbot-* groups to roles", () => {
  assert.equal(DEFAULT_GROUP_MAPPING["siskelbot-admins"], "admin");
  assert.equal(DEFAULT_GROUP_MAPPING["siskelbot-members"], "member");
});

// --- applyMapping ---

test("applyMapping with default mapping extracts standard claims", () => {
  const profile = {
    sub: "user-123",
    email: "alice@example.com",
    name: "Alice",
    given_name: "Alice",
    family_name: "Smith",
    groups: ["g1"],
  };
  const result = applyMapping(profile);
  assert.equal(result.userId, "user-123");
  assert.equal(result.email, "alice@example.com");
  assert.equal(result.firstName, "Alice");
  assert.equal(result.lastName, "Smith");
  assert.deepEqual(result.groups, ["g1"]);
});

test("applyMapping with custom mapping uses custom field names", () => {
  const profile = { upn: "u1", mail: "x@y.z", displayName: "X" };
  const result = applyMapping(profile, {
    userId: "upn",
    email: "mail",
    name: "displayName",
  });
  assert.equal(result.userId, "u1");
  assert.equal(result.email, "x@y.z");
  assert.equal(result.name, "X");
});

test("applyMapping handles missing fields gracefully", () => {
  const result = applyMapping({ sub: "abc" });
  assert.equal(result.userId, "abc");
  assert.equal(result.email, undefined);
});

test("applyMapping returns empty object for null profile", () => {
  assert.deepEqual(applyMapping(null), {});
});

// --- validateRequiredAttributes ---

test("validateRequiredAttributes passes when all present", () => {
  const result = validateRequiredAttributes({ userId: "x", email: "a@b.c" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, []);
});

test("validateRequiredAttributes fails when missing", () => {
  const result = validateRequiredAttributes({ userId: "x" });
  assert.equal(result.ok, false);
  assert.ok(result.missing.includes("email"));
});

test("validateRequiredAttributes uses custom required list", () => {
  const result = validateRequiredAttributes(
    { userId: "x", email: "a@b.c" },
    ["userId", "name"]
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ["name"]);
});

test("validateRequiredAttributes treats empty string as missing", () => {
  const result = validateRequiredAttributes({ userId: "", email: "a@b.c" });
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ["userId"]);
});

// --- mapSSOClaimsToUser ---

test("mapSSOClaimsToUser normalizes a basic OIDC profile", async () => {
  const out = await mapSSOClaimsToUser(
    {
      sub: "u1",
      email: "u1@example.com",
      name: "User One",
      groups: ["a", "b"],
    },
    { provider: "google" }
  );
  assert.equal(out.userId, "u1");
  assert.equal(out.email, "u1@example.com");
  assert.equal(out.name, "User One");
  assert.deepEqual(out.groups, ["a", "b"]);
  assert.equal(out.provider, "google");
  assert.equal(out.externalId, "u1");
});

test("mapSSOClaimsToUser splits string groups into array", async () => {
  const out = await mapSSOClaimsToUser({
    sub: "u2",
    email: "u2@example.com",
    groups: "a, b; c",
  });
  assert.deepEqual(out.groups, ["a", "b", "c"]);
});

test("mapSSOClaimsToUser synthesizes name from given/family", async () => {
  const out = await mapSSOClaimsToUser({
    sub: "u3",
    email: "u3@example.com",
    given_name: "Jane",
    family_name: "Doe",
  });
  assert.equal(out.name, "Jane Doe");
});

test("mapSSOClaimsToUser respects custom field config", async () => {
  const out = await mapSSOClaimsToUser(
    { id: "u4", mail: "u4@x.y", displayName: "User Four", roles: ["r1"] },
    {
      userIdField: "id",
      emailField: "mail",
      nameField: "displayName",
      groupsField: "roles",
    }
  );
  assert.equal(out.userId, "u4");
  assert.equal(out.email, "u4@x.y");
  assert.equal(out.name, "User Four");
  assert.deepEqual(out.groups, ["r1"]);
});

// --- JIT config ---

test("getJITConfig returns defaults when nothing stored", async () => {
  const cfg = await getJITConfig("ws-default");
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.defaultRole, "member");
  assert.equal(cfg.groupMapping["siskelbot-admins"], "admin");
});

test("setJITConfig persists and getJITConfig returns merged values", async () => {
  await setJITConfig("ws-1", {
    enabled: true,
    defaultRole: "viewer",
    groupMapping: { "engineering": "admin" },
  });
  const cfg = await getJITConfig("ws-1");
  assert.equal(cfg.defaultRole, "viewer");
  assert.equal(cfg.groupMapping["engineering"], "admin");
  // defaults still merged in:
  assert.equal(cfg.groupMapping["siskelbot-admins"], "admin");
});

test("setJITConfig rejects invalid defaultRole", async () => {
  await assert.rejects(() => setJITConfig("ws-bad", { defaultRole: "evil" }));
});

// --- applyGroupToRoleMapping ---

test("applyGroupToRoleMapping returns mapped role for matching group", async () => {
  const result = await applyGroupToRoleMapping(["siskelbot-admins"], "ws-grp");
  assert.equal(result.role, "admin");
  assert.equal(result.matchedGroup, "siskelbot-admins");
});

test("applyGroupToRoleMapping uses precedence when multiple groups match", async () => {
  // Both viewer and admin groups → admin should win.
  const result = await applyGroupToRoleMapping(
    ["siskelbot-viewers", "siskelbot-admins"],
    "ws-grp"
  );
  assert.equal(result.role, "admin");
});

test("applyGroupToRoleMapping owner beats admin in precedence", async () => {
  const result = await applyGroupToRoleMapping(
    ["siskelbot-admins", "siskelbot-owners"],
    "ws-grp"
  );
  assert.equal(result.role, "owner");
});

test("applyGroupToRoleMapping falls back to default role when no match", async () => {
  await setJITConfig("ws-fb", { defaultRole: "viewer" });
  const result = await applyGroupToRoleMapping(["unknown-group"], "ws-fb");
  assert.equal(result.role, "viewer");
  assert.equal(result.matchedGroup, null);
});

// --- provisionUserFromSSO ---

test("provisionUserFromSSO creates a new user", async () => {
  const result = await provisionUserFromSSO(
    {
      provider: "oidc",
      externalId: "ext-1",
      email: "ext1@example.com",
      name: "Ext One",
      groups: ["siskelbot-members"],
    },
    { defaultWorkspace: "ws-prov" }
  );
  assert.equal(result.created, true);
  assert.equal(result.role, "member");
  assert.equal(result.workspaceId, "ws-prov");
  assert.ok(result.userId.startsWith("oidc-"));
});

test("provisionUserFromSSO updates user on repeat login (created=false)", async () => {
  const first = await provisionUserFromSSO(
    {
      provider: "oidc",
      externalId: "ext-2",
      email: "ext2@example.com",
      name: "Ext Two",
      groups: ["siskelbot-members"],
    },
    { defaultWorkspace: "ws-prov" }
  );
  assert.equal(first.created, true);

  const second = await provisionUserFromSSO(
    {
      provider: "oidc",
      externalId: "ext-2",
      email: "ext2-new@example.com",
      name: "Ext Two Updated",
      groups: ["siskelbot-admins"],
    },
    { defaultWorkspace: "ws-prov" }
  );
  assert.equal(second.created, false);
  assert.equal(second.userId, first.userId);
  assert.equal(second.role, "admin");

  const users = await listProvisionedUsers("ws-prov");
  const found = users.find((u) => u.userId === first.userId);
  assert.equal(found.email, "ext2-new@example.com");
  assert.equal(found.name, "Ext Two Updated");
  assert.deepEqual(found.groups, ["siskelbot-admins"]);
});

test("provisionUserFromSSO rejects when required attributes are missing", async () => {
  await assert.rejects(
    () =>
      provisionUserFromSSO(
        { provider: "oidc", externalId: "ext-3" /* no email */ },
        { defaultWorkspace: "ws-prov" }
      ),
    /Missing required SSO attributes/
  );
});

test("provisionUserFromSSO honors disabled JIT config", async () => {
  await setJITConfig("ws-disabled", { enabled: false });
  await assert.rejects(
    () =>
      provisionUserFromSSO(
        {
          provider: "oidc",
          externalId: "x",
          email: "x@y.z",
          name: "X",
        },
        { defaultWorkspace: "ws-disabled" }
      ),
    /disabled/
  );
});

test("provisionUserFromSSO records audit entry", async () => {
  await provisionUserFromSSO(
    {
      provider: "oidc",
      externalId: "ext-audit",
      email: "audit@example.com",
      name: "Audit User",
      groups: ["siskelbot-members"],
    },
    { defaultWorkspace: "ws-audit" }
  );
  const audit = await listAuditLog("ws-audit");
  assert.ok(audit.length > 0);
  assert.ok(audit.some((a) => a.event === "user_provisioned"));
});

test("findJITUser locates user by provider+externalId", async () => {
  const r = await provisionUserFromSSO(
    {
      provider: "oidc",
      externalId: "ext-find",
      email: "find@example.com",
      name: "Find Me",
    },
    { defaultWorkspace: "ws-find" }
  );
  const found = await findJITUser("oidc", "ext-find");
  assert.ok(found);
  assert.equal(found.userId, r.userId);
});

// --- updateUserFromSSO ---

test("updateUserFromSSO updates email, name, groups, role", async () => {
  const created = await provisionUserFromSSO(
    {
      provider: "oidc",
      externalId: "ext-upd",
      email: "upd@example.com",
      name: "Upd User",
      groups: ["siskelbot-members"],
    },
    { defaultWorkspace: "ws-upd" }
  );

  const updated = await updateUserFromSSO(created.userId, {
    email: "upd-new@example.com",
    name: "New Name",
    groups: ["siskelbot-admins"],
    role: "admin",
  });
  assert.equal(updated.email, "upd-new@example.com");
  assert.equal(updated.name, "New Name");
  assert.deepEqual(updated.groups, ["siskelbot-admins"]);
  assert.equal(updated.role, "admin");
});

test("updateUserFromSSO returns null for unknown user", async () => {
  const result = await updateUserFromSSO("nonexistent-user", { name: "X" });
  assert.equal(result, null);
});

// --- deprovisionUser ---

test("deprovisionUser soft-deletes a JIT user", async () => {
  const created = await provisionUserFromSSO(
    {
      provider: "oidc",
      externalId: "ext-deprov",
      email: "deprov@example.com",
      name: "Deprov",
    },
    { defaultWorkspace: "ws-deprov" }
  );

  const result = await deprovisionUser(created.userId, "test cleanup");
  assert.equal(result.deprovisioned, true);

  const users = await listProvisionedUsers("ws-deprov");
  const found = users.find((u) => u.userId === created.userId);
  assert.ok(found);
  assert.equal(found.active, false);
  assert.ok(found.deprovisionedAt);
  assert.equal(found.deprovisionedReason, "test cleanup");
});

test("deprovisionUser audit trail is preserved", async () => {
  const created = await provisionUserFromSSO(
    {
      provider: "oidc",
      externalId: "ext-deprov-audit",
      email: "deprov-audit@example.com",
      name: "Deprov Audit",
    },
    { defaultWorkspace: "ws-deprov-audit" }
  );
  await deprovisionUser(created.userId, "policy violation");

  const audit = await listAuditLog("ws-deprov-audit");
  assert.ok(audit.some((a) => a.event === "user_deprovisioned" && a.userId === created.userId));
});

test("deprovisionUser returns deprovisioned=false for unknown user", async () => {
  const result = await deprovisionUser("never-existed", "test");
  assert.equal(result.deprovisioned, false);
});

// --- listProvisionedUsers ---

test("listProvisionedUsers filters by workspace", async () => {
  await provisionUserFromSSO(
    {
      provider: "oidc",
      externalId: "ext-ws-A",
      email: "a@example.com",
      name: "A",
    },
    { defaultWorkspace: "ws-A" }
  );
  await provisionUserFromSSO(
    {
      provider: "oidc",
      externalId: "ext-ws-B",
      email: "b@example.com",
      name: "B",
    },
    { defaultWorkspace: "ws-B" }
  );
  const a = await listProvisionedUsers("ws-A");
  const b = await listProvisionedUsers("ws-B");
  assert.ok(a.some((u) => u.externalId === "ext-ws-A"));
  assert.ok(!a.some((u) => u.externalId === "ext-ws-B"));
  assert.ok(b.some((u) => u.externalId === "ext-ws-B"));
});

test("listProvisionedUsers returns all when no workspace specified", async () => {
  const all = await listProvisionedUsers();
  assert.ok(all.length >= 2);
});
