/**
 * Phase 49.2: Spatial knowledge graph.
 *
 * Projects a workspace's knowledge graph entities and relationships into 3D
 * space for WebXR / VR browsing. Provides force-directed layout, spherical
 * projection, community clustering, neighborhood queries, and shortest-path
 * search. Designed to consume the graph data exposed by lib/knowledge-graph.js
 * but tolerant if that module or a workspace graph file is unavailable.
 */

/**
 * Seeded pseudo-random number generator (mulberry32).
 * Used so layouts with the same seed are deterministic.
 * @param {number} seed
 * @returns {() => number}
 */
function mulberry32(seed) {
  let a = (seed >>> 0) || 1;
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function add(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function scale(v, s) {
  return [v[0] * s, v[1] * s, v[2] * s];
}

function magnitude(v) {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
}

function distance(a, b) {
  return magnitude(sub(a, b));
}

/**
 * Normalize input node/edge lists so the layout is tolerant of partial data.
 * Accepts either {id, position?} or plain id strings for nodes, and edges as
 * {from,to}/{source,target} or [from,to] tuples.
 * @param {Array} rawNodes
 * @param {Array} rawEdges
 */
function normalizeInput(rawNodes, rawEdges) {
  const nodes = [];
  const byId = new Map();
  const list = Array.isArray(rawNodes) ? rawNodes : [];
  for (const n of list) {
    if (n == null) continue;
    let id;
    let rest = {};
    if (typeof n === "string") {
      id = n;
    } else if (typeof n === "object") {
      id = n.id != null ? String(n.id) : null;
      rest = n;
    }
    if (!id || byId.has(id)) continue;
    const node = {
      ...rest,
      id,
      position: Array.isArray(rest.position) && rest.position.length === 3
        ? [Number(rest.position[0]) || 0, Number(rest.position[1]) || 0, Number(rest.position[2]) || 0]
        : null,
      velocity: Array.isArray(rest.velocity) && rest.velocity.length === 3
        ? [Number(rest.velocity[0]) || 0, Number(rest.velocity[1]) || 0, Number(rest.velocity[2]) || 0]
        : [0, 0, 0],
    };
    byId.set(id, node);
    nodes.push(node);
  }

  const edges = [];
  const edgeList = Array.isArray(rawEdges) ? rawEdges : [];
  for (const e of edgeList) {
    if (e == null) continue;
    let from;
    let to;
    let rest = {};
    if (Array.isArray(e) && e.length >= 2) {
      from = String(e[0]);
      to = String(e[1]);
    } else if (typeof e === "object") {
      from = e.from != null ? String(e.from) : e.source != null ? String(e.source) : null;
      to = e.to != null ? String(e.to) : e.target != null ? String(e.target) : null;
      rest = e;
    }
    if (!from || !to) continue;
    if (!byId.has(from) || !byId.has(to)) continue;
    edges.push({ ...rest, from, to });
  }

  return { nodes, edges, byId };
}

/**
 * Initialize node positions if they are missing. Uses a seeded random cube.
 * @param {Array} nodes
 * @param {() => number} rand
 * @param {number} spread
 */
function initializePositions(nodes, rand, spread = 4) {
  for (const node of nodes) {
    if (!Array.isArray(node.position) || node.position.length !== 3) {
      node.position = [
        (rand() - 0.5) * spread,
        (rand() - 0.5) * spread,
        (rand() - 0.5) * spread,
      ];
    }
    if (!Array.isArray(node.velocity) || node.velocity.length !== 3) {
      node.velocity = [0, 0, 0];
    }
  }
}

/**
 * Run a single Fruchterman-Reingold style iteration in 3D.
 * Repulsive force between all node pairs; attractive force along edges.
 * A soft gravity pulls nodes toward the origin so disconnected clusters do
 * not drift to infinity.
 *
 * @param {Array} nodes
 * @param {Array} edges
 * @param {object} cfg
 */
function runIterations(nodes, edges, cfg) {
  const { iterations, k, gravity, damping, initialTemp, minDist } = cfg;
  const n = nodes.length;
  if (n === 0) return;

  const kSquared = k * k;

  for (let it = 0; it < iterations; it++) {
    const temp = initialTemp * (1 - it / Math.max(1, iterations));
    const displacements = nodes.map(() => [0, 0, 0]);

    // Repulsive forces between all pairs.
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const delta = sub(nodes[i].position, nodes[j].position);
        let dist = magnitude(delta);
        if (dist < minDist) dist = minDist;
        const force = kSquared / dist;
        const unit = scale(delta, 1 / dist);
        const push = scale(unit, force);
        displacements[i] = add(displacements[i], push);
        displacements[j] = sub(displacements[j], push);
      }
    }

    // Attractive forces along edges.
    const idIndex = new Map();
    for (let i = 0; i < n; i++) idIndex.set(nodes[i].id, i);
    for (const edge of edges) {
      const i = idIndex.get(edge.from);
      const j = idIndex.get(edge.to);
      if (i == null || j == null) continue;
      const delta = sub(nodes[i].position, nodes[j].position);
      let dist = magnitude(delta);
      if (dist < minDist) dist = minDist;
      const force = (dist * dist) / k;
      const unit = scale(delta, 1 / dist);
      const pull = scale(unit, force);
      displacements[i] = sub(displacements[i], pull);
      displacements[j] = add(displacements[j], pull);
    }

    // Gravity pulls toward origin; damping reduces oscillation.
    for (let i = 0; i < n; i++) {
      const g = scale(nodes[i].position, -gravity);
      displacements[i] = add(displacements[i], g);
    }

    // Apply displacement capped by temperature.
    for (let i = 0; i < n; i++) {
      const disp = scale(displacements[i], damping);
      const dispMag = magnitude(disp);
      if (dispMag === 0) continue;
      const limited = Math.min(dispMag, temp);
      const step = scale(disp, limited / dispMag);
      nodes[i].velocity = step;
      nodes[i].position = add(nodes[i].position, step);
    }
  }
}

