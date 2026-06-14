/**
 * Phase 52.2: Self-consistency voting tests.
 *
 * Covers sampleMultiple, extractAnswer, normalizeAnswer, voteAnswers,
 * weightedVote, runSelfConsistency, analyzeAgreement, computeUncertainty,
 * pickHighestConfidence, and the run history persistence log.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-self-consistency-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  sampleMultiple,
  extractAnswer,
  normalizeAnswer,
  voteAnswers,
  weightedVote,
  plurality,
  majority,
  runSelfConsistency,
  analyzeAgreement,
  computeUncertainty,
  pickHighestConfidence,
  recordRun,
  getRunHistory,
} = await import("../lib/self-consistency.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ---- sampleMultiple ----

test("sampleMultiple returns N samples from mock sampler", async () => {
  const sampler = async (task, opts) => ({
    answer: `a${opts.sampleIndex}`,
    reasoning: `path ${opts.sampleIndex}`,
  });
  const samples = await sampleMultiple("task", sampler, 5);
  assert.equal(samples.length, 5);
  assert.equal(samples[0].answer, "a0");
  assert.equal(samples[4].answer, "a4");
  assert.ok(samples[0].sampleId);
});

test("sampleMultiple captures errors without throwing", async () => {
  const sampler = async (_t, { sampleIndex }) => {
    if (sampleIndex === 2) throw new Error("boom");
    return { answer: "ok", reasoning: "" };
  };
  const samples = await sampleMultiple("task", sampler, 4);
  assert.equal(samples.length, 4);
  assert.equal(samples[2].error, "boom");
  assert.equal(samples[2].answer, null);
});

test("sampleMultiple rejects non-function sampler", async () => {
  await assert.rejects(() => sampleMultiple("t", null, 3), /samplerFn/);
});

// ---- extractAnswer ----

test("extractAnswer auto: 'The answer is 42' -> '42'", () => {
  assert.equal(extractAnswer("The answer is 42"), "42");
});

test("extractAnswer auto handles 'Final answer: Paris.'", () => {
  assert.equal(extractAnswer("Final answer: Paris."), "Paris");
});

test("extractAnswer number format extracts numeric value", () => {
  assert.equal(extractAnswer("The answer is 42", "number"), 42);
  assert.equal(extractAnswer("I think 3.14 is the answer.", "number"), 3.14);
  assert.equal(extractAnswer("result: -17", "number"), -17);
});

test("extractAnswer JSON format parses embedded JSON", () => {
  const r1 = extractAnswer('{"name":"alice","n":7}', "json");
  assert.deepEqual(r1, { name: "alice", n: 7 });
  const r2 = extractAnswer(
    'Here is my answer:\n```json\n{"ok":true,"count":3}\n```',
    "json",
  );
  assert.deepEqual(r2, { ok: true, count: 3 });
  const r3 = extractAnswer("prose and then {\"x\":1} here", "json");
  assert.deepEqual(r3, { x: 1 });
});

test("extractAnswer regex format extracts via custom pattern", () => {
  const res = extractAnswer("Order #abc-123 was placed", {
    type: "regex",
    pattern: "#([a-z0-9-]+)",
    flags: "i",
  });
  assert.equal(res, "abc-123");
});

test("extractAnswer boolean detects yes/no", () => {
  assert.equal(extractAnswer("Yes, that is correct.", "boolean"), true);
  assert.equal(extractAnswer("No, false.", "boolean"), false);
});

test("extractAnswer choice picks from provided choices", () => {
  assert.equal(
    extractAnswer("I think the answer is apple", { type: "choice", choices: ["apple", "banana", "cherry"] }),
    "apple",
  );
  assert.equal(
    extractAnswer("Answer: B", "choice"),
    "B",
  );
});

// ---- normalizeAnswer ----

test("normalizeAnswer is case-insensitive and strips punctuation", () => {
  assert.equal(normalizeAnswer("Paris!"), "paris");
  assert.equal(normalizeAnswer("  Hello, world.  "), "hello world");
  assert.equal(normalizeAnswer("YES"), "yes");
});

test("normalizeAnswer canonicalizes numbers (1.0 -> '1')", () => {
  assert.equal(normalizeAnswer(1.0, "number"), "1");
  assert.equal(normalizeAnswer(1.5, "number"), "1.5");
});

test("normalizeAnswer handles booleans and objects", () => {
  assert.equal(normalizeAnswer(true), "true");
  assert.equal(normalizeAnswer({ b: 2, a: 1 }), '{"a":1,"b":2}');
});

// ---- voteAnswers ----

test("voteAnswers majority wins", () => {
  const samples = [
    { answer: "42" },
    { answer: "42" },
    { answer: "42" },
    { answer: "7" },
    { answer: "42" },
  ];
  const result = voteAnswers(samples);
  assert.equal(result.winner, "42");
  assert.equal(result.confidence, 4 / 5);
  assert.equal(result.consensusRate, 4 / 5);
  assert.equal(result.votes["42"], 4);
  assert.equal(result.votes["7"], 1);
});

test("voteAnswers tie-breaking: first-seen wins deterministically", () => {
  const samples = [
    { answer: "alpha" },
    { answer: "beta" },
    { answer: "alpha" },
    { answer: "beta" },
  ];
  const result = voteAnswers(samples);
  assert.equal(result.winner, "alpha");
  assert.equal(result.votes.alpha, 2);
  assert.equal(result.votes.beta, 2);
});

test("voteAnswers handles empty samples", () => {
  const result = voteAnswers([]);
  assert.equal(result.winner, null);
  assert.equal(result.confidence, 0);
  assert.equal(result.totalVotes, 0);
});

test("voteAnswers handles single sample", () => {
  const result = voteAnswers([{ answer: "only" }]);
  assert.equal(result.winner, "only");
  assert.equal(result.confidence, 1);
});

test("weightedVote respects weights", () => {
  const samples = [
    { answer: "A" },
    { answer: "B" },
    { answer: "A" },
    { answer: "B" },
  ];
  // Upweight B heavily.
  const result = weightedVote(samples, [1, 5, 1, 5]);
  assert.equal(result.winner, "b");
  assert.equal(result.votes.b, 10);
  assert.equal(result.votes.a, 2);
});

test("plurality picks the max key", () => {
  assert.equal(plurality({ a: 2, b: 5, c: 3 }), "b");
  assert.equal(plurality({}), null);
});

test("majority enforces threshold", () => {
  // 3/5 = 0.6 > 0.5 threshold
  assert.equal(majority({ a: 3, b: 2 }, 0.5), "a");
  // 3/6 = 0.5 not strictly greater than 0.5 -> null
  assert.equal(majority({ a: 3, b: 3 }, 0.5), null);
});

// ---- runSelfConsistency full flow ----

test("runSelfConsistency: 5 samples, 3 agreeing -> winner", async () => {
  const answers = ["42", "42", "7", "42", "9"];
  const sampler = async (_t, { sampleIndex }) => ({
    answer: answers[sampleIndex],
    reasoning: `path ${sampleIndex}`,
  });
  const result = await runSelfConsistency("what is it?", sampler, { n: 5, persist: false });
  assert.equal(result.normalizedAnswer, "42");
  assert.equal(result.answer, "42");
  assert.ok(result.confidence >= 0.5);
  assert.equal(result.samples.length, 5);
  assert.ok(result.consensus === true);
});

test("runSelfConsistency reports low consensus", async () => {
  const answers = ["a", "b", "c", "d", "e"];
  const sampler = async (_t, { sampleIndex }) => ({
    answer: answers[sampleIndex],
    reasoning: "",
  });
  const result = await runSelfConsistency("task", sampler, {
    n: 5,
    minConsensus: 0.6,
    persist: false,
  });
  assert.equal(result.consensus, false);
  assert.ok(result.confidence <= 0.3);
  // Uncertainty (entropy) should be high for uniform distribution: log2(5) ~= 2.32
  assert.ok(result.uncertainty > 1.5);
});

test("runSelfConsistency extracts from reasoning when answer missing", async () => {
  const sampler = async (_t, { sampleIndex }) => ({
    answer: null,
    reasoning: `Some thinking... The answer is ${sampleIndex < 3 ? "yes" : "no"}`,
  });
  const result = await runSelfConsistency("q", sampler, { n: 5, persist: false });
  assert.equal(result.normalizedAnswer, "yes");
  assert.equal(result.samples[0].answer, "yes");
});

// ---- analyzeAgreement ----

test("analyzeAgreement computes rate and unique answers", () => {
  const samples = [
    { answer: "X" },
    { answer: "X" },
    { answer: "Y" },
    { answer: "X" },
  ];
  const a = analyzeAgreement(samples);
  assert.equal(a.uniqueAnswers, 2);
  assert.equal(a.agreementRate, 3 / 4);
  assert.deepEqual(a.disagreementCategories, ["x", "y"]);
});

test("analyzeAgreement handles empty input", () => {
  const a = analyzeAgreement([]);
  assert.equal(a.uniqueAnswers, 0);
  assert.equal(a.agreementRate, 0);
});

// ---- computeUncertainty ----

test("computeUncertainty: uniform has higher entropy than skewed", () => {
  const uniform = [
    { answer: "a" },
    { answer: "b" },
    { answer: "c" },
    { answer: "d" },
  ];
  const skewed = [
    { answer: "a" },
    { answer: "a" },
    { answer: "a" },
    { answer: "b" },
  ];
  const uEnt = computeUncertainty(uniform);
  const sEnt = computeUncertainty(skewed);
  assert.ok(uEnt > sEnt);
  // log2(4) = 2.0
  assert.ok(Math.abs(uEnt - 2) < 0.001);
});

test("computeUncertainty: single unanimous answer is zero", () => {
  const samples = [{ answer: "x" }, { answer: "x" }, { answer: "x" }];
  assert.equal(computeUncertainty(samples), 0);
});

// ---- pickHighestConfidence ----

test("pickHighestConfidence picks max", () => {
  const samples = [
    { answer: "a", confidence: 0.5 },
    { answer: "b", confidence: 0.9 },
    { answer: "c", confidence: 0.7 },
  ];
  const picked = pickHighestConfidence(samples);
  assert.equal(picked.answer, "b");
});

test("pickHighestConfidence handles empty", () => {
  assert.equal(pickHighestConfidence([]), null);
});

// ---- recordRun / getRunHistory ----

test("recordRun persists and getRunHistory returns it", async () => {
  const runA = {
    runId: "test-run-1",
    task: "alpha task",
    answer: "A",
    confidence: 0.8,
    consensus: true,
    samples: [{ answer: "A" }],
  };
  await recordRun(runA);
  const history = await getRunHistory({ limit: 10 });
  const found = history.find((r) => r.runId === "test-run-1");
  assert.ok(found);
  assert.equal(found.task, "alpha task");
  assert.equal(found.answer, "A");
});

test("getRunHistory filter by task substring", async () => {
  await recordRun({
    runId: "test-run-2",
    task: "unique-filter-token-xyz",
    answer: "Z",
    samples: [],
  });
  const results = await getRunHistory({ task: "unique-filter-token" });
  assert.equal(results.length, 1);
  assert.equal(results[0].runId, "test-run-2");
});

// ---- edge cases ----

test("runSelfConsistency with single sample returns that sample", async () => {
  const sampler = async () => ({ answer: "solo", reasoning: "" });
  const result = await runSelfConsistency("t", sampler, { n: 1, persist: false });
  assert.equal(result.normalizedAnswer, "solo");
  assert.equal(result.confidence, 1);
  assert.equal(result.samples.length, 1);
});

test("runSelfConsistency with empty/null sampler results", async () => {
  const sampler = async () => ({ answer: null, reasoning: "" });
  const result = await runSelfConsistency("t", sampler, { n: 3, persist: false });
  assert.equal(result.normalizedAnswer, null);
  assert.equal(result.confidence, 0);
  assert.equal(result.samples.length, 3);
});
