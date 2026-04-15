/**
 * Tests for the runId → sessionId reverse index in lib/agent-session.js.
 *
 * Covers linkage, async + sync lookups, unlink, last-write-wins conflict
 * resolution, and idempotency of the buildRunIndexFromSessions() migration.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const dir = mkdtempSync(join(tmpdir(), "agent-sess-revidx-"));
const prevStoragePath = process.env.STORAGE_PATH;
process.env.STORAGE_PATH = dir;

const {
  createAgentSession,
  linkRunToAgentSession,
  getSessionIdForRun,
  getSessionIdForRunSync,
  unlinkRunFromAgentSession,
  buildRunIndexFromSessions,
  __resetRunIndexMemoryForTests,
} = await import("../lib/agent-session.js");

test.after(() => {
  if (prevStoragePath === undefined) delete process.env.STORAGE_PATH;
  else process.env.STORAGE_PATH = prevStoragePath;
  rmSync(dir, { recursive: true, force: true });
});

test("linkRunToAgentSession populates the reverse index (async + sync)", async () => {
  const s = await createAgentSession({
    workspace: "default",
    ownerStorageUserId: "anon",
    title: "link test",
  });
  const runId = `run-${s.id.slice(0, 8)}-1`;
  await linkRunToAgentSession(s.id, runId);

  assert.equal(getSessionIdForRunSync(runId), s.id);
  assert.equal(await getSessionIdForRun(runId), s.id);
});

test("getSessionIdForRun returns null for unknown runId", async () => {
  assert.equal(await getSessionIdForRun("does-not-exist"), null);
  assert.equal(getSessionIdForRunSync("does-not-exist"), null);
  assert.equal(await getSessionIdForRun(""), null);
  assert.equal(getSessionIdForRunSync(""), null);
});

test("getSessionIdForRun persists across in-memory mirror reset", async () => {
  const s = await createAgentSession({
    workspace: "default",
    ownerStorageUserId: "anon",
    title: "persist test",
  });
  const runId = `run-${s.id.slice(0, 8)}-persist`;
  await linkRunToAgentSession(s.id, runId);

  // Cold cache: simulate a process restart by clearing the in-memory mirror.
  __resetRunIndexMemoryForTests();
  assert.equal(getSessionIdForRunSync(runId), null);

  // The async lookup should still find it in the persisted store and rehydrate
  // the mirror.
  assert.equal(await getSessionIdForRun(runId), s.id);
  assert.equal(getSessionIdForRunSync(runId), s.id);
});

test("unlinkRunFromAgentSession removes the reverse-index entry", async () => {
  const s = await createAgentSession({
    workspace: "default",
    ownerStorageUserId: "anon",
    title: "unlink test",
  });
  const runId = `run-${s.id.slice(0, 8)}-u`;
  await linkRunToAgentSession(s.id, runId);
  assert.equal(await getSessionIdForRun(runId), s.id);

  await unlinkRunFromAgentSession(runId);
  assert.equal(getSessionIdForRunSync(runId), null);
  assert.equal(await getSessionIdForRun(runId), null);

  // Safe for unknown runIds
  await unlinkRunFromAgentSession("nonexistent-run");
  await unlinkRunFromAgentSession("");
});

test("linking the same runId to two sessions: last write wins", async () => {
  const a = await createAgentSession({
    workspace: "default",
    ownerStorageUserId: "anon",
    title: "lww A",
  });
  const b = await createAgentSession({
    workspace: "default",
    ownerStorageUserId: "anon",
    title: "lww B",
  });
  const sharedRun = `run-shared-${a.id.slice(0, 6)}`;

  await linkRunToAgentSession(a.id, sharedRun);
  assert.equal(await getSessionIdForRun(sharedRun), a.id);

  await linkRunToAgentSession(b.id, sharedRun);
  // Last-write-wins: the reverse index now points at session B, even though
  // session A still has the runId in its runIds array.
  assert.equal(await getSessionIdForRun(sharedRun), b.id);
  assert.equal(getSessionIdForRunSync(sharedRun), b.id);
});

test("buildRunIndexFromSessions backfills and is idempotent", async () => {
  // Create two sessions with linked runs, then wipe the in-memory mirror and
  // (implicitly via a clean rebuild) assert the migration reconstructs the
  // index from the durable sessions.
  const s1 = await createAgentSession({
    workspace: "ws-migrate",
    ownerStorageUserId: "anon",
    title: "mig s1",
  });
  const s2 = await createAgentSession({
    workspace: "ws-migrate",
    ownerStorageUserId: "anon",
    title: "mig s2",
  });
  const r1 = `run-${s1.id.slice(0, 6)}-mig`;
  const r2 = `run-${s2.id.slice(0, 6)}-mig`;
  await linkRunToAgentSession(s1.id, r1);
  await linkRunToAgentSession(s2.id, r2);

  __resetRunIndexMemoryForTests();
  const first = await buildRunIndexFromSessions();
  assert.ok(first.sessions >= 2);
  assert.ok(first.runs >= 2);
  assert.equal(getSessionIdForRunSync(r1), s1.id);
  assert.equal(getSessionIdForRunSync(r2), s2.id);

  // Idempotent: calling again yields the same mappings.
  const second = await buildRunIndexFromSessions();
  assert.equal(second.sessions, first.sessions);
  assert.equal(second.runs, first.runs);
  assert.equal(getSessionIdForRunSync(r1), s1.id);
  assert.equal(getSessionIdForRunSync(r2), s2.id);
});

test("buildRunIndexFromSessions picks the most-recently-updated session on conflict", async () => {
  // Force a conflict where two sessions each have the same runId in their
  // runIds array by linking it on session A first, then on session B.
  const a = await createAgentSession({
    workspace: "default",
    ownerStorageUserId: "anon",
    title: "conflict A",
  });
  const b = await createAgentSession({
    workspace: "default",
    ownerStorageUserId: "anon",
    title: "conflict B",
  });
  const run = `run-conflict-${a.id.slice(0, 6)}`;
  await linkRunToAgentSession(a.id, run);
  // Small delay so B's updatedAt is strictly greater than A's.
  await new Promise((r) => setTimeout(r, 10));
  await linkRunToAgentSession(b.id, run);

  __resetRunIndexMemoryForTests();
  await buildRunIndexFromSessions();
  assert.equal(getSessionIdForRunSync(run), b.id);
});