/**
 * Fruchterman-Reingold style force-directed layout in 3D.
 *
 * @param {Array} rawNodes - nodes (objects with at least { id })
 * @param {Array} rawEdges - edges between node ids
 * @param {object} [options]
 * @param {number} [options.iterations=100]
 * @param {number} [options.k=1.5]      spring constant / ideal edge length
 * @param {number} [options.gravity=0.05]
 * @param {number} [options.damping=0.9]
 * @param {number} [options.seed=42]
 * @param {number} [options.initialTemp=2]
 * @param {number} [options.minDist=0.01]
 * @returns {{ nodes: Array, edges: Array }}
 */
export function forceDirectedLayout(rawNodes, rawEdges, options = {}) {
  const opts = {
    iterations: Number.isFinite(options.iterations) ? Math.max(0, options.iterations | 0) : 100,
    k: Number.isFinite(options.k) ? options.k : 1.5,
    gravity: Number.isFinite(options.gravity) ? options.gravity : 0.05,
    damping: Number.isFinite(options.damping) ? options.damping : 0.9,
    seed: Number.isFinite(options.seed) ? options.seed : 42,
    initialTemp: Number.isFinite(options.initialTemp) ? options.initialTemp : 2,
    minDist: Number.isFinite(options.minDist) ? options.minDist : 0.01,
  };

  const { nodes, edges } = normalizeInput(rawNodes, rawEdges);
  const rand = mulberry32(opts.seed);

  // A single node should always end up at origin so it's trivially deterministic.
  if (nodes.length === 1) {
    nodes[0].position = [0, 0, 0];
    nodes[0].velocity = [0, 0, 0];
    return { nodes, edges };
  }

  initializePositions(nodes, rand);
  runIterations(nodes, edges, opts);
  return { nodes, edges };
}

/**
 * Run additional layout iterations on an already-placed graph.
 * @param {Array} currentNodes
 * @param {Array} edges
 * @param {object} [options]
 * @returns {{ nodes: Array, edges: Array }}
 */
