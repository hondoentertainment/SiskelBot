/**
 * Tests for lib/graph-of-thought.js — DAG-based Graph-of-Thought reasoning.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  ThoughtGraph,
  expandGraph,
  mergeThoughts,
  scoreGraph,
  findCriticalPath,
  reasonWithGraph,
  findContradictions,
  resolveContradictions,
  graphToDot,
  graphToMermaid,
} from "../lib/graph-of-thought.js";

test("ThoughtGraph.addNode returns a unique id", () => {
  const g = new ThoughtGraph();
  const a = g.addNode("premise A");
  const b = g.addNode("premise B");
  assert.ok(a);
  assert.ok(b);
  assert.notEqual(a, b);
  assert.equal(g.nodes.size, 2);
  assert.equal(g.getNode(a).thought, "premise A");
});

test("addEdge connects two existing nodes", () => {
  const g = new ThoughtGraph();
  const a = g.addNode("A");
  const b = g.addNode("B");
  g.addEdge(a, b, "derives_from");
  const neighbors = g.getNeighbors(a, "out");
  assert.equal(neighbors.length, 1);
  assert.equal(neighbors[0].id, b);
  assert.equal(neighbors[0].type, "derives_from");
});

test("addEdge rejects an edge that would create a cycle", () => {
  const g = new ThoughtGraph();
  const a = g.addNode("A");
  const b = g.addNode("B");
  const c = g.addNode("C");
  g.addEdge(a, b);
  g.addEdge(b, c);
  assert.throws(() => g.addEdge(c, a), /cycle/);
  // Graph should still be valid afterwards.
  assert.equal(g.hasCycle(), false);
});

test("hasCycle detects a 3-node cycle when built via raw mutation", () => {
  const g = new ThoughtGraph();
  const a = g.addNode("A");
  const b = g.addNode("B");
  const c = g.addNode("C");
  g.addEdge(a, b);
  g.addEdge(b, c);
  // Bypass cycle check by mutating internal structures.
  g.edges.get(c).set(a, { type: "derives_from" });
  g.reverseEdges.get(a).set(c, { type: "derives_from" });
  assert.equal(g.hasCycle(), true);
});

test("topoSort produces a valid topological order", () => {
  const g = new ThoughtGraph();
  const a = g.addNode("A");
  const b = g.addNode("B");
  const c = g.addNode("C");
  const d = g.addNode("D");
  g.addEdge(a, b);
  g.addEdge(a, c);
  g.addEdge(b, d);
  g.addEdge(c, d);
  const order = g.topoSort();
  assert.equal(order.length, 4);
  assert.ok(order.indexOf(a) < order.indexOf(b));
  assert.ok(order.indexOf(a) < order.indexOf(c));
  assert.ok(order.indexOf(b) < order.indexOf(d));
  assert.ok(order.indexOf(c) < order.indexOf(d));
});

test("topoSort throws on a cycle", () => {
  const g = new ThoughtGraph();
  const a = g.addNode("A");
  const b = g.addNode("B");
  g.addEdge(a, b);
  // Force a cycle.
  g.edges.get(b).set(a, { type: "derives_from" });
  g.reverseEdges.get(a).set(b, { type: "derives_from" });
  assert.throws(() => g.topoSort(), /cycle/);
});

test("getAncestors returns all reachable ancestors upward", () => {
  const g = new ThoughtGraph();
  const a = g.addNode("A");
  const b = g.addNode("B");
  const c = g.addNode("C");
  const d = g.addNode("D");
  g.addEdge(a, c);
  g.addEdge(b, c);
  g.addEdge(c, d);
  const ancestors = g.getAncestors(d);
  assert.equal(ancestors.length, 3);
  assert.ok(ancestors.includes(a));
  assert.ok(ancestors.includes(b));
  assert.ok(ancestors.includes(c));
});

test("getDescendants returns all reachable descendants downward", () => {
  const g = new ThoughtGraph();
  const a = g.addNode("A");
  const b = g.addNode("B");
  const c = g.addNode("C");
  const d = g.addNode("D");
  g.addEdge(a, b);
  g.addEdge(a, c);
  g.addEdge(b, d);
  const descendants = g.getDescendants(a);
  assert.equal(descendants.length, 3);
  assert.ok(descendants.includes(b));
  assert.ok(descendants.includes(c));
  assert.ok(descendants.includes(d));
});

test("getLeaves and getRoots identify terminal and source nodes", () => {
  const g = new ThoughtGraph();
  const a = g.addNode("A");
  const b = g.addNode("B");
  const c = g.addNode("C");
  const d = g.addNode("D");
  g.addEdge(a, b);
  g.addEdge(a, c);
  g.addEdge(b, d);
  const roots = g.getRoots();
  const leaves = g.getLeaves();
  assert.deepEqual(roots.sort(), [a].sort());
  assert.deepEqual(leaves.sort(), [c, d].sort());
});

test("mergeThoughts creates a merged node with edges from all sources", () => {
  const g = new ThoughtGraph();
  const a = g.addNode("fact: X");
  const b = g.addNode("fact: Y");
  const c = g.addNode("fact: Z");
  const mergedId = mergeThoughts(g, [a, b, c], (nodes) =>
    `merged: ${nodes.map((n) => n.thought).join(" + ")}`,
  );
  const merged = g.getNode(mergedId);
  assert.ok(merged);
  assert.match(merged.thought, /merged:/);
  assert.deepEqual(merged.metadata.sources, [a, b, c]);
  // All three sources should have an edge of type "merges" to the merged node.
  for (const src of [a, b, c]) {
    const out = g.getNeighbors(src, "out");
    assert.equal(out.length, 1);
    assert.equal(out[0].id, mergedId);
    assert.equal(out[0].type, "merges");
  }
});

test("expandGraph adds children returned by an expander", async () => {
  const g = new ThoughtGraph();
  const seed = g.addNode("root");
  const expander = async (node) => [
    { thought: `${node.thought}-child-1` },
    { thought: `${node.thought}-child-2`, edgeType: "supports" },
  ];
  const { added } = await expandGraph(g, seed, expander);
  assert.equal(added.length, 2);
  assert.equal(g.nodes.size, 3);
  const out = g.getNeighbors(seed, "out");
  assert.equal(out.length, 2);
  const types = out.map((e) => e.type).sort();
  assert.deepEqual(types, ["derives_from", "supports"]);
});

test("findCriticalPath returns the highest-scoring path to a target", () => {
  const g = new ThoughtGraph();
  const a = g.addNode("A", { score: 1 });
  const b = g.addNode("B", { score: 5 });
  const c = g.addNode("C", { score: 2 });
  const d = g.addNode("D", { score: 10 });
  g.addEdge(a, b);
  g.addEdge(a, c);
  g.addEdge(b, d);
  g.addEdge(c, d);
  const { path, score } = findCriticalPath(g, d);
  assert.deepEqual(path, [a, b, d]);
  assert.equal(score, 1 + 5 + 10);
});

test("findContradictions returns pairs connected by contradicts edge", () => {
  const g = new ThoughtGraph();
  const a = g.addNode("sky is blue");
  const b = g.addNode("sky is green");
  const c = g.addNode("sky is red");
  g.addEdge(a, b, "contradicts");
  g.addEdge(a, c, "contradicts");
  const contradictions = findContradictions(g);
  assert.equal(contradictions.length, 2);
  const pair = contradictions.find((c) => c.aThought === "sky is blue");
  assert.ok(pair);
});

test("reasonWithGraph runs full flow with a mock expander and goal check", async () => {
  // Expander produces a chain where node at depth 3 triggers goal.
  const expander = async (node) => {
    const depth = (node.metadata?.depth || 0) + 1;
    if (depth > 4) return [];
    return [{ thought: `step-${depth}`, metadata: { depth, score: depth } }];
  };
  const goalCheck = (node) => /step-3$/.test(node?.thought || "");
  const result = await reasonWithGraph("solve the thing", {
    expander,
    goalCheck,
    maxNodes: 10,
  });
  assert.ok(result.graph instanceof ThoughtGraph);
  assert.ok(Array.isArray(result.bestPath));
  assert.ok(result.bestPath.length >= 2);
  assert.match(result.answer, /step-3$/);
  assert.equal(result.stats.reachedGoal, true);
});

test("toJSON and fromJSON perform a faithful roundtrip", () => {
  const g = new ThoughtGraph();
  const a = g.addNode("A", { role: "seed" });
  const b = g.addNode("B", { score: 3 });
  const c = g.addNode("C");
  g.addEdge(a, b, "supports");
  g.addEdge(b, c, "derives_from");
  const json = g.toJSON();
  const restored = ThoughtGraph.fromJSON(json);
  assert.equal(restored.nodes.size, 3);
  assert.equal(restored.getNode(a).metadata.role, "seed");
  const outB = restored.getNeighbors(b, "out");
  assert.equal(outB.length, 1);
  assert.equal(outB[0].id, c);
  assert.equal(outB[0].type, "derives_from");
  // Roundtrip JSON should be stable when re-serialized.
  assert.deepEqual(restored.toJSON(), json);
});

test("graphToDot produces valid DOT output", () => {
  const g = new ThoughtGraph();
  const a = g.addNode("alpha");
  const b = g.addNode("beta");
  g.addEdge(a, b, "supports");
  const dot = graphToDot(g);
  assert.match(dot, /^digraph ThoughtGraph \{/);
  assert.match(dot, /alpha/);
  assert.match(dot, /beta/);
  assert.match(dot, /->/);
  assert.match(dot, /supports/);
  assert.ok(dot.trim().endsWith("}"));
});

test("graphToMermaid produces valid Mermaid syntax", () => {
  const g = new ThoughtGraph();
  const a = g.addNode("alpha");
  const b = g.addNode("beta");
  g.addEdge(a, b, "contradicts");
  const mmd = graphToMermaid(g);
  assert.match(mmd, /^graph TD/);
  assert.match(mmd, /\["alpha"\]/);
  assert.match(mmd, /\["beta"\]/);
  assert.match(mmd, /-->\|contradicts\|/);
});

test("empty graph is handled gracefully", () => {
  const g = new ThoughtGraph();
  assert.equal(g.hasCycle(), false);
  assert.deepEqual(g.topoSort(), []);
  assert.deepEqual(g.getLeaves(), []);
  assert.deepEqual(g.getRoots(), []);
  assert.deepEqual(g.toJSON(), { nodes: [], edges: [] });
  assert.match(graphToDot(g), /digraph ThoughtGraph/);
  assert.match(graphToMermaid(g), /graph TD/);
});

test("single node graph is handled", () => {
  const g = new ThoughtGraph();
  const a = g.addNode("only");
  assert.equal(g.hasCycle(), false);
  assert.deepEqual(g.topoSort(), [a]);
  assert.deepEqual(g.getLeaves(), [a]);
  assert.deepEqual(g.getRoots(), [a]);
  const { path, score } = findCriticalPath(g, a, () => 7);
  assert.deepEqual(path, [a]);
  assert.equal(score, 7);
});

test("scoreGraph returns nodes sorted by descending score", () => {
  const g = new ThoughtGraph();
  g.addNode("low", { score: 1 });
  g.addNode("mid", { score: 5 });
  g.addNode("high", { score: 9 });
  const scored = scoreGraph(g, (n) => n.metadata.score || 0);
  assert.equal(scored[0].thought, "high");
  assert.equal(scored[1].thought, "mid");
  assert.equal(scored[2].thought, "low");
});

test("resolveContradictions keeps the winning node", () => {
  const g = new ThoughtGraph();
  const a = g.addNode("truth");
  const b = g.addNode("lie");
  g.addEdge(a, b, "contradicts");
  const resolutions = resolveContradictions(g, () => ({ winner: "a" }));
  assert.equal(resolutions.length, 1);
  assert.equal(g.hasNode(a), true);
  assert.equal(g.hasNode(b), false);
});

test("removeNode cleans up incoming and outgoing edges", () => {
  const g = new ThoughtGraph();
  const a = g.addNode("A");
  const b = g.addNode("B");
  const c = g.addNode("C");
  g.addEdge(a, b);
  g.addEdge(b, c);
  g.removeNode(b);
  assert.equal(g.hasNode(b), false);
  assert.deepEqual(g.getNeighbors(a, "out"), []);
  assert.deepEqual(g.getNeighbors(c, "in"), []);
});
