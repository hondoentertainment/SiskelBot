/**
 * Phase 46.4: Group synchronization tests.
 *
 * Covers:
 *   - rule CRUD
 *   - pattern matching (literal, regex, glob)
 *   - rule evaluation with multiple rules
 *   - role conflict resolution
 *   - user group sync (add, update, remove)
 *   - dry-run mode
 *   - audit logging hook
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "siskelbot-group-sync-"));
process.env.STORAGE_PATH = tempDir;

const {
  matchGroupPattern,
  evaluateRules,
  resolveRoleConflict,
  detectPatternType,
  reduceMatchesByWorkspace,
} = await import("../lib/group-rule-engine.js");

const groupSync = await import("../lib/group-sync.js");
const {
  createGroupSyncRule,
  listGroupSyncRules,
  getGroupSyncRule,
  updateGroupSyncRule,
  deleteGroupSyncRule,
  syncUserGroups,
  runFullGroupSync,
  getGroupSyncHistory,
  testGroupSyncRule,
  setAuditSink,
  setFullSyncProvider,
  _resetForTests,
  _getWorkspaceMembersRaw,
} = groupSync;

test.after(() => {
  try { rmSync(tempDir, { recursive: true }); } catch {}
});

test.beforeEach(async () => {
  await _resetForTests();
  setAuditSink(null);
  setFullSyncProvider(null);
});

// ─── Pattern matching ──────────────────────────────────────────────────────

test("matchGroupPattern: literal exact match", () => {
  assert.equal(matchGroupPattern("engineering", "engineering"), true);
  assert.equal(matchGroupPattern("eng", "engineering"), false);
  assert.equal(matchGroupPattern("engineering ", "engineering"), false);
});

test("matchGroupPattern: glob with * wildcard", () => {
  assert.equal(matchGroupPattern("eng-backend", "eng-*"), true);
  assert.equal(matchGroupPattern("eng-frontend", "eng-*"), true);
  assert.equal(matchGroupPattern("design", "eng-*"), false);
  assert.equal(matchGroupPattern("anything", "*"), true);
});

test("matchGroupPattern: glob with ? wildcard", () => {
  assert.equal(matchGroupPattern("ab", "??"), true);
  assert.equal(matchGroupPattern("a", "??"), false);
  assert.equal(matchGroupPattern("abc", "??"), false);
});

test("matchGroupPattern: inline /regex/flags", () => {
  assert.equal(matchGroupPattern("Eng-Backend", "/^eng-.+$/i"), true);
  assert.equal(matchGroupPattern("eng-backend", "/^eng-.+$/"), true);
  assert.equal(matchGroupPattern("Eng-Backend", "/^eng-.+$/"), false);
});

test("matchGroupPattern: explicit regex hint", () => {
  assert.equal(matchGroupPattern("admin-1", "^admin-\\d+$", "regex"), true);
  assert.equal(matchGroupPattern("admin-x", "^admin-\\d+$", "regex"), false);
});

test("matchGroupPattern: invalid inputs", () => {
  assert.equal(matchGroupPattern("", "x"), false);
  assert.equal(matchGroupPattern("x", ""), false);
  assert.equal(matchGroupPattern(null, "x"), false);
});

test("detectPatternType auto-detects", () => {
  assert.equal(detectPatternType("engineering"), "literal");
  assert.equal(detectPatternType("eng-*"), "glob");
  assert.equal(detectPatternType("/^eng-.+$/i"), "regex");
  assert.equal(detectPatternType("plain", "regex"), "regex");
});

// ─── Rule evaluation ──────────────────────────────────────────────────────

test("evaluateRules returns matching rules with matched group", () => {
  const rules = [
    { id: "r1", groupPattern: "eng-*", targetWorkspace: "eng-ws", targetRole: "member" },
    { id: "r2", groupPattern: "design", targetWorkspace: "design-ws", targetRole: "viewer" },
    { id: "r3", groupPattern: "/^ops-/", targetWorkspace: "ops-ws", targetRole: "admin" },
  ];
  const matches = evaluateRules(["eng-backend", "ops-prod", "marketing"], rules);
  assert.equal(matches.length, 2);
  const byId = Object.fromEntries(matches.map((m) => [m.rule.id, m.matchedGroup]));
  assert.equal(byId.r1, "eng-backend");
  assert.equal(byId.r3, "ops-prod");
});

test("evaluateRules skips disabled rules", () => {
  const rules = [
    { id: "r1", groupPattern: "*", targetWorkspace: "all", targetRole: "viewer", enabled: false },
  ];
  assert.equal(evaluateRules(["anything"], rules).length, 0);
});

test("evaluateRules returns empty for empty inputs", () => {
  assert.deepEqual(evaluateRules([], [{ id: "r1", groupPattern: "*", targetRole: "viewer" }]), []);
  assert.deepEqual(evaluateRules(["g"], []), []);
});

// ─── Role conflict resolution ─────────────────────────────────────────────

test("resolveRoleConflict picks highest from string list", () => {
  assert.equal(resolveRoleConflict(["viewer", "member", "admin"]), "admin");
  assert.equal(resolveRoleConflict(["viewer", "member"]), "member");
  assert.equal(resolveRoleConflict(["owner", "viewer"]), "owner");
});

test("resolveRoleConflict picks highest from object list", () => {
  assert.equal(
    resolveRoleConflict([{ role: "viewer" }, { role: "admin" }, { role: "member" }]),
    "admin"
  );
});

test("resolveRoleConflict handles unknown roles and empty input", () => {
  assert.equal(resolveRoleConflict(["junk", "viewer"]), "viewer");
  assert.equal(resolveRoleConflict([]), null);
  assert.equal(resolveRoleConflict(["junk"]), null);
});

test("reduceMatchesByWorkspace folds matches to one role per workspace", () => {
  const matches = [
    { rule: { id: "r1", targetWorkspace: "ws1", targetRole: "viewer" }, matchedGroup: "g1" },
    { rule: { id: "r2", targetWorkspace: "ws1", targetRole: "admin" }, matchedGroup: "g2" },
    { rule: { id: "r3", targetWorkspace: "ws2", targetRole: "member" }, matchedGroup: "g3" },
  ];
  const folded = reduceMatchesByWorkspace(matches);
  assert.equal(folded.get("ws1").role, "admin");
  assert.deepEqual(folded.get("ws1").ruleIds.sort(), ["r1", "r2"]);
  assert.equal(folded.get("ws2").role, "member");
});

// ─── Rule CRUD ────────────────────────────────────────────────────────────

test("createGroupSyncRule validates required fields", async () => {
  await assert.rejects(() => createGroupSyncRule({}), /name is required/);
  await assert.rejects(
    () => createGroupSyncRule({ name: "x" }),
    /source must be one of/
  );
  await assert.rejects(
    () => createGroupSyncRule({ name: "x", source: "ldap" }),
    /groupPattern is required/
  );
  await assert.rejects(
    () => createGroupSyncRule({ name: "x", source: "ldap", groupPattern: "g" }),
    /targetWorkspace is required/
  );
  await assert.rejects(
    () => createGroupSyncRule({ name: "x", source: "ldap", groupPattern: "g", targetWorkspace: "ws" }),
    /targetRole must be one of/
  );
});

test("createGroupSyncRule rejects invalid source", async () => {
  await assert.rejects(
    () =>
      createGroupSyncRule({
        name: "x",
        source: "facebook",
        groupPattern: "g",
        targetWorkspace: "ws",
        targetRole: "member",
      }),
    /source must be one of/
  );
});

test("createGroupSyncRule persists and returns public view", async () => {
  const rule = await createGroupSyncRule({
    name: "Engineering",
    source: "ldap",
    groupPattern: "eng-*",
    targetWorkspace: "engineering",
    targetRole: "member",
    autoCreateWorkspace: true,
    permissions: ["read", "write"],
    createdBy: "admin",
  });
  assert.ok(rule.id);
  assert.equal(rule.name, "Engineering");
  assert.equal(rule.source, "ldap");
  assert.equal(rule.targetWorkspace, "engineering");
  assert.equal(rule.targetRole, "member");
  assert.equal(rule.autoCreateWorkspace, true);
  assert.deepEqual(rule.permissions, ["read", "write"]);
  assert.equal(rule.enabled, true);
});

test("listGroupSyncRules returns and filters by workspace", async () => {
  await createGroupSyncRule({
    name: "A", source: "ldap", groupPattern: "a", targetWorkspace: "ws1", targetRole: "viewer",
  });
  await createGroupSyncRule({
    name: "B", source: "ldap", groupPattern: "b", targetWorkspace: "ws2", targetRole: "member",
  });
  const all = await listGroupSyncRules();
  assert.equal(all.length, 2);
  const ws1 = await listGroupSyncRules("ws1");
  assert.equal(ws1.length, 1);
  assert.equal(ws1[0].name, "A");
});

test("updateGroupSyncRule updates supplied fields", async () => {
  const rule = await createGroupSyncRule({
    name: "Eng", source: "ldap", groupPattern: "eng-*", targetWorkspace: "ws", targetRole: "viewer",
  });
  const updated = await updateGroupSyncRule(rule.id, { targetRole: "admin", enabled: false });
  assert.equal(updated.targetRole, "admin");
  assert.equal(updated.enabled, false);
  // Unchanged fields preserved
  assert.equal(updated.name, "Eng");
  assert.equal(updated.groupPattern, "eng-*");
});

test("updateGroupSyncRule returns null for missing rule", async () => {
  const result = await updateGroupSyncRule("does-not-exist", { targetRole: "admin" });
  assert.equal(result, null);
});

test("deleteGroupSyncRule removes a rule", async () => {
  const rule = await createGroupSyncRule({
    name: "X", source: "ldap", groupPattern: "x", targetWorkspace: "ws", targetRole: "viewer",
  });
  const result = await deleteGroupSyncRule(rule.id);
  assert.equal(result.ok, true);
  const after = await getGroupSyncRule(rule.id);
  assert.equal(after, null);
});

test("deleteGroupSyncRule returns ok=false for missing", async () => {
  const result = await deleteGroupSyncRule("missing-id");
  assert.equal(result.ok, false);
});

// ─── Dry-run ──────────────────────────────────────────────────────────────

test("testGroupSyncRule returns matched info without persisting", async () => {
  const rule = {
    groupPattern: "eng-*",
    targetWorkspace: "engineering",
    targetRole: "member",
  };
  const result = testGroupSyncRule(rule, ["eng-backend", "design"]);
  assert.equal(result.matched, true);
  assert.equal(result.matchedGroup, "eng-backend");
  assert.deepEqual(result.wouldAssign, { workspaceId: "engineering", role: "member" });
});

test("testGroupSyncRule returns matched=false when no group matches", () => {
  const rule = { groupPattern: "ops-*", targetWorkspace: "ops", targetRole: "admin" };
  const result = testGroupSyncRule(rule, ["eng-backend"]);
  assert.equal(result.matched, false);
  assert.equal(result.matchedGroup, null);
  assert.equal(result.wouldAssign, null);
});

// ─── User sync ────────────────────────────────────────────────────────────

test("syncUserGroups adds user to matched workspaces", async () => {
  await createGroupSyncRule({
    name: "Eng", source: "ldap", groupPattern: "eng-*",
    targetWorkspace: "ws-eng", targetRole: "member", autoCreateWorkspace: true,
  });
  await createGroupSyncRule({
    name: "Ops", source: "ldap", groupPattern: "ops-*",
    targetWorkspace: "ws-ops", targetRole: "admin", autoCreateWorkspace: true,
  });

  const result = await syncUserGroups("alice", ["eng-backend", "ops-prod"], "ldap");
  assert.equal(result.added.length, 2);
  assert.equal(result.removed.length, 0);

  const engEntry = await _getWorkspaceMembersRaw("ws-eng");
  assert.ok(engEntry);
  assert.ok(engEntry.members.find((m) => m.userId === "alice" && m.role === "member"));
  const opsEntry = await _getWorkspaceMembersRaw("ws-ops");
  assert.ok(opsEntry.members.find((m) => m.userId === "alice" && m.role === "admin"));
});

test("syncUserGroups removes user when no longer matching", async () => {
  await createGroupSyncRule({
    name: "Eng", source: "ldap", groupPattern: "eng-*",
    targetWorkspace: "ws-eng-r", targetRole: "member", autoCreateWorkspace: true,
  });
  // First sync: user is in eng group
  await syncUserGroups("bob", ["eng-platform"], "ldap");
  let entry = await _getWorkspaceMembersRaw("ws-eng-r");
  assert.ok(entry.members.find((m) => m.userId === "bob"));

  // Second sync: user is no longer in eng group
  const result = await syncUserGroups("bob", ["marketing"], "ldap");
  assert.equal(result.removed.length, 1);
  assert.equal(result.removed[0].workspaceId, "ws-eng-r");
  entry = await _getWorkspaceMembersRaw("ws-eng-r");
  assert.equal(entry.members.find((m) => m.userId === "bob"), undefined);
});

test("syncUserGroups updates role when conflicting rules increase access", async () => {
  await createGroupSyncRule({
    name: "Viewer", source: "ldap", groupPattern: "team-x",
    targetWorkspace: "ws-conflict", targetRole: "viewer", autoCreateWorkspace: true,
  });
  // First sync as viewer only
  await syncUserGroups("carol", ["team-x"], "ldap");
  let entry = await _getWorkspaceMembersRaw("ws-conflict");
  assert.equal(entry.members.find((m) => m.userId === "carol").role, "viewer");

  // Add a rule that grants admin via a different group
  await createGroupSyncRule({
    name: "Admin", source: "ldap", groupPattern: "admins",
    targetWorkspace: "ws-conflict", targetRole: "admin", autoCreateWorkspace: true,
  });
  const result = await syncUserGroups("carol", ["team-x", "admins"], "ldap");
  assert.equal(result.added.length, 1);
  assert.equal(result.added[0].updated, true);
  assert.equal(result.added[0].role, "admin");
  entry = await _getWorkspaceMembersRaw("ws-conflict");
  assert.equal(entry.members.find((m) => m.userId === "carol").role, "admin");
});

test("syncUserGroups returns unchanged when nothing changed", async () => {
  await createGroupSyncRule({
    name: "Eng", source: "ldap", groupPattern: "eng-*",
    targetWorkspace: "ws-stable", targetRole: "member", autoCreateWorkspace: true,
  });
  await syncUserGroups("dave", ["eng-x"], "ldap");
  const result = await syncUserGroups("dave", ["eng-x"], "ldap");
  assert.equal(result.added.length, 0);
  assert.equal(result.removed.length, 0);
  assert.equal(result.unchanged.length, 1);
});

test("syncUserGroups only acts on rules from the matching source", async () => {
  await createGroupSyncRule({
    name: "Saml", source: "saml", groupPattern: "team-*",
    targetWorkspace: "ws-saml-only", targetRole: "member", autoCreateWorkspace: true,
  });
  await createGroupSyncRule({
    name: "Ldap", source: "ldap", groupPattern: "team-*",
    targetWorkspace: "ws-ldap-only", targetRole: "member", autoCreateWorkspace: true,
  });
  const r = await syncUserGroups("eve", ["team-a"], "saml");
  assert.equal(r.added.length, 1);
  assert.equal(r.added[0].workspaceId, "ws-saml-only");
});

test("syncUserGroups validates source", async () => {
  await assert.rejects(
    () => syncUserGroups("u", ["g"], "facebook"),
    /source must be one of/
  );
});

test("syncUserGroups requires userId", async () => {
  await assert.rejects(
    () => syncUserGroups("", ["g"], "ldap"),
    /userId is required/
  );
});

// ─── Audit logging ────────────────────────────────────────────────────────

test("setAuditSink captures sync events", async () => {
  const events = [];
  setAuditSink((entry) => events.push(entry));

  await createGroupSyncRule({
    name: "Eng", source: "ldap", groupPattern: "eng-*",
    targetWorkspace: "ws-audit", targetRole: "member", autoCreateWorkspace: true,
  });
  await syncUserGroups("frank", ["eng-team"], "ldap");

  const syncEvents = events.filter((e) => e.op === "sync-user");
  assert.ok(syncEvents.length >= 1);
  assert.equal(syncEvents[0].userId, "frank");
  assert.equal(syncEvents[0].source, "ldap");
  assert.equal(syncEvents[0].added, 1);
});

// ─── Full sync via provider ───────────────────────────────────────────────

test("runFullGroupSync iterates the provider and records history", async () => {
  await createGroupSyncRule({
    name: "Eng", source: "ldap", groupPattern: "eng-*",
    targetWorkspace: "ws-full", targetRole: "member", autoCreateWorkspace: true,
  });
  setFullSyncProvider(async (source) => {
    assert.equal(source, "ldap");
    return [
      { userId: "u1", groups: ["eng-a"] },
      { userId: "u2", groups: ["other"] },
      { userId: "u3", groups: ["eng-b"] },
    ];
  });

  const result = await runFullGroupSync("ldap");
  assert.equal(result.usersProcessed, 3);
  assert.equal(result.changes, 2); // u1 + u3 added
  assert.equal(result.errors.length, 0);

  const history = await getGroupSyncHistory();
  assert.ok(history.length >= 1);
  assert.equal(history[0].source, "ldap");
  assert.equal(history[0].usersProcessed, 3);
});

test("runFullGroupSync returns 0 users when no provider installed", async () => {
  const result = await runFullGroupSync("scim");
  assert.equal(result.usersProcessed, 0);
  assert.equal(result.changes, 0);
});

test("runFullGroupSync rejects unknown source", async () => {
  await assert.rejects(() => runFullGroupSync("github"), /source must be one of/);
});

test("getGroupSyncHistory filters by source and limit", async () => {
  setFullSyncProvider(async () => []);
  await runFullGroupSync("ldap");
  await runFullGroupSync("scim");
  await runFullGroupSync("ldap");

  const ldapHistory = await getGroupSyncHistory({ source: "ldap" });
  assert.ok(ldapHistory.length >= 2);
  assert.ok(ldapHistory.every((r) => r.source === "ldap"));

  const limited = await getGroupSyncHistory({ limit: 1 });
  assert.equal(limited.length, 1);
});
