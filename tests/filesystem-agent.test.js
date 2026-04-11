/**
 * Phase 55.4: Filesystem agent with dry-run tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-fs-agent-data-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const WORKSPACE = mkdtempSync(join(tmpdir(), "siskel-fs-agent-ws-"));
process.env.WORKSPACE_ROOT = WORKSPACE;

const {
  planFsOperations,
  previewFsPlan,
  applyFsPlan,
  fsOpAllowed,
} = await import("../lib/filesystem-agent.js");

test.after(() => {
  try { rmSync(TMP_DATA_DIR, { recursive: true, force: true }); } catch (_) {}
  try { rmSync(WORKSPACE, { recursive: true, force: true }); } catch (_) {}
});

function seed(rel, content) {
  const abs = join(WORKSPACE, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf8");
  return abs;
}

/* -------------------------------------------------------------------------- */
/* fsOpAllowed                                                                */
/* -------------------------------------------------------------------------- */

test("fsOpAllowed accepts known ops", () => {
  assert.equal(fsOpAllowed({ op: "read" }), true);
  assert.equal(fsOpAllowed({ op: "write" }), true);
  assert.equal(fsOpAllowed({ op: "move" }), true);
});

test("fsOpAllowed rejects unknown ops", () => {
  assert.equal(fsOpAllowed({ op: "chmod" }), false);
  assert.equal(fsOpAllowed(null), false);
  assert.equal(fsOpAllowed({}), false);
});

/* -------------------------------------------------------------------------- */
/* planFsOperations                                                           */
/* -------------------------------------------------------------------------- */

test("planFsOperations resolves paths and normalizes ops", () => {
  const plan = planFsOperations([
    { op: "write", path: "a.txt", content: "hello" },
    { op: "read", path: "a.txt" },
  ]);
  assert.equal(plan.operations.length, 2);
  assert.ok(plan.operations[0].resolved.startsWith(WORKSPACE));
  assert.equal(plan.root, WORKSPACE);
});

test("planFsOperations rejects path traversal", () => {
  assert.throws(() => planFsOperations([{ op: "read", path: "../escape" }]));
});

test("planFsOperations rejects invalid op shape", () => {
  assert.throws(() => planFsOperations([{ op: "nope", path: "x" }]));
  assert.throws(() => planFsOperations([{ op: "write", path: "x" }])); // missing content
  assert.throws(() => planFsOperations([{ op: "move", from: "a" }])); // missing to
});

test("planFsOperations rejects non-array input", () => {
  assert.throws(() => planFsOperations("not-an-array"));
});

/* -------------------------------------------------------------------------- */
/* previewFsPlan                                                              */
/* -------------------------------------------------------------------------- */

test("previewFsPlan reports creates, overwrites, deletes, moves", () => {
  seed("existing.txt", "old");
  const plan = planFsOperations([
    { op: "write", path: "new.txt", content: "new content" },
    { op: "write", path: "existing.txt", content: "updated" },
    { op: "delete", path: "existing.txt" },
    { op: "mkdir", path: "subdir" },
  ]);
  const preview = previewFsPlan(plan);
  assert.equal(preview.summary.creates, 2);
  assert.equal(preview.summary.overwrites, 1);
  assert.equal(preview.summary.deletes, 1);
  const kinds = preview.entries.map((e) => e.kind);
  assert.ok(kinds.includes("create"));
  assert.ok(kinds.includes("overwrite"));
  assert.ok(kinds.includes("delete"));
});

/* -------------------------------------------------------------------------- */
/* applyFsPlan                                                                */
/* -------------------------------------------------------------------------- */

test("applyFsPlan writes and reads files", async () => {
  const plan = planFsOperations([
    { op: "write", path: "apply1.txt", content: "hello world" },
    { op: "read", path: "apply1.txt" },
  ]);
  const result = await applyFsPlan(plan);
  assert.ok(!("dryRun" in result));
  assert.equal(result.rolledBack, false);
  assert.equal(result.applied, 2);
  const readResult = result.results.find((r) => r.op === "read");
  assert.equal(readResult.detail.content, "hello world");
  assert.ok(existsSync(join(WORKSPACE, "apply1.txt")));
});

