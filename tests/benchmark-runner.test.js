/**
 * Phase 56.2: Benchmark runner tests.
 *
 * Covers fixture listing, custom fixture registration, graders,
 * injected model runner, run execution, history, and compareRuns().
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-benchmark-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  listBenchmarks,
  runBenchmark,
  getBenchmarkHistory,
  compareRuns,
  registerBenchmark,
  setModelRunner,
  gradeItem,
  getFixture,
  _clearRuns,
} = await import("../lib/benchmark-runner.js");

test.after(() => {
  setModelRunner(null);
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

/* -------------------------------------------------------------------------- */

test("listBenchmarks returns the built-in suites", () => {
  const list = listBenchmarks();
  const names = list.map((b) => b.name).sort();
  assert.ok(names.includes("mmlu"));
  assert.ok(names.includes("humaneval"));
  assert.ok(names.includes("swebench"));
  assert.ok(names.includes("gsm8k"));
  for (const b of list) {
    assert.ok(b.itemCount > 0);
  }
});

test("gradeItem supports exact, contains, numeric, code graders", () => {
  assert.equal(gradeItem({ expected: "A", grader: "exact" }, "A").correct, true);
  assert.equal(gradeItem({ expected: "A", grader: "exact" }, "B").correct, false);
  assert.equal(gradeItem({ expected: "return a + b", grader: "contains" }, "def add(a,b): return a + b").correct, true);
  assert.equal(gradeItem({ expected: "50", grader: "numeric" }, "Answer: 50").correct, true);
  assert.equal(gradeItem({ expected: "50", grader: "numeric" }, "Answer: 51").correct, false);
  assert.equal(gradeItem({ expected: "foo()", grader: "code" }, "call foo() now").correct, true);
});

test("registerBenchmark accepts a custom fixture and runBenchmark uses it", async () => {
  registerBenchmark("tiny", {
    description: "custom",
    items: [
      { id: "t-1", prompt: "1+1?", expected: "2", grader: "numeric" },
      { id: "t-2", prompt: "2+2?", expected: "4", grader: "numeric" },
    ],
  });
  assert.ok(getFixture("tiny"));
  setModelRunner(async (prompt) => {
    if (prompt.includes("1+1")) return "2";
    if (prompt.includes("2+2")) return "4";
    return "?";
  });
  const run = await runBenchmark("tiny", { model: "fake" });
  assert.equal(run.total, 2);
  assert.equal(run.correct, 2);
  assert.equal(run.score, 1);
  assert.equal(run.benchmark, "tiny");
  assert.ok(run.runId.startsWith("run_"));
});

test("runBenchmark records category breakdown and per-item results", async () => {
  setModelRunner(async (prompt) => {
    // Always pick A
    if (prompt.includes("capital of France")) return "A";
    return "A";
  });
  const run = await runBenchmark("mmlu", { model: "picky" });
  assert.ok(run.total >= 4);
  // At least one correct (capital of France is A)
  assert.ok(run.correct >= 1);
  assert.ok(run.byCategory && Object.keys(run.byCategory).length > 0);
  assert.ok(run.items.every((i) => typeof i.correct === "boolean"));
});

test("runBenchmark rejects unknown benchmark names", async () => {
  await assert.rejects(() => runBenchmark("nope"), /unknown benchmark/);
  await assert.rejects(() => runBenchmark(""), /required/);
});

test("runBenchmark honors limit option", async () => {
  setModelRunner(async () => "wrong");
  const run = await runBenchmark("humaneval", { limit: 2 });
  assert.equal(run.total, 2);
  assert.equal(run.items.length, 2);
});

test("getBenchmarkHistory returns persisted runs", async () => {
  const hist = await getBenchmarkHistory("tiny");
  assert.ok(Array.isArray(hist));
  assert.ok(hist.length >= 1);
  const all = await getBenchmarkHistory();
  assert.ok(typeof all === "object");
  assert.ok(Array.isArray(all.tiny));
});

test("compareRuns produces a delta with regressions and improvements", async () => {
  await _clearRuns();
  registerBenchmark("tiny2", {
    items: [
      { id: "q1", prompt: "say foo", expected: "foo", grader: "exact" },
      { id: "q2", prompt: "say bar", expected: "bar", grader: "exact" },
    ],
  });
  setModelRunner(async (p) => {
    if (p.includes("foo")) return "foo";
    if (p.includes("bar")) return "WRONG";
    return "";
  });
  const a = await runBenchmark("tiny2", { model: "m1" });
  setModelRunner(async (p) => {
    if (p.includes("foo")) return "WRONG";
    if (p.includes("bar")) return "bar";
    return "";
  });
  const b = await runBenchmark("tiny2", { model: "m2" });
  const cmp = await compareRuns(a.runId, b.runId);
  assert.equal(cmp.modelA, "m1");
  assert.equal(cmp.modelB, "m2");
  assert.ok(cmp.regressions.includes("q1"));
  assert.ok(cmp.improvements.includes("q2"));
  assert.equal(cmp.scoreDelta, 0);
});

test("compareRuns rejects missing run ids", async () => {
  await assert.rejects(() => compareRuns("missing_a", "missing_b"), /not found/);
  await assert.rejects(() => compareRuns("", ""), /required/);
});

test("runBenchmark tolerates runner exceptions and marks items wrong", async () => {
  setModelRunner(async () => {
    throw new Error("backend down");
  });
  const run = await runBenchmark("gsm8k", { limit: 2 });
  assert.equal(run.total, 2);
  assert.equal(run.correct, 0);
  assert.ok(run.items[0].response.includes("runner error"));
});
