/**
 * Phase 56.2: benchmark-runner unit tests.
 * Uses a temp STORAGE_PATH so tests don't touch the real data/ directory.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "siskelbot-benchmark-runner-"));
process.env.STORAGE_PATH = tempDir;

const {
  BENCHMARK_TYPES,
  SCORERS,
  registerScorer,
  scoreCase,
  loadBenchmark,
  saveBenchmark,
  deleteBenchmark,
  listBenchmarks,
  runBenchmark,
  recordRun,
  getRunHistory,
  getLatestRun,
  compareRuns,
  formatReport,
} = await import("../lib/benchmark-runner.js");

test.after(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

// ─── Type registry ────────────────────────────────────────────────────────────

test("BENCHMARK_TYPES contains all documented standard types", () => {
  for (const t of ["multiple_choice", "code_completion", "math_word", "issue_resolution", "custom"]) {
    assert.ok(BENCHMARK_TYPES[t], `missing type ${t}`);
    assert.ok(BENCHMARK_TYPES[t].label);
    assert.ok(BENCHMARK_TYPES[t].defaultScorer);
  }
});

// ─── loadBenchmark from inline JSONL ──────────────────────────────────────────

test("loadBenchmark parses inline JSONL text", async () => {
  const jsonl = [
    JSON.stringify({ id: "q1", input: { question: "2+2?" }, expected: "4" }),
    JSON.stringify({ id: "q2", input: { question: "3+3?" }, expected: "6" }),
  ].join("\n");
  const bench = await loadBenchmark("inline-math", jsonl, { inline: true, type: "math_word" });
  assert.equal(bench.name, "inline-math");
  assert.equal(bench.type, "math_word");
  assert.equal(bench.cases.length, 2);
  assert.equal(bench.cases[0].expected, "4");
});

test("loadBenchmark rejects malformed JSONL", async () => {
  await assert.rejects(
    () => loadBenchmark("bad", "this is not json\n", { inline: true }),
    /invalid JSONL/
  );
});

// ─── save / list / delete ─────────────────────────────────────────────────────

test("saveBenchmark persists and listBenchmarks returns it", async () => {
  const cases = [
    { id: "c1", input: { question: "Q1" }, expected: "A" },
    { id: "c2", input: { question: "Q2" }, expected: "B" },
  ];
  const saved = await saveBenchmark("mmlu-mini", { type: "multiple_choice", cases });
  assert.equal(saved.name, "mmlu-mini");
  assert.equal(saved.cases.length, 2);

  const items = await listBenchmarks();
  const found = items.find((b) => b.name === "mmlu-mini");
  assert.ok(found);
  assert.equal(found.cases, 2);
  assert.equal(found.type, "multiple_choice");
});

test("loadBenchmark fetches a saved benchmark", async () => {
  const loaded = await loadBenchmark("mmlu-mini");
  assert.ok(loaded);
  assert.equal(loaded.type, "multiple_choice");
  assert.equal(loaded.cases[0].id, "c1");
});

test("deleteBenchmark removes a saved benchmark", async () => {
  await saveBenchmark("tmp-delete", { type: "custom", cases: [{ id: "x", input: "x", expected: "x" }] });
  const before = (await listBenchmarks()).some((b) => b.name === "tmp-delete");
  assert.equal(before, true);
  const result = await deleteBenchmark("tmp-delete");
  assert.equal(result.deleted, true);
  const after = await loadBenchmark("tmp-delete");
  assert.equal(after, null);
});

test("deleteBenchmark returns deleted:false for unknown name", async () => {
  const r = await deleteBenchmark("does-not-exist");
  assert.equal(r.deleted, false);
});

// ─── Scorers ──────────────────────────────────────────────────────────────────

test("all built-in SCORERS return correct booleans", () => {
  assert.equal(SCORERS.exact_match("hello", "hello"), true);
  assert.equal(SCORERS.exact_match("hello ", " hello"), true);
  assert.equal(SCORERS.exact_match("hello", "bye"), false);

  assert.equal(SCORERS.regex("the answer is 42", "\\d+"), true);
  assert.equal(SCORERS.regex("no digits", "\\d+"), false);

  assert.equal(SCORERS.multiple_choice_letter("The answer is B.", "B"), true);
  assert.equal(SCORERS.multiple_choice_letter("I think A", "B"), false);
  assert.equal(SCORERS.multiple_choice_letter("no letter", "C"), false);

  assert.equal(SCORERS.numeric("The answer is 3.14", "3.14"), true);
  assert.equal(SCORERS.numeric("answer: 1,234", "1234"), true);
  assert.equal(SCORERS.numeric("not a number", "5"), false);

  assert.equal(SCORERS.contains("hello world", "world"), true);
  assert.equal(SCORERS.contains("hello", "world"), false);

  assert.equal(SCORERS.jsonEqual('{"a":1,"b":[1,2]}', { a: 1, b: [1, 2] }), true);
  assert.equal(SCORERS.jsonEqual('{"a":2}', { a: 1 }), false);
  assert.equal(SCORERS.jsonEqual("not-json", { a: 1 }), false);
});

test("registerScorer adds a custom scorer usable via scoreCase", () => {
  registerScorer("starts_with", (out, exp) => String(out).startsWith(String(exp)));
  const { pass } = scoreCase({ expected: "hello" }, "hello world", "starts_with");
  assert.equal(pass, true);
  const { pass: pass2 } = scoreCase({ expected: "bye" }, "hello world", "starts_with");
  assert.equal(pass2, false);
});

test("scoreCase rejects unknown scorer name", () => {
  assert.throws(
    () => scoreCase({ expected: "x" }, "x", "not-a-real-scorer"),
    /unknown scorer/
  );
});

// ─── runBenchmark ─────────────────────────────────────────────────────────────

test("runBenchmark with echo target and exact_match scorer", async () => {
  await saveBenchmark("echo-bench", {
    type: "custom",
    cases: [
      { id: "a", input: "hello", expected: "hello" },
      { id: "b", input: "world", expected: "nope" },
    ],
  });
  const result = await runBenchmark("echo-bench", (tc) => tc.input, { scorer: "exact_match" });
  assert.equal(result.total, 2);
  assert.equal(result.correct, 1);
  assert.equal(result.score, 0.5);
  assert.equal(result.perCase[0].pass, true);
  assert.equal(result.perCase[1].pass, false);
  assert.ok(result.runId);
});

test("runBenchmark honors maxCases limit", async () => {
  const result = await runBenchmark("mmlu-mini", () => "A", {
    scorer: "exact_match",
    maxCases: 1,
  });
  assert.equal(result.total, 1);
});

test("runBenchmark honors concurrency (all cases still execute)", async () => {
  const cases = Array.from({ length: 10 }, (_, i) => ({
    id: `c${i}`,
    input: String(i),
    expected: String(i),
  }));
  await saveBenchmark("concurrency-bench", { type: "custom", cases });
  const inflightPeaks = { value: 0, current: 0 };
  const target = async (tc) => {
    inflightPeaks.current++;
    inflightPeaks.value = Math.max(inflightPeaks.value, inflightPeaks.current);
    await new Promise((r) => setTimeout(r, 5));
    inflightPeaks.current--;
    return tc.input;
  };
  const result = await runBenchmark("concurrency-bench", target, {
    concurrency: 4,
    scorer: "exact_match",
  });
  assert.equal(result.total, 10);
  assert.equal(result.correct, 10);
  assert.ok(inflightPeaks.value > 1, "concurrency should allow >1 inflight");
  assert.ok(inflightPeaks.value <= 4, "concurrency should cap at configured value");
});

test("runBenchmark rejects unknown scorer", async () => {
  await assert.rejects(
    () => runBenchmark("echo-bench", () => "x", { scorer: "no-such-scorer" }),
    /unknown scorer/
  );
});

test("runBenchmark handles empty benchmark gracefully", async () => {
  await saveBenchmark("empty-bench", { type: "custom", cases: [] });
  const result = await runBenchmark("empty-bench", () => "x", { scorer: "exact_match" });
  assert.equal(result.total, 0);
  assert.equal(result.correct, 0);
  assert.equal(result.score, 0);
});

test("runBenchmark records thrown target errors as failed cases", async () => {
  await saveBenchmark("err-bench", {
    type: "custom",
    cases: [{ id: "e1", input: "x", expected: "x" }],
  });
  const result = await runBenchmark("err-bench", () => { throw new Error("boom"); }, {
    scorer: "exact_match",
  });
  assert.equal(result.correct, 0);
  assert.equal(result.perCase[0].pass, false);
  assert.match(result.perCase[0].error || "", /boom/);
});

// ─── Run history ──────────────────────────────────────────────────────────────

test("recordRun persists and getRunHistory returns it", async () => {
  const run = await runBenchmark("echo-bench", (tc) => tc.input, { scorer: "exact_match" });
  const saved = await recordRun(run);
  assert.equal(saved.runId, run.runId);
  assert.equal(saved.benchmarkName, "echo-bench");

  const all = await getRunHistory();
  assert.ok(all.some((r) => r.runId === run.runId));

  const filtered = await getRunHistory("echo-bench");
  assert.ok(filtered.every((r) => r.benchmarkName === "echo-bench"));
  assert.ok(filtered.length >= 1);
});

test("getLatestRun returns the most recent entry for a benchmark", async () => {
  const r1 = await runBenchmark("echo-bench", () => "hello", { scorer: "exact_match" });
  await recordRun(r1);
  const r2 = await runBenchmark("echo-bench", () => "world", { scorer: "exact_match" });
  await recordRun(r2);
  const latest = await getLatestRun("echo-bench");
  assert.equal(latest.runId, r2.runId);
});

// ─── compareRuns ──────────────────────────────────────────────────────────────

test("compareRuns reports score delta and improved/regressed ids", () => {
  const runA = {
    runId: "A",
    benchmarkName: "x",
    score: 0.5,
    correct: 1,
    total: 2,
    durationMs: 100,
    perCase: [
      { id: "q1", pass: true },
      { id: "q2", pass: false },
    ],
  };
  const runB = {
    runId: "B",
    benchmarkName: "x",
    score: 1.0,
    correct: 2,
    total: 2,
    durationMs: 120,
    perCase: [
      { id: "q1", pass: true },
      { id: "q2", pass: true },
    ],
  };
  const diff = compareRuns(runA, runB);
  assert.equal(diff.scoreDelta, 0.5);
  assert.equal(diff.correctDelta, 1);
  assert.equal(diff.durationDelta, 20);
  assert.deepEqual(diff.improved, ["q2"]);
  assert.deepEqual(diff.regressed, []);
  assert.deepEqual(diff.unchanged, ["q1"]);
});

// ─── formatReport ─────────────────────────────────────────────────────────────

test("formatReport text includes score and failures", () => {
  const run = {
    benchmarkName: "demo",
    type: "custom",
    scorer: "exact_match",
    total: 2,
    correct: 1,
    score: 0.5,
    durationMs: 42,
    startedAt: "2026-01-01T00:00:00Z",
    perCase: [
      { id: "ok", pass: true, output: "x", expected: "x" },
      { id: "bad", pass: false, output: "y", expected: "x" },
    ],
  };
  const text = formatReport(run, "text");
  assert.match(text, /demo/);
  assert.match(text, /1\/2/);
  assert.match(text, /50\.00%/);
  assert.match(text, /bad/);
});

test("formatReport json emits parseable JSON with failures", () => {
  const run = {
    benchmarkName: "demo-json",
    total: 1,
    correct: 0,
    score: 0,
    perCase: [{ id: "f1", pass: false, output: "", expected: "x", error: "boom" }],
  };
  const json = formatReport(run, "json");
  const parsed = JSON.parse(json);
  assert.equal(parsed.benchmarkName, "demo-json");
  assert.equal(parsed.failures.length, 1);
  assert.equal(parsed.failures[0].id, "f1");
  assert.equal(parsed.failures[0].error, "boom");
});

// ─── Route module imports cleanly ─────────────────────────────────────────────

test("route module imports and mounts without throwing", async () => {
  const { mountBenchmarkRunnerRoutes } = await import("../routes/benchmark-runner.js");
  assert.equal(typeof mountBenchmarkRunnerRoutes, "function");

  const registered = [];
  const fakeApp = {};
  const apiRoute = (method, path, ..._handlers) => {
    registered.push(`${method.toUpperCase()} ${path}`);
  };
  const apiError = (res, status, code, message) => ({ status, code, message });
  const logRequest = (_req, _res, next) => (next ? next() : undefined);
  mountBenchmarkRunnerRoutes(fakeApp, { apiRoute, apiError, logRequest });

  assert.ok(registered.includes("POST /benchmark/save"));
  assert.ok(registered.includes("GET /benchmarks"));
  assert.ok(registered.includes("POST /benchmark/:name/run"));
  assert.ok(registered.includes("GET /benchmark/runs"));
  assert.ok(registered.includes("POST /benchmark/compare"));
});
