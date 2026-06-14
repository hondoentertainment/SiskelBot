/**
 * Phase 52.5: Verification loop tests.
 */
import test from "node:test";
import assert from "node:assert/strict";

const {
  VerificationLoop,
  IterativeRefiner,
  propose,
  verify,
  refine,
  defaultVerifier,
  mathVerifier,
  codeVerifier,
  formatVerifier,
  factVerifier,
  chainVerifiers,
  computeRefinementMetrics,
} = await import("../lib/verification-loop.js");

// ────────────────────────────────────────────────────────────────────
// VerificationLoop
// ────────────────────────────────────────────────────────────────────

test("VerificationLoop runs proposer → verifier", async () => {
  const proposer = () => "Yes, the answer is complete and clear for deployment.";
  const loop = new VerificationLoop({ proposer });
  const result = await loop.run("deploy recipe");
  assert.ok(Array.isArray(result.iterations));
  assert.ok(result.iterations.length >= 1);
  assert.equal(typeof result.finalAnswer, "string");
});

test("VerificationLoop stops when verifier approves", async () => {
  let calls = 0;
  const proposer = () => {
    calls++;
    return "The answer is fully correct and meets the deployment requirement for production.";
  };
  const loop = new VerificationLoop({
    proposer,
    verifier: () => ({ approved: true, score: 1, critique: "ok", suggestions: [] }),
    maxIterations: 5,
  });
  const result = await loop.run("anything");
  assert.equal(result.accepted, true);
  assert.equal(result.iterationsCount, 1);
  assert.equal(calls, 1);
});

test("VerificationLoop respects maxIterations", async () => {
  const proposer = () => "bad";
  const loop = new VerificationLoop({
    proposer,
    verifier: () => ({ approved: false, score: 0.1, critique: "no", suggestions: [] }),
    maxIterations: 3,
  });
  const result = await loop.run("task");
  assert.equal(result.accepted, false);
  assert.equal(result.iterationsCount, 3);
});

test("VerificationLoop returns all iterations with critique and score", async () => {
  const proposer = () => "draft answer";
  let call = 0;
  const verifier = () => {
    call++;
    return { approved: false, score: 0.2 * call, critique: `v${call}`, suggestions: [] };
  };
  const loop = new VerificationLoop({ proposer, verifier, maxIterations: 3 });
  const result = await loop.run("task");
  assert.equal(result.iterations.length, 3);
  for (const it of result.iterations) {
    assert.ok(typeof it.answer === "string");
    assert.ok(typeof it.critique === "string");
    assert.ok(typeof it.score === "number");
  }
  assert.equal(result.iterations[0].critique, "v1");
  assert.equal(result.iterations[2].critique, "v3");
});

test("VerificationLoop calls refiner between iterations", async () => {
  const proposer = () => "first";
  let refineCalls = 0;
  const refiner = (answer, critique) => {
    refineCalls++;
    return `${answer}+refined(${critique})`;
  };
  const loop = new VerificationLoop({
    proposer,
    verifier: () => ({ approved: false, score: 0, critique: "nope", suggestions: [] }),
    refiner,
    maxIterations: 3,
  });
  const result = await loop.run("task");
  // refiner called between each iteration (maxIterations - 1 times).
  assert.equal(refineCalls, 2);
  assert.ok(result.iterations[1].answer.includes("refined"));
});

// ────────────────────────────────────────────────────────────────────
// Low-level helpers
// ────────────────────────────────────────────────────────────────────

test("propose returns answer from proposerFn", async () => {
  const answer = await propose("what is 2+2?", () => "four");
  assert.equal(answer, "four");
});

test("propose throws on empty task", async () => {
  await assert.rejects(() => propose("", () => "x"), /task is required/);
});

test("verify returns approved boolean", async () => {
  const result = await verify("good answer", "task", () => ({
    approved: true,
    score: 1,
    critique: "ok",
    suggestions: [],
  }));
  assert.equal(result.approved, true);
  assert.equal(result.score, 1);
});

test("verify normalizes missing fields", async () => {
  const result = await verify("answer", "task", () => ({ approved: true }));
  assert.equal(result.approved, true);
  assert.equal(result.score, 0);
  assert.deepEqual(result.suggestions, []);
});

