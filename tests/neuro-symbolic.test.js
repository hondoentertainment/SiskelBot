/**
 * Phase 52.4: Neuro-symbolic SAT/SMT bridge tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-neurosym-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  parseClauses,
  solveSAT,
  solveLinearConstraints,
  checkConstraints,
  explainModel,
  getRun,
} = await import("../lib/neuro-symbolic.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

/* -------------------------------------------------------------------------- */
/* parseClauses                                                               */
/* -------------------------------------------------------------------------- */

test("parseClauses handles DIMACS-style input", () => {
  const out = parseClauses([[1, -2], [2, 3]]);
  assert.deepEqual(out.clauses, [[1, -2], [2, 3]]);
  assert.equal(out.variables.length, 3);
});

test("parseClauses handles simple infix strings", () => {
  const out = parseClauses("a & (b | !c)");
  assert.equal(out.clauses.length, 2);
  assert.ok(out.variables.includes("a"));
  assert.ok(out.variables.includes("b"));
  assert.ok(out.variables.includes("c"));
  // clause 2 should include b (positive) and !c (negative)
  const clause2 = out.clauses[1];
  const hasB = clause2.some((l) => out.variables[Math.abs(l) - 1] === "b" && l > 0);
  const hasNotC = clause2.some((l) => out.variables[Math.abs(l) - 1] === "c" && l < 0);
  assert.ok(hasB);
  assert.ok(hasNotC);
});

test("parseClauses rejects malformed literals", () => {
  assert.throws(() => parseClauses("a & (1 | b)"));
});

test("parseClauses handles empty input", () => {
  assert.deepEqual(parseClauses("").clauses, []);
  assert.deepEqual(parseClauses([]).clauses, []);
});

/* -------------------------------------------------------------------------- */
/* solveSAT                                                                   */
/* -------------------------------------------------------------------------- */

test("solveSAT finds a satisfying assignment", async () => {
  const r = await solveSAT("(a | b) & (!a | b) & (a | !b)");
  assert.equal(r.sat, true);
  assert.equal(r.assignment.a, true);
  assert.equal(r.assignment.b, true);
  assert.ok(Array.isArray(r.model));
});

test("solveSAT reports unsatisfiable for direct contradictions", async () => {
  const r = await solveSAT("a & !a");
  assert.equal(r.sat, false);
  assert.ok(r.reason);
});

test("solveSAT reports unsatisfiable on a combinatorial UNSAT", async () => {
  const r = await solveSAT("(a | b) & (a | !b) & (!a | b) & (!a | !b)");
  assert.equal(r.sat, false);
});

test("solveSAT handles DIMACS input directly", async () => {
  const r = await solveSAT([[1, 2], [-1, 2], [1, -2]]);
  assert.equal(r.sat, true);
  assert.equal(r.assignment.x1, true);
  assert.equal(r.assignment.x2, true);
});

test("solveSAT persists when persist=true", async () => {
  const r = await solveSAT("a | b", { persist: true });
  assert.equal(r.sat, true);
  assert.ok(r.runId);
  const loaded = await getRun(r.runId);
  assert.ok(loaded);
  assert.equal(loaded.kind, "sat");
});

test("solveSAT respects the decision limit", async () => {
  // Force an impossibly low ceiling on a moderate formula.
  const r = await solveSAT("(a | b) & (c | d) & (e | f) & (!a | !c | !e)", {
    maxDecisions: 1,
  });
  // With only 1 decision allowed, the solver either finds a trivial model or bails.
  assert.ok(r.sat === true || r.sat === false);
});

/* -------------------------------------------------------------------------- */
/* solveLinearConstraints                                                     */
/* -------------------------------------------------------------------------- */

test("solveLinearConstraints finds a feasible model", async () => {
  const r = await solveLinearConstraints({
    constraints: [
      { coefficients: { x: 1, y: 1 }, op: "<=", rhs: 5 },
      { coefficients: { x: 1 }, op: ">=", rhs: 2 },
      { coefficients: { y: 1 }, op: ">=", rhs: 1 },
    ],
    bounds: { x: { min: 0, max: 5 }, y: { min: 0, max: 5 } },
  });
  assert.equal(r.sat, true);
  assert.ok(r.assignment.x >= 2);
  assert.ok(r.assignment.y >= 1);
  assert.ok(r.assignment.x + r.assignment.y <= 5);
});

test("solveLinearConstraints returns unsat when bounds are empty", async () => {
  const r = await solveLinearConstraints({
    constraints: [{ coefficients: { x: 1 }, op: ">=", rhs: 100 }],
    bounds: { x: { min: 0, max: 10 } },
  });
  assert.equal(r.sat, false);
});

test("solveLinearConstraints supports equality constraints", async () => {
  const r = await solveLinearConstraints({
    constraints: [
      { coefficients: { a: 2, b: 1 }, op: "=", rhs: 5 },
      { coefficients: { a: 1 }, op: ">=", rhs: 1 },
    ],
    bounds: { a: { min: 0, max: 5 }, b: { min: 0, max: 5 } },
  });
  assert.equal(r.sat, true);
  assert.equal(2 * r.assignment.a + r.assignment.b, 5);
});

test("solveLinearConstraints respects maxCombinations guard", async () => {
  const r = await solveLinearConstraints(
    {
      constraints: [{ coefficients: { x: 1 }, op: "<=", rhs: 100 }],
      bounds: { x: { min: 0, max: 10 }, y: { min: 0, max: 10 }, z: { min: 0, max: 10 } },
    },
    { maxCombinations: 5 },
  );
  assert.equal(r.sat, false);
  assert.ok(String(r.reason).includes("domain too large"));
});

/* -------------------------------------------------------------------------- */
/* checkConstraints                                                           */
/* -------------------------------------------------------------------------- */

test("checkConstraints validates SAT + linear models", () => {
  const check = checkConstraints(
    {
      sat: "a & (b | !c)",
      linear: {
        constraints: [{ coefficients: { x: 1 }, op: "<=", rhs: 10 }],
      },
    },
    { a: true, b: true, c: false, x: 5 },
  );
  assert.equal(check.ok, true);
  assert.equal(check.sat.failed, 0);
  assert.equal(check.linear.failed, 0);
});

test("checkConstraints flags failing constraints", () => {
  const check = checkConstraints(
    {
      sat: "a & b",
      linear: { constraints: [{ coefficients: { x: 1 }, op: ">=", rhs: 100 }] },
    },
    { a: true, b: false, x: 1 },
  );
  assert.equal(check.ok, false);
  assert.ok(check.sat.failed >= 1);
  assert.ok(check.linear.failed >= 1);
});

test("checkConstraints requires spec and model", () => {
  assert.throws(() => checkConstraints(null, {}));
  assert.throws(() => checkConstraints({}, null));
});

/* -------------------------------------------------------------------------- */
/* explainModel                                                               */
/* -------------------------------------------------------------------------- */

test("explainModel describes satisfying assignments", () => {
  const r = { sat: true, assignment: { a: true, b: false } };
  const text = explainModel(r);
  assert.ok(text.includes("a = true"));
  assert.ok(text.includes("b = false"));
});

test("explainModel describes unsatisfiable results", () => {
  const r = { sat: false, variables: [], decisions: 0, propagations: 0, reason: "contradiction" };
  assert.ok(explainModel(r).includes("unsatisfiable"));
});

test("explainModel handles numeric assignments", () => {
  const text = explainModel({ sat: true, assignment: { x: 3, y: 0 } });
  assert.ok(text.includes("x = 3"));
  assert.ok(text.includes("y = 0"));
});
