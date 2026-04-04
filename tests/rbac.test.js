/**
 * Tests for granular RBAC (lib/rbac.js).
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
  BUILT_IN_ROLES,
  createCustomRole,
  updateCustomRole,
  deleteCustomRole,
  listRoles,
  assignRole,
  getUserPermissions,
  requirePermission,
} from "../lib/rbac.js";
import { registerWorkspaceMembers } from "../lib/teams.js";

test.after(() => {
  try {
    rmSync(tempDir, { recursive: true });
  } catch (_) {}
});

// --- PERMISSIONS & BUILT_IN_ROLES ---

test("PERMISSIONS contains expected keys", () => {
  assert.ok(PERMISSIONS["workspace:read"]);
  assert.ok(PERMISSIONS["admin:users"]);
  assert.ok(PERMISSIONS["memory:write"]);
  assert.ok(Object.keys(PERMISSIONS).length > 15);
});

test("BUILT_IN_ROLES has owner/admin/member/viewer", () => {
  assert.ok(BUILT_IN_ROLES.owner);
  assert.ok(BUILT_IN_ROLES.admin);
  assert.ok(BUILT_IN_ROLES.member);
  assert.ok(BUILT_IN_ROLES.viewer);
});

test("owner has all permissions", () => {
  const allPerms = Object.keys(PERMISSIONS);
  for (const p of allPerms) {
    assert.ok(BUILT_IN_ROLES.owner.permissions.includes(p), `owner missing ${p}`);
  }
});

test("admin has all permissions except workspace:delete", () => {
  assert.ok(!BUILT_IN_ROLES.admin.permissions.includes("workspace:delete"));
  assert.ok(BUILT_IN_ROLES.admin.permissions.includes("workspace:read"));
  assert.ok(BUILT_IN_ROLES.admin.permissions.includes("admin:users"));
});

test("member has limited permissions", () => {
  assert.ok(BUILT_IN_ROLES.member.permissions.includes("workspace:read"));
  assert.ok(BUILT_IN_ROLES.member.permissions.includes("conversation:write"));
  assert.ok(!BUILT_IN_ROLES.member.permissions.includes("admin:users"));
  assert.ok(!BUILT_IN_ROLES.member.permissions.includes("workspace:delete"));
});

test("viewer has read-only permissions", () => {
  const viewerPerms = BUILT_IN_ROLES.viewer.permissions;
  assert.ok(viewerPerms.includes("workspace:read"));
  assert.ok(viewerPerms.includes("conversation:read"));
  assert.ok(!viewerPerms.includes("conversation:write"));
  assert.ok(!viewerPerms.includes("admin:users"));
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

test("createCustomRole rejects built-in names", async () => {
  await assert.rejects(() => createCustomRole("ws-builtin-reject", "admin", ["workspace:read"]), /built-in/i);
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
  assert.equal(jsonBody.code, "PERMISSION_DENIED");
});
