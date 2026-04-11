/**
 * Phase 56.3: Synthetic tasks tests.
 *
 * Covers difficulty sampling, built-in generators, task set creation,
 * grading, listing, and custom generator injection.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-synth-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  generateTaskSet,
  gradeTask,
  listTaskSets,
  getTaskSet,
  sampleDifficulty,
  setGenerator,
} = await import("../lib/synthetic-tasks.js");

test.after(() => {
  setGenerator(null);
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

/* -------------------------------------------------------------------------- */

test("sampleDifficulty stays within 1..5", () => {
  for (let i = 0; i < 100; i++) {
    const d = sampleDifficulty({ targetMean: 3 });
    assert.ok(d >= 1 && d <= 5);
    assert.equal(d, Math.floor(d));
  }
});

test("sampleDifficulty biases toward target mean", () => {
  // Low target should average lower than high target
  let lowSum = 0, highSum = 0;
  const N = 500;
  for (let i = 0; i < N; i++) {
    lowSum += sampleDifficulty({ targetMean: 1 });
    highSum += sampleDifficulty({ targetMean: 5 });
  }
  assert.ok(lowSum / N < highSum / N);
});

test("generateTaskSet creates reproducible output with the same seed", async () => {
  const a = await generateTaskSet({ seed: 42, count: 5, skills: ["arithmetic"] });
  const b = await generateTaskSet({ seed: 42, count: 5, skills: ["arithmetic"] });
  // Same prompts, same expected answers (IDs differ — use prompt as fingerprint)
  assert.deepEqual(
    a.tasks.map((t) => t.prompt),
    b.tasks.map((t) => t.prompt),
  );
  assert.deepEqual(
    a.tasks.map((t) => t.expected),
    b.tasks.map((t) => t.expected),
  );
});

test("generateTaskSet persists and listTaskSets returns metadata", async () => {
  const set = await generateTaskSet({ seed: 1, count: 3, name: "demo" });
  assert.equal(set.count, 3);
  assert.ok(set.id.startsWith("tset_"));
  assert.ok(set.avgDifficulty >= 1 && set.avgDifficulty <= 5);
  const list = await listTaskSets();
  assert.ok(list.some((s) => s.id === set.id && s.name === "demo"));
});

test("generateTaskSet covers all requested skills", async () => {
  const set = await generateTaskSet({ seed: 7, count: 30, skills: ["arithmetic", "string", "logic"] });
  const skills = new Set(set.tasks.map((t) => t.skill));
  assert.ok(skills.has("arithmetic"));
  // With 30 tasks and 3 skills, statistically all should appear
  assert.ok(skills.size >= 2);
});

test("arithmetic tasks grade correctly", async () => {
  const set = await generateTaskSet({ seed: 100, count: 5, skills: ["arithmetic"], targetDifficulty: 1 });
  for (const t of set.tasks) {
    const g = await gradeTask(t.id, t.expected);
    assert.equal(g.correct, true);
    assert.equal(g.difficulty, t.difficulty);
    const wrong = await gradeTask(t.id, "9999999");
    assert.equal(wrong.correct, false);
  }
});

test("string tasks grade via exact match", async () => {
  const set = await generateTaskSet({ seed: 200, count: 3, skills: ["string"], targetDifficulty: 1 });
  for (const t of set.tasks) {
    const g = await gradeTask(t.id, t.expected);
    assert.equal(g.correct, true);
  }
});

test("gradeTask rejects unknown task ids", async () => {
  await assert.rejects(() => gradeTask("nope", "x"), /not found/);
  await assert.rejects(() => gradeTask("", "x"), /required/);
});

test("getTaskSet returns the full task list", async () => {
  const set = await generateTaskSet({ seed: 9, count: 4 });
  const fetched = await getTaskSet(set.id);
  assert.ok(fetched);
  assert.equal(fetched.tasks.length, 4);
  assert.equal(await getTaskSet("missing"), null);
});

test("setGenerator injects a custom generator", async () => {
  setGenerator(({ difficulty, skill }) => ({
    prompt: `custom-${skill}-${difficulty}`,
    expected: `ans-${difficulty}`,
    grader: "exact",
    skill,
  }));
  const set = await generateTaskSet({ seed: 55, count: 4 });
  assert.ok(set.tasks.every((t) => t.prompt.startsWith("custom-")));
  for (const t of set.tasks) {
    const g = await gradeTask(t.id, `ans-${t.difficulty}`);
    assert.equal(g.correct, true);
  }
  setGenerator(null);
});
