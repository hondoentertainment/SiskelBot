/**
 * Phase 56.3: Synthetic task generator tests.
 *
 * Covers: built-in templates, task shape, determinism via seed, difficulty
 * variation, batch generation, template registration, difficulty estimation,
 * grading, validation, filtering, and persistence roundtrip.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-synthetic-tasks-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  TASK_TEMPLATES,
  registerTemplate,
  listTemplates,
  generateTask,
  generateBatch,
  estimateDifficulty,
  gradeByExpectedTime,
  validateTask,
  seededRandom,
  saveTaskSet,
  getTaskSet,
  listTaskSets,
  filterByDifficulty,
  filterByTemplate,
} = await import("../lib/synthetic-tasks.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

// ─── Template catalog ──────────────────────────────────────────────────────

test("TASK_TEMPLATES has all required built-in templates", () => {
  const expected = [
    "arithmetic",
    "word_problem",
    "sequence_completion",
    "ordering",
    "set_operations",
    "logic_puzzle",
    "string_manipulation",
    "pattern_matching",
  ];
  for (const name of expected) {
    assert.ok(TASK_TEMPLATES[name], `template ${name} missing`);
    assert.equal(typeof TASK_TEMPLATES[name].generate, "function");
  }
  assert.ok(listTemplates().length >= expected.length);
});

// ─── generateTask shape ────────────────────────────────────────────────────

test("generateTask returns a valid task shape", async () => {
  const task = await generateTask("arithmetic", 2, { seed: 42 });
  assert.ok(task.id && typeof task.id === "string");
  assert.equal(task.template, "arithmetic");
  assert.equal(task.difficulty, 2);
  assert.equal(typeof task.input, "string");
  assert.ok(task.input.length > 0);
  assert.equal(typeof task.expected, "string");
  assert.ok(task.metadata && typeof task.metadata === "object");
});

// ─── Determinism ───────────────────────────────────────────────────────────

test("same seed produces same task", async () => {
  const a = await generateTask("sequence_completion", 3, { seed: 123 });
  const b = await generateTask("sequence_completion", 3, { seed: 123 });
  assert.equal(a.input, b.input);
  assert.equal(a.expected, b.expected);
});

test("different seeds produce different tasks (usually)", async () => {
  const a = await generateTask("arithmetic", 4, { seed: 1 });
  const b = await generateTask("arithmetic", 4, { seed: 999 });
  assert.notEqual(a.input, b.input);
});

// ─── Difficulty variation ──────────────────────────────────────────────────

test("different difficulties produce different complexity", async () => {
  const easy = await generateTask("arithmetic", 1, { seed: 42 });
  const hard = await generateTask("arithmetic", 5, { seed: 42 });
  // Easier tasks generally have shorter input; at minimum they should differ.
  assert.notEqual(easy.input, hard.input);
  // Hard arithmetic should have at least as many operations as easy
  const easyOps = (easy.metadata.operations || []).length;
  const hardOps = (hard.metadata.operations || []).length;
  assert.ok(hardOps >= easyOps);
});

// ─── Batch generation ──────────────────────────────────────────────────────

test("generateBatch produces N tasks", async () => {
  const tasks = await generateBatch(10, { seed: 7 });
  assert.equal(tasks.length, 10);
  for (const t of tasks) {
    const { ok } = validateTask(t);
    assert.ok(ok);
  }
});

test("generateBatch respects template filter and difficulty bounds", async () => {
  const tasks = await generateBatch(5, {
    seed: "repeatable",
    templates: ["arithmetic", "ordering"],
    minDifficulty: 2,
    maxDifficulty: 3,
  });
  assert.equal(tasks.length, 5);
  for (const t of tasks) {
    assert.ok(["arithmetic", "ordering"].includes(t.template));
    assert.ok(t.difficulty >= 2 && t.difficulty <= 3);
  }
});

test("generateBatch with count=0 returns empty array", async () => {
  const tasks = await generateBatch(0);
  assert.deepEqual(tasks, []);
  const none = await generateBatch(-1);
  assert.deepEqual(none, []);
});

// ─── registerTemplate ──────────────────────────────────────────────────────

test("registerTemplate adds a custom template", async () => {
  registerTemplate("echo_test", {
    difficulties: [1, 2],
    generate: (d) => ({
      input: `echo ${d}`,
      expected: String(d),
      metadata: { echoed: true },
    }),
  });
  const task = await generateTask("echo_test", 2, { seed: 1 });
  assert.equal(task.template, "echo_test");
  assert.equal(task.expected, "2");
  assert.equal(task.metadata.echoed, true);
  assert.ok(listTemplates().some((t) => t.name === "echo_test"));
});

test("registerTemplate rejects malformed input", () => {
  assert.throws(() => registerTemplate("", { generate: () => ({ input: "a", expected: "b" }) }));
  assert.throws(() => registerTemplate("bad", {}));
  assert.throws(() => registerTemplate("bad", { generate: "not-a-function" }));
});

// ─── estimateDifficulty ────────────────────────────────────────────────────

test("estimateDifficulty returns an integer in 1..5", async () => {
  for (const name of Object.keys(TASK_TEMPLATES)) {
    for (const d of [1, 3, 5]) {
      const task = await generateTask(name, d, { seed: 11 });
      const est = estimateDifficulty(task);
      assert.ok(Number.isInteger(est));
      assert.ok(est >= 1 && est <= 5, `estimate ${est} out of range for ${name}/${d}`);
    }
  }
});

test("estimateDifficulty increases with task complexity", async () => {
  const easy = await generateTask("word_problem", 1, { seed: 5 });
  const hard = await generateTask("word_problem", 5, { seed: 5 });
  const easyEst = estimateDifficulty(easy);
  const hardEst = estimateDifficulty(hard);
  assert.ok(hardEst >= easyEst);
});

// ─── gradeByExpectedTime ───────────────────────────────────────────────────

test("gradeByExpectedTime scales with difficulty", () => {
  const t1 = gradeByExpectedTime(1);
  const t5 = gradeByExpectedTime(5);
  assert.ok(t1 > 0);
  assert.ok(t5 > t1);
  // Monotonic
  for (let d = 1; d < 5; d++) {
    assert.ok(gradeByExpectedTime(d + 1) > gradeByExpectedTime(d));
  }
  // Clamps
  assert.equal(gradeByExpectedTime(0), gradeByExpectedTime(1));
  assert.equal(gradeByExpectedTime(10), gradeByExpectedTime(5));
});

// ─── validateTask ──────────────────────────────────────────────────────────

test("validateTask rejects malformed tasks", () => {
  assert.equal(validateTask(null).ok, false);
  assert.equal(validateTask({}).ok, false);
  assert.equal(
    validateTask({ id: "x", template: "t", difficulty: 3, input: "", expected: "y" }).ok,
    false,
  );
  assert.equal(
    validateTask({ id: "x", template: "t", difficulty: 9, input: "q", expected: "y" }).ok,
    false,
  );
  assert.equal(
    validateTask({ id: "x", template: "t", difficulty: 3, input: "q", expected: "y" }).ok,
    true,
  );
});

// ─── seededRandom ──────────────────────────────────────────────────────────

test("seededRandom is reproducible for same seed", () => {
  const a = seededRandom(12345);
  const b = seededRandom(12345);
  for (let i = 0; i < 20; i++) {
    assert.equal(a(), b());
  }
});

test("seededRandom helpers work", () => {
  const r = seededRandom("string-seed");
  const n = r.int(1, 10);
  assert.ok(n >= 1 && n <= 10);
  const pick = r.pick(["a", "b", "c"]);
  assert.ok(["a", "b", "c"].includes(pick));
  assert.equal(typeof r.bool(), "boolean");
  const arr = r.shuffle([1, 2, 3, 4, 5]);
  assert.equal(arr.length, 5);
});

// ─── Persistence ───────────────────────────────────────────────────────────

test("saveTaskSet/getTaskSet roundtrip", async () => {
  const tasks = await generateBatch(3, { seed: "persist-test" });
  await saveTaskSet("my-set", tasks, { description: "test set" });
  const loaded = await getTaskSet("my-set");
  assert.ok(loaded);
  assert.equal(loaded.tasks.length, 3);
  assert.equal(loaded.description, "test set");
  assert.deepEqual(loaded.tasks[0].id, tasks[0].id);
});

test("listTaskSets returns summaries", async () => {
  const tasks = await generateBatch(2, { seed: "list-test" });
  await saveTaskSet("listable", tasks);
  const all = await listTaskSets();
  const found = all.find((s) => s.name === "listable");
  assert.ok(found);
  assert.equal(found.taskCount, 2);
});

test("saveTaskSet rejects invalid tasks", async () => {
  await assert.rejects(() => saveTaskSet("bad", [{ id: "x" }]));
  await assert.rejects(() => saveTaskSet("", []));
  await assert.rejects(() => saveTaskSet("ok", "not-array"));
});

// ─── Filtering ─────────────────────────────────────────────────────────────

test("filterByDifficulty selects inclusive range", async () => {
  const tasks = [
    await generateTask("arithmetic", 1, { seed: 1 }),
    await generateTask("arithmetic", 3, { seed: 2 }),
    await generateTask("arithmetic", 5, { seed: 3 }),
  ];
  const mid = filterByDifficulty(tasks, 2, 4);
  assert.equal(mid.length, 1);
  assert.equal(mid[0].difficulty, 3);
  const all = filterByDifficulty(tasks, 1, 5);
  assert.equal(all.length, 3);
});

test("filterByTemplate selects by template name", async () => {
  const tasks = [
    await generateTask("arithmetic", 2, { seed: 1 }),
    await generateTask("ordering", 2, { seed: 2 }),
    await generateTask("pattern_matching", 2, { seed: 3 }),
  ];
  const subset = filterByTemplate(tasks, ["arithmetic", "ordering"]);
  assert.equal(subset.length, 2);
  const empty = filterByTemplate(tasks, []);
  assert.equal(empty.length, 3);
});

// ─── Each built-in template produces a valid task ──────────────────────────

test("each built-in template produces a valid task at every difficulty", async () => {
  for (const name of Object.keys(TASK_TEMPLATES)) {
    for (const d of [1, 2, 3, 4, 5]) {
      const task = await generateTask(name, d, { seed: `${name}-${d}` });
      const { ok, errors } = validateTask(task);
      assert.ok(ok, `${name} at d=${d} invalid: ${errors.join(", ")}`);
    }
  }
});

test("generateTask rejects unknown template", async () => {
  await assert.rejects(() => generateTask("no_such_template", 3, { seed: 1 }));
});
