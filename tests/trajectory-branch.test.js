/**
 * Unit tests for lib/trajectory-branch.js — branchFromCheckpoint and listBranches.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const dir = mkdtempSync(join(tmpdir(), "traj-branch-"));
const prev = process.env.STORAGE_PATH;
process.env.STORAGE_PATH = dir;

const { branchFromCheckpoint, listBranches } = await import("../lib/trajectory-branch.js");
const { createAgentSession, getAgentSession } = await import("../lib/agent-session.js");
const { saveCheckpoint, loadCheckpoint } = await import("../lib/agent-checkpoint.js");

test.after(() => {
  if (prev === undefined) delete process.env.STORAGE_PATH;
  else process.env.STORAGE_PATH = prev;
  rmSync(dir, { recursive: true, force: true });
});

test("branchFromCheckpoint creates child session and copies checkpoint", async () => {
  const parent = await createAgentSession({
    workspace: "default",
    ownerStorageUserId: "user1",
    title: "Parent run",
  });
  await saveCheckpoint(parent.id, {
    sessionId: parent.id,
    iteration: 3,
    messages: [{ role: "user", content: "hello" }],
    runId: "run-1",
    model: "gpt-4",
    timestamp: Date.now(),
  });

  const result = await branchFromCheckpoint({
    sessionId: parent.id,
    workspace: "default",
    userId: "user1",
  });

  assert.ok(result.branchSessionId);
  assert.equal(result.iteration, 3);
  assert.ok(result.checkpoint);
  assert.equal(result.checkpoint.sessionId, result.branchSessionId);
  assert.deepEqual(result.checkpoint.messages, [{ role: "user", content: "hello" }]);

  // Child session should exist and reference parent
  const child = await getAgentSession(result.branchSessionId);
  assert.ok(child);
  assert.equal(child.parentSessionId, parent.id);
  assert.equal(child.title, "Branch from iteration 3");

  // Checkpoint should be saved under the new session id
  const cp = await loadCheckpoint(result.branchSessionId);
  assert.ok(cp);
  assert.equal(cp.sessionId, result.branchSessionId);
  assert.equal(cp.iteration, 3);
});

test("branchFromCheckpoint with matching iteration succeeds", async () => {
  const parent = await createAgentSession({
    workspace: "default",
    ownerStorageUserId: "user1",
    title: "Parent 2",
  });
  await saveCheckpoint(parent.id, {
    sessionId: parent.id,
    iteration: 5,
    messages: [],
    runId: "run-2",
    model: "gpt-4",
    timestamp: Date.now(),
  });

  const result = await branchFromCheckpoint({
    sessionId: parent.id,
    iteration: 5,
    workspace: "default",
    userId: "user1",
  });

  assert.equal(result.iteration, 5);
  assert.ok(result.branchSessionId);
});

test("branchFromCheckpoint rejects mismatched iteration", async () => {
  const parent = await createAgentSession({
    workspace: "default",
    ownerStorageUserId: "user1",
    title: "Parent 3",
  });
  await saveCheckpoint(parent.id, {
    sessionId: parent.id,
    iteration: 7,
    messages: [],
    runId: "run-3",
    model: "gpt-4",
    timestamp: Date.now(),
  });

  await assert.rejects(
    () =>
      branchFromCheckpoint({
        sessionId: parent.id,
        iteration: 4,
        workspace: "default",
        userId: "user1",
      }),
    (err) => {
      assert.equal(err.code, "ITERATION_MISMATCH");
      return true;
    },
  );
});

test("branchFromCheckpoint throws when no checkpoint exists", async () => {
  const parent = await createAgentSession({
    workspace: "default",
    ownerStorageUserId: "user1",
    title: "No checkpoint",
  });

  await assert.rejects(
    () =>
      branchFromCheckpoint({
        sessionId: parent.id,
        workspace: "default",
        userId: "user1",
      }),
    (err) => {
      assert.equal(err.code, "CHECKPOINT_NOT_FOUND");
      return true;
    },
  );
});

test("branchFromCheckpoint throws on empty sessionId", async () => {
  await assert.rejects(
    () =>
      branchFromCheckpoint({
        sessionId: "",
        workspace: "default",
        userId: "user1",
      }),
    (err) => {
      assert.equal(err.code, "INVALID_SESSION_ID");
      return true;
    },
  );
});

test("listBranches returns branches created via branchFromCheckpoint", async () => {
  const parent = await createAgentSession({
    workspace: "default",
    ownerStorageUserId: "user1",
    title: "Parent list test",
  });
  await saveCheckpoint(parent.id, {
    sessionId: parent.id,
    iteration: 2,
    messages: [],
    runId: "run-list",
    model: "gpt-4",
    timestamp: Date.now(),
  });

  await branchFromCheckpoint({
    sessionId: parent.id,
    workspace: "default",
    userId: "user1",
  });

  const branches = await listBranches(parent.id);
  assert.ok(Array.isArray(branches));
  assert.ok(branches.length >= 1);

  const b = branches[0];
  assert.ok(b.branchSessionId);
  assert.equal(b.branchedAtIteration, 2);
  assert.ok(b.createdAt);
  assert.equal(b.status, "running");
});

test("listBranches returns empty array for session with no branches", async () => {
  const parent = await createAgentSession({
    workspace: "default",
    ownerStorageUserId: "user1",
    title: "No branches",
  });

  const branches = await listBranches(parent.id);
  assert.deepEqual(branches, []);
});

test("listBranches returns empty array for empty sessionId", async () => {
  const branches = await listBranches("");
  assert.deepEqual(branches, []);
});
