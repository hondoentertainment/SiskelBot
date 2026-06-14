import test from "node:test";
import assert from "node:assert/strict";

test.before(() => {
  process.env.STORAGE_PATH = "/tmp/ws-lifecycle-test-" + Date.now();
});

await test("exportWorkspaceBundle returns bundle with expected keys", async () => {
  // We need to set up some mock storage; import storage first
  const storage = await import("../lib/storage.js");

  // Pre-populate storage for the test user/workspace
  const userId = "lifecycle-user";
  const workspaceId = "lifecycle-ws";

  // Create workspace
  try {
    await storage.createWorkspace(userId, workspaceId, "Lifecycle Test");
  } catch (_) {
    // May already exist
  }

  const { exportWorkspaceBundle } = await import("../lib/workspace-lifecycle.js");
  const bundle = await exportWorkspaceBundle(userId, workspaceId);

  assert.equal(bundle._version, 1);
  assert.ok(bundle.exportedAt);
  assert.equal(bundle.workspaceId, workspaceId);
  assert.equal(bundle.userId, userId);
  assert.ok(Array.isArray(bundle.context));
  assert.ok(Array.isArray(bundle.recipes));
  assert.ok(Array.isArray(bundle.conversations));
  assert.ok(bundle.agentSettings !== undefined);
});

await test("deleteWorkspaceForUser rejects deleting default workspace", async () => {
  const { deleteWorkspaceForUser } = await import("../lib/workspace-lifecycle.js");
  const result = await deleteWorkspaceForUser("anyuser", "default");
  assert.equal(result.ok, false);
  assert.ok(result.error.includes("default"));
});

await test("deleteWorkspaceForUser returns error for nonexistent workspace", async () => {
  const { deleteWorkspaceForUser } = await import("../lib/workspace-lifecycle.js");
  const result = await deleteWorkspaceForUser("nouser", "nonexistent-ws-12345");
  assert.equal(result.ok, false);
});
