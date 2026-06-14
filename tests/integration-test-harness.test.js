/**
 * Phase 61.3: Integration test harness tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-itest-harness-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  runRecipeTest,
  getTestRun,
  listTestRuns,
  defaultStepRunner,
  _internals,
} = await import("../lib/integration-test-harness.js");

test.after(() => {
  try { rmSync(TMP_DATA_DIR, { recursive: true, force: true }); } catch (_) {}
});

test("defaultStepRunner echoes deterministic dry-run output", async () => {
  const result = await defaultStepRunner({ name: "build", kind: "build", input: { a: 1 } }, {});
  assert.equal(result.output.dryRun, true);
  assert.equal(result.output.kind, "build");
  assert.deepEqual(result.output.input, { a: 1 });
});

test("runRecipeTest runs every step and returns a passed record when no expectations", async () => {
  const recipe = {
    name: "simple",
    steps: [
      { name: "a", kind: "noop" },
      { name: "b", kind: "noop" },
      { name: "c", kind: "noop" },
    ],
  };
  const run = await runRecipeTest(recipe);
  assert.equal(run.status, "passed");
  assert.equal(run.summary.total, 3);
  assert.equal(run.summary.passed, 3);
  assert.equal(run.steps.length, 3);
});

test("runRecipeTest evaluates equals assertions", async () => {
  const recipe = {
    name: "eq",
    steps: [
      { name: "echo", kind: "echo", output: { ok: true }, expect: { equals: { ok: true } } },
    ],
  };
  const run = await runRecipeTest(recipe);
  assert.equal(run.status, "passed");
});

test("runRecipeTest reports failure when assertion mismatches", async () => {
  const recipe = {
    name: "fail",
    steps: [
      { name: "only", kind: "echo", output: { ok: false }, expect: { equals: { ok: true } } },
    ],
  };
  const run = await runRecipeTest(recipe);
  assert.equal(run.status, "failed");
  assert.equal(run.summary.failed, 1);
  assert.ok(run.steps[0].reason);
});

test("runRecipeTest supports contains / matches / type assertions", async () => {
  const recipe = {
    name: "assertions",
    steps: [
      { name: "c", kind: "echo", output: "hello world", expect: { contains: "world" } },
      { name: "m", kind: "echo", output: "abc123", expect: { matches: "^abc\\d+$" } },
      { name: "t", kind: "echo", output: [1, 2, 3], expect: { type: "array" } },
    ],
  };
  const run = await runRecipeTest(recipe);
  assert.equal(run.status, "passed");
  assert.equal(run.summary.passed, 3);
});

test("runRecipeTest stops on first failure unless stopOnFail=false", async () => {
  const recipe = {
    name: "stops",
    steps: [
      { name: "bad", kind: "echo", output: 1, expect: { equals: 2 } },
      { name: "later", kind: "echo" },
    ],
  };
  const run = await runRecipeTest(recipe);
  assert.equal(run.status, "failed");
  assert.equal(run.summary.executed, 1);
  assert.equal(run.summary.skipped, 1);
});

test("runRecipeTest runs all steps when stopOnFail=false", async () => {
  const recipe = {
    name: "continues",
    steps: [
      { name: "bad", kind: "echo", output: 1, expect: { equals: 2 }, stopOnFail: false },
      { name: "ok", kind: "echo" },
    ],
  };
  const run = await runRecipeTest(recipe);
  assert.equal(run.status, "failed");
  assert.equal(run.summary.executed, 2);
  assert.equal(run.summary.passed, 1);
  assert.equal(run.summary.failed, 1);
});

test("runRecipeTest loads by name via injected loader", async () => {
  const fakeLoader = async (name) => {
    if (name !== "my-recipe") return null;
    return { name: "my-recipe", steps: [{ name: "s1", kind: "noop" }] };
  };
  const run = await runRecipeTest("my-recipe", { loader: fakeLoader });
  assert.equal(run.status, "passed");
  assert.equal(run.recipe.name, "my-recipe");
});

test("runRecipeTest throws NOT_FOUND when loader returns null", async () => {
  await assert.rejects(
    () => runRecipeTest("missing", { loader: async () => null }),
    (err) => err.code === "NOT_FOUND",
  );
});

test("getTestRun + listTestRuns round-trip stored runs", async () => {
  const rec = { name: "list-me", steps: [{ name: "a", kind: "noop" }] };
  const run = await runRecipeTest(rec);
  const fetched = await getTestRun(run.id);
  assert.equal(fetched.id, run.id);
  const list = await listTestRuns({ name: "list-me" });
  assert.ok(list.some((r) => r.id === run.id));
});

test("listTestRuns filters by status", async () => {
  await runRecipeTest({ name: "status-pass", steps: [{ name: "a", kind: "noop" }] });
  await runRecipeTest({
    name: "status-fail",
    steps: [{ name: "a", kind: "echo", output: 1, expect: { equals: 2 } }],
  });
  const failed = await listTestRuns({ status: "failed" });
  assert.ok(failed.every((r) => r.status === "failed"));
  assert.ok(failed.length >= 1);
});

test("internal deepEqual handles arrays, objects, and primitives", () => {
  const { deepEqual } = _internals;
  assert.equal(deepEqual([1, 2], [1, 2]), true);
  assert.equal(deepEqual([1, 2], [1, 3]), false);
  assert.equal(deepEqual({ a: 1 }, { a: 1 }), true);
  assert.equal(deepEqual({ a: 1 }, { a: 1, b: 2 }), false);
});
