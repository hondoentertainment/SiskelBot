import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { resolveWorkspacePath } from "../lib/workspace-path-guard.js";

test("resolveWorkspacePath allows file under root", () => {
  const root = mkdtempSync(join(tmpdir(), "ws-"));
  const r = resolveWorkspacePath(root, "foo/bar.txt");
  assert.equal(r.ok, true);
  assert.ok(r.absPath.includes("foo"));
});

test("resolveWorkspacePath rejects traversal", () => {
  const root = mkdtempSync(join(tmpdir(), "ws-"));
  const r = resolveWorkspacePath(root, "../outside");
  assert.equal(r.ok, false);
  assert.equal(r.code, "PATH_TRAVERSAL");
});

test("resolveWorkspacePath rejects absolute path", () => {
  const root = mkdtempSync(join(tmpdir(), "ws-"));
  const r = resolveWorkspacePath(root, "/etc/passwd");
  assert.equal(r.ok, false);
});

test("resolveWorkspacePath rejects escape via nested resolve", () => {
  const root = mkdtempSync(join(tmpdir(), "ws-"));
  const r = resolveWorkspacePath(root, "a/../../..");
  assert.equal(r.ok, false);
});
