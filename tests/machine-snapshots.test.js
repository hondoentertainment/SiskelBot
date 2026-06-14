import test from "node:test";
import assert from "node:assert/strict";
import { listSnapshots, getSnapshot } from "../lib/machine-snapshots.js";

// These tests only cover the non-docker read-only operations.
// Docker-dependent functions (createSnapshot, deleteSnapshot, restoreSnapshot)
// require a running Docker daemon and are not tested in unit context.

const ws = () => `test-ws-${Date.now()}-${Math.random().toString(36).slice(2)}`;

test("listSnapshots returns empty array for fresh workspace", async () => {
  const workspaceId = ws();
  const snapshots = await listSnapshots(workspaceId);
  assert.ok(Array.isArray(snapshots));
  assert.equal(snapshots.length, 0);
});

test("listSnapshots throws for missing workspaceId", async () => {
  await assert.rejects(() => listSnapshots(null), /workspaceId is required/i);
  await assert.rejects(() => listSnapshots(""), /workspaceId is required/i);
  await assert.rejects(() => listSnapshots(undefined), /workspaceId is required/i);
});

test("getSnapshot throws for missing workspaceId", async () => {
  await assert.rejects(() => getSnapshot(null, "snap-id"), /workspaceId is required/i);
});

test("getSnapshot throws for missing snapshotId", async () => {
  const workspaceId = ws();
  await assert.rejects(() => getSnapshot(workspaceId, null), /snapshotId is required/i);
  await assert.rejects(() => getSnapshot(workspaceId, ""), /snapshotId is required/i);
});

test("getSnapshot returns null for nonexistent snapshotId", async () => {
  const workspaceId = ws();
  const result = await getSnapshot(workspaceId, "no-such-snapshot");
  assert.equal(result, null);
});
