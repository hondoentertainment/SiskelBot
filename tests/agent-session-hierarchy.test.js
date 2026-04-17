/**
 * Tests for parent-child session hierarchy in lib/agent-session.js.
 *
 * Covers: createAgentSession with parentSessionId, depth tracking,
 * getSessionChildren, getSessionTree, getSessionAncestors, error cases,
 * and backward compatibility.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const dir = mkdtempSync(join(tmpdir(), "agent-sess-hierarchy-"));
const prev = process.env.STORAGE_PATH;
process.env.STORAGE_PATH = dir;

const {
  createAgentSession,
  getAgentSession,
  getSessionChildren,
  getSessionTree,
  getSessionAncestors,
} = await import("../lib/agent-session.js");

test.after(() => {
  if (prev === undefined) delete process.env.STORAGE_PATH;
  else process.env.STORAGE_PATH = prev;
  rmSync(dir, { recursive: true, force: true });
});

test("child session has correct depth and parent has childSessionIds", async () => {
  const root = await createAgentSession({
    workspace: "default",
    ownerStorageUserId: "user1",
    title: "root",
  });
  assert.equal(root.depth, 0);
  assert.equal(root.parentSessionId, null);
  assert.deepEqual(root.childSessionIds, []);

  const child = await createAgentSession({
    workspace: "default",
    ownerStorageUserId: "user1",
    title: "child",
    parentSessionId: root.id,
  });
  assert.equal(child.depth, 1);
  assert.equal(child.parentSessionId, root.id);
  assert.deepEqual(child.childSessionIds, []);

  // Re-read root to verify childSessionIds was updated
  const updatedRoot = await getAgentSession(root.id);
  assert.ok(updatedRoot.childSessionIds.includes(child.id));
});

test("getSessionChildren returns direct children only", async () => {
  const root = await createAgentSession({
    workspace: "default",
    ownerStorageUserId: "user1",
    title: "root-children",
  });
  const child1 = await createAgentSession({
    workspace: "default",
    ownerStorageUserId: "user1",
    title: "child-1",
    parentSessionId: root.id,
  });
  const child2 = await createAgentSession({
    workspace: "default",
    ownerStorageUserId: "user1",
    title: "child-2",
    parentSessionId: root.id,
  });
  // Grandchild should NOT appear
  await createAgentSession({
    workspace: "default",
    ownerStorageUserId: "user1",
    title: "grandchild",
    parentSessionId: child1.id,
  });

  const children = await getSessionChildren(root.id);
  assert.equal(children.length, 2);
  const ids = children.map((c) => c.id);
  assert.ok(ids.includes(child1.id));
  assert.ok(ids.includes(child2.id));
  // Check shape
  for (const c of children) {
    assert.ok("id" in c);
    assert.ok("title" in c);
    assert.ok("status" in c);
    assert.ok("depth" in c);
    assert.ok("createdAt" in c);
  }
});

test("getSessionTree builds recursive tree and caps at depth 5", async () => {
  // Build a chain: root -> c1 -> c2 -> c3
  const root = await createAgentSession({
    workspace: "default",
    ownerStorageUserId: "user1",
    title: "tree-root",
  });
  const c1 = await createAgentSession({
    workspace: "default",
    ownerStorageUserId: "user1",
    title: "tree-c1",
    parentSessionId: root.id,
  });
  const c2 = await createAgentSession({
    workspace: "default",
    ownerStorageUserId: "user1",
    title: "tree-c2",
    parentSessionId: c1.id,
  });
  const c3 = await createAgentSession({
    workspace: "default",
    ownerStorageUserId: "user1",
    title: "tree-c3",
    parentSessionId: c2.id,
  });

  const tree = await getSessionTree(root.id);
  assert.ok(tree);
  assert.equal(tree.id, root.id);
  assert.equal(tree.depth, 0);
  assert.equal(tree.children.length, 1);
  assert.equal(tree.children[0].id, c1.id);
  assert.equal(tree.children[0].depth, 1);
  assert.equal(tree.children[0].children.length, 1);
  assert.equal(tree.children[0].children[0].id, c2.id);
  assert.equal(tree.children[0].children[0].children.length, 1);
  assert.equal(tree.children[0].children[0].children[0].id, c3.id);
});

test("getSessionTree caps at depth 5", async () => {
  // Build a chain deeper than 5
  let parent = await createAgentSession({
    workspace: "default",
    ownerStorageUserId: "user1",
    title: "deep-root",
  });
  const ids = [parent.id];
  for (let i = 0; i < 7; i++) {
    parent = await createAgentSession({
      workspace: "default",
      ownerStorageUserId: "user1",
      title: `deep-${i}`,
      parentSessionId: parent.id,
    });
    ids.push(parent.id);
  }

  const tree = await getSessionTree(ids[0]);
  assert.ok(tree);

  // Walk to the deepest visible node
  let node = tree;
  let maxReachedDepth = 0;
  while (node.children && node.children.length > 0) {
    node = node.children[0];
    maxReachedDepth = node.depth;
  }
  // Tree should stop expanding at depth 5
  assert.ok(maxReachedDepth <= 5, `max depth was ${maxReachedDepth}`);
  // Node at depth 5 should have no children expanded
  assert.equal(node.children.length, 0);
});

test("getSessionAncestors returns correct path from root to current", async () => {
  const root = await createAgentSession({
    workspace: "default",
    ownerStorageUserId: "user1",
    title: "anc-root",
  });
  const mid = await createAgentSession({
    workspace: "default",
    ownerStorageUserId: "user1",
    title: "anc-mid",
    parentSessionId: root.id,
  });
  const leaf = await createAgentSession({
    workspace: "default",
    ownerStorageUserId: "user1",
    title: "anc-leaf",
    parentSessionId: mid.id,
  });

  const ancestors = await getSessionAncestors(leaf.id);
  assert.deepEqual(ancestors, [root.id, mid.id, leaf.id]);

  // Root session returns just itself
  const rootAnc = await getSessionAncestors(root.id);
  assert.deepEqual(rootAnc, [root.id]);
});

test("creating a child of a non-existent parent throws", async () => {
  await assert.rejects(
    () =>
      createAgentSession({
        workspace: "default",
        ownerStorageUserId: "user1",
        title: "orphan",
        parentSessionId: "nonexistent-id",
      }),
    (err) => {
      assert.equal(err.code, "PARENT_NOT_FOUND");
      return true;
    },
  );
});

test("parentSessionId=null creates root session (backward compat)", async () => {
  const s1 = await createAgentSession({
    workspace: "default",
    ownerStorageUserId: "user1",
    title: "compat-null",
    parentSessionId: null,
  });
  assert.equal(s1.parentSessionId, null);
  assert.equal(s1.depth, 0);
  assert.deepEqual(s1.childSessionIds, []);

  // Omitting parentSessionId entirely
  const s2 = await createAgentSession({
    workspace: "default",
    ownerStorageUserId: "user1",
    title: "compat-omit",
  });
  assert.equal(s2.parentSessionId, null);
  assert.equal(s2.depth, 0);
  assert.deepEqual(s2.childSessionIds, []);
});

test("getSessionChildren returns empty for unknown session", async () => {
  const result = await getSessionChildren("does-not-exist");
  assert.deepEqual(result, []);
});

test("getSessionTree returns null for unknown session", async () => {
  const result = await getSessionTree("does-not-exist");
  assert.equal(result, null);
});

test("getSessionAncestors returns empty for unknown session", async () => {
  const result = await getSessionAncestors("does-not-exist");
  assert.deepEqual(result, []);
});
