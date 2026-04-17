/**
 * Tests for lib/agent-checkpoint.js — save, load, overwrite, delete, load-nonexistent.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Isolate storage to a temp directory so tests don't pollute real data.
const dir = mkdtempSync(join(tmpdir(), "agent-ckpt-"));
const prev = process.env.STORAGE_PATH;
process.env.STORAGE_PATH = dir;

const { saveCheckpoint, loadCheckpoint, deleteCheckpoint } = await import(
  "../lib/agent-checkpoint.js"
);

test.after(() => {
  if (prev === undefined) delete process.env.STORAGE_PATH;
  else process.env.STORAGE_PATH = prev;
  rmSync(dir, { recursive: true, force: true });
});

test("save and load round-trip", async () => {
  const sessionId = "ckpt-roundtrip-" + Date.now();
  const checkpoint = {
    sessionId,
    iteration: 3,
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ],
    runId: "run-1",
    model: "gpt-4",
    timestamp: Date.now(),
    version: 1,
  };
  await saveCheckpoint(sessionId, checkpoint);
  const loaded = await loadCheckpoint(sessionId);
  assert.ok(loaded);
  assert.equal(loaded.sessionId, sessionId);
  assert.equal(loaded.iteration, 3);
  assert.equal(loaded.runId, "run-1");
  assert.equal(loaded.model, "gpt-4");
  assert.equal(loaded.version, 1);
  assert.equal(loaded.messages.length, 2);
  assert.equal(loaded.messages[0].content, "hello");
});

test("overwrite replaces previous checkpoint", async () => {
  const sessionId = "ckpt-overwrite-" + Date.now();
  await saveCheckpoint(sessionId, {
    sessionId,
    iteration: 1,
    messages: [{ role: "user", content: "first" }],
    runId: "run-a",
    model: "gpt-4",
    timestamp: Date.now(),
    version: 1,
  });
  await saveCheckpoint(sessionId, {
    sessionId,
    iteration: 5,
    messages: [{ role: "user", content: "second" }],
    runId: "run-b",
    model: "gpt-4",
    timestamp: Date.now(),
    version: 1,
  });
  const loaded = await loadCheckpoint(sessionId);
  assert.ok(loaded);
  assert.equal(loaded.iteration, 5);
  assert.equal(loaded.runId, "run-b");
  assert.equal(loaded.messages[0].content, "second");
});

test("delete removes checkpoint", async () => {
  const sessionId = "ckpt-delete-" + Date.now();
  await saveCheckpoint(sessionId, {
    sessionId,
    iteration: 2,
    messages: [],
    runId: "run-x",
    model: "gpt-4",
    timestamp: Date.now(),
    version: 1,
  });
  const before = await loadCheckpoint(sessionId);
  assert.ok(before);

  await deleteCheckpoint(sessionId);
  const after = await loadCheckpoint(sessionId);
  assert.equal(after, null);
});

test("load nonexistent returns null", async () => {
  const result = await loadCheckpoint("does-not-exist-" + Date.now());
  assert.equal(result, null);
});

test("load with empty string returns null", async () => {
  const result = await loadCheckpoint("");
  assert.equal(result, null);
});

test("save with empty sessionId is a no-op", async () => {
  // Should not throw
  await saveCheckpoint("", { iteration: 1, messages: [] });
  const result = await loadCheckpoint("");
  assert.equal(result, null);
});
