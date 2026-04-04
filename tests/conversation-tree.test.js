/**
 * Conversation branching & forking unit tests.
 * Uses temp directory via STORAGE_PATH to avoid polluting data/.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Set temp dir before importing modules
const tempDir = mkdtempSync(join(tmpdir(), "siskelbot-conv-tree-"));
process.env.STORAGE_PATH = tempDir;

import * as storage from "../lib/storage.js";
import {
  branchConversation,
  getConversationTree,
  listBranches,
  getBranch,
  deleteBranch,
} from "../lib/conversation-tree.js";

test.after(() => {
  try {
    rmSync(tempDir, { recursive: true });
  } catch (_) {}
});

// Helper: create a conversation with some messages
async function createConversation(id, messageCount = 5) {
  const messages = [];
  for (let i = 0; i < messageCount; i++) {
    messages.push({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Message ${i}`,
    });
  }
  const conv = {
    id,
    title: `Test conversation ${id}`,
    messages,
    createdAt: new Date().toISOString(),
    pinned: false,
    tags: ["test"],
  };
  await storage.add("conversations", conv, "default", false, "anonymous");
  return conv;
}

test("branchConversation creates a branch at a given message index", async () => {
  await createConversation("conv-1", 6);
  const branch = await branchConversation("conv-1", 2, "anonymous", {
    label: "Try alternative",
    workspace: "default",
  });

  assert.ok(branch.id, "branch should have an id");
  assert.equal(branch._isBranch, true);
  assert.equal(branch.parentConversationId, "conv-1");
  assert.equal(branch.branchPoint, 2);
  assert.equal(branch.label, "Try alternative");
  assert.equal(branch.messages.length, 3); // messages 0, 1, 2
  assert.deepStrictEqual(
    branch.messages.map((m) => m.content),
    ["Message 0", "Message 1", "Message 2"]
  );
  assert.ok(branch.createdAt);
});

test("branchConversation throws for invalid message index", async () => {
  await createConversation("conv-2", 4);

  await assert.rejects(
    () => branchConversation("conv-2", 10, "anonymous", { workspace: "default" }),
    { message: /Invalid branch point/ }
  );

  await assert.rejects(
    () => branchConversation("conv-2", -1, "anonymous", { workspace: "default" }),
    { message: /Invalid branch point/ }
  );
});

test("branchConversation throws for non-existent conversation", async () => {
  await assert.rejects(
    () => branchConversation("nonexistent-999", 0, "anonymous", { workspace: "default" }),
    { message: /not found/ }
  );
});

test("branchConversation at index 0 copies only first message", async () => {
  await createConversation("conv-3", 5);
  const branch = await branchConversation("conv-3", 0, "anonymous", { workspace: "default" });
  assert.equal(branch.messages.length, 1);
  assert.equal(branch.messages[0].content, "Message 0");
});

test("branchConversation at last index copies all messages", async () => {
  await createConversation("conv-4", 4);
  const branch = await branchConversation("conv-4", 3, "anonymous", { workspace: "default" });
  assert.equal(branch.messages.length, 4);
});

test("listBranches returns direct branches of a conversation", async () => {
  await createConversation("conv-5", 6);
  await branchConversation("conv-5", 1, "anonymous", { label: "Branch A", workspace: "default" });
  await branchConversation("conv-5", 3, "anonymous", { label: "Branch B", workspace: "default" });
  await branchConversation("conv-5", 5, "anonymous", { label: "Branch C", workspace: "default" });

  const branches = await listBranches("conv-5", "default", "anonymous");
  assert.equal(branches.length, 3);

  const labels = branches.map((b) => b.label).sort();
  assert.deepStrictEqual(labels, ["Branch A", "Branch B", "Branch C"]);

  // Each branch should have metadata fields
  for (const b of branches) {
    assert.equal(b.parentConversationId, "conv-5");
    assert.ok(typeof b.branchPoint === "number");
    assert.ok(typeof b.messageCount === "number");
    assert.ok(b.createdAt);
  }
});

test("getBranch returns a specific branch with full data", async () => {
  await createConversation("conv-6", 4);
  const created = await branchConversation("conv-6", 2, "anonymous", {
    label: "Detailed branch",
    workspace: "default",
  });

  const fetched = await getBranch(created.id, "default", "anonymous");
  assert.ok(fetched);
  assert.equal(fetched.id, created.id);
  assert.equal(fetched._isBranch, true);
  assert.equal(fetched.parentConversationId, "conv-6");
  assert.equal(fetched.messages.length, 3);
});

test("getBranch returns null for non-existent branch", async () => {
  const result = await getBranch("no-such-branch", "default", "anonymous");
  assert.equal(result, null);
});

test("getBranch returns null for a regular conversation (not a branch)", async () => {
  await createConversation("conv-7-regular", 3);
  const result = await getBranch("conv-7-regular", "default", "anonymous");
  assert.equal(result, null);
});

test("getConversationTree returns tree structure", async () => {
  await createConversation("conv-tree-root", 6);
  const b1 = await branchConversation("conv-tree-root", 2, "anonymous", {
    label: "Branch 1",
    workspace: "default",
  });
  await branchConversation("conv-tree-root", 4, "anonymous", {
    label: "Branch 2",
    workspace: "default",
  });
  // Create a sub-branch off Branch 1
  await branchConversation(b1.id, 1, "anonymous", {
    label: "Sub-branch 1a",
    workspace: "default",
  });

  const tree = await getConversationTree("conv-tree-root", "default", "anonymous");
  assert.ok(tree);
  assert.equal(tree.id, "conv-tree-root");
  assert.equal(tree.branches.length, 2);

  const branch1Node = tree.branches.find((b) => b.label === "Branch 1");
  assert.ok(branch1Node);
  assert.equal(branch1Node.branchPoint, 2);
  assert.equal(branch1Node.branches.length, 1);
  assert.equal(branch1Node.branches[0].label, "Sub-branch 1a");

  const branch2Node = tree.branches.find((b) => b.label === "Branch 2");
  assert.ok(branch2Node);
  assert.equal(branch2Node.branchPoint, 4);
  assert.equal(branch2Node.branches.length, 0);
});

test("getConversationTree returns null for non-existent root", async () => {
  const tree = await getConversationTree("nonexistent-tree", "default", "anonymous");
  assert.equal(tree, null);
});

test("deleteBranch removes a branch", async () => {
  await createConversation("conv-del-1", 4);
  const branch = await branchConversation("conv-del-1", 1, "anonymous", {
    label: "Delete me",
    workspace: "default",
  });

  const deleted = await deleteBranch(branch.id, "default", "anonymous");
  assert.equal(deleted, true);

  const fetched = await getBranch(branch.id, "default", "anonymous");
  assert.equal(fetched, null);
});

test("deleteBranch recursively deletes child branches", async () => {
  await createConversation("conv-del-2", 6);
  const parent = await branchConversation("conv-del-2", 2, "anonymous", {
    label: "Parent branch",
    workspace: "default",
  });
  const child = await branchConversation(parent.id, 1, "anonymous", {
    label: "Child branch",
    workspace: "default",
  });

  await deleteBranch(parent.id, "default", "anonymous");

  assert.equal(await getBranch(parent.id, "default", "anonymous"), null);
  assert.equal(await getBranch(child.id, "default", "anonymous"), null);
});

test("deleteBranch returns false for non-existent branch", async () => {
  const result = await deleteBranch("no-such-branch-del", "default", "anonymous");
  assert.equal(result, false);
});

test("branching at different points creates independent branches", async () => {
  await createConversation("conv-multi", 8);

  const b0 = await branchConversation("conv-multi", 0, "anonymous", { workspace: "default" });
  const b3 = await branchConversation("conv-multi", 3, "anonymous", { workspace: "default" });
  const b7 = await branchConversation("conv-multi", 7, "anonymous", { workspace: "default" });

  assert.equal(b0.messages.length, 1);
  assert.equal(b3.messages.length, 4);
  assert.equal(b7.messages.length, 8);

  // All are independent branches of the same parent
  const branches = await listBranches("conv-multi", "default", "anonymous");
  assert.equal(branches.length, 3);

  const points = branches.map((b) => b.branchPoint).sort((a, b) => a - b);
  assert.deepStrictEqual(points, [0, 3, 7]);
});
