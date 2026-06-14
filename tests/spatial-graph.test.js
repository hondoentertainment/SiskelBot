/**
 * Phase 49.2: Spatial knowledge graph tests.
 *
 * Covers the force-directed 3D layout, spherical projection, label-propagation
 * clustering, graph filtering, stats, neighborhood queries, and BFS shortest
 * path.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  forceDirectedLayout,
  computeLayoutIncremental,
  clusterNodes,
  projectToSphere,
  buildSpatialGraph,
  filterGraphByType,
  filterGraphByDegree,
  computeGraphStats,
  getNeighborhood,
  pathBetween,
  _internals,
} from "../lib/spatial-graph.js";

function dist(a, b) {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

await test("forceDirectedLayout handles empty graph", () => {
  const result = forceDirectedLayout([], []);
  assert.deepEqual(result.nodes, []);
  assert.deepEqual(result.edges, []);
});

await test("forceDirectedLayout places single node at origin", () => {
  const result = forceDirectedLayout([{ id: "a" }], []);
  assert.equal(result.nodes.length, 1);
  assert.deepEqual(result.nodes[0].position, [0, 0, 0]);
  assert.deepEqual(result.nodes[0].velocity, [0, 0, 0]);
});

await test("forceDirectedLayout separates two connected nodes a reasonable distance", () => {
  const result = forceDirectedLayout(
    [{ id: "a" }, { id: "b" }],
    [{ from: "a", to: "b" }],
    { iterations: 200, seed: 7 },
  );
  const d = dist(result.nodes[0].position, result.nodes[1].position);
  assert.ok(d > 0.3, `expected distance > 0.3, got ${d}`);
  assert.ok(d < 20, `expected distance < 20, got ${d}`);
});

await test("forceDirectedLayout is deterministic with the same seed", () => {
  const nodes = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
  const edges = [
    { from: "a", to: "b" },
    { from: "b", to: "c" },
    { from: "c", to: "d" },
  ];
  const first = forceDirectedLayout(nodes.map((n) => ({ ...n })), edges, { seed: 123, iterations: 50 });
  const second = forceDirectedLayout(nodes.map((n) => ({ ...n })), edges, { seed: 123, iterations: 50 });
  for (let i = 0; i < first.nodes.length; i++) {
    assert.deepEqual(first.nodes[i].position, second.nodes[i].position);
  }
});

await test("forceDirectedLayout iterations reduce total movement over time", () => {
  const nodes = Array.from({ length: 6 }, (_, i) => ({ id: `n${i}` }));
  const edges = [
    { from: "n0", to: "n1" },
    { from: "n1", to: "n2" },
    { from: "n2", to: "n3" },
    { from: "n3", to: "n4" },
    { from: "n4", to: "n5" },
  ];

  // Run full layout then a single incremental iteration — the movement
  // from that incremental step should be very small relative to an
  // initial pass of the same length.
  const full = forceDirectedLayout(nodes.map((n) => ({ ...n })), edges, { seed: 9, iterations: 400 });
  const before = full.nodes.map((n) => [...n.position]);
  const after = computeLayoutIncremental(full.nodes, edges, { iterations: 1, seed: 9 });
  const movement = after.nodes.reduce((s, n, i) => s + dist(n.position, before[i]), 0);

  const earlyFirst = forceDirectedLayout(nodes.map((n) => ({ ...n })), edges, { seed: 9, iterations: 1 });
  const earlySecond = computeLayoutIncremental(earlyFirst.nodes, edges, { iterations: 1, seed: 9 });
  const earlyMovement = earlySecond.nodes.reduce(
    (s, n, i) => s + dist(n.position, earlyFirst.nodes[i].position),
    0,
  );

  assert.ok(movement <= earlyMovement + 1e-6, `late movement ${movement} should be <= early ${earlyMovement}`);
});

await test("projectToSphere places every node at the requested radius", () => {
  const nodes = Array.from({ length: 20 }, (_, i) => ({ id: `n${i}`, type: "concept" }));
  const out = projectToSphere(nodes, 3);
  assert.equal(out.length, 20);
  for (const n of out) {
    const r = Math.sqrt(n.position[0] ** 2 + n.position[1] ** 2 + n.position[2] ** 2);
    assert.ok(Math.abs(r - 3) < 1e-6, `expected radius 3, got ${r}`);
    assert.equal(n.type, "concept");
  }
});

await test("projectToSphere with zero and one nodes", () => {
  assert.deepEqual(projectToSphere([], 4), []);
  const single = projectToSphere([{ id: "only" }], 2);
  assert.equal(single.length, 1);
  assert.deepEqual(single[0].position, [2, 0, 0]);
});

await test("clusterNodes assigns cluster ids to every node", () => {
  const nodes = [
    { id: "a" }, { id: "b" }, { id: "c" },
    { id: "x" }, { id: "y" }, { id: "z" },
  ];
  const edges = [
    { from: "a", to: "b" }, { from: "b", to: "c" }, { from: "a", to: "c" },
    { from: "x", to: "y" }, { from: "y", to: "z" }, { from: "x", to: "z" },
  ];
  const result = clusterNodes(nodes, edges);
  for (const n of result.nodes) {
    assert.equal(typeof n.cluster, "number");
  }
  const clusterA = result.nodes.find((n) => n.id === "a").cluster;
  const clusterB = result.nodes.find((n) => n.id === "b").cluster;
  const clusterX = result.nodes.find((n) => n.id === "x").cluster;
  assert.equal(clusterA, clusterB);
  assert.notEqual(clusterA, clusterX);
});

await test("buildSpatialGraph returns the expected shape with tolerant empty state", async () => {
  const graph = await buildSpatialGraph("__nonexistent_ws__", { layout: "force", iterations: 5 });
  assert.ok(Array.isArray(graph.nodes));
  assert.ok(Array.isArray(graph.edges));
  assert.ok(graph.bounds);
  assert.ok(Array.isArray(graph.bounds.min));
  assert.ok(Array.isArray(graph.bounds.max));
  assert.ok(Array.isArray(graph.bounds.center));
  assert.ok(Array.isArray(graph.bounds.size));
  assert.equal(graph.layout, "force");
});

await test("buildSpatialGraph supports sphere layout", async () => {
  const graph = await buildSpatialGraph("__nonexistent_ws__", { layout: "sphere", radius: 4 });
  assert.equal(graph.layout, "sphere");
  assert.ok(Array.isArray(graph.nodes));
});

await test("filterGraphByType keeps only matching nodes and drops orphan edges", () => {
  const graph = {
    nodes: [
      { id: "a", type: "technology" },
      { id: "b", type: "person" },
      { id: "c", type: "technology" },
    ],
    edges: [
      { from: "a", to: "b" },
      { from: "a", to: "c" },
    ],
  };
  const filtered = filterGraphByType(graph, ["technology"]);
  assert.equal(filtered.nodes.length, 2);
  assert.equal(filtered.edges.length, 1);
  assert.equal(filtered.edges[0].from, "a");
  assert.equal(filtered.edges[0].to, "c");
});

await test("filterGraphByType with empty types returns the input unchanged", () => {
  const graph = {
    nodes: [{ id: "a", type: "concept" }],
    edges: [],
  };
  const filtered = filterGraphByType(graph, []);
  assert.equal(filtered.nodes.length, 1);
});

await test("filterGraphByDegree removes low-degree nodes and their edges", () => {
  const graph = {
    nodes: [
      { id: "a" }, { id: "b" }, { id: "c" }, { id: "loner" },
    ],
    edges: [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
    ],
  };
  const filtered = filterGraphByDegree(graph, 1);
  assert.ok(!filtered.nodes.find((n) => n.id === "loner"));
  assert.equal(filtered.nodes.length, 3);
  assert.equal(filtered.edges.length, 2);
});

await test("computeGraphStats reports accurate values for a simple graph", () => {
  const graph = {
    nodes: [{ id: "a" }, { id: "b" }, { id: "c" }],
    edges: [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
    ],
  };
  const stats = computeGraphStats(graph);
  assert.equal(stats.nodeCount, 3);
  assert.equal(stats.edgeCount, 2);
  // Degrees: a=1, b=2, c=1 → avg 4/3
  assert.ok(Math.abs(stats.avgDegree - 4 / 3) < 0.01);
  // Density: 2*2 / (3*2) = 2/3
  assert.ok(Math.abs(stats.density - 2 / 3) < 0.01);
  assert.equal(stats.diameter, 2);
});

await test("computeGraphStats handles an empty graph", () => {
  const stats = computeGraphStats({ nodes: [], edges: [] });
  assert.equal(stats.nodeCount, 0);
  assert.equal(stats.edgeCount, 0);
  assert.equal(stats.avgDegree, 0);
  assert.equal(stats.density, 0);
  assert.equal(stats.diameter, 0);
});

await test("getNeighborhood returns the node itself at depth 0", () => {
  const graph = {
    nodes: [{ id: "a" }, { id: "b" }, { id: "c" }],
    edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }],
  };
  const nb = getNeighborhood(graph, "a", 0);
  assert.equal(nb.nodes.length, 1);
  assert.equal(nb.nodes[0].id, "a");
});

await test("getNeighborhood returns direct neighbors at depth 1", () => {
  const graph = {
    nodes: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }],
    edges: [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
      { from: "c", to: "d" },
    ],
  };
  const nb = getNeighborhood(graph, "a", 1);
  const ids = nb.nodes.map((n) => n.id).sort();
  assert.deepEqual(ids, ["a", "b"]);
});

await test("getNeighborhood depth 2 reaches two hops away", () => {
  const graph = {
    nodes: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }],
    edges: [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
      { from: "c", to: "d" },
    ],
  };
  const nb = getNeighborhood(graph, "a", 2);
  const ids = nb.nodes.map((n) => n.id).sort();
  assert.deepEqual(ids, ["a", "b", "c"]);
});

await test("pathBetween returns BFS shortest path", () => {
  const graph = {
    nodes: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }],
    edges: [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
      { from: "c", to: "d" },
      { from: "a", to: "d" },
    ],
  };
  const path = pathBetween(graph, "a", "d");
  assert.ok(path);
  assert.deepEqual(path.path, ["a", "d"]);
  assert.equal(path.length, 1);
});

await test("pathBetween returns null when graph is disconnected", () => {
  const graph = {
    nodes: [{ id: "a" }, { id: "b" }, { id: "c" }],
    edges: [{ from: "a", to: "b" }],
  };
  const path = pathBetween(graph, "a", "c");
  assert.equal(path, null);
});

await test("pathBetween returns a zero-length path for same source and target", () => {
  const graph = {
    nodes: [{ id: "a" }, { id: "b" }],
    edges: [{ from: "a", to: "b" }],
  };
  const path = pathBetween(graph, "a", "a");
  assert.ok(path);
  assert.deepEqual(path.path, ["a"]);
  assert.equal(path.length, 0);
});

await test("pathBetween returns null for unknown node ids", () => {
  const graph = {
    nodes: [{ id: "a" }, { id: "b" }],
    edges: [{ from: "a", to: "b" }],
  };
  assert.equal(pathBetween(graph, "a", "missing"), null);
  assert.equal(pathBetween(graph, "missing", "a"), null);
});

await test("_internals.computeBounds reports correct box for laid-out nodes", () => {
  const nodes = [
    { id: "a", position: [-1, -2, -3] },
    { id: "b", position: [4, 5, 6] },
  ];
  const bounds = _internals.computeBounds(nodes);
  assert.deepEqual(bounds.min, [-1, -2, -3]);
  assert.deepEqual(bounds.max, [4, 5, 6]);
  assert.deepEqual(bounds.center, [1.5, 1.5, 1.5]);
  assert.deepEqual(bounds.size, [5, 7, 9]);
});
