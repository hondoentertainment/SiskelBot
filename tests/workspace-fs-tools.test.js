import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { workspaceListDir, workspaceReadFile, workspaceSearchText } from "../lib/workspace-fs-tools.js";

test("workspaceReadFile reads UTF-8 file within root", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-"));
  writeFileSync(join(root, "hello.txt"), "hello world", "utf8");
  const ctx = { workspaceFilesystemRoot: root };
  const r = await workspaceReadFile(ctx, "hello.txt");
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.content, "hello world");
});

test("workspaceListDir lists directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-"));
  mkdirSync(join(root, "sub"));
  const ctx = { workspaceFilesystemRoot: root };
  const r = await workspaceListDir(ctx, ".");
  assert.equal(r.ok, true);
  if (r.ok) assert.ok(r.entries.some((e) => e.name === "sub"));
});

test("workspaceSearchText finds substring", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-"));
  writeFileSync(join(root, "a.txt"), "alpha beta\ngamma\n", "utf8");
  const ctx = { workspaceFilesystemRoot: root };
  const r = await workspaceSearchText(ctx, { query: "beta", rootRelative: "." });
  assert.equal(r.ok, true);
  if (r.ok) assert.ok(r.matchCount >= 1);
});
