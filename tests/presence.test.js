/**
 * Tests for lib/presence.js — session join/leave, cursor updates, status
 * changes, workspace filtering, stale cleanup, avatar color determinism,
 * and initials extraction.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  createPresenceManager,
  globalPresence,
  getAvatarColor,
  getInitials,
} from "../lib/presence.js";

// Session join / leave

test("joinSession registers a session entry", () => {
  const mgr = createPresenceManager();
  const entry = mgr.joinSession("s1", "alice", "ws1", { displayName: "Alice" });
  assert.ok(entry);
  assert.equal(entry.sessionId, "s1");
  assert.equal(entry.userId, "alice");
  assert.equal(entry.workspace, "ws1");
  assert.equal(entry.status, "active");
  assert.equal(entry.cursor, null);
  assert.equal(entry.metadata.displayName, "Alice");
  assert.equal(mgr.sessionCount(), 1);
});

test("joinSession sanitizes empty userId and workspace", () => {
  const mgr = createPresenceManager();
  const entry = mgr.joinSession("s1", "", "");
  assert.equal(entry.userId, "anonymous");
  assert.equal(entry.workspace, "default");
});

test("joinSession rejects empty sessionId", () => {
  const mgr = createPresenceManager();
  assert.equal(mgr.joinSession("", "alice", "ws1"), null);
  assert.equal(mgr.joinSession(null, "alice", "ws1"), null);
  assert.equal(mgr.sessionCount(), 0);
});

test("leaveSession removes a session", () => {
  const mgr = createPresenceManager();
  mgr.joinSession("s1", "alice", "ws1");
  assert.equal(mgr.leaveSession("s1"), true);
  assert.equal(mgr.sessionCount(), 0);
  assert.equal(mgr.leaveSession("s1"), false);
});

// Cursor updates

test("updateCursor stores position on the session", () => {
  const mgr = createPresenceManager();
  mgr.joinSession("s1", "alice", "ws1");
  const cursor = mgr.updateCursor("s1", { line: 10, column: 5, documentId: "doc1" });
  assert.ok(cursor);
  assert.equal(cursor.line, 10);
  assert.equal(cursor.column, 5);
  assert.equal(cursor.documentId, "doc1");

  const session = mgr.getSession("s1");
  assert.equal(session.cursor.line, 10);
});

test("updateCursor returns null for unknown session", () => {
  const mgr = createPresenceManager();
  const result = mgr.updateCursor("nope", { line: 1, column: 1, documentId: "d" });
  assert.equal(result, null);
});

test("updateCursor handles missing fields gracefully", () => {
  const mgr = createPresenceManager();
  mgr.joinSession("s1", "alice", "ws1");
  const cursor = mgr.updateCursor("s1", {});
  assert.equal(cursor.line, 0);
  assert.equal(cursor.column, 0);
  assert.equal(cursor.documentId, null);
});

// Status changes

test("updateStatus accepts valid statuses", () => {
  const mgr = createPresenceManager();
  mgr.joinSession("s1", "alice", "ws1");
  assert.equal(mgr.updateStatus("s1", "idle"), "idle");
  assert.equal(mgr.updateStatus("s1", "away"), "away");
  assert.equal(mgr.updateStatus("s1", "active"), "active");
});

test("updateStatus rejects invalid status", () => {
  const mgr = createPresenceManager();
  mgr.joinSession("s1", "alice", "ws1");
  assert.equal(mgr.updateStatus("s1", "bogus"), null);
  // Original status preserved
  assert.equal(mgr.getSession("s1").status, "active");
});

test("updateStatus returns null for unknown session", () => {
  const mgr = createPresenceManager();
  assert.equal(mgr.updateStatus("nope", "idle"), null);
});

// Workspace filtering

test("getPresence returns sessions for a workspace only", () => {
  const mgr = createPresenceManager();
  mgr.joinSession("s1", "alice", "ws1");
  mgr.joinSession("s2", "bob", "ws1");
  mgr.joinSession("s3", "carol", "ws2");

  const ws1 = mgr.getPresence("ws1");
  assert.equal(ws1.length, 2);
  const userIds = ws1.map((s) => s.userId).sort();
  assert.deepEqual(userIds, ["alice", "bob"]);

  const ws2 = mgr.getPresence("ws2");
  assert.equal(ws2.length, 1);
  assert.equal(ws2[0].userId, "carol");
});

test("getUserSessions returns sessions across workspaces", () => {
  const mgr = createPresenceManager();
  mgr.joinSession("s1", "alice", "ws1");
  mgr.joinSession("s2", "alice", "ws2");
  mgr.joinSession("s3", "bob", "ws1");

  const aliceSessions = mgr.getUserSessions("alice");
  assert.equal(aliceSessions.length, 2);
  const workspaces = aliceSessions.map((s) => s.workspace).sort();
  assert.deepEqual(workspaces, ["ws1", "ws2"]);

  const bobSessions = mgr.getUserSessions("bob");
  assert.equal(bobSessions.length, 1);
});

// Stale session cleanup

test("cleanup removes sessions older than the stale threshold", () => {
  const mgr = createPresenceManager();
  mgr.joinSession("s1", "alice", "ws1");
  mgr.joinSession("s2", "bob", "ws1");

  // Manually backdate one session to simulate staleness
  const stale = mgr.getSession("s1");
  stale.lastSeen = Date.now() - 120_000; // 2 minutes ago

  const removed = mgr.cleanup();
  assert.equal(removed, 1);
  assert.equal(mgr.sessionCount(), 1);
  assert.equal(mgr.getSession("s1"), null);
  assert.ok(mgr.getSession("s2"));
});

test("getPresence omits stale sessions even before cleanup", () => {
  const mgr = createPresenceManager();
  mgr.joinSession("s1", "alice", "ws1");
  const stale = mgr.getSession("s1");
  stale.lastSeen = Date.now() - 120_000;

  const result = mgr.getPresence("ws1");
  assert.equal(result.length, 0);
});

test("startCleanupTimer / stopCleanupTimer can be called safely", () => {
  const mgr = createPresenceManager();
  const timer = mgr.startCleanupTimer(50);
  assert.ok(timer);
  // Replacing timer should not throw
  mgr.startCleanupTimer(100);
  mgr.stopCleanupTimer();
  // Calling stop again should also be safe
  mgr.stopCleanupTimer();
});

// Avatar color determinism

test("getAvatarColor is deterministic for the same userId", () => {
  assert.equal(getAvatarColor("alice"), getAvatarColor("alice"));
  assert.equal(getAvatarColor("bob"), getAvatarColor("bob"));
});

test("getAvatarColor returns an HSL string", () => {
  const color = getAvatarColor("alice");
  assert.match(color, /^hsl\(\d+, 65%, 50%\)$/);
});

test("getAvatarColor returns different colors for different ids", () => {
  // Not strictly required, but very likely for these inputs.
  const colors = new Set([
    getAvatarColor("alice"),
    getAvatarColor("bob"),
    getAvatarColor("charlie"),
    getAvatarColor("dave"),
  ]);
  assert.ok(colors.size >= 2, "expected at least 2 distinct colors");
});

test("getAvatarColor handles empty / missing input", () => {
  const a = getAvatarColor("");
  const b = getAvatarColor(null);
  const c = getAvatarColor(undefined);
  assert.match(a, /^hsl\(/);
  assert.equal(a, b);
  assert.equal(b, c);
});

// Initials extraction

test("getInitials extracts up to two initials from a full name", () => {
  assert.equal(getInitials("Alice Smith"), "AS");
  assert.equal(getInitials("alice smith"), "AS");
  assert.equal(getInitials("Alice Bob Smith"), "AS");
});

test("getInitials handles single-word names", () => {
  assert.equal(getInitials("Alice"), "AL");
  assert.equal(getInitials("a"), "A");
});

test("getInitials handles empty / invalid input", () => {
  assert.equal(getInitials(""), "?");
  assert.equal(getInitials("   "), "?");
  assert.equal(getInitials(null), "?");
  assert.equal(getInitials(undefined), "?");
  assert.equal(getInitials(42), "?");
});

// Singleton sanity

test("globalPresence is a presence manager instance", () => {
  assert.equal(typeof globalPresence.joinSession, "function");
  assert.equal(typeof globalPresence.getPresence, "function");
  globalPresence.joinSession("test-global-1", "tester", "test-ws");
  const presence = globalPresence.getPresence("test-ws");
  assert.ok(presence.find((s) => s.sessionId === "test-global-1"));
  globalPresence.leaveSession("test-global-1");
});
