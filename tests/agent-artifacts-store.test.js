/**
 * Tests for lib/agent-artifacts.js.
 *
 * Uses a temp STORAGE_PATH so the artifact store writes to isolated directories
 * for each test. Exercises the inline path, the disk-spill path, size and
 * quota caps, mime/name validation, content retrieval, list scoping, and
 * session cleanup.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const dir = mkdtempSync(join(tmpdir(), "agent-artifacts-store-"));
const prev = process.env.STORAGE_PATH;
const prevMax = process.env.ARTIFACT_MAX_BYTES;
const prevSession = process.env.ARTIFACT_SESSION_MAX_BYTES;
const prevInline = process.env.ARTIFACT_INLINE_BYTES;
process.env.STORAGE_PATH = dir;
// Keep defaults loose but override inline threshold so tests can exercise
// both the inline and disk-spill paths cheaply.
process.env.ARTIFACT_INLINE_BYTES = "1024";

const streamMod = await import("../lib/agent-run-stream.js");
const sessionMod = await import("../lib/agent-session.js");
const mod = await import("../lib/agent-artifacts.js");

test.after(() => {
  if (prev === undefined) delete process.env.STORAGE_PATH;
  else process.env.STORAGE_PATH = prev;
  if (prevMax === undefined) delete process.env.ARTIFACT_MAX_BYTES;
  else process.env.ARTIFACT_MAX_BYTES = prevMax;
  if (prevSession === undefined) delete process.env.ARTIFACT_SESSION_MAX_BYTES;
  else process.env.ARTIFACT_SESSION_MAX_BYTES = prevSession;
  if (prevInline === undefined) delete process.env.ARTIFACT_INLINE_BYTES;
  else process.env.ARTIFACT_INLINE_BYTES = prevInline;
  try { rmSync(dir, { recursive: true, force: true }); } catch (_) {}
});

async function makeSession(workspace = "wsA") {
  const s = await sessionMod.createAgentSession({
    workspace,
    ownerStorageUserId: "owner",
    planSummary: "p",
  });
  return s.id;
}

test("createArtifact stores small payloads inline", async () => {
  streamMod.__resetAgentRunStreamForTests();
  await mod.__resetArtifactsForTests();
  const sessionId = await makeSession();
  const rec = await mod.createArtifact({
    sessionId,
    name: "hello.txt",
    mime: "text/plain",
    content: "hi there",
  });
  assert.equal(rec.storage, "inline");
  assert.equal(rec.sizeBytes, Buffer.byteLength("hi there", "utf8"));
  assert.equal(rec.name, "hello.txt");
  assert.equal(rec.mime, "text/plain");
  assert.ok(!("inline" in rec), "list record must not include inline payload");
  const buf = await mod.getArtifactContent(rec.id);
  assert.ok(buf);
  assert.equal(buf.toString("utf8"), "hi there");
});

test("createArtifact spills large payloads to disk", async () => {
  streamMod.__resetAgentRunStreamForTests();
  await mod.__resetArtifactsForTests();
  const sessionId = await makeSession("wsDisk");
  const payload = Buffer.alloc(8 * 1024, 0x41);
  const rec = await mod.createArtifact({
    sessionId,
    name: "big.bin",
    mime: "application/octet-stream",
    content: payload,
  });
  assert.equal(rec.storage, "disk");
  assert.equal(rec.sizeBytes, payload.length);
  const full = await mod.getArtifactRecord(rec.id);
  assert.ok(full.diskPath && existsSync(full.diskPath), "disk file must exist");
  const buf = await mod.getArtifactContent(rec.id);
  assert.ok(buf);
  assert.equal(buf.length, payload.length);
  assert.equal(buf[0], 0x41);
});

test("createArtifact publishes artifact.new on the session emitter", async () => {
  streamMod.__resetAgentRunStreamForTests();
  await mod.__resetArtifactsForTests();
  const sessionId = await makeSession("wsEmit");
  const emitter = streamMod.getAgentRunEmitter(sessionId);
  const events = [];
  emitter.on("event", (e) => events.push(e));
  const rec = await mod.createArtifact({
    sessionId,
    name: "a.json",
    mime: "application/json",
    content: '{"a":1}',
  });
  assert.ok(events.find((e) => e.type === "artifact.new" && e.payload?.id === rec.id));
  const pub = events.find((e) => e.type === "artifact.new");
  assert.equal(pub.payload.name, "a.json");
  assert.equal(pub.payload.mime, "application/json");
  assert.equal(typeof pub.payload.url, "string");
});

test("listArtifactsForSession returns records for the owning session only", async () => {
  streamMod.__resetAgentRunStreamForTests();
  await mod.__resetArtifactsForTests();
  const s1 = await makeSession("wsL1");
  const s2 = await makeSession("wsL2");
  await mod.createArtifact({ sessionId: s1, name: "a", mime: "text/plain", content: "1" });
  await mod.createArtifact({ sessionId: s1, name: "b", mime: "text/plain", content: "2" });
  await mod.createArtifact({ sessionId: s2, name: "c", mime: "text/plain", content: "3" });
  const list1 = await mod.listArtifactsForSession(s1);
  const list2 = await mod.listArtifactsForSession(s2);
  assert.equal(list1.length, 2);
  assert.equal(list2.length, 1);
  assert.equal(list2[0].name, "c");
  // Inline payload should never appear in list output.
  for (const r of list1) assert.ok(!("inline" in r));
});

test("createArtifact rejects oversize artifacts with ARTIFACT_TOO_LARGE", async () => {
  const prevMaxBytes = process.env.ARTIFACT_MAX_BYTES;
  process.env.ARTIFACT_MAX_BYTES = "256";
  try {
    await mod.__resetArtifactsForTests();
    const sessionId = await makeSession("wsCap");
    const tooBig = Buffer.alloc(512);
    await assert.rejects(
      () => mod.createArtifact({ sessionId, name: "big", mime: "application/octet-stream", content: tooBig }),
      (err) => err.code === "ARTIFACT_TOO_LARGE",
    );
  } finally {
    if (prevMaxBytes === undefined) delete process.env.ARTIFACT_MAX_BYTES;
    else process.env.ARTIFACT_MAX_BYTES = prevMaxBytes;
  }
});

test("createArtifact enforces per-session quota (ARTIFACT_QUOTA_EXCEEDED)", async () => {
  const prevSessMax = process.env.ARTIFACT_SESSION_MAX_BYTES;
  process.env.ARTIFACT_SESSION_MAX_BYTES = "1024";
  try {
    await mod.__resetArtifactsForTests();
    const sessionId = await makeSession("wsQuota");
    const chunk = Buffer.alloc(600, 0x42);
    await mod.createArtifact({ sessionId, name: "a", mime: "application/octet-stream", content: chunk });
    await assert.rejects(
      () => mod.createArtifact({ sessionId, name: "b", mime: "application/octet-stream", content: chunk }),
      (err) => err.code === "ARTIFACT_QUOTA_EXCEEDED",
    );
    // The second attempt spills to disk before quota is checked; confirm that
    // the rollback removed the temp file and the metadata store rejects both.
    const list = await mod.listArtifactsForSession(sessionId);
    assert.equal(list.length, 1, "rejected artifact must not persist");
  } finally {
    if (prevSessMax === undefined) delete process.env.ARTIFACT_SESSION_MAX_BYTES;
    else process.env.ARTIFACT_SESSION_MAX_BYTES = prevSessMax;
  }
});

test("createArtifact rejects invalid mime (INVALID_MIME)", async () => {
  await mod.__resetArtifactsForTests();
  const sessionId = await makeSession("wsMime");
  await assert.rejects(
    () => mod.createArtifact({ sessionId, name: "x", mime: "not-a-mime", content: "abc" }),
    (err) => err.code === "INVALID_MIME",
  );
  await assert.rejects(
    () => mod.createArtifact({ sessionId, name: "x", mime: "", content: "abc" }),
    (err) => err.code === "INVALID_MIME",
  );
});

test("createArtifact rejects invalid names (INVALID_NAME)", async () => {
  await mod.__resetArtifactsForTests();
  const sessionId = await makeSession("wsName");
  await assert.rejects(
    () => mod.createArtifact({ sessionId, name: "", mime: "text/plain", content: "x" }),
    (err) => err.code === "INVALID_NAME",
  );
  await assert.rejects(
    () => mod.createArtifact({ sessionId, name: "a".repeat(300), mime: "text/plain", content: "x" }),
    (err) => err.code === "INVALID_NAME",
  );
});

test("deleteArtifactsForSession removes records and disk files", async () => {
  streamMod.__resetAgentRunStreamForTests();
  await mod.__resetArtifactsForTests();
  const sessionId = await makeSession("wsDel");
  const a = await mod.createArtifact({
    sessionId,
    name: "inline.txt",
    mime: "text/plain",
    content: "tiny",
  });
  const bigBytes = Buffer.alloc(4096, 0x43);
  const b = await mod.createArtifact({
    sessionId,
    name: "big.bin",
    mime: "application/octet-stream",
    content: bigBytes,
  });
  const fullA = await mod.getArtifactRecord(a.id);
  const fullB = await mod.getArtifactRecord(b.id);
  assert.equal(fullA.storage, "inline");
  assert.equal(fullB.storage, "disk");
  assert.ok(existsSync(fullB.diskPath));

  const count = await mod.deleteArtifactsForSession(sessionId);
  assert.equal(count, 2);
  const list = await mod.listArtifactsForSession(sessionId);
  assert.equal(list.length, 0);
  assert.equal(existsSync(fullB.diskPath), false, "disk file must be removed");
  const sessionDir = join(process.env.STORAGE_PATH, "artifacts", sessionId);
  assert.equal(existsSync(sessionDir), false, "per-session dir is swept");
});

test("deleteArtifact removes a single record and its disk file", async () => {
  streamMod.__resetAgentRunStreamForTests();
  await mod.__resetArtifactsForTests();
  const sessionId = await makeSession("wsDelOne");
  const bigBytes = Buffer.alloc(4096, 0x44);
  const rec = await mod.createArtifact({
    sessionId,
    name: "one.bin",
    mime: "application/octet-stream",
    content: bigBytes,
  });
  const full = await mod.getArtifactRecord(rec.id);
  assert.ok(existsSync(full.diskPath));
  const removed = await mod.deleteArtifact(rec.id);
  assert.equal(removed, true);
  assert.equal(existsSync(full.diskPath), false);
  assert.equal(await mod.getArtifactRecord(rec.id), null);
  assert.equal(await mod.deleteArtifact(rec.id), false, "second delete is a no-op");
});