export function computeLayoutIncremental(currentNodes, edges, options = {}) {
  const opts = {
    iterations: Number.isFinite(options.iterations) ? Math.max(0, options.iterations | 0) : 20,
    k: Number.isFinite(options.k) ? options.k : 1.5,
    gravity: Number.isFinite(options.gravity) ? options.gravity : 0.05,
    damping: Number.isFinite(options.damping) ? options.damping : 0.9,
    seed: Number.isFinite(options.seed) ? options.seed : 42,
    initialTemp: Number.isFinite(options.initialTemp) ? options.initialTemp : 0.8,
    minDist: Number.isFinite(options.minDist) ? options.minDist : 0.01,
  };

  const normalized = normalizeInput(currentNodes, edges);
  const rand = mulberry32(opts.seed);
  // Only initialize nodes that have no position.
  initializePositions(normalized.nodes, rand);
  runIterations(normalized.nodes, normalized.edges, opts);
  return { nodes: normalized.nodes, edges: normalized.edges };
}

/**
 * Simplified label-propagation community detection.
 * Each node starts with its own label; on every pass each node adopts the
 * most frequent label among its neighbors. After convergence (or maxPasses)
 * labels are compacted to small integer cluster ids.
 *
 * @param {Array} rawNodes
 * @param {Array} rawEdges
 * @param {object} [options]
 * @returns {{ nodes: Array, edges: Array }}
 */
export function clusterNodes(rawNodes, rawEdges, options = {}) {
  const maxPasses = Number.isFinite(options.maxPasses) ? options.maxPasses | 0 : 10;
  const { nodes, edges } = normalizeInput(rawNodes, rawEdges);

  if (nodes.length === 0) return { nodes, edges };

  const labels = new Map();
  for (const n of nodes) labels.set(n.id, n.id);

  const neighbors = new Map();
  for (const n of nodes) neighbors.set(n.id, []);
  for (const e of edges) {
    neighbors.get(e.from).push(e.to);
    neighbors.get(e.to).push(e.from);
  }

  for (let pass = 0; pass < maxPasses; pass++) {
    let changed = false;
    // Stable traversal keeps the clustering deterministic.
    for (const n of nodes) {
      const nbrs = neighbors.get(n.id);
      if (nbrs.length === 0) continue;
      const counts = new Map();
      for (const nb of nbrs) {
        const lbl = labels.get(nb);
        counts.set(lbl, (counts.get(lbl) || 0) + 1);
      }
      let bestLabel = labels.get(n.id);
      let bestCount = counts.get(bestLabel) || 0;
      for (const [lbl, cnt] of counts) {
        if (cnt > bestCount || (cnt === bestCount && String(lbl) < String(bestLabel))) {
          bestLabel = lbl;
          bestCount = cnt;
        }
      }
      if (bestLabel !== labels.get(n.id)) {
        labels.set(n.id, bestLabel);
        changed = true;
      }
    }
    if (!changed) break;
  }

  // Compact labels to 0..k-1.
  const compact = new Map();
  let next = 0;
  for (const n of nodes) {
    const lbl = labels.get(n.id);
    if (!compact.has(lbl)) {
      compact.set(lbl, next++);
    }
    n.cluster = compact.get(lbl);
  }

  return { nodes, edges };
}

/**
 * Project nodes onto the surface of a sphere with the given radius using a
 * deterministic Fibonacci-lattice. This gives a pleasant evenly spaced
 * distribution for VR browsing when the exact topology is not important.
 *
 * @param {Array} rawNodes
 * @param {number} [radius=5]
 * @returns {Array}
 */
