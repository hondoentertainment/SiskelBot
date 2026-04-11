/**
 * Tests for lib/annotations.js — collaborative annotations: create/read/update/
 * delete, replies, reactions, resolve/unresolve, unread tracking, anchors, and
 * authorization.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  createAnnotation,
  getAnnotations,
  updateAnnotation,
  deleteAnnotation,
  replyToAnnotation,
  getReplies,
  addReaction,
  getReactions,
  resolveAnnotation,
  unresolveAnnotation,
  getUnreadAnnotations,
  markAnnotationsRead,
  getAnnotationThread,
  setBroadcaster,
} from "../lib/annotations.js";

const TEST_WS = "test-annot-ws-" + Date.now();
const ALICE = "user-alice-" + Date.now();
const BOB = "user-bob-" + Date.now();

// --- createAnnotation ---

test("createAnnotation creates an annotation on a message", async () => {
  const ann = await createAnnotation("message", "msg-1", {
    workspaceId: TEST_WS,
    userId: ALICE,
    text: "This response is great",
  });
  assert.ok(ann.id);
  assert.ok(ann.createdAt);
  assert.equal(ann.targetType, "message");
  assert.equal(ann.targetId, "msg-1");
  assert.equal(ann.userId, ALICE);
  assert.equal(ann.text, "This response is great");
  assert.equal(ann.parentId, null);
  assert.equal(ann.resolved, false);
});

test("createAnnotation supports anchor ranges", async () => {
  const ann = await createAnnotation("message", "msg-anchor", {
    workspaceId: TEST_WS,
    userId: ALICE,
    text: "this part",
    anchor: { start: 5, end: 12 },
  });
  assert.deepEqual(ann.anchor, { start: 5, end: 12 });
});

test("createAnnotation rejects invalid anchor (end < start)", async () => {
  const ann = await createAnnotation("message", "msg-anchor-bad", {
    workspaceId: TEST_WS,
    userId: ALICE,
    text: "x",
    anchor: { start: 10, end: 5 },
  });
  // Invalid anchor → null
  assert.equal(ann.anchor, null);
});

test("createAnnotation rejects empty text", async () => {
  await assert.rejects(
    () => createAnnotation("message", "m1", { workspaceId: TEST_WS, userId: ALICE, text: "" }),
    /text is required/
  );
});

test("createAnnotation rejects invalid targetType", async () => {
  await assert.rejects(
    () => createAnnotation("invalid", "m1", { workspaceId: TEST_WS, userId: ALICE, text: "hi" }),
    /targetType must be one of/
  );
});

test("createAnnotation rejects empty targetId", async () => {
  await assert.rejects(
    () => createAnnotation("message", "", { workspaceId: TEST_WS, userId: ALICE, text: "hi" }),
    /targetId is required/
  );
});

test("createAnnotation supports document, recipe, conversation targets", async () => {
  const docAnn = await createAnnotation("document", "doc-1", { workspaceId: TEST_WS, userId: ALICE, text: "doc note" });
  assert.equal(docAnn.targetType, "document");
  const recipeAnn = await createAnnotation("recipe", "rec-1", { workspaceId: TEST_WS, userId: ALICE, text: "recipe note" });
  assert.equal(recipeAnn.targetType, "recipe");
  const convAnn = await createAnnotation("conversation", "conv-1", { workspaceId: TEST_WS, userId: ALICE, text: "conv note" });
  assert.equal(convAnn.targetType, "conversation");
});

// --- getAnnotations ---

test("getAnnotations returns annotations for a target", async () => {
  const tid = "msg-list-" + Date.now();
  await createAnnotation("message", tid, { workspaceId: TEST_WS, userId: ALICE, text: "first" });
  await createAnnotation("message", tid, { workspaceId: TEST_WS, userId: BOB, text: "second" });
  const items = await getAnnotations("message", tid, { workspaceId: TEST_WS });
  assert.equal(items.length, 2);
  const texts = items.map((a) => a.text);
  assert.ok(texts.includes("first"));
  assert.ok(texts.includes("second"));
});

test("getAnnotations excludes other targets", async () => {
  const t1 = "msg-iso-1-" + Date.now();
  const t2 = "msg-iso-2-" + Date.now();
  await createAnnotation("message", t1, { workspaceId: TEST_WS, userId: ALICE, text: "in t1" });
  await createAnnotation("message", t2, { workspaceId: TEST_WS, userId: ALICE, text: "in t2" });
  const items = await getAnnotations("message", t1, { workspaceId: TEST_WS });
  assert.ok(items.every((a) => a.targetId === t1));
});

test("getAnnotations excludes resolved by default", async () => {
  const tid = "msg-resolved-" + Date.now();
  const ann = await createAnnotation("message", tid, { workspaceId: TEST_WS, userId: ALICE, text: "resolve me" });
  await resolveAnnotation(ann.id, ALICE, TEST_WS);
  const items = await getAnnotations("message", tid, { workspaceId: TEST_WS });
  assert.equal(items.length, 0);
  const withResolved = await getAnnotations("message", tid, { workspaceId: TEST_WS, includeResolved: true });
  assert.equal(withResolved.length, 1);
});

test("getAnnotations excludes deleted", async () => {
  const tid = "msg-deleted-" + Date.now();
  const ann = await createAnnotation("message", tid, { workspaceId: TEST_WS, userId: ALICE, text: "byebye" });
  await deleteAnnotation(ann.id, ALICE, TEST_WS);
  const items = await getAnnotations("message", tid, { workspaceId: TEST_WS });
  assert.equal(items.length, 0);
});

// --- updateAnnotation ---

test("updateAnnotation updates the text for the author", async () => {
  const ann = await createAnnotation("message", "msg-upd", {
    workspaceId: TEST_WS, userId: ALICE, text: "original",
  });
  const updated = await updateAnnotation(ann.id, "edited", ALICE, TEST_WS);
  assert.equal(updated.text, "edited");
  assert.notEqual(updated.updatedAt, ann.createdAt);
});

test("updateAnnotation rejects non-author", async () => {
  const ann = await createAnnotation("message", "msg-upd-auth", {
    workspaceId: TEST_WS, userId: ALICE, text: "original",
  });
  await assert.rejects(
    () => updateAnnotation(ann.id, "hacked", BOB, TEST_WS),
    /only the author can update/
  );
});

test("updateAnnotation rejects unknown id", async () => {
  await assert.rejects(
    () => updateAnnotation("nonexistent-id", "x", ALICE, TEST_WS),
    /annotation not found/
  );
});

test("updateAnnotation rejects empty text", async () => {
  const ann = await createAnnotation("message", "msg-upd-empty", {
    workspaceId: TEST_WS, userId: ALICE, text: "original",
  });
  await assert.rejects(
    () => updateAnnotation(ann.id, "", ALICE, TEST_WS),
    /text is required/
  );
});

// --- deleteAnnotation ---

test("deleteAnnotation removes annotation for the author", async () => {
  const tid = "msg-del-" + Date.now();
  const ann = await createAnnotation("message", tid, {
    workspaceId: TEST_WS, userId: ALICE, text: "doomed",
  });
  const result = await deleteAnnotation(ann.id, ALICE, TEST_WS);
  assert.equal(result.ok, true);
  const items = await getAnnotations("message", tid, { workspaceId: TEST_WS });
  assert.equal(items.length, 0);
});

test("deleteAnnotation rejects non-author", async () => {
  const ann = await createAnnotation("message", "msg-del-auth", {
    workspaceId: TEST_WS, userId: ALICE, text: "x",
  });
  await assert.rejects(
    () => deleteAnnotation(ann.id, BOB, TEST_WS),
    /only the author can delete/
  );
});

test("deleteAnnotation rejects unknown id", async () => {
  await assert.rejects(
    () => deleteAnnotation("nonexistent-id-del", ALICE, TEST_WS),
    /annotation not found/
  );
});

// --- reply threading ---

test("replyToAnnotation creates a reply tied to the parent", async () => {
  const parent = await createAnnotation("message", "msg-thread", {
    workspaceId: TEST_WS, userId: ALICE, text: "parent comment",
  });
  const reply = await replyToAnnotation(parent.id, {
    workspaceId: TEST_WS, text: "reply text",
  }, BOB);
  assert.equal(reply.parentId, parent.id);
  assert.equal(reply.userId, BOB);
  assert.equal(reply.targetType, "message");
  assert.equal(reply.targetId, "msg-thread");
});

test("getReplies returns replies for a parent", async () => {
  const parent = await createAnnotation("message", "msg-replies", {
    workspaceId: TEST_WS, userId: ALICE, text: "parent",
  });
  await replyToAnnotation(parent.id, { workspaceId: TEST_WS, text: "r1" }, BOB);
  await replyToAnnotation(parent.id, { workspaceId: TEST_WS, text: "r2" }, ALICE);
  const replies = await getReplies(parent.id, TEST_WS);
  assert.equal(replies.length, 2);
  assert.ok(replies.every((r) => r.parentId === parent.id));
});

test("replyToAnnotation rejects unknown parent", async () => {
  await assert.rejects(
    () => replyToAnnotation("nonexistent-parent", { workspaceId: TEST_WS, text: "reply" }, BOB),
    /parent annotation not found/
  );
});

test("getAnnotations with includeReplies=false hides replies", async () => {
  const tid = "msg-replyfilter-" + Date.now();
  const parent = await createAnnotation("message", tid, {
    workspaceId: TEST_WS, userId: ALICE, text: "p",
  });
  await replyToAnnotation(parent.id, { workspaceId: TEST_WS, text: "r" }, BOB);
  const all = await getAnnotations("message", tid, { workspaceId: TEST_WS, includeReplies: true });
  const onlyRoots = await getAnnotations("message", tid, { workspaceId: TEST_WS, includeReplies: false });
  assert.equal(all.length, 2);
  assert.equal(onlyRoots.length, 1);
  assert.equal(onlyRoots[0].parentId, null);
});

// --- reactions ---

test("addReaction adds a reaction emoji", async () => {
  const ann = await createAnnotation("message", "msg-react", {
    workspaceId: TEST_WS, userId: ALICE, text: "react to me",
  });
  const result = await addReaction(ann.id, "👍", BOB, TEST_WS);
  assert.deepEqual(result.reactions["👍"], [BOB]);
});

test("addReaction toggles off when same user reacts again", async () => {
  const ann = await createAnnotation("message", "msg-react-toggle", {
    workspaceId: TEST_WS, userId: ALICE, text: "x",
  });
  await addReaction(ann.id, "❤️", BOB, TEST_WS);
  const result = await addReaction(ann.id, "❤️", BOB, TEST_WS);
  assert.equal(result.reactions["❤️"], undefined);
});

test("addReaction supports multiple users for same emoji", async () => {
  const ann = await createAnnotation("message", "msg-react-multi", {
    workspaceId: TEST_WS, userId: ALICE, text: "x",
  });
  await addReaction(ann.id, "🎉", ALICE, TEST_WS);
  await addReaction(ann.id, "🎉", BOB, TEST_WS);
  const reactions = await getReactions(ann.id, TEST_WS);
  assert.equal(reactions["🎉"].length, 2);
  assert.ok(reactions["🎉"].includes(ALICE));
  assert.ok(reactions["🎉"].includes(BOB));
});

test("addReaction rejects empty emoji", async () => {
  const ann = await createAnnotation("message", "msg-react-empty", {
    workspaceId: TEST_WS, userId: ALICE, text: "x",
  });
  await assert.rejects(
    () => addReaction(ann.id, "", BOB, TEST_WS),
    /emoji is required/
  );
});

test("addReaction rejects unknown annotation", async () => {
  await assert.rejects(
    () => addReaction("nonexistent-react", "👍", BOB, TEST_WS),
    /annotation not found/
  );
});

test("getReactions returns empty for unknown annotation", async () => {
  const reactions = await getReactions("nonexistent-getreact", TEST_WS);
  assert.deepEqual(reactions, {});
});

// --- resolve / unresolve ---

test("resolveAnnotation marks an annotation as resolved", async () => {
  const ann = await createAnnotation("message", "msg-res", {
    workspaceId: TEST_WS, userId: ALICE, text: "resolve me",
  });
  const resolved = await resolveAnnotation(ann.id, BOB, TEST_WS);
  assert.equal(resolved.resolved, true);
  assert.equal(resolved.resolvedBy, BOB);
  assert.ok(resolved.resolvedAt);
});

test("unresolveAnnotation reverses resolution", async () => {
  const ann = await createAnnotation("message", "msg-unres", {
    workspaceId: TEST_WS, userId: ALICE, text: "x",
  });
  await resolveAnnotation(ann.id, BOB, TEST_WS);
  const unresolved = await unresolveAnnotation(ann.id, BOB, TEST_WS);
  assert.equal(unresolved.resolved, false);
  assert.equal(unresolved.resolvedBy, null);
  assert.equal(unresolved.resolvedAt, null);
});

test("resolveAnnotation rejects unknown annotation", async () => {
  await assert.rejects(
    () => resolveAnnotation("nonexistent-res", ALICE, TEST_WS),
    /annotation not found/
  );
});

// --- unread tracking ---

test("getUnreadAnnotations returns annotations user has not read", async () => {
  const tid = "msg-unread-" + Date.now();
  const ann = await createAnnotation("message", tid, {
    workspaceId: TEST_WS, userId: ALICE, text: "Bob hasn't seen this",
  });
  const unread = await getUnreadAnnotations(BOB, TEST_WS);
  assert.ok(unread.some((a) => a.id === ann.id));
});

test("getUnreadAnnotations excludes own annotations", async () => {
  const tid = "msg-unread-own-" + Date.now();
  const ann = await createAnnotation("message", tid, {
    workspaceId: TEST_WS, userId: ALICE, text: "Alice's own",
  });
  const unread = await getUnreadAnnotations(ALICE, TEST_WS);
  assert.ok(!unread.some((a) => a.id === ann.id));
});

test("markAnnotationsRead clears unread state", async () => {
  const tid = "msg-mark-read-" + Date.now();
  const ann = await createAnnotation("message", tid, {
    workspaceId: TEST_WS, userId: ALICE, text: "mark as read test",
  });
  let unread = await getUnreadAnnotations(BOB, TEST_WS);
  assert.ok(unread.some((a) => a.id === ann.id));
  const result = await markAnnotationsRead(BOB, [ann.id], TEST_WS);
  assert.equal(result.ok, true);
  assert.equal(result.count, 1);
  unread = await getUnreadAnnotations(BOB, TEST_WS);
  assert.ok(!unread.some((a) => a.id === ann.id));
});

test("markAnnotationsRead with empty list returns count 0", async () => {
  const result = await markAnnotationsRead(BOB, [], TEST_WS);
  assert.equal(result.count, 0);
});

test("markAnnotationsRead is idempotent for already-read annotation", async () => {
  const tid = "msg-mark-idempotent-" + Date.now();
  const ann = await createAnnotation("message", tid, {
    workspaceId: TEST_WS, userId: ALICE, text: "x",
  });
  await markAnnotationsRead(BOB, [ann.id], TEST_WS);
  const second = await markAnnotationsRead(BOB, [ann.id], TEST_WS);
  assert.equal(second.count, 0);
});

// --- thread retrieval ---

test("getAnnotationThread returns annotation + replies", async () => {
  const parent = await createAnnotation("message", "msg-thr", {
    workspaceId: TEST_WS, userId: ALICE, text: "thread parent",
  });
  await replyToAnnotation(parent.id, { workspaceId: TEST_WS, text: "r1" }, BOB);
  await replyToAnnotation(parent.id, { workspaceId: TEST_WS, text: "r2" }, ALICE);
  const thread = await getAnnotationThread(parent.id, TEST_WS);
  assert.ok(thread);
  assert.equal(thread.annotation.id, parent.id);
  assert.equal(thread.replies.length, 2);
});

test("getAnnotationThread returns root when given a reply id", async () => {
  const parent = await createAnnotation("message", "msg-thr-walk", {
    workspaceId: TEST_WS, userId: ALICE, text: "p",
  });
  const reply = await replyToAnnotation(parent.id, { workspaceId: TEST_WS, text: "r" }, BOB);
  const thread = await getAnnotationThread(reply.id, TEST_WS);
  assert.ok(thread);
  assert.equal(thread.annotation.id, parent.id);
  assert.ok(thread.replies.some((r) => r.id === reply.id));
});

test("getAnnotationThread returns null for unknown id", async () => {
  const thread = await getAnnotationThread("nonexistent-thread-id", TEST_WS);
  assert.equal(thread, null);
});

// --- broadcaster integration ---

test("setBroadcaster receives annotation_created events", async () => {
  const events = [];
  setBroadcaster((wsId, message) => {
    events.push({ wsId, message });
  });
  await createAnnotation("message", "msg-broadcast", {
    workspaceId: TEST_WS, userId: ALICE, text: "hello broadcast",
  });
  assert.ok(events.some((e) => e.message.type === "annotation_created"));
  setBroadcaster(null);
});

test("setBroadcaster receives annotation_reaction events", async () => {
  const events = [];
  const ann = await createAnnotation("message", "msg-broadcast-react", {
    workspaceId: TEST_WS, userId: ALICE, text: "react test",
  });
  setBroadcaster((wsId, message) => {
    events.push({ wsId, message });
  });
  await addReaction(ann.id, "👍", BOB, TEST_WS);
  assert.ok(events.some((e) => e.message.type === "annotation_reaction"));
  setBroadcaster(null);
});

test("setBroadcaster receives annotation_deleted events", async () => {
  const ann = await createAnnotation("message", "msg-broadcast-del", {
    workspaceId: TEST_WS, userId: ALICE, text: "x",
  });
  const events = [];
  setBroadcaster((wsId, message) => events.push(message));
  await deleteAnnotation(ann.id, ALICE, TEST_WS);
  assert.ok(events.some((m) => m.type === "annotation_deleted"));
  setBroadcaster(null);
});
