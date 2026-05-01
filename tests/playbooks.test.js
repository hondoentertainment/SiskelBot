import test from "node:test";
import assert from "node:assert/strict";
import {
  createPlaybook,
  getPlaybook,
  updatePlaybook,
  deletePlaybook,
  listPlaybooks,
  publishToGallery,
  listGallery,
  incrementUsage,
} from "../lib/playbooks.js";

const ws = () => `test-ws-${Date.now()}-${Math.random().toString(36).slice(2)}`;

test("createPlaybook creates a playbook with required fields", async () => {
  const workspaceId = ws();
  const pb = await createPlaybook(workspaceId, { name: "My Playbook", description: "desc", tags: ["tag1"] });
  assert.ok(pb.playbookId);
  assert.equal(pb.name, "My Playbook");
  assert.equal(pb.description, "desc");
  assert.deepEqual(pb.tags, ["tag1"]);
  assert.equal(pb.workspaceId, workspaceId);
  assert.equal(pb.usageCount, 0);
});

test("createPlaybook throws if name is missing", async () => {
  const workspaceId = ws();
  await assert.rejects(() => createPlaybook(workspaceId, { description: "no name" }), /name is required/i);
});

test("getPlaybook retrieves a playbook by id", async () => {
  const workspaceId = ws();
  const pb = await createPlaybook(workspaceId, { name: "To Get" });
  const fetched = await getPlaybook(workspaceId, pb.playbookId);
  assert.equal(fetched.playbookId, pb.playbookId);
  assert.equal(fetched.name, "To Get");
});

test("getPlaybook returns null for unknown id", async () => {
  const workspaceId = ws();
  const result = await getPlaybook(workspaceId, "nonexistent-id");
  assert.equal(result, null);
});

test("updatePlaybook updates fields", async () => {
  const workspaceId = ws();
  const pb = await createPlaybook(workspaceId, { name: "Old Name" });
  const updated = await updatePlaybook(workspaceId, pb.playbookId, { name: "New Name", description: "updated desc" });
  assert.equal(updated.name, "New Name");
  assert.equal(updated.description, "updated desc");
});

test("updatePlaybook throws for unknown id", async () => {
  const workspaceId = ws();
  await assert.rejects(() => updatePlaybook(workspaceId, "fake-id", { name: "X" }), /not found/i);
});

test("deletePlaybook removes a playbook", async () => {
  const workspaceId = ws();
  const pb = await createPlaybook(workspaceId, { name: "To Delete" });
  const del = await deletePlaybook(workspaceId, pb.playbookId);
  assert.equal(del.deleted, true);
  const fetched = await getPlaybook(workspaceId, pb.playbookId);
  assert.equal(fetched, null);
});

test("deletePlaybook throws for unknown id", async () => {
  const workspaceId = ws();
  await assert.rejects(() => deletePlaybook(workspaceId, "no-such-id"), /not found/i);
});

test("listPlaybooks returns all playbooks in workspace", async () => {
  const workspaceId = ws();
  await createPlaybook(workspaceId, { name: "PB1" });
  await createPlaybook(workspaceId, { name: "PB2" });
  const list = await listPlaybooks(workspaceId);
  assert.ok(list.length >= 2);
});

test("publishToGallery adds to gallery", async () => {
  const workspaceId = ws();
  const pb = await createPlaybook(workspaceId, { name: "Gallery PB", isPublic: true });
  const published = await publishToGallery(workspaceId, pb.playbookId);
  assert.ok(published.playbookId);
  const gallery = await listGallery();
  assert.ok(gallery.some((g) => g.playbookId === pb.playbookId));
});

test("publishToGallery throws for unknown playbook", async () => {
  const workspaceId = ws();
  await assert.rejects(() => publishToGallery(workspaceId, "fake-id"), /not found/i);
});

test("incrementUsage increments the usage count", async () => {
  const workspaceId = ws();
  const pb = await createPlaybook(workspaceId, { name: "Usage Test" });
  assert.equal(pb.usageCount, 0);
  await incrementUsage(pb.playbookId, workspaceId);
  const updated = await getPlaybook(workspaceId, pb.playbookId);
  assert.equal(updated.usageCount, 1);
});
