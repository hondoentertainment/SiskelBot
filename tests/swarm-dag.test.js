import test from "node:test";
import assert from "node:assert/strict";
import { createDAG, executeDAG } from "../lib/swarm-dag.js";

test("linear DAG (A→B→C) executes in order", async () => {
  const dag = createDAG();
  dag.addNode("A", { goal: "step A" });
  dag.addNode("B", { goal: "step B", deps: ["A"] });
  dag.addNode("C", { goal: "step C", deps: ["B"] });
  const order = [];
  const result = await executeDAG(dag, async (id) => { order.push(id); return `done-${id}`; });
  assert.deepEqual(order, ["A", "B", "C"]);
  assert.equal(result.results.get("A"), "done-A");
  assert.equal(result.results.get("C"), "done-C");
  assert.equal(result.failed.length, 0);
});

test("parallel DAG (A, B → C) runs A and B concurrently", async () => {
  const dag = createDAG();
  dag.addNode("A", { goal: "a" });
  dag.addNode("B", { goal: "b" });
  dag.addNode("C", { goal: "c", deps: ["A", "B"] });
  const starts = {};
  const result = await executeDAG(dag, async (id) => {
    starts[id] = Date.now();
    await new Promise(r => setTimeout(r, 20));
    return id;
  });
  assert.equal(result.results.size, 3);
  assert.ok(Math.abs((starts.A || 0) - (starts.B || 0)) < 15, "A and B start near-simultaneously");
});

test("failed node skips dependents", async () => {
  const dag = createDAG();
  dag.addNode("A", { goal: "fail" });
  dag.addNode("B", { goal: "skip", deps: ["A"] });
  const result = await executeDAG(dag, async (id) => {
    if (id === "A") throw new Error("boom");
    return id;
  });
  assert.ok(result.failed.includes("A"));
  assert.ok(result.skipped.includes("B"));
});

test("retry: node fails once then succeeds", async () => {
  const dag = createDAG();
  dag.addNode("A", { goal: "flaky" });
  let attempts = 0;
  const result = await executeDAG(dag, async () => {
    attempts++;
    if (attempts === 1) throw new Error("transient");
    return "ok";
  }, { retries: 2 });
  assert.equal(result.results.get("A"), "ok");
  assert.equal(result.failed.length, 0);
});

test("cycle detection throws", () => {
  const dag = createDAG();
  dag.addNode("A", { goal: "a", deps: ["B"] });
  dag.addNode("B", { goal: "b", deps: ["A"] });
  assert.throws(() => dag.getExecutionOrder(), /cycle/i);
});

test("empty DAG returns empty results", async () => {
  const dag = createDAG();
  const result = await executeDAG(dag, async () => "x");
  assert.equal(result.results.size, 0);
  assert.equal(result.failed.length, 0);
});

test("getExecutionOrder returns valid topological sort", () => {
  const dag = createDAG();
  dag.addNode("X", { goal: "x" });
  dag.addNode("Y", { goal: "y", deps: ["X"] });
  dag.addNode("Z", { goal: "z", deps: ["X"] });
  const order = dag.getExecutionOrder();
  assert.equal(order[0], "X");
  assert.ok(order.includes("Y"));
  assert.ok(order.includes("Z"));
});
