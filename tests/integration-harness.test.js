/**
 * Phase 61.3: integration-harness tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-harness-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  createHarness,
  runHarness,
  listHarnesses,
  recordOutcome,
  clearHarnessRuns,
  listRuns,
} = await import("../lib/integration-harness.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

test("createHarness persists a new harness", async () => {
  const h = await createHarness({
    name: "basic",
    description: "basic smoke",
    steps: [{ name: "hello", recipe: "echo", input: { text: "hi" } }],
  });
  assert.equal(h.name, "basic");
  assert.equal(h.steps.length, 1);
  assert.ok(h.id);
});

test("createHarness rejects invalid configs", async () => {
  await assert.rejects(() => createHarness(null));
  await assert.rejects(() => createHarness({ name: "no-steps", steps: [] }));
  await assert.rejects(() => createHarness({ name: "bad-step", steps: [{}] }));
  await assert.rejects(() => createHarness({ steps: [{ name: "x" }] }));
});

test("listHarnesses returns defined harnesses", async () => {
  await createHarness({ name: "listed", steps: [{ name: "a" }] });
  const all = await listHarnesses();
  assert.ok(all.some((h) => h.name === "listed"));
});

test("runHarness passes when executor returns ok", async () => {
  await createHarness({
    name: "run-pass",
    steps: [
      { name: "s1" },
      { name: "s2" },
    ],
  });
  const executor = async (step) => ({ ok: true, output: `ran-${step.name}` });
  const run = await runHarness("run-pass", { executor });
  assert.equal(run.status, "passed");
  assert.equal(run.passed, 2);
  assert.equal(run.failed, 0);
  assert.equal(run.steps.length, 2);
});

test("runHarness fails when executor throws", async () => {
  await createHarness({
    name: "run-fail",
    steps: [
      { name: "good" },
      { name: "bad" },
      { name: "skipped" },
    ],
  });
  const executor = async (step) => {
    if (step.name === "bad") throw new Error("kaboom");
    return { ok: true };
  };
  const run = await runHarness("run-fail", { executor });
  assert.equal(run.status, "failed");
  assert.equal(run.failed, 1);
  // stopOnFailure defaults to true so we skip the third step.
  const stepRecords = run.steps.filter((s) => s.phase === "steps");
  assert.equal(stepRecords.length, 2);
  const bad = stepRecords.find((s) => s.name === "bad");
  assert.equal(bad.error, "kaboom");
});

test("runHarness honors stopOnFailure=false", async () => {
  await createHarness({
    name: "run-continue",
    steps: [
      { name: "a" },
      { name: "b" },
      { name: "c" },
    ],
  });
  const executor = async (step) => {
    if (step.name === "a") throw new Error("x");
    return { ok: true };
  };
  const run = await runHarness("run-continue", { executor, stopOnFailure: false });
  const stepRecords = run.steps.filter((s) => s.phase === "steps");
  assert.equal(stepRecords.length, 3);
  assert.equal(run.failed, 1);
  assert.equal(run.passed, 2);
});

test("runHarness runs setup and teardown phases", async () => {
  await createHarness({
    name: "run-phases",
    setup: [{ name: "setup1" }],
    steps: [{ name: "core" }],
    teardown: [{ name: "tear1" }],
  });
  const seen = [];
  const executor = async (step, ctx) => {
    seen.push({ name: step.name, phase: ctx.phase });
    return { ok: true };
  };
  const run = await runHarness("run-phases", { executor });
  assert.equal(run.status, "passed");
  assert.deepEqual(
    seen.map((s) => s.phase),
    ["setup", "steps", "teardown"],
  );
});

test("runHarness treats returned ok:false as failure", async () => {
  await createHarness({
    name: "run-ok-false",
    steps: [{ name: "s" }],
  });
  const executor = async () => ({ ok: false, error: "bad data" });
  const run = await runHarness("run-ok-false", { executor });
  assert.equal(run.status, "failed");
  assert.equal(run.steps[0].error, "bad data");
});

test("runHarness rejects unknown harness", async () => {
  await assert.rejects(() => runHarness("does-not-exist"));
});

test("recordOutcome attaches an outcome to a run", async () => {
  await createHarness({ name: "outcome-test", steps: [{ name: "s" }] });
  const run = await runHarness("outcome-test", { executor: async () => ({ ok: true }) });
  const updated = await recordOutcome(run.id, { status: "approved", note: "lgtm" });
  assert.ok(updated.outcome);
  assert.equal(updated.outcome.status, "approved");
});

test("recordOutcome rejects unknown run", async () => {
  await assert.rejects(() => recordOutcome("nope", { status: "x" }));
});

test("listRuns returns runs filtered by harness", async () => {
  await createHarness({ name: "list-a", steps: [{ name: "s" }] });
  await createHarness({ name: "list-b", steps: [{ name: "s" }] });
  await runHarness("list-a", { executor: async () => ({ ok: true }) });
  await runHarness("list-b", { executor: async () => ({ ok: true }) });
  const aRuns = await listRuns("list-a");
  assert.ok(aRuns.every((r) => r.harnessName === "list-a"));
});

test("clearHarnessRuns removes runs for one harness and all", async () => {
  await createHarness({ name: "clr-a", steps: [{ name: "s" }] });
  await createHarness({ name: "clr-b", steps: [{ name: "s" }] });
  await runHarness("clr-a", { executor: async () => ({ ok: true }) });
  await runHarness("clr-b", { executor: async () => ({ ok: true }) });
  const clearedA = await clearHarnessRuns("clr-a");
  assert.ok(clearedA.cleared >= 1);
  const remaining = await listRuns();
  assert.ok(!remaining.some((r) => r.harnessName === "clr-a"));
  await clearHarnessRuns();
  const empty = await listRuns();
  assert.equal(empty.length, 0);
});
