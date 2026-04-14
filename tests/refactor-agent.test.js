/**
 * Phase 63.4: Refactoring agent tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "siskel-refactor-"));
process.env.STORAGE_PATH = TMP;

const {
  planRefactor,
  previewRefactor,
  applyRefactor,
  listPlans,
  getPlan,
  _reset,
} = await import("../lib/refactor-agent.js");

test.after(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

test("planRefactor rename replaces identifiers at word boundary", async () => {
  await _reset("ws-rename");
  const plan = await planRefactor({
    workspaceId: "ws-rename",
    files: [
      { path: "a.js", content: "const foo = 1; foobar + foo + foo2;" },
      { path: "b.js", content: "foo(); // not here: foobar" },
    ],
    transform: { type: "rename", from: "foo", to: "bar" },
  });
  assert.ok(plan.planId);
  assert.equal(plan.status, "planned");
  const a = plan.files.find((f) => f.path === "a.js");
  assert.equal(a.modified, "const bar = 1; foobar + bar + foo2;");
  assert.equal(a.changes, 2);
  const b = plan.files.find((f) => f.path === "b.js");
  assert.equal(b.modified, "bar(); // not here: foobar");
  assert.equal(b.changes, 1);
});

test("planRefactor replace does substring replacement", async () => {
  await _reset("ws-replace");
  const plan = await planRefactor({
    workspaceId: "ws-replace",
    files: [{ path: "x.js", content: "abcXabcXabc" }],
    transform: { type: "replace", from: "X", to: "Y" },
  });
  const f = plan.files[0];
  assert.equal(f.modified, "abcYabcYabc");
  assert.equal(f.changes, 2);
});

test("planRefactor rejects invalid transform type", async () => {
  await _reset("ws-bad");
  await assert.rejects(() =>
    planRefactor({
      workspaceId: "ws-bad",
      files: [{ path: "a.js", content: "x" }],
      transform: { type: "bogus", from: "x", to: "y" },
    }),
  );
});

test("previewRefactor and getPlan round-trip", async () => {
  await _reset("ws-preview");
  const plan = await planRefactor({
    workspaceId: "ws-preview",
    files: [{ path: "a.js", content: "one two" }],
    transform: { type: "replace", from: "two", to: "three" },
  });
  const preview = await previewRefactor(plan.planId, "ws-preview");
  assert.equal(preview.planId, plan.planId);
  assert.equal(preview.files[0].modified, "one three");
  const fetched = await getPlan(plan.planId, "ws-preview");
  assert.equal(fetched.planId, plan.planId);
  assert.equal(fetched.status, "planned");
});

test("applyRefactor dryRun returns diffs without marking applied", async () => {
  await _reset("ws-dry");
  const plan = await planRefactor({
    workspaceId: "ws-dry",
    files: [{ path: "a.js", content: "hello" }],
    transform: { type: "replace", from: "hello", to: "world" },
  });
  const res = await applyRefactor({ planId: plan.planId, dryRun: true, workspaceId: "ws-dry" });
  assert.equal(res.dryRun, true);
  assert.equal(res.status, "planned");
  const after = await getPlan(plan.planId, "ws-dry");
  assert.equal(after.status, "planned");
});

test("applyRefactor marks plan applied and stores snapshot", async () => {
  await _reset("ws-apply");
  const plan = await planRefactor({
    workspaceId: "ws-apply",
    files: [{ path: "a.js", content: "hello world" }],
    transform: { type: "replace", from: "hello", to: "howdy" },
  });
  const res = await applyRefactor({ planId: plan.planId, dryRun: false, workspaceId: "ws-apply" });
  assert.equal(res.dryRun, false);
  assert.equal(res.status, "applied");
  assert.ok(res.appliedAt);
  assert.equal(res.files[0].content, "howdy world");
  const after = await getPlan(plan.planId, "ws-apply");
  assert.equal(after.status, "applied");
  assert.ok(after.appliedSnapshot);
});

test("listPlans returns the list in insertion order with counts", async () => {
  await _reset("ws-list");
  await planRefactor({
    workspaceId: "ws-list",
    files: [{ path: "a.js", content: "foo" }],
    transform: { type: "rename", from: "foo", to: "bar" },
  });
  await planRefactor({
    workspaceId: "ws-list",
    files: [
      { path: "b.js", content: "baz baz" },
      { path: "c.js", content: "qux" },
    ],
    transform: { type: "rename", from: "baz", to: "quux" },
  });
  const { plans } = await listPlans("ws-list");
  assert.equal(plans.length, 2);
  assert.equal(plans[1].fileCount, 2);
  assert.equal(plans[1].totalChanges, 2);
});

test("applyRefactor on unknown plan returns null", async () => {
  await _reset("ws-none");
  const res = await applyRefactor({ planId: "does-not-exist", dryRun: false, workspaceId: "ws-none" });
  assert.equal(res, null);
});
