/**
 * Tests for lib/collaboration.js — cursor tracking, typing indicators,
 * document locking, activity feed, and notification broadcast.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  createCollaborationSession,
  getCollaborationSession,
  getActiveCollaborators,
  getSessionCount,
} from "../lib/collaboration.js";

test("createCollaborationSession returns a session object", () => {
  const session = createCollaborationSession("test-ws-1");
  assert.ok(session);
  assert.equal(session.workspaceId, "test-ws-1");
  session.destroy();
});

test("createCollaborationSession returns same session for same workspace", () => {
  const s1 = createCollaborationSession("test-ws-2");
  const s2 = createCollaborationSession("test-ws-2");
  assert.strictEqual(s1, s2);
  s1.destroy();
});

test("getCollaborationSession returns null for unknown workspace", () => {
  const result = getCollaborationSession("nonexistent-ws");
  assert.equal(result, null);
});

// Cursor tracking

test("updateCursor and getCursors track cursor positions", () => {
  const session = createCollaborationSession("cursor-ws");
  session.updateCursor("alice", { documentId: "doc1", line: 10, column: 5 });
  session.updateCursor("bob", { documentId: "doc1", line: 20, column: 3 });

  const cursors = session.getCursors();
  assert.equal(cursors.length, 2);

  const alice = cursors.find((c) => c.userId === "alice");
  assert.ok(alice);
  assert.equal(alice.documentId, "doc1");
  assert.equal(alice.line, 10);
  assert.equal(alice.column, 5);

  const bob = cursors.find((c) => c.userId === "bob");
  assert.ok(bob);
  assert.equal(bob.line, 20);
  assert.equal(bob.column, 3);

  session.destroy();
});

test("updateCursor replaces previous cursor for same user", () => {
  const session = createCollaborationSession("cursor-replace-ws");
  session.updateCursor("alice", { documentId: "doc1", line: 1, column: 1 });
  session.updateCursor("alice", { documentId: "doc2", line: 5, column: 10 });

  const cursors = session.getCursors();
  assert.equal(cursors.length, 1);
  assert.equal(cursors[0].documentId, "doc2");
  assert.equal(cursors[0].line, 5);

  session.destroy();
});

test("updateCursor ignores null/undefined userId", () => {
  const session = createCollaborationSession("cursor-null-ws");
  session.updateCursor(null, { documentId: "doc1", line: 1, column: 1 });
  session.updateCursor(undefined, { documentId: "doc1", line: 1, column: 1 });
  assert.equal(session.getCursors().length, 0);
  session.destroy();
});

test("updateCursor broadcasts cursor_update event", () => {
  const session = createCollaborationSession("cursor-broadcast-ws");
  const messages = [];
  session.setBroadcast((msg, exclude) => messages.push({ msg, exclude }));

  session.updateCursor("alice", { documentId: "doc1", line: 3, column: 7 });

  assert.equal(messages.length, 1);
  assert.equal(messages[0].msg.type, "cursor_update");
  assert.equal(messages[0].msg.userId, "alice");
  assert.equal(messages[0].exclude, "alice");

  session.destroy();
});

// Typing indicators

test("setTyping and getTypingUsers track typing state", () => {
  const session = createCollaborationSession("typing-ws");
  session.setTyping("alice", true);
  session.setTyping("bob", true);

  const typing = session.getTypingUsers();
  assert.ok(typing.includes("alice"));
  assert.ok(typing.includes("bob"));

  session.setTyping("alice", false);
  const after = session.getTypingUsers();
  assert.ok(!after.includes("alice"));
  assert.ok(after.includes("bob"));

  session.destroy();
});

test("setTyping ignores null userId", () => {
  const session = createCollaborationSession("typing-null-ws");
  session.setTyping(null, true);
  assert.equal(session.getTypingUsers().length, 0);
  session.destroy();
});

test("setTyping broadcasts typing_indicator event", () => {
  const session = createCollaborationSession("typing-broadcast-ws");
  const messages = [];
  session.setBroadcast((msg, exclude) => messages.push({ msg, exclude }));

  session.setTyping("bob", true);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].msg.type, "typing_indicator");
  assert.equal(messages[0].msg.userId, "bob");
  assert.equal(messages[0].msg.typing, true);
  assert.equal(messages[0].exclude, "bob");

  session.destroy();
});

// Document locking

test("lockDocument and unlockDocument manage document locks", () => {
  const session = createCollaborationSession("lock-ws");

  const lockResult = session.lockDocument("alice", "doc1");
  assert.equal(lockResult.ok, true);

  const locked = session.getLockedDocuments();
  assert.equal(locked.length, 1);
  assert.equal(locked[0].docId, "doc1");
  assert.equal(locked[0].userId, "alice");

  const unlockResult = session.unlockDocument("alice", "doc1");
  assert.equal(unlockResult.ok, true);

  assert.equal(session.getLockedDocuments().length, 0);

  session.destroy();
});

test("lockDocument rejects lock by different user", () => {
  const session = createCollaborationSession("lock-conflict-ws");

  session.lockDocument("alice", "doc1");
  const result = session.lockDocument("bob", "doc1");

  assert.equal(result.ok, false);
  assert.ok(result.error.includes("alice"));

  session.destroy();
});

test("lockDocument allows same user to refresh lock", () => {
  const session = createCollaborationSession("lock-refresh-ws");

  session.lockDocument("alice", "doc1");
  const result = session.lockDocument("alice", "doc1");
  assert.equal(result.ok, true);

  session.destroy();
});

test("unlockDocument rejects unlock by non-owner", () => {
  const session = createCollaborationSession("unlock-reject-ws");

  session.lockDocument("alice", "doc1");
  const result = session.unlockDocument("bob", "doc1");

  assert.equal(result.ok, false);
  assert.ok(result.error.includes("alice"));

  session.destroy();
});

test("lockDocument requires userId and docId", () => {
  const session = createCollaborationSession("lock-validation-ws");

  assert.equal(session.lockDocument(null, "doc1").ok, false);
  assert.equal(session.lockDocument("alice", null).ok, false);
  assert.equal(session.unlockDocument(null, "doc1").ok, false);
  assert.equal(session.unlockDocument("alice", null).ok, false);

  session.destroy();
});

test("lockDocument broadcasts document_locked event", () => {
  const session = createCollaborationSession("lock-broadcast-ws");
  const messages = [];
  session.setBroadcast((msg) => messages.push(msg));

  session.lockDocument("alice", "doc1");

  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, "document_locked");
  assert.equal(messages[0].userId, "alice");
  assert.equal(messages[0].docId, "doc1");

  session.destroy();
});

test("unlockDocument broadcasts document_unlocked event", () => {
  const session = createCollaborationSession("unlock-broadcast-ws");
  const messages = [];
  session.setBroadcast((msg) => messages.push(msg));

  session.lockDocument("alice", "doc1");
  messages.length = 0; // clear the lock message

  session.unlockDocument("alice", "doc1");

  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, "document_unlocked");
  assert.equal(messages[0].userId, "alice");
  assert.equal(messages[0].docId, "doc1");

  session.destroy();
});

// Activity feed

test("recordActivity adds entries and getRecentActivity retrieves them", () => {
  const session = createCollaborationSession("activity-ws");

  session.recordActivity("alice", "created_document", { name: "doc1" });
  session.recordActivity("bob", "edited_document", { name: "doc2" });

  const recent = session.getRecentActivity(10);
  assert.equal(recent.length, 2);
  // Most recent first
  assert.equal(recent[0].userId, "bob");
  assert.equal(recent[0].action, "edited_document");
  assert.equal(recent[1].userId, "alice");
  assert.equal(recent[1].action, "created_document");

  session.destroy();
});

test("recordActivity returns entry with id and timestamp", () => {
  const session = createCollaborationSession("activity-entry-ws");

  const entry = session.recordActivity("alice", "joined_workspace", null);
  assert.ok(entry.id);
  assert.equal(entry.userId, "alice");
  assert.equal(entry.action, "joined_workspace");
  assert.ok(entry.timestamp);

  session.destroy();
});

test("getRecentActivity respects limit parameter", () => {
  const session = createCollaborationSession("activity-limit-ws");

  for (let i = 0; i < 10; i++) {
    session.recordActivity("user" + i, "action" + i, null);
  }

  const limited = session.getRecentActivity(3);
  assert.equal(limited.length, 3);

  session.destroy();
});

test("recordActivity broadcasts activity event", () => {
  const session = createCollaborationSession("activity-broadcast-ws");
  const messages = [];
  session.setBroadcast((msg) => messages.push(msg));

  session.recordActivity("alice", "uploaded_file", { filename: "test.txt" });

  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, "activity");
  assert.equal(messages[0].activity.userId, "alice");
  assert.equal(messages[0].activity.action, "uploaded_file");

  session.destroy();
});

// Notification broadcast

test("notifyMembers sends collaboration_notification via broadcast", () => {
  const session = createCollaborationSession("notify-ws");
  const messages = [];
  session.setBroadcast((msg, exclude) => messages.push({ msg, exclude }));

  session.notifyMembers({ title: "Hello", body: "World" }, "alice");

  assert.equal(messages.length, 1);
  assert.equal(messages[0].msg.type, "collaboration_notification");
  assert.equal(messages[0].msg.title, "Hello");
  assert.equal(messages[0].exclude, "alice");

  session.destroy();
});

test("notifyMembers does not throw without broadcast fn", () => {
  const session = createCollaborationSession("notify-no-broadcast-ws");
  assert.doesNotThrow(() => {
    session.notifyMembers({ title: "Test" });
  });
  session.destroy();
});

// User removal

test("removeUser cleans up cursors, typing, and locks", () => {
  const session = createCollaborationSession("remove-user-ws");

  session.updateCursor("alice", { documentId: "doc1", line: 1, column: 1 });
  session.setTyping("alice", true);
  session.lockDocument("alice", "doc1");

  session.removeUser("alice");

  assert.equal(session.getCursors().length, 0);
  assert.equal(session.getTypingUsers().length, 0);
  assert.equal(session.getLockedDocuments().length, 0);

  session.destroy();
});

test("removeUser broadcasts document_unlocked for user locks", () => {
  const session = createCollaborationSession("remove-unlock-ws");
  const messages = [];
  session.setBroadcast((msg) => messages.push(msg));

  session.lockDocument("alice", "doc1");
  messages.length = 0;

  session.removeUser("alice");

  const unlockMsg = messages.find((m) => m.type === "document_unlocked");
  assert.ok(unlockMsg);
  assert.equal(unlockMsg.docId, "doc1");

  session.destroy();
});

// getActiveCollaborators

test("getActiveCollaborators merges presence with collaboration state", () => {
  const session = createCollaborationSession("collab-merge-ws");
  session.updateCursor("alice", { documentId: "doc1", line: 5, column: 2 });
  session.setTyping("bob", true);

  const onlineUsers = [
    { userId: "alice", displayName: "Alice" },
    { userId: "bob", displayName: "Bob" },
    { userId: "charlie", displayName: "Charlie" },
  ];

  const collaborators = getActiveCollaborators("collab-merge-ws", onlineUsers);
  assert.equal(collaborators.length, 3);

  const alice = collaborators.find((c) => c.userId === "alice");
  assert.equal(alice.displayName, "Alice");
  assert.ok(alice.cursor);
  assert.equal(alice.cursor.line, 5);
  assert.equal(alice.typing, false);

  const bob = collaborators.find((c) => c.userId === "bob");
  assert.equal(bob.typing, true);
  assert.equal(bob.cursor, undefined);

  const charlie = collaborators.find((c) => c.userId === "charlie");
  assert.equal(charlie.typing, false);

  session.destroy();
});

test("getActiveCollaborators works without a session", () => {
  const collaborators = getActiveCollaborators("no-session-ws", [
    { userId: "alice", displayName: "Alice" },
  ]);
  assert.equal(collaborators.length, 1);
  assert.equal(collaborators[0].typing, false);
});

// Session lifecycle

test("destroy removes session from internal map", () => {
  const session = createCollaborationSession("destroy-ws");
  assert.ok(getCollaborationSession("destroy-ws"));

  session.destroy();
  assert.equal(getCollaborationSession("destroy-ws"), null);
});

test("getSessionCount returns active session count", () => {
  const before = getSessionCount();
  const s1 = createCollaborationSession("count-ws-1");
  const s2 = createCollaborationSession("count-ws-2");
  assert.equal(getSessionCount(), before + 2);

  s1.destroy();
  s2.destroy();
  assert.equal(getSessionCount(), before);
});
