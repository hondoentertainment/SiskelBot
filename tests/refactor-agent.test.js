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

test("planIndex survives a module reload (persistent index)", async () => {
  // Create a plan, reload the module to simulate a restart, then resolve
  // the plan without passing workspaceId. The lookup must succeed via the
  // on-disk index.
  await _reset("ws-persist");
  const plan = await planRefactor({
    workspaceId: "ws-persist",
    files: [{ path: "a.js", content: "alpha" }],
    transform: { type: "replace", from: "alpha", to: "beta" },
  });
  const fresh = await import(`../lib/refactor-agent.js?reload=${Date.now()}`);
  const fetched = await fresh.getPlan(plan.planId);
  assert.ok(fetched, "plan should resolve via persistent index after module reload");
  assert.equal(fetched.planId, plan.planId);
  assert.equal(fetched.workspaceId, "ws-persist");
});

test("applyRefactor writeToDisk is refused when WORKSPACE_FILE_TOOLS is disabled", async () => {
  await _reset("ws-write-gate");
  const plan = await planRefactor({
    workspaceId: "ws-write-gate",
    files: [{ path: "a.js", content: "hello" }],
    transform: { type: "replace", from: "hello", to: "world" },
  });
  const prevGate = process.env.WORKSPACE_FILE_TOOLS;
  delete process.env.WORKSPACE_FILE_TOOLS;
  try {
    const res = await applyRefactor({
      planId: plan.planId,
      dryRun: false,
      writeToDisk: true,
      workspaceId: "ws-write-gate",
    });
    assert.equal(res.writeToDisk, false);
    assert.ok(Array.isArray(res.writeErrors));
    assert.equal(res.writeErrors[0].code, "WORKSPACE_FILE_TOOLS_DISABLED");
    assert.deepEqual(res.wrote, []);
  } finally {
    if (prevGate === undefined) delete process.env.WORKSPACE_FILE_TOOLS;
    else process.env.WORKSPACE_FILE_TOOLS = prevGate;
  }
});

test("applyRefactor writeToDisk actually writes files when gated correctly", async () => {
  const { mkdtempSync: mkt, readFileSync } = await import("node:fs");
  const { tmpdir: tmp } = await import("node:os");
  const { join: j } = await import("node:path");
  const wsRoot = mkt(j(tmp(), "siskel-refactor-root-"));
  await _reset("ws-write-ok");
  const plan = await planRefactor({
    workspaceId: "ws-write-ok",
    files: [{ path: "sub/a.js", content: "hello" }],
    transform: { type: "replace", from: "hello", to: "howdy" },
  });
  // Pre-create the directory so writeFile succeeds (planRefactor doesn't
  // mkdirp; the test supplies an empty dir tree mirroring the intended layout).
  const { mkdirSync } = await import("node:fs");
  mkdirSync(j(wsRoot, "sub"), { recursive: true });

  const prevGate = process.env.WORKSPACE_FILE_TOOLS;
  process.env.WORKSPACE_FILE_TOOLS = "1";
  try {
    const res = await applyRefactor({
      planId: plan.planId,
      dryRun: false,
      writeToDisk: true,
      workspaceId: "ws-write-ok",
      workspaceFilesystemRoot: wsRoot,
    });
    assert.equal(res.writeToDisk, true);
    assert.deepEqual(res.wrote, ["sub/a.js"]);
    assert.deepEqual(res.writeErrors, []);
    const written = readFileSync(j(wsRoot, "sub/a.js"), "utf8");
    assert.equal(written, "howdy");
  } finally {
    if (prevGate === undefined) delete process.env.WORKSPACE_FILE_TOOLS;
    else process.env.WORKSPACE_FILE_TOOLS = prevGate;
    try { rmSync(wsRoot, { recursive: true, force: true }); } catch (_) {}
  }
});

test("applyRefactor writeToDisk refuses paths that escape the workspace root", async () => {
  const { mkdtempSync: mkt } = await import("node:fs");
  const { tmpdir: tmp } = await import("node:os");
  const { join: j } = await import("node:path");
  const wsRoot = mkt(j(tmp(), "siskel-refactor-esc-"));
  await _reset("ws-esc");
  const plan = await planRefactor({
    workspaceId: "ws-esc",
    files: [
      { path: "../escape.js", content: "x" },
      { path: "ok.js", content: "x" },
    ],
    transform: { type: "replace", from: "x", to: "y" },
  });

  const prevGate = process.env.WORKSPACE_FILE_TOOLS;
  process.env.WORKSPACE_FILE_TOOLS = "1";
  try {
    const res = await applyRefactor({
      planId: plan.planId,
      dryRun: false,
      writeToDisk: true,
      workspaceId: "ws-esc",
      workspaceFilesystemRoot: wsRoot,
    });
    assert.equal(res.writeToDisk, true);
    // Traversal is refused by the guard; ok.js still writes.
    assert.ok(res.writeErrors.some((e) => e.path === "../escape.js" && e.code === "PATH_TRAVERSAL"));
    assert.ok(res.wrote.includes("ok.js"));
  } finally {
    if (prevGate === undefined) delete process.env.WORKSPACE_FILE_TOOLS;
    else process.env.WORKSPACE_FILE_TOOLS = prevGate;
    try { rmSync(wsRoot, { recursive: true, force: true }); } catch (_) {}
  }
});