test("refine updates answer via refinerFn", async () => {
  const result = await refine("draft", "too short", (a, c) => `${a} -- ${c}`);
  assert.equal(result, "draft -- too short");
});

test("refine default appends note when no refinerFn", async () => {
  const result = await refine("draft", "fix it");
  assert.ok(result.includes("draft"));
  assert.ok(result.includes("revised"));
});

// ────────────────────────────────────────────────────────────────────
// Built-in verifiers
// ────────────────────────────────────────────────────────────────────

test("defaultVerifier checks length and rejects empty", () => {
  const empty = defaultVerifier("", "task");
  assert.equal(empty.approved, false);
  assert.equal(empty.score, 0);

  const short = defaultVerifier("hi", "task");
  assert.equal(short.approved, false);
});

test("defaultVerifier approves substantive answers", () => {
  const good = defaultVerifier(
    "The deployment recipe runs build, test, and push to production.",
    "deployment",
  );
  assert.equal(good.approved, true);
  assert.ok(good.score >= 0.8);
});

test("mathVerifier checks correct arithmetic", () => {
  const result = mathVerifier("The answer is 4.", "what is 2 + 2?");
  assert.equal(result.approved, true);
  assert.equal(result.score, 1);
});

test("mathVerifier detects wrong arithmetic", () => {
  const result = mathVerifier("The answer is 5.", "what is 2 + 2?");
  assert.equal(result.approved, false);
  assert.ok(result.critique.includes("4"));
});

test("mathVerifier handles multiplication and subtraction", () => {
  assert.equal(mathVerifier("36", "what is 12 * 3?").approved, true);
  assert.equal(mathVerifier("5", "9 - 4").approved, true);
  assert.equal(mathVerifier("999", "9 - 4").approved, false);
});

test("codeVerifier checks JS syntax (balanced braces)", () => {
  const good = codeVerifier("function add(a, b) { return a + b; }", "code task");
  assert.equal(good.approved, true);

  const bad = codeVerifier("function add(a, b) { return a + b;", "code task");
  assert.equal(bad.approved, false);
  assert.ok(bad.critique.includes("{"));
});

test("codeVerifier rejects empty code", () => {
  const result = codeVerifier("", "code task");
  assert.equal(result.approved, false);
});

test("formatVerifier validates JSON schema", () => {
  const schema = {
    type: "object",
    required: ["name", "age"],
    properties: {
      name: { type: "string" },
      age: { type: "number" },
    },
  };
  const ok = formatVerifier('{"name":"Alice","age":30}', "task", schema);
  assert.equal(ok.approved, true);

  const missing = formatVerifier('{"name":"Alice"}', "task", schema);
  assert.equal(missing.approved, false);

  const wrongType = formatVerifier('{"name":"Alice","age":"old"}', "task", schema);
  assert.equal(wrongType.approved, false);
});

test("formatVerifier rejects non-JSON", () => {
  const schema = { type: "object" };
  const result = formatVerifier("not json at all", "task", schema);
  assert.equal(result.approved, false);
  assert.ok(/not valid JSON/i.test(result.critique));
});

test("factVerifier checks claims against knowledge base", () => {
  const kb = ["The Earth orbits the Sun.", "Water boils at 100 degrees Celsius."];
  const good = factVerifier("The Earth orbits the Sun.", kb);
  assert.equal(good.approved, true);

  const bad = factVerifier("The Moon is made of cheese and tastes wonderful.", kb);
  assert.equal(bad.approved, false);
});

test("chainVerifiers aggregates scores from multiple verifiers", async () => {
  const combined = chainVerifiers([
    () => ({ approved: true, score: 1, critique: "a", suggestions: [] }),
    () => ({ approved: true, score: 0.8, critique: "b", suggestions: [] }),
  ]);
  const result = await combined("answer", "task");
  assert.equal(result.approved, true);
  assert.ok(Math.abs(result.score - 0.9) < 1e-9);
  assert.ok(result.critique.includes("a"));
  assert.ok(result.critique.includes("b"));
});

