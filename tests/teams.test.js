/**
 * Phase 29: Multi-Tenant Teams & Collaboration unit tests.
 * Phase 68: Async teams APIs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "siskelbot-teams-"));
process.env.STORAGE_PATH = tempDir;

import * as teams from "../lib/teams.js";

test.after(() => {
  try {
    rmSync(tempDir, { recursive: true });
  } catch (_) {}
});

test("canAccessWorkspace returns allowed for owner", async () => {
  const access = await teams.canAccessWorkspace("ws1", "user1", "user1");
  assert.equal(access.allowed, true);
  assert.equal(access.role, "admin");
});

test("registerWorkspaceMembers and getWorkspaceMembers", async () => {
  await teams.registerWorkspaceMembers("ws-team-1", "owner1", [
    { userId: "owner1", role: "admin" },
    { userId: "member1", role: "member" },
  ]);
  const entry = await teams.getWorkspaceMembers("ws-team-1");
  assert.ok(entry);
  assert.equal(entry.ownerId, "owner1");
  assert.equal(entry.members.length, 2);
});

test("canAccessWorkspace returns allowed for team member", async () => {
  await teams.registerWorkspaceMembers("ws-team-2", "owner2", [
    { userId: "owner2", role: "admin" },
    { userId: "member2", role: "member" },
  ]);
  const access = await teams.canAccessWorkspace("ws-team-2", "member2");
  assert.equal(access.allowed, true);
  assert.equal(access.ownerId, "owner2");
  assert.equal(access.role, "member");
});

test("createInviteCode returns unique code", async () => {
  const wsId = "ws-invite-1";
  await teams.registerWorkspaceMembers(wsId, "owner-invite", [{ userId: "owner-invite", role: "admin" }]);
  const inv = await teams.createInviteCode(wsId, "owner-invite");
  assert.ok(inv.code);
  assert.equal(inv.code.length, 8);
  assert.ok(/^[A-Z0-9]+$/.test(inv.code));
});

test("joinByInviteCode adds member and returns ok", async () => {
  const wsId = "ws-join-1";
  await teams.registerWorkspaceMembers(wsId, "owner-join", [{ userId: "owner-join", role: "admin" }]);
  const inv = await teams.createInviteCode(wsId, "owner-join");
  const result = await teams.joinByInviteCode(inv.code, "new-user");
  assert.equal(result.ok, true);
  assert.equal(result.workspaceId, wsId);
  const members = await teams.getWorkspaceMembers(wsId);
  assert.ok(members.members.some((m) => m.userId === "new-user" && m.role === "member"));
});

test("joinByInviteCode returns error for invalid code", async () => {
  const result = await teams.joinByInviteCode("INVALID1", "user1");
  assert.equal(result.ok, false);
  assert.ok(result.error);
});

test("logActivity and getWorkspaceActivity", async () => {
  await teams.logActivity("ws-activity-1", "context_added", "user1", { title: "Doc 1" });
  await teams.logActivity("ws-activity-1", "recipe_ran", "user2", { recipeId: "r1" });
  const items = await teams.getWorkspaceActivity("ws-activity-1", 10);
  assert.ok(Array.isArray(items));
  assert.ok(items.length >= 2);
  assert.ok(items.some((i) => i.action === "context_added" && i.userId === "user1"));
});

test("resolveStorageUserId returns owner for team workspace", async () => {
  await teams.registerWorkspaceMembers("ws-resolve-1", "owner-resolve", [
    { userId: "owner-resolve", role: "admin" },
  ]);
  const uid = await teams.resolveStorageUserId("member-x", "ws-resolve-1");
  assert.equal(uid, "owner-resolve");
});

test("resolveStorageUserId returns userId for personal workspace", async () => {
  const uid = await teams.resolveStorageUserId("user1", "default");
  assert.equal(uid, "user1");
});