test("applyFsPlan appends to existing files", async () => {
  seed("append.txt", "base-");
  const plan = planFsOperations([
    { op: "append", path: "append.txt", content: "added" },
  ]);
  await applyFsPlan(plan);
  assert.equal(readFileSync(join(WORKSPACE, "append.txt"), "utf8"), "base-added");
});

test("applyFsPlan moves files", async () => {
  seed("src.txt", "contents");
  const plan = planFsOperations([
    { op: "move", from: "src.txt", to: "dst.txt" },
  ]);
  const r = await applyFsPlan(plan);
  assert.equal(r.rolledBack, false);
  assert.equal(existsSync(join(WORKSPACE, "src.txt")), false);
  assert.equal(readFileSync(join(WORKSPACE, "dst.txt"), "utf8"), "contents");
});

test("applyFsPlan deletes files and directories", async () => {
  seed("delete-me.txt", "bye");
  mkdirSync(join(WORKSPACE, "delete-dir"), { recursive: true });
  writeFileSync(join(WORKSPACE, "delete-dir", "inner.txt"), "inner");

  const plan = planFsOperations([
    { op: "delete", path: "delete-me.txt" },
    { op: "delete", path: "delete-dir" },
  ]);
  await applyFsPlan(plan);
  assert.equal(existsSync(join(WORKSPACE, "delete-me.txt")), false);
  assert.equal(existsSync(join(WORKSPACE, "delete-dir")), false);
});

test("applyFsPlan dry-run does not mutate disk", async () => {
  const before = existsSync(join(WORKSPACE, "dry.txt"));
  const plan = planFsOperations([
    { op: "write", path: "dry.txt", content: "dry content" },
  ]);
  const r = await applyFsPlan(plan, { dryRun: true });
  assert.equal(r.dryRun, true);
  assert.ok(r.preview);
  assert.equal(existsSync(join(WORKSPACE, "dry.txt")), before);
});

test("applyFsPlan rolls back on failure", async () => {
  seed("rb-keep.txt", "initial");
  // Plan: write new file, then try a move whose source doesn't exist AND we
  // force-fail by moving to an invalid resolved path.
  // Simpler: plan two writes where the second intentionally fails via an
  // extremely long path inside the workspace root (we use a null byte-free
  // but overly-nested directory that will work fine). Instead, we force
  // failure by appending a move op that has a non-existent source being
  // considered a normal skip -- which won't actually fail. The cleanest way
  // is to patch node's fs with a bad op: use an unknown-at-runtime op to
  // cause the switch default; but default maps to "skipped" not "throw".
  //
  // We'll instead test rollback by manually invoking with a forced error in
  // the middle: use `delete` on an existing path, then write. Deletion is
  // reversible via snapshot. To force failure we append a second write to a
  // directory path (which throws EISDIR on writeFileSync).
  mkdirSync(join(WORKSPACE, "rb-dir"), { recursive: true });

  const plan = planFsOperations([
    { op: "write", path: "rb-new.txt", content: "created" },
    { op: "write", path: "rb-dir", content: "oops" }, // EISDIR
  ]);
  const r = await applyFsPlan(plan);
  assert.equal(r.rolledBack, true);
  // First write should have been undone.
  assert.equal(existsSync(join(WORKSPACE, "rb-new.txt")), false);
});

test("applyFsPlan rejects missing plan", async () => {
  await assert.rejects(() => applyFsPlan(null));
});

test("applyFsPlan list operation returns entries", async () => {
  seed("list-dir/a.txt", "a");
  seed("list-dir/b.txt", "b");
  const plan = planFsOperations([{ op: "list", path: "list-dir" }]);
  const r = await applyFsPlan(plan);
  assert.equal(r.rolledBack, false);
  const entry = r.results[0];
  assert.equal(entry.status, "ok");
  assert.ok(Array.isArray(entry.detail.entries));
  assert.ok(entry.detail.entries.some((e) => e.name === "a.txt"));
});
