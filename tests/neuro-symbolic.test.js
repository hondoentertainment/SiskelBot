/**
 * Phase 52.4: Neuro-symbolic bridge tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "siskel-neuro-symbolic-"));
process.env.STORAGE_PATH = TMP;

const {
  solveSat,
  solveSmt,
  registerSolver,
  listSolvers,
  getSolver,
} = await import("../lib/neuro-symbolic.js");

test.after(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

// ─── Provider registry ────────────────────────────────────────────────────

test("builtin solver is registered by default", () => {
  assert.ok(listSolvers().includes("builtin"));
  assert.ok(getSolver("builtin"));
});

test("registerSolver validates input", () => {
  assert.throws(() => registerSolver("", {}), /name is required/);
  assert.throws(() => registerSolver("x", null), /impl must be/);
});

test("registerSolver accepts a custom backend", async () => {
  registerSolver("echo-solver", {
    solveSat: async () => ({ sat: true, assignment: { fake: true }, stats: {}, provider: "echo-solver" }),
  });
  const result = await solveSat([[1]], { provider: "echo-solver" });
  assert.equal(result.sat, true);
  assert.equal(result.provider, "echo-solver");
});

// ─── SAT ───────────────────────────────────────────────────────────────────

test("solveSat: empty formula is trivially satisfiable", async () => {
  const r = await solveSat([]);
  assert.equal(r.sat, true);
  assert.deepEqual(r.assignment, {});
});

test("solveSat: formula with an empty clause is unsatisfiable", async () => {
  const r = await solveSat([[]]);
  assert.equal(r.sat, false);
});

test("solveSat: unit-propagation solves a simple chain", async () => {
  // (x1) AND (-x1 OR x2) AND (-x2 OR x3) ⇒ x1=x2=x3=true
  const r = await solveSat([[1], [-1, 2], [-2, 3]]);
  assert.equal(r.sat, true);
  assert.equal(r.assignment[1], true);
  assert.equal(r.assignment[2], true);
  assert.equal(r.assignment[3], true);
});

test("solveSat: a trivial contradiction is unsat", async () => {
  // (x1) AND (-x1)
  const r = await solveSat([[1], [-1]]);
  assert.equal(r.sat, false);
});

test("solveSat: pigeonhole 3-in-2 is unsat", async () => {
  // Not strictly pigeonhole; a small classic unsat: 3 variables, pair-exclusive,
  // and at least one must be true → this is sat. Use a known unsat:
  //   (a) AND (b) AND (-a OR -b)
  const r = await solveSat([[1], [2], [-1, -2]]);
  assert.equal(r.sat, false);
});

test("solveSat: 3-SAT sample yields a valid assignment", async () => {
  // (x1 OR x2 OR x3) AND (-x1 OR x2) AND (-x2 OR x3) AND (-x3 OR x1)
  const clauses = [[1, 2, 3], [-1, 2], [-2, 3], [-3, 1]];
  const r = await solveSat(clauses);
  assert.equal(r.sat, true);
  // Verify the assignment satisfies every clause.
  for (const c of clauses) {
    const satisfied = c.some((lit) => {
      const v = Math.abs(lit);
      return lit > 0 ? r.assignment[v] === true : r.assignment[v] === false;
    });
    assert.ok(satisfied, `clause ${JSON.stringify(c)} not satisfied`);
  }
});

test("solveSat: invalid input throws", async () => {
  await assert.rejects(() => solveSat("nope"), /must be an array/);
  await assert.rejects(() => solveSat([1, 2]), /each clause/);
});

// ─── SMT stub ─────────────────────────────────────────────────────────────

test("solveSmt: boolean constant formula", async () => {
  const r = await solveSmt({ const: true });
  assert.equal(r.sat, true);
});

test("solveSmt: linear feasibility finds an assignment", async () => {
  // x + y = 5, x > 0, y > 0, with domain 0..10
  const formula = {
    op: "and",
    args: [
      { op: "eq", args: [{ op: "add", args: [{ var: "x" }, { var: "y" }] }, { const: 5 }] },
      { op: "gt", args: [{ var: "x" }, { const: 0 }] },
      { op: "gt", args: [{ var: "y" }, { const: 0 }] },
    ],
  };
  const r = await solveSmt(formula, { domains: { x: { min: 0, max: 10 }, y: { min: 0, max: 10 } } });
  assert.equal(r.sat, true);
  assert.ok(r.assignment.x > 0);
  assert.ok(r.assignment.y > 0);
  assert.equal(r.assignment.x + r.assignment.y, 5);
});

test("solveSmt: infeasible formula returns unsat", async () => {
  const formula = {
    op: "and",
    args: [
      { op: "eq", args: [{ var: "x" }, { const: 5 }] },
      { op: "eq", args: [{ var: "x" }, { const: 3 }] },
    ],
  };
  const r = await solveSmt(formula, { domains: { x: { min: 0, max: 10 } } });
  assert.equal(r.sat, false);
});