export function projectToSphere(rawNodes, radius = 5) {
  const r = Number.isFinite(radius) && radius > 0 ? radius : 5;
  const list = Array.isArray(rawNodes) ? rawNodes : [];
  const n = list.length;
  if (n === 0) return [];

  if (n === 1) {
    const first = list[0];
    const id = typeof first === "string" ? first : first?.id;
    return [{
      ...(typeof first === "object" ? first : {}),
      id: id != null ? String(id) : "0",
      position: [r, 0, 0],
      velocity: [0, 0, 0],
    }];
  }

  const golden = Math.PI * (3 - Math.sqrt(5));
  const out = [];
  for (let i = 0; i < n; i++) {
    const source = list[i];
    const rest = typeof source === "object" ? source : {};
    const id = typeof source === "string" ? source : source?.id;
    if (id == null) continue;
    const y = 1 - (i / (n - 1)) * 2;
    const radiusAtY = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    const x = Math.cos(theta) * radiusAtY;
    const z = Math.sin(theta) * radiusAtY;
    out.push({
      ...rest,
      id: String(id),
      position: [x * r, y * r, z * r],
      velocity: [0, 0, 0],
    });
  }
  return out;
}

/**
 * Compute the axis-aligned bounding box of the laid-out nodes.
 * @param {Array} nodes
 */
function computeBounds(nodes) {
  if (!nodes.length) {
    return { min: [0, 0, 0], max: [0, 0, 0], center: [0, 0, 0], size: [0, 0, 0] };
  }
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const n of nodes) {
    const p = n.position || [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      if (p[i] < min[i]) min[i] = p[i];
      if (p[i] > max[i]) max[i] = p[i];
    }
  }
  const center = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  return { min, max, center, size };
}

/**
 * Build a spatial graph for a workspace. Dynamically imports the knowledge
 * graph store so this module stays usable in environments where the graph
 * persistence layer is not configured.
 *
 * @param {string} workspaceId
 * @param {object} [options]
 * @param {"force"|"sphere"|"grid"} [options.layout="force"]
 * @param {number} [options.iterations]
 * @param {number} [options.radius]
 * @param {number} [options.seed]
 * @returns {Promise<{ nodes: Array, edges: Array, bounds: object, layout: string }>}
 */
export async function buildSpatialGraph(workspaceId, options = {}) {
  const layout = options.layout || "force";
  let rawEntities = [];
  let rawRelations = [];

  try {
    const mod = await import("./knowledge-graph-store.js");
    if (mod && typeof mod.getWorkspaceKnowledgeGraph === "function") {
      const kg = await mod.getWorkspaceKnowledgeGraph(workspaceId);
      if (kg && typeof kg.serialize === "function") {
        const data = kg.serialize();
        rawEntities = Array.isArray(data.entities) ? data.entities : [];
        rawRelations = Array.isArray(data.relations) ? data.relations : [];
      }
    }
  } catch {
    // Knowledge graph module or file unavailable — fall through with empty data.
  }

  const inputNodes = rawEntities.map((e) => ({
    id: e.id,
    name: e.name,
    type: e.type,
    sourceDocId: e.sourceDocId || null,
  }));
  const inputEdges = rawRelations.map((r) => ({
    from: r.from,
    to: r.to,
    type: r.type,
  }));

  let laid;
  if (layout === "sphere") {
    const radius = Number.isFinite(options.radius) ? options.radius : 5;
    laid = { nodes: projectToSphere(inputNodes, radius), edges: inputEdges };
  } else if (layout === "grid") {
    laid = { nodes: gridLayout(inputNodes), edges: inputEdges };
  } else {
    laid = forceDirectedLayout(inputNodes, inputEdges, {
      iterations: options.iterations,
      seed: options.seed,
    });
  }

  // Attach clusters so the client can color communities.
  const clustered = clusterNodes(laid.nodes, laid.edges);
  const bounds = computeBounds(clustered.nodes);

  return {
    nodes: clustered.nodes,
    edges: clustered.edges,
    bounds,
    layout,
  };
}

/**
 * Deterministic grid layout used as a fallback when neither force-directed
 * nor spherical layout is desired.
 * @param {Array} rawNodes
 */
