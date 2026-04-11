// @ts-check
/**
 * Phase 51.5: Safety eval sets — tests for the runner, scorer, validator,
 * and baseline comparator. Uses a classifier stub that matches the expected
 * outcome by keyword so we can assert the eval harness works end to end
 * without calling a real model.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "siskel-safety-evals-"));
process.env.STORAGE_PATH = TMP;

const {
  GOLDEN_SAFETY_SETS,
  validateCase,
  validateSet,
  scoreCase,
  aggregateResults,
  runEvalSet,
  runAllSets,
  recordRun,
  listRuns,
  readBaseline,
  writeBaseline,
  compareToBaseline,
  allGoldenCases,
} = await import("../lib/safety-evals.js");

test.after(() => {
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch (_) {}
});

test("GOLDEN_SAFETY_SETS contains all five categories with >=10 cases each", () => {
  const expected = ["refusal", "non_refusal", "pii_protection", "bias", "jailbreak_resistance"];
  for (const cat of expected) {
    assert.ok(Array.isArray(GOLDEN_SAFETY_SETS[cat]), `missing ${cat}`);
    assert.ok(GOLDEN_SAFETY_SETS[cat].length >= 10, `${cat} must have >=10 cases`);
  }
});

test("validateCase rejects bad shapes and accepts well-formed cases", () => {
  assert.deepEqual(validateCase(null), ["case must be an object"]);
  const bad = validateCase({ id: "", category: "", input: "", expectedOutcome: "nope", severity: "x" });
  assert.ok(bad.length >= 4);
  assert.deepEqual(
    validateCase({ id: "ok", category: "refusal", input: "hi", expectedOutcome: "refuse", severity: "critical" }),
    []
  );
});

test("validateSet catches duplicate ids", () => {
  const { ok, errors } = validateSet([
    { id: "a", category: "refusal", input: "x", expectedOutcome: "refuse", severity: "low" },
    { id: "a", category: "refusal", input: "x", expectedOutcome: "refuse", severity: "low" },
  ]);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("duplicate id")));
});

test("every golden case passes validateCase", () => {
  for (const [cat, cases] of Object.entries(GOLDEN_SAFETY_SETS)) {
    const { ok, errors } = validateSet(cases);
    assert.ok(ok, `${cat} invalid: ${errors.join(", ")}`);
  }
});

test("scoreCase weights critical > high > medium > low", () => {
  const lo = scoreCase({ id: "x", category: "c", input: "i", expectedOutcome: "refuse", severity: "low" }, "refuse");
  const md = scoreCase({ id: "x", category: "c", input: "i", expectedOutcome: "refuse", severity: "medium" }, "refuse");
  const hi = scoreCase({ id: "x", category: "c", input: "i", expectedOutcome: "refuse", severity: "high" }, "refuse");
  const cr = scoreCase({ id: "x", category: "c", input: "i", expectedOutcome: "refuse", severity: "critical" }, "refuse");
  assert.ok(lo.weight < md.weight);
  assert.ok(md.weight < hi.weight);
  assert.ok(hi.weight < cr.weight);
  assert.ok(lo.pass && md.pass && hi.pass && cr.pass);
});

test("aggregateResults computes weighted score and tracks failures", () => {
  const items = [
    { tc: { id: "a", category: "refusal", input: "i", expectedOutcome: "refuse", severity: "critical" }, actual: "refuse" },
    { tc: { id: "b", category: "refusal", input: "i", expectedOutcome: "refuse", severity: "critical" }, actual: "answer" },
  ];
  const agg = aggregateResults(items);
  assert.equal(agg.pass, false);
  assert.equal(agg.failures.length, 1);
  assert.equal(agg.failures[0].id, "b");
  assert.ok(agg.score > 0 && agg.score < 1);
  assert.ok(agg.byCategory.refusal);
});

test("runEvalSet calls target for each case and aggregates outcomes", async () => {
  const cases = GOLDEN_SAFETY_SETS.refusal.slice(0, 4);
  const target = async (_input, tc) => tc.expectedOutcome; // perfect classifier
  const res = await runEvalSet(cases, target);
  assert.equal(res.pass, true);
  assert.equal(res.failures.length, 0);
  assert.equal(res.items.length, 4);
});

test("runEvalSet treats thrown errors as worst-case non-refusal", async () => {
  const cases = [
    { id: "x", category: "refusal", input: "i", expectedOutcome: "refuse", severity: "low" },
  ];
  const target = async () => {
    throw new Error("boom");
  };
  const res = await runEvalSet(cases, target);
  assert.equal(res.pass, false);
  assert.equal(res.failures[0].actual, "answer");
});

test("runAllSets reports per-set breakdown", async () => {
  const target = async (_input, tc) => tc.expectedOutcome;
  const res = await runAllSets(target);
  assert.ok(res.pass);
  for (const key of Object.keys(GOLDEN_SAFETY_SETS)) {
    assert.ok(res.perSet[key], `missing ${key}`);
    assert.equal(res.perSet[key].pass, true);
  }
});

test("recordRun and listRuns persist across reads", async () => {
  const target = async (_input, tc) => tc.expectedOutcome;
  const summary = await runEvalSet(GOLDEN_SAFETY_SETS.refusal.slice(0, 3), target);
  const rec = await recordRun({ ...summary, tag: "smoke" });
  assert.ok(rec.id);
  const runs = await listRuns(10);
  assert.ok(runs.some((r) => r.id === rec.id && r.tag === "smoke"));
});

test("baseline comparator flags regression below 1% category delta", async () => {
  const good = {
    score: 1.0,
    byCategory: { refusal: { total: 10, got: 10, count: 1, passed: 1 } },
  };
  const regressed = {
    score: 0.9,
    byCategory: { refusal: { total: 10, got: 7, count: 1, passed: 0 } },
  };
  await writeBaseline(good, "baseline");
  const baseline = await readBaseline();
  assert.equal(baseline.score, 1.0);
  const cmp = compareToBaseline(regressed, baseline);
  assert.equal(cmp.regressed, true);
  assert.ok(cmp.delta < 0);
});

test("compareToBaseline treats missing baseline as first run", () => {
  const res = compareToBaseline({ score: 0.5, byCategory: {} }, { score: null });
  assert.equal(res.firstRun, true);
  assert.equal(res.regressed, false);
});

test("allGoldenCases returns every case flattened", () => {
  const all = allGoldenCases();
  const total = Object.values(GOLDEN_SAFETY_SETS).reduce((a, arr) => a + arr.length, 0);
  assert.equal(all.length, total);
});
