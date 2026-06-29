import test from "node:test";
import assert from "node:assert/strict";
import { lintPlanDag, planDagLooksLikeGraph } from "../lib/agent-session-plan-dag.js";

test("planDagLooksLikeGraph detects nodes or edges arrays", () => {
  assert.equal(planDagLooksLikeGraph(null), false);
  assert.equal(planDagLooksLikeGraph({ steps: ["a"] }), false);
  assert.equal(planDagLooksLikeGraph({ nodes: [] }), true);
  assert.equal(planDagLooksLikeGraph({ edges: [] }), true);
});

test("lintPlanDag skips non-graph free-form objects", () => {
  const r = lintPlanDag({ version: 1, steps: ["x", "y"] });
  assert.equal(r.skipped, true);
  assert.equal(r.ok, true);
});

test("lintPlanDag accepts empty graph", () => {
  const r = lintPlanDag({ nodes: [], edges: [] });
  assert.equal(r.skipped, false);
  assert.equal(r.ok, true);
  assert.equal(r.nodeCount, 0);
  assert.equal(r.edgeCount, 0);
});

test("lintPlanDag accepts acyclic graph and source/target aliases", () => {
  const r = lintPlanDag({
    nodes: [{ id: "a" }, { id: "b" }],
    edges: [{ source: "a", target: "b" }],
  });
  assert.equal(r.ok, true);
  assert.equal(r.edgeCount, 1);
});

test("lintPlanDag rejects duplicate ids and dangling edges", () => {
  const dup = lintPlanDag({
    nodes: [{ id: "a" }, { id: "a" }],
    edges: [],
  });
  assert.equal(dup.ok, false);
  assert.ok(dup.issues.some((x) => x.includes("duplicate")));

  const dangle = lintPlanDag({
    nodes: [{ id: "a" }],
    edges: [{ from: "a", to: "missing" }],
  });
  assert.equal(dangle.ok, false);
  assert.ok(dangle.issues.some((x) => x.includes("unknown")));
});

test("lintPlanDag rejects directed cycle", () => {
  const r = lintPlanDag({
    nodes: [{ id: "a" }, { id: "b" }],
    edges: [
      { from: "a", to: "b" },
      { from: "b", to: "a" },
    ],
  });
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((x) => x.toLowerCase().includes("cycle")));
});