function gridLayout(rawNodes) {
  const list = Array.isArray(rawNodes) ? rawNodes : [];
  const n = list.length;
  if (n === 0) return [];
  const side = Math.ceil(Math.cbrt(n));
  const step = 2;
  const offset = -((side - 1) * step) / 2;
  const out = [];
  for (let i = 0; i < n; i++) {
    const source = list[i];
    const rest = typeof source === "object" ? source : {};
    const id = typeof source === "string" ? source : source?.id;
    if (id == null) continue;
    const x = i % side;
    const y = Math.floor(i / side) % side;
    const z = Math.floor(i / (side * side));
    out.push({
      ...rest,
      id: String(id),
      position: [offset + x * step, offset + y * step, offset + z * step],
      velocity: [0, 0, 0],
    });
  }
  return out;
}

/**
 * Filter a spatial graph down to nodes matching at least one of the given
 * types. Edges with an endpoint outside the filtered set are dropped.
 *
 * @param {{nodes: Array, edges: Array}} graph
 * @param {string[]} [types]
 * @returns {{nodes: Array, edges: Array, bounds?: object, layout?: string}}
 */
export function filterGraphByType(graph, types = []) {
  const input = graph || { nodes: [], edges: [] };
  const list = Array.isArray(types) ? types.filter(Boolean).map((t) => String(t).toLowerCase()) : [];
  if (list.length === 0) {
    return { ...input, nodes: [...(input.nodes || [])], edges: [...(input.edges || [])] };
  }
  const typeSet = new Set(list);
  const nodes = (input.nodes || []).filter((n) => typeSet.has(String(n.type || "").toLowerCase()));
  const keep = new Set(nodes.map((n) => n.id));
  const edges = (input.edges || []).filter((e) => keep.has(e.from) && keep.has(e.to));
  return { ...input, nodes, edges };
}

/**
 * Filter a spatial graph to nodes whose total degree is at least minDegree.
 * @param {{nodes: Array, edges: Array}} graph
 * @param {number} [minDegree=0]
 */
export function filterGraphByDegree(graph, minDegree = 0) {
  const input = graph || { nodes: [], edges: [] };
  const min = Number.isFinite(minDegree) ? Math.max(0, minDegree | 0) : 0;
  const degree = new Map();
  for (const n of input.nodes || []) degree.set(n.id, 0);
  for (const e of input.edges || []) {
    if (degree.has(e.from)) degree.set(e.from, degree.get(e.from) + 1);
    if (degree.has(e.to)) degree.set(e.to, degree.get(e.to) + 1);
  }
  const nodes = (input.nodes || []).filter((n) => (degree.get(n.id) || 0) >= min);
  const keep = new Set(nodes.map((n) => n.id));
  const edges = (input.edges || []).filter((e) => keep.has(e.from) && keep.has(e.to));
  return { ...input, nodes, edges };
}

/**
 * Compute summary statistics over a spatial graph.
 * @param {{nodes: Array, edges: Array}} graph
 */
export function computeGraphStats(graph) {
  const input = graph || { nodes: [], edges: [] };
  const nodes = input.nodes || [];
  const edges = input.edges || [];
  const nodeCount = nodes.length;
  const edgeCount = edges.length;
  const degree = new Map();
  for (const n of nodes) degree.set(n.id, 0);
  for (const e of edges) {
    if (degree.has(e.from)) degree.set(e.from, degree.get(e.from) + 1);
    if (degree.has(e.to)) degree.set(e.to, degree.get(e.to) + 1);
  }
  const totalDegree = [...degree.values()].reduce((a, b) => a + b, 0);
  const avgDegree = nodeCount > 0 ? totalDegree / nodeCount : 0;
  const maxEdges = nodeCount * (nodeCount - 1);
  const density = maxEdges > 0 ? (2 * edgeCount) / maxEdges : 0;

  // Diameter via BFS (approximation — capped for large graphs).
  let diameter = 0;
  if (nodeCount > 0 && nodeCount <= 200) {
    const adj = new Map();
    for (const n of nodes) adj.set(n.id, []);
    for (const e of edges) {
      if (adj.has(e.from)) adj.get(e.from).push(e.to);
      if (adj.has(e.to)) adj.get(e.to).push(e.from);
    }
    for (const start of adj.keys()) {
      const dist = new Map([[start, 0]]);
      const q = [start];
      while (q.length) {
        const cur = q.shift();
        const d = dist.get(cur);
        for (const nb of adj.get(cur) || []) {
          if (!dist.has(nb)) {
            dist.set(nb, d + 1);
            q.push(nb);
            if (d + 1 > diameter) diameter = d + 1;
          }
        }
      }
    }
  }

  return {
    nodeCount,
    edgeCount,
    avgDegree: Math.round(avgDegree * 1000) / 1000,
    density: Math.round(density * 10000) / 10000,
    diameter,
  };
}