test("chainVerifiers rejects if any verifier rejects", async () => {
  const combined = chainVerifiers([
    () => ({ approved: true, score: 1, critique: "", suggestions: [] }),
    () => ({ approved: false, score: 0.2, critique: "nope", suggestions: ["fix"] }),
  ]);
  const result = await combined("answer", "task");
  assert.equal(result.approved, false);
  assert.ok(result.suggestions.includes("fix"));
});

test("chainVerifiers throws on empty list", () => {
  assert.throws(() => chainVerifiers([]), /non-empty/);
});

// ────────────────────────────────────────────────────────────────────
// IterativeRefiner
// ────────────────────────────────────────────────────────────────────

test("IterativeRefiner history tracking", async () => {
  const proposer = () => "start";
  const refiner = new IterativeRefiner({
    proposer,
    verifier: () => ({ approved: false, score: 0, critique: "x", suggestions: [] }),
  });
  await refiner.refine("task", 3);
  const history = refiner.getHistory();
  assert.equal(history.length, 3);
  assert.equal(history[0].iteration, 1);
  assert.equal(history[2].iteration, 3);
});

test("IterativeRefiner reset clears history", async () => {
  const refiner = new IterativeRefiner({
    proposer: () => "x",
    verifier: () => ({ approved: false, score: 0, critique: "", suggestions: [] }),
  });
  await refiner.refine("task", 2);
  assert.equal(refiner.getHistory().length, 2);
  refiner.reset();
  assert.equal(refiner.getHistory().length, 0);
});

test("IterativeRefiner stops on approval", async () => {
  let calls = 0;
  const refiner = new IterativeRefiner({
    proposer: () => "x",
    verifier: () => {
      calls++;
      return { approved: true, score: 1, critique: "ok", suggestions: [] };
    },
  });
  const result = await refiner.refine("task", 5);
  assert.equal(result.accepted, true);
  assert.equal(calls, 1);
});

// ────────────────────────────────────────────────────────────────────
// Metrics
// ────────────────────────────────────────────────────────────────────

test("computeRefinementMetrics calculates improvement", () => {
  const history = [
    { score: 0.2, approved: false },
    { score: 0.5, approved: false },
    { score: 0.9, approved: true },
  ];
  const metrics = computeRefinementMetrics(history);
  assert.equal(metrics.iterations, 3);
  assert.equal(metrics.initialScore, 0.2);
  assert.equal(metrics.finalScore, 0.9);
  assert.ok(Math.abs(metrics.totalImprovement - 0.7) < 1e-9);
  assert.equal(metrics.improvementPerStep.length, 2);
  assert.equal(metrics.accepted, true);
  assert.equal(metrics.earlyStopped, true);
});

test("computeRefinementMetrics handles empty history", () => {
  const metrics = computeRefinementMetrics([]);
  assert.equal(metrics.iterations, 0);
  assert.equal(metrics.finalScore, 0);
  assert.equal(metrics.accepted, false);
});

// ────────────────────────────────────────────────────────────────────
// Error/validation
// ────────────────────────────────────────────────────────────────────

test("VerificationLoop rejects empty task", async () => {
  const loop = new VerificationLoop({ proposer: () => "x" });
  await assert.rejects(() => loop.run(""), /task is required/);
});

test("VerificationLoop requires proposer function", () => {
  assert.throws(() => new VerificationLoop({}), /proposer function is required/);
});

// ────────────────────────────────────────────────────────────────────
// End-to-end
// ────────────────────────────────────────────────────────────────────

test("Mock proposer/verifier full flow: refine until accepted", async () => {
  let attempt = 0;
  const proposer = () => "I think the answer is 3.";
  const refiner = () => "The answer is 4.";
  const loop = new VerificationLoop({
    proposer,
    verifier: (answer, task) => {
      attempt++;
      return mathVerifier(answer, task);
    },
    refiner,
    maxIterations: 4,
  });
  const result = await loop.run("what is 2 + 2?");
  assert.equal(result.accepted, true);
  assert.ok(attempt >= 2);
  assert.equal(result.iterations.length, 2);
  assert.equal(result.iterations[0].approved, false);
  assert.equal(result.iterations[1].approved, true);
});
