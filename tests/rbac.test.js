/**
 * Tests for granular RBAC (lib/rbac.js).
 * Covers role hierarchy, permission checking, custom roles, and middleware.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "siskelbot-rbac-"));
process.env.STORAGE_PATH = tempDir;

import {
  PERMISSIONS,
  ROLES,
  BUILT_IN_ROLES,
  hasPermission,
  listPermissions,
  createCustomRole,
  updateCustomRole,
  deleteCustomRole,
  listRoles,
  assignRole,
  getUserRole,
  setUserRole,
  getUserPermissions,
  requirePermission,
} from "../lib/rbac.js";
import { registerWorkspaceMembers } from "../lib/teams.js";

test.after(() => {
  try {
    rmSync(tempDir, { recursive: true });
  } catch (_) {}
});

// --- PERMISSIONS & ROLES ---

test("PERMISSIONS contains expected keys", () => {
  assert.ok(PERMISSIONS["workspace:read"]);
  assert.ok(PERMISSIONS["admin:users"]);
  assert.ok(PERMISSIONS["memory:write"]);
  assert.ok(PERMISSIONS["manage:users"]);
  assert.ok(PERMISSIONS["read:conversations"]);
  assert.ok(Object.keys(PERMISSIONS).length > 15);
});

test("ROLES has owner/admin/member/viewer", () => {
  assert.ok(ROLES.owner);
  assert.ok(ROLES.admin);
  assert.ok(ROLES.member);
  assert.ok(ROLES.viewer);
});

test("BUILT_IN_ROLES has owner/admin/member/viewer with computed permissions", () => {
  assert.ok(BUILT_IN_ROLES.owner);
  assert.ok(BUILT_IN_ROLES.admin);
  assert.ok(BUILT_IN_ROLES.member);
  assert.ok(BUILT_IN_ROLES.viewer);
});

// --- Role Hierarchy: viewer < member < admin < owner ---

test("owner has all permissions (wildcard)", () => {
  const allPerms = Object.keys(PERMISSIONS);
  const ownerPerms = listPermissions("owner");
  for (const p of allPerms) {
    assert.ok(ownerPerms.includes(p), `owner missing ${p}`);
  }
});

test("admin inherits from member", () => {
  assert.deepEqual(ROLES.admin.inherits, ["member"]);
  const adminPerms = listPermissions("admin");
  // admin should have all member permissions
  const memberPerms = listPermissions("member");
  for (const p of memberPerms) {
    assert.ok(adminPerms.includes(p), `admin missing inherited member perm: ${p}`);
  }
  // admin should also have manage:users
  assert.ok(adminPerms.includes("manage:users"));
  assert.ok(adminPerms.includes("admin:users"));
});

test("member inherits from viewer", () => {
  assert.deepEqual(ROLES.member.inherits, ["viewer"]);
  const memberPerms = listPermissions("member");
  const viewerPerms = listPermissions("viewer");
  for (const p of viewerPerms) {
    assert.ok(memberPerms.includes(p), `member missing inherited viewer perm: ${p}`);
  }
  // member should also have write permissions
  assert.ok(memberPerms.includes("write:conversations"));
  assert.ok(memberPerms.includes("conversation:write"));
});

test("viewer has read-only permissions", () => {
  const viewerPerms = listPermissions("viewer");
  assert.ok(viewerPerms.includes("workspace:read"));
  assert.ok(viewerPerms.includes("conversation:read"));
  assert.ok(viewerPerms.includes("read:conversations"));
  assert.ok(viewerPerms.includes("view:dashboard"));
  // viewer should NOT have write or admin perms
  assert.ok(!viewerPerms.includes("conversation:write"));
  assert.ok(!viewerPerms.includes("admin:users"));
  assert.ok(!viewerPerms.includes("manage:users"));
});

test("hierarchy: viewer perms < member perms < admin perms < owner perms", () => {
  const vCount = listPermissions("viewer").length;
  const mCount = listPermissions("member").length;
  const aCount = listPermissions("admin").length;
  const oCount = listPermissions("owner").length;
  assert.ok(vCount < mCount, `viewer (${vCount}) should have fewer perms than member (${mCount})`);
  assert.ok(mCount < aCount, `member (${mCount}) should have fewer perms than admin (${aCount})`);
  assert.ok(aCount <= oCount, `admin (${aCount}) should have fewer or equal perms than owner (${oCount})`);
});

// --- hasPermission ---

test("hasPermission returns true for direct permission", () => {
  assert.ok(hasPermission("viewer", "workspace:read"));
  assert.ok(hasPermission("member", "conversation:write"));
  assert.ok(hasPermission("admin", "manage:users"));
});

test("hasPermission returns true for inherited permission", () => {
  // member inherits viewer's read:conversations
  assert.ok(hasPermission("member", "read:conversations"));
  // admin inherits member's write:conversations
  assert.ok(hasPermission("admin", "write:conversations"));
  // admin inherits viewer's workspace:read through member
  assert.ok(hasPermission("admin", "workspace:read"));
});

test("hasPermission returns true for owner with any permission", () => {
  assert.ok(hasPermission("owner", "workspace:read"));
  assert.ok(hasPermission("owner", "admin:users"));
  assert.ok(hasPermission("owner", "manage:webhooks"));
  assert.ok(hasPermission("owner", "conversation:delete"));
});

test("hasPermission returns false for missing permission", () => {
  assert.ok(!hasPermission("viewer", "conversation:write"));
  assert.ok(!hasPermission("viewer", "admin:users"));
  assert.ok(!hasPermission("member", "manage:users"));
  assert.ok(!hasPermission("member", "admin:users"));
});

test("hasPermission returns false for null/undefined role", () => {
  assert.ok(!hasPermission(null, "workspace:read"));
  assert.ok(!hasPermission(undefined, "workspace:read"));
  assert.ok(!hasPermission("", "workspace:read"));
});

test("hasPermission returns false for unknown role", () => {
  assert.ok(!hasPermission("nonexistent", "workspace:read"));
});

// --- listPermissions ---

test("listPermissions returns correct permissions for each role", () => {
  const viewerPerms = listPermissions("viewer");
  assert.ok(viewerPerms.includes("workspace:read"));
  assert.ok(!viewerPerms.includes("conversation:write"));

  const memberPerms = listPermissions("member");
  assert.ok(memberPerms.includes("workspace:read")); // inherited
  assert.ok(memberPerms.includes("conversation:write")); // direct

  const adminPerms = listPermissions("admin");
  assert.ok(adminPerms.includes("manage:users")); // direct
  assert.ok(adminPerms.includes("conversation:write")); // inherited from member

  const ownerPerms = listPermissions("owner");
  // owner has wildcard so all perms
  assert.ok(ownerPerms.length === Object.keys(PERMISSIONS).length);
});

test("listPermissions returns empty for unknown role", () => {
  const perms = listPermissions("nonexistent");
  assert.deepEqual(perms, []);
});

// --- Custom Roles ---

test("createCustomRole creates a role", async () => {
  const role = await createCustomRole("ws-create-1", "developer", [
    "workspace:read",
    "conversation:read",
    "conversation:write",
    "knowledge:read",
    "agent:execute",
  ]);
  assert.ok(role.id);
  assert.equal(role.name, "developer");
  assert.equal(role.builtin, false);
  assert.equal(role.permissions.length, 5);
});

test("createCustomRole with inherits", async () => {
  const role = await createCustomRole("ws-inherit-1", "senior-dev", [
    "agent:configure",
  ], ["member"]);
  assert.ok(role.id);
  assert.equal(role.name, "senior-dev");
  assert.deepEqual(role.inherits, ["member"]);
  // Effective permissions should include member + agent:configure
  const allRoles = await listRoles("ws-inherit-1");
  const seniorDev = allRoles.find((r) => r.name === "senior-dev");
  assert.ok(seniorDev);
  assert.ok(seniorDev.effectivePermissions.includes("agent:configure"));
  assert.ok(seniorDev.effectivePermissions.includes("workspace:read")); // from member -> viewer
  assert.ok(seniorDev.effectivePermissions.includes("conversation:write")); // from member
});

test("createCustomRole rejects built-in names", async () => {
  await assert.rejects(() => createCustomRole("ws-builtin-reject", "admin", ["workspace:read"]), /built-in/i);
  await assert.rejects(() => createCustomRole("ws-builtin-reject", "owner", ["workspace:read"]), /built-in/i);
  await assert.rejects(() => createCustomRole("ws-builtin-reject", "member", ["workspace:read"]), /built-in/i);
  await assert.rejects(() => createCustomRole("ws-builtin-reject", "viewer", ["workspace:read"]), /built-in/i);
});

test("createCustomRole rejects duplicates in same workspace", async () => {
  await createCustomRole("ws-dup-check", "unique-role", ["workspace:read"]);
  await assert.rejects(() => createCustomRole("ws-dup-check", "unique-role", ["workspace:read"]), /already exists/i);
});

test("listRoles returns built-in and custom roles", async () => {
  await createCustomRole("ws-list-1", "custom-dev", ["workspace:read", "agent:execute"]);
  const roles = await listRoles("ws-list-1");
  const builtInNames = ["owner", "admin", "member", "viewer"];
  for (const name of builtInNames) {
    assert.ok(roles.find((r) => r.name === name), `Missing built-in role: ${name}`);
  }
  assert.ok(roles.find((r) => r.name === "custom-dev"), "Missing custom role");
  // Each role should have effectivePermissions
  for (const role of roles) {
    assert.ok(Array.isArray(role.effectivePermissions), `Role ${role.name} missing effectivePermissions`);
  }
});

test("updateCustomRole modifies a role", async () => {
  const role = await createCustomRole("ws-upd-1", "temp-role", [
    "workspace:read",
    "conversation:read",
  ]);
  const updated = await updateCustomRole("ws-upd-1", role.id, {
    name: "updated-role",
    permissions: ["workspace:read", "conversation:read", "conversation:write", "knowledge:read", "knowledge:write", "agent:execute"],
  });
  assert.equal(updated.name, "updated-role");
  assert.equal(updated.permissions.length, 6);
});

test("updateCustomRole can update inherits", async () => {
  const role = await createCustomRole("ws-upd-inh", "edit-inherit", ["workspace:read"]);
  const updated = await updateCustomRole("ws-upd-inh", role.id, {
    inherits: ["viewer"],
  });
  assert.deepEqual(updated.inherits, ["viewer"]);
});

test("updateCustomRole rejects built-in role name", async () => {
  const role = await createCustomRole("ws-upd-builtin", "rename-me", ["workspace:read"]);
  await assert.rejects(() => updateCustomRole("ws-upd-builtin", role.id, { name: "owner" }), /built-in/i);
});

test("deleteCustomRole removes a role", async () => {
  const role = await createCustomRole("ws-del-1", "deletable", ["workspace:read"]);
  const result = await deleteCustomRole("ws-del-1", role.id);
  assert.ok(result);
  const rolesAfter = await listRoles("ws-del-1");
  assert.ok(!rolesAfter.find((r) => r.name === "deletable"));
});

test("deleteCustomRole returns false for unknown id", async () => {
  const result = await deleteCustomRole("ws-del-unk", "nonexistent-id");
  assert.equal(result, false);
});

// --- getUserRole / setUserRole ---

test("getUserRole returns role for explicitly assigned user", async () => {
  await registerWorkspaceMembers("ws-getrole-1", "owner-gr", [
    { userId: "owner-gr", role: "admin" },
    { userId: "user-gr", role: "member" },
  ]);
  await assignRole("ws-getrole-1", "user-gr", "viewer");
  const role = await getUserRole("user-gr", "ws-getrole-1");
  assert.equal(role, "viewer");
});

test("getUserRole falls back to team role when no RBAC assignment", async () => {
  await registerWorkspaceMembers("ws-getrole-2", "owner-gr2", [
    { userId: "owner-gr2", role: "admin" },
    { userId: "user-gr2", role: "member" },
  ]);
  const role = await getUserRole("user-gr2", "ws-getrole-2");
  assert.equal(role, "member");
});

test("getUserRole returns null for non-member", async () => {
  const role = await getUserRole("stranger-gr", "ws-getrole-2");
  assert.equal(role, null);
});

test("setUserRole sets role via alias", async () => {
  await registerWorkspaceMembers("ws-setrole-1", "owner-sr", [
    { userId: "owner-sr", role: "admin" },
    { userId: "user-sr", role: "member" },
  ]);
  const result = await setUserRole("user-sr", "ws-setrole-1", "admin");
  assert.equal(result.roleId, "admin");
  const role = await getUserRole("user-sr", "ws-setrole-1");
  assert.equal(role, "admin");
});

// --- Role Assignment ---

test("assignRole assigns a built-in role", async () => {
  await registerWorkspaceMembers("ws-assign-1", "owner2", [
    { userId: "owner2", role: "admin" },
    { userId: "user2", role: "member" },
  ]);
  const result = await assignRole("ws-assign-1", "user2", "viewer");
  assert.equal(result.roleId, "viewer");
  assert.equal(result.roleName, "viewer");
});

test("assignRole rejects unknown role", async () => {
  await assert.rejects(() => assignRole("ws-assign-1", "user2", "nonexistent"), /not found/i);
});

test("assignRole assigns a custom role", async () => {
  const role = await createCustomRole("ws-assign-2", "tester", ["workspace:read", "conversation:read"]);
  const result = await assignRole("ws-assign-2", "user2", role.id);
  assert.equal(result.roleId, role.id);
  assert.equal(result.roleName, "tester");
});

// --- getUserPermissions ---

test("getUserPermissions returns custom role permissions when assigned", async () => {
  // user2 in ws-assign-2 has custom "tester" role from above
  const perms = await getUserPermissions("ws-assign-2", "user2");
  assert.ok(perms.includes("workspace:read"));
  assert.ok(perms.includes("conversation:read"));
  assert.ok(!perms.includes("admin:users"));
});

test("getUserPermissions falls back to team role when no RBAC assignment", async () => {
  await registerWorkspaceMembers("ws-fallback-1", "owner3", [
    { userId: "owner3", role: "admin" },
    { userId: "member3", role: "member" },
  ]);
  const perms = await getUserPermissions("ws-fallback-1", "member3");
  assert.ok(perms.includes("workspace:read"));
  assert.ok(perms.includes("conversation:write"));
  assert.ok(!perms.includes("admin:users"));
});

test("getUserPermissions returns empty for non-member", async () => {
  const perms = await getUserPermissions("ws-fallback-1", "stranger");
  assert.deepEqual(perms, []);
});

test("getUserPermissions resolves inherited permissions for custom role", async () => {
  await createCustomRole("ws-perms-inh", "lead-dev", [
    "agent:configure",
  ], ["member"]);
  await registerWorkspaceMembers("ws-perms-inh", "owner-pi", [
    { userId: "owner-pi", role: "admin" },
    { userId: "user-pi", role: "member" },
  ]);
  const customRoles = await listRoles("ws-perms-inh");
  const leadDev = customRoles.find((r) => r.name === "lead-dev");
  await assignRole("ws-perms-inh", "user-pi", leadDev.id);
  const perms = await getUserPermissions("ws-perms-inh", "user-pi");
  // Should have agent:configure (direct) + member perms (inherited) + viewer perms (inherited from member)
  assert.ok(perms.includes("agent:configure"));
  assert.ok(perms.includes("conversation:write")); // from member
  assert.ok(perms.includes("workspace:read")); // from viewer via member
});

// --- requirePermission middleware ---

test("requirePermission denies unauthenticated user", async () => {
  const middleware = requirePermission("workspace:read");
  let statusCode, jsonBody;
  const req = { params: { id: "ws1" } };
  const res = {
    status(code) { statusCode = code; return this; },
    json(body) { jsonBody = body; },
  };
  await middleware(req, res, () => {});
  assert.equal(statusCode, 401);
  assert.equal(jsonBody.code, "AUTH_REQUIRED");
});

test("requirePermission denies missing workspace", async () => {
  const middleware = requirePermission("workspace:read");
  let statusCode;
  const req = { userId: "user1", params: {}, query: {} };
  const res = {
    status(code) { statusCode = code; return this; },
    json() {},
  };
  await middleware(req, res, () => {});
  assert.equal(statusCode, 400);
});

test("requirePermission allows user with correct permissions", async () => {
  await registerWorkspaceMembers("ws-perm-1", "ownerP", [
    { userId: "ownerP", role: "admin" },
    { userId: "userP", role: "member" },
  ]);
  const middleware = requirePermission("workspace:read", "conversation:read");
  let called = false;
  const req = { userId: "userP", params: { id: "ws-perm-1" }, query: {} };
  const res = {
    status() { return this; },
    json() {},
  };
  await middleware(req, res, () => { called = true; });
  assert.ok(called);
});

test("requirePermission denies user missing permissions", async () => {
  const middleware = requirePermission("admin:users");
  let statusCode, jsonBody;
  const req = { userId: "userP", params: { id: "ws-perm-1" }, query: {} };
  const res = {
    status(code) { statusCode = code; return this; },
    json(body) { jsonBody = body; },
  };
  await middleware(req, res, () => {});
  assert.equal(statusCode, 403);
  assert.equal(jsonBody.code, "FORBIDDEN");
  assert.equal(jsonBody.required, "admin:users");
});

test("requirePermission passes for admin session users with admin scope", async () => {
  const middleware = requirePermission("admin:users");
  let called = false;
  const req = {
    session: { userId: "admin-session" },
    apiKeyScopes: ["admin"],
    params: { id: "ws1" },
    query: {},
  };
  const res = {
    status() { return this; },
    json() {},
  };
  await middleware(req, res, () => { called = true; });
  assert.ok(called, "admin session user should pass requirePermission");
});

test("requirePermission sets req.userRole on success", async () => {
  await registerWorkspaceMembers("ws-perm-role", "ownerPR", [
    { userId: "ownerPR", role: "admin" },
    { userId: "userPR", role: "member" },
  ]);
  const middleware = requirePermission("workspace:read");
  const req = { userId: "userPR", params: { id: "ws-perm-role" }, query: {} };
  const res = {
    status() { return this; },
    json() {},
  };
  let called = false;
  await middleware(req, res, () => { called = true; });
  assert.ok(called);
  assert.equal(req.userRole, "member");
  assert.ok(Array.isArray(req.userPermissions));
});