/**
 * Return a subgraph containing nodeId and all neighbors reachable within the
 * given BFS depth. Edges between any pair of included nodes are preserved.
 *
 * @param {{nodes: Array, edges: Array}} graph
 * @param {string} nodeId
 * @param {number} [depth=1]
 */
export function getNeighborhood(graph, nodeId, depth = 1) {
  const input = graph || { nodes: [], edges: [] };
  const d = Number.isFinite(depth) ? Math.max(0, depth | 0) : 1;
  const nodeIndex = new Map();
  for (const n of input.nodes || []) nodeIndex.set(n.id, n);
  if (!nodeIndex.has(nodeId)) return { nodes: [], edges: [] };

  const adj = new Map();
  for (const n of input.nodes || []) adj.set(n.id, []);
  for (const e of input.edges || []) {
    if (adj.has(e.from)) adj.get(e.from).push(e.to);
    if (adj.has(e.to)) adj.get(e.to).push(e.from);
  }

  const visited = new Map([[nodeId, 0]]);
  const queue = [nodeId];
  while (queue.length) {
    const cur = queue.shift();
    const curDepth = visited.get(cur);
    if (curDepth >= d) continue;
    for (const nb of adj.get(cur) || []) {
      if (!visited.has(nb)) {
        visited.set(nb, curDepth + 1);
        queue.push(nb);
      }
    }
  }

  const subNodes = [...visited.keys()].map((id) => nodeIndex.get(id)).filter(Boolean);
  const keep = new Set(visited.keys());
  const subEdges = (input.edges || []).filter((e) => keep.has(e.from) && keep.has(e.to));
  return { nodes: subNodes, edges: subEdges };
}

/**
 * BFS shortest path between two nodes in a spatial graph.
 *
 * @param {{nodes: Array, edges: Array}} graph
 * @param {string} fromId
 * @param {string} toId
 * @returns {{ path: string[], length: number } | null}
 */
export function pathBetween(graph, fromId, toId) {
  const input = graph || { nodes: [], edges: [] };
  const nodeIds = new Set((input.nodes || []).map((n) => n.id));
  if (!nodeIds.has(fromId) || !nodeIds.has(toId)) return null;
  if (fromId === toId) return { path: [fromId], length: 0 };

  const adj = new Map();
  for (const id of nodeIds) adj.set(id, []);
  for (const e of input.edges || []) {
    if (adj.has(e.from)) adj.get(e.from).push(e.to);
    if (adj.has(e.to)) adj.get(e.to).push(e.from);
  }

  const parent = new Map([[fromId, null]]);
  const queue = [fromId];
  while (queue.length) {
    const cur = queue.shift();
    if (cur === toId) {
      const path = [];
      let c = cur;
      while (c != null) {
        path.push(c);
        c = parent.get(c);
      }
      path.reverse();
      return { path, length: path.length - 1 };
    }
    for (const nb of adj.get(cur) || []) {
      if (!parent.has(nb)) {
        parent.set(nb, cur);
        queue.push(nb);
      }
    }
  }
  return null;
}

export const _internals = {
  mulberry32,
  distance,
  computeBounds,
  gridLayout,
};
