/**
 * Phase 10: Storage module unit tests.
 * Uses temp directory via STORAGE_PATH to avoid polluting data/.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Set temp dir before importing storage - storage reads STORAGE_PATH at runtime
const tempDir = mkdtempSync(join(tmpdir(), "siskelbot-storage-"));
process.env.STORAGE_PATH = tempDir;

// Import after env is set (storage reads getDataDir on each call)
import * as storage from "../lib/storage.js";

test.after(() => {
  try {
    rmSync(tempDir, { recursive: true });
  } catch (_) {}
});

test("sanitizeWorkspace returns default for empty/invalid", () => {
  assert.equal(storage.sanitizeWorkspace(""), "default");
  assert.equal(storage.sanitizeWorkspace("   "), "default");
  assert.equal(storage.sanitizeWorkspace("a/b"), "default");
  assert.equal(storage.sanitizeWorkspace("valid-ws"), "valid-ws");
});

test("listWorkspaces returns default workspace for new user", async () => {
  const items = await storage.listWorkspaces("anonymous");
  assert.ok(Array.isArray(items));
  assert.ok(items.length >= 1);
  const defaultWs = items.find((w) => w.id === "default");
  assert.ok(defaultWs);
  assert.equal(defaultWs.name, "Default");
});

test("mergeItems creates and updates context items", async () => {
  const items = [
    { id: "ctx-1", title: "Doc 1", content: "Content 1" },
    { id: "ctx-2", title: "Doc 2", content: "Content 2" },
  ];
  const merged = await storage.mergeItems("context", "default", items);
  assert.equal(merged.length, 2);
  assert.ok(merged.find((i) => i.id === "ctx-1" && i.title === "Doc 1"));
  assert.ok(merged.find((i) => i.id === "ctx-2" && i.title === "Doc 2"));

  const list = await storage.list("context", "default", "anonymous");
  assert.equal(list.length, 2);
});

test("get returns item by id", async () => {
  await storage.mergeItems("context", "default", [
    { id: "get-test", title: "Get Test", content: "x" },
  ]);
  const item = await storage.get("context", "get-test", "default", "anonymous");
  assert.ok(item);
  assert.equal(item.title, "Get Test");
});

test("updateItem modifies existing item", async () => {
  await storage.mergeItems("context", "default", [
    { id: "upd-test", title: "Original", content: "c" },
  ]);
  const updated = await storage.updateItem(
    "context",
    "upd-test",
    "default",
    (e) => {
      e.title = "Updated";
      return e;
    },
    "anonymous"
  );
  assert.ok(updated);
  assert.equal(updated.title, "Updated");
});

test("deleteItem removes item", async () => {
  await storage.mergeItems("context", "default", [
    { id: "del-test", title: "To Delete", content: "x" },
  ]);
  const deleted = await storage.deleteItem("context", "del-test", "default", "anonymous");
  assert.equal(deleted, true);
  const item = await storage.get("context", "del-test", "default", "anonymous");
  assert.equal(item, null);
});

test("createWorkspace adds workspace for user", async () => {
  const ws = await storage.createWorkspace("user1", "My Workspace");
  assert.ok(ws.id);
  assert.equal(ws.name, "My Workspace");
  assert.equal(ws.userId, "user1");

  const list = await storage.listWorkspaces("user1");
  assert.ok(list.some((w) => w.id === ws.id && w.name === "My Workspace"));
});
