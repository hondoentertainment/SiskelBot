/**
 * Phase 52.3: Graph-of-Thought reasoning.
 *
 * Unlike tree-of-thought, thoughts can merge (convergent reasoning).
 * This requires a DAG with cycle detection.
 *
 * Edge types:
 *   derives_from — conventional derivation (parent → child)
 *   supports     — evidence/justification
 *   contradicts  — negates or disputes another thought
 *   merges       — two or more thoughts were fused into a new node
 */

const VALID_EDGE_TYPES = new Set([
  "derives_from",
  "supports",
  "contradicts",
  "merges",
]);

let idCounter = 0;
function nextId(prefix = "n") {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

export class ThoughtGraph {
  constructor() {
    // nodes: Map<nodeId, { id, thought, metadata, createdAt }>
    this.nodes = new Map();
    // edges: Map<fromId, Map<toId, { type }>>
    this.edges = new Map();
    // reverse adjacency for fast ancestor lookup
    this.reverseEdges = new Map();
  }

  addNode(thought, metadata = {}) {
    const id = nextId("node");
    this.nodes.set(id, {
      id,
      thought,
      metadata: metadata || {},
      createdAt: Date.now(),
    });
    this.edges.set(id, new Map());
    this.reverseEdges.set(id, new Map());
    return id;
  }

  addEdge(fromId, toId, type = "derives_from") {
    if (!this.nodes.has(fromId)) {
      throw new Error(`fromId ${fromId} not found`);
    }
    if (!this.nodes.has(toId)) {
      throw new Error(`toId ${toId} not found`);
    }
    if (fromId === toId) {
      throw new Error("self-loops not allowed");
    }
    if (!VALID_EDGE_TYPES.has(type)) {
      throw new Error(
        `invalid edge type: ${type} (valid: ${Array.from(VALID_EDGE_TYPES).join(", ")})`,
      );
    }

    // Tentatively add and check for cycle.
    this.edges.get(fromId).set(toId, { type });
    this.reverseEdges.get(toId).set(fromId, { type });

    if (this._createsCycle()) {
      // Rollback.
      this.edges.get(fromId).delete(toId);
      this.reverseEdges.get(toId).delete(fromId);
      throw new Error(
        `edge ${fromId} -> ${toId} would create a cycle`,
      );
    }

    return true;
  }

  removeNode(nodeId) {
    if (!this.nodes.has(nodeId)) return false;
    // Remove all outgoing edges.
    for (const toId of this.edges.get(nodeId).keys()) {
      this.reverseEdges.get(toId).delete(nodeId);
    }
    // Remove all incoming edges.
    for (const fromId of this.reverseEdges.get(nodeId).keys()) {
      this.edges.get(fromId).delete(nodeId);
    }
    this.edges.delete(nodeId);
    this.reverseEdges.delete(nodeId);
    this.nodes.delete(nodeId);
    return true;
  }

  removeEdge(fromId, toId) {
    if (!this.edges.has(fromId)) return false;
    const outgoing = this.edges.get(fromId);
    if (!outgoing.has(toId)) return false;
    outgoing.delete(toId);
    this.reverseEdges.get(toId).delete(fromId);
    return true;
  }

  hasNode(nodeId) {
    return this.nodes.has(nodeId);
  }

  /**
   * DFS-based cycle check — public API.
   */
  hasCycle() {
    return this._createsCycle();
  }

  _createsCycle() {
    const WHITE = 0;
    const GRAY = 1;
    const BLACK = 2;
    const color = new Map();
    for (const id of this.nodes.keys()) color.set(id, WHITE);

    const dfs = (id) => {
      color.set(id, GRAY);
      const neighbors = this.edges.get(id);
      if (neighbors) {
        for (const toId of neighbors.keys()) {
          const c = color.get(toId);
          if (c === GRAY) return true;
          if (c === WHITE && dfs(toId)) return true;
        }
      }
      color.set(id, BLACK);
      return false;
    };

    for (const id of this.nodes.keys()) {
      if (color.get(id) === WHITE) {
        if (dfs(id)) return true;
      }
    }
    return false;
  }

  /**
   * Kahn's algorithm topological sort.
   * Throws if the graph has a cycle.
   */
  topoSort() {
    if (this.hasCycle()) {
      throw new Error("cannot topologically sort: graph has a cycle");
    }
    const inDegree = new Map();
    for (const id of this.nodes.keys()) {
      inDegree.set(id, this.reverseEdges.get(id).size);
    }
    const queue = [];
    for (const [id, deg] of inDegree.entries()) {
      if (deg === 0) queue.push(id);
    }
    const result = [];
    while (queue.length > 0) {
      const id = queue.shift();
      result.push(id);
      for (const toId of this.edges.get(id).keys()) {
        const d = inDegree.get(toId) - 1;
        inDegree.set(toId, d);
        if (d === 0) queue.push(toId);
      }
    }
    if (result.length !== this.nodes.size) {
      throw new Error("cannot topologically sort: graph has a cycle");
    }
    return result;
  }

  getNode(nodeId) {
    return this.nodes.get(nodeId) || null;
  }

  /**
   * Get neighbors in a direction.
   * direction: "out" | "in" | "both"
   */
  getNeighbors(nodeId, direction = "out") {
    if (!this.nodes.has(nodeId)) return [];
    const out = [];
    if (direction === "out" || direction === "both") {
      for (const [toId, edge] of this.edges.get(nodeId).entries()) {
        out.push({ id: toId, direction: "out", type: edge.type });
      }
    }
    if (direction === "in" || direction === "both") {
      for (const [fromId, edge] of this.reverseEdges.get(nodeId).entries()) {
        out.push({ id: fromId, direction: "in", type: edge.type });
      }
    }
    return out;
  }

  /**
   * DFS upward — all reachable ancestors.
   */
  getAncestors(nodeId) {
    if (!this.nodes.has(nodeId)) return [];
    const visited = new Set();
    const stack = [nodeId];
    while (stack.length > 0) {
      const id = stack.pop();
      for (const fromId of this.reverseEdges.get(id).keys()) {
        if (!visited.has(fromId)) {
          visited.add(fromId);
          stack.push(fromId);
        }
      }
    }
    return Array.from(visited);
  }

  /**
   * DFS downward — all reachable descendants.
   */
  getDescendants(nodeId) {
    if (!this.nodes.has(nodeId)) return [];
    const visited = new Set();
    const stack = [nodeId];
    while (stack.length > 0) {
      const id = stack.pop();
      for (const toId of this.edges.get(id).keys()) {
        if (!visited.has(toId)) {
          visited.add(toId);
          stack.push(toId);
        }
      }
    }
    return Array.from(visited);
  }

  /**
   * Leaves: nodes with no outgoing edges.
   */
  getLeaves() {
    const out = [];
    for (const [id, adj] of this.edges.entries()) {
      if (adj.size === 0) out.push(id);
    }
    return out;
  }

  /**
   * Roots: nodes with no incoming edges.
   */
  getRoots() {
    const out = [];
    for (const [id, adj] of this.reverseEdges.entries()) {
      if (adj.size === 0) out.push(id);
    }
    return out;
  }

  toJSON() {
    const nodes = [];
    for (const node of this.nodes.values()) {
      nodes.push({
        id: node.id,
        thought: node.thought,
        metadata: node.metadata,
        createdAt: node.createdAt,
      });
    }
    const edges = [];
    for (const [fromId, adj] of this.edges.entries()) {
      for (const [toId, edge] of adj.entries()) {
        edges.push({ from: fromId, to: toId, type: edge.type });
      }
    }
    return { nodes, edges };
  }

  static fromJSON(json) {
    const g = new ThoughtGraph();
    if (!json || !Array.isArray(json.nodes)) return g;
    // Preserve ids by restoring directly instead of going through addNode.
    for (const node of json.nodes) {
      g.nodes.set(node.id, {
        id: node.id,
        thought: node.thought,
        metadata: node.metadata || {},
        createdAt: node.createdAt || Date.now(),
      });
      g.edges.set(node.id, new Map());
      g.reverseEdges.set(node.id, new Map());
    }
    if (Array.isArray(json.edges)) {
      for (const edge of json.edges) {
        if (!g.nodes.has(edge.from) || !g.nodes.has(edge.to)) continue;
        const type = VALID_EDGE_TYPES.has(edge.type) ? edge.type : "derives_from";
        g.edges.get(edge.from).set(edge.to, { type });
        g.reverseEdges.get(edge.to).set(edge.from, { type });
      }
    }
    return g;
  }
}

/**
 * Expand a seed node by calling an expander function that returns
 * candidate child thoughts. Returns the updated graph.
 *
 * expander: async (node) => [{ thought, edgeType, metadata }]
 */
export async function expandGraph(graph, seedNodeId, expander, options = {}) {
  if (!(graph instanceof ThoughtGraph)) {
    throw new Error("graph must be a ThoughtGraph");
  }
  if (!graph.hasNode(seedNodeId)) {
    throw new Error(`seedNodeId ${seedNodeId} not found`);
  }
  if (typeof expander !== "function") {
    throw new Error("expander must be a function");
  }
  const maxChildren = Number.isFinite(options.maxChildren) ? options.maxChildren : 8;

  const seed = graph.getNode(seedNodeId);
  const candidates = await expander(seed);
  if (!Array.isArray(candidates)) return graph;

  const added = [];
  for (const cand of candidates.slice(0, maxChildren)) {
    if (!cand || typeof cand.thought === "undefined") continue;
    const type = cand.edgeType || "derives_from";
    const childId = graph.addNode(cand.thought, cand.metadata || {});
    try {
      graph.addEdge(seedNodeId, childId, type);
      added.push(childId);
    } catch (err) {
      // Rollback the node on cycle/edge failure.
      graph.removeNode(childId);
    }
  }
  return { graph, added };
}

/**
 * Merge a set of thoughts into a new convergent node. Each original
 * node gets an edge of type "merges" pointing to the new node.
 *
 * mergeFn: (nodes) => mergedThought
 */
export function mergeThoughts(graph, nodeIds, mergeFn) {
  if (!(graph instanceof ThoughtGraph)) {
    throw new Error("graph must be a ThoughtGraph");
  }
  if (!Array.isArray(nodeIds) || nodeIds.length < 2) {
    throw new Error("mergeThoughts requires at least 2 nodeIds");
  }
  if (typeof mergeFn !== "function") {
    throw new Error("mergeFn must be a function");
  }
  const nodes = [];
  for (const id of nodeIds) {
    const n = graph.getNode(id);
    if (!n) throw new Error(`node ${id} not found`);
    nodes.push(n);
  }
  const mergedThought = mergeFn(nodes);
  const mergedId = graph.addNode(mergedThought, {
    merged: true,
    sources: nodeIds.slice(),
  });
  for (const id of nodeIds) {
    try {
      graph.addEdge(id, mergedId, "merges");
    } catch (err) {
      // If creating the edge somehow cycles, abort the merge.
      graph.removeNode(mergedId);
      throw new Error(`merge failed: ${err.message}`, { cause: err });
    }
  }
  return mergedId;
}

/**
 * Score each node. scorer: (node) => number. Returns sorted desc.
 */
export function scoreGraph(graph, scorer) {
  if (!(graph instanceof ThoughtGraph)) {
    throw new Error("graph must be a ThoughtGraph");
  }
  if (typeof scorer !== "function") {
    throw new Error("scorer must be a function");
  }
  const scored = [];
  for (const node of graph.nodes.values()) {
    let score;
    try {
      score = scorer(node);
    } catch {
      score = 0;
    }
    scored.push({ id: node.id, thought: node.thought, score: Number(score) || 0 });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/**
 * Find the highest-scoring path to a target node, using the sum of
 * node scores along the path. Uses dynamic programming on topological
 * order.
 */
export function findCriticalPath(graph, targetId, scorer) {
  if (!(graph instanceof ThoughtGraph)) {
    throw new Error("graph must be a ThoughtGraph");
  }
  if (!graph.hasNode(targetId)) {
    throw new Error(`targetId ${targetId} not found`);
  }
  const scoreFn =
    typeof scorer === "function"
      ? scorer
      : (node) => {
          const s = node?.metadata?.score;
          return typeof s === "number" ? s : 1;
        };

  const order = graph.topoSort();
  const nodeScore = new Map();
  for (const n of graph.nodes.values()) {
    nodeScore.set(n.id, Number(scoreFn(n)) || 0);
  }

  // best[id] = highest path score ending at id
  const best = new Map();
  const prev = new Map();
  for (const id of order) {
    best.set(id, nodeScore.get(id));
    prev.set(id, null);
  }
  for (const id of order) {
    for (const toId of graph.edges.get(id).keys()) {
      const candidate = best.get(id) + nodeScore.get(toId);
      if (candidate > best.get(toId)) {
        best.set(toId, candidate);
        prev.set(toId, id);
      }
    }
  }

  // Reconstruct path.
  const path = [];
  let cur = targetId;
  while (cur) {
    path.unshift(cur);
    cur = prev.get(cur);
  }
  return { path, score: best.get(targetId) || 0 };
}

/**
 * Full reasoning loop. Expands from a seed, optionally merges similar
 * thoughts, and stops on a goal check or when maxNodes is reached.
 *
 * options:
 *   expander(node) -> candidate children
 *   maxNodes: number, default 20
 *   mergeThreshold: number (unused stub, caller can merge)
 *   goalCheck(node) -> boolean
 *   seedThought: string
 *   scorer(node) -> number
 */
export async function reasonWithGraph(task, options = {}) {
  const {
    expander,
    maxNodes = 20,
    goalCheck,
    seedThought,
    scorer,
  } = options;

  if (typeof expander !== "function") {
    throw new Error("options.expander is required");
  }

  const graph = new ThoughtGraph();
  const seed = seedThought || `Task: ${task}`;
  const seedId = graph.addNode(seed, { role: "seed", task });

  const frontier = [seedId];
  let goalNodeId = null;
  let iterations = 0;

  while (frontier.length > 0 && graph.nodes.size < maxNodes) {
    iterations += 1;
    const current = frontier.shift();
    const currentNode = graph.getNode(current);

    if (typeof goalCheck === "function" && goalCheck(currentNode)) {
      goalNodeId = current;
      break;
    }

    const { added } = await expandGraph(graph, current, expander, {
      maxChildren: Math.max(1, maxNodes - graph.nodes.size),
    });
    for (const childId of added) {
      const childNode = graph.getNode(childId);
      if (typeof goalCheck === "function" && goalCheck(childNode)) {
        goalNodeId = childId;
        break;
      }
      frontier.push(childId);
    }
    if (goalNodeId) break;
  }

  // Pick a target if no goal was hit: highest-scoring leaf.
  if (!goalNodeId) {
    const leaves = graph.getLeaves();
    if (leaves.length > 0) {
      const scored = leaves
        .map((id) => {
          const node = graph.getNode(id);
          const s = typeof scorer === "function" ? scorer(node) : node?.metadata?.score || 0;
          return { id, score: Number(s) || 0 };
        })
        .sort((a, b) => b.score - a.score);
      goalNodeId = scored[0].id;
    } else {
      goalNodeId = seedId;
    }
  }

  const critical = findCriticalPath(graph, goalNodeId, scorer);
  const answerNode = graph.getNode(goalNodeId);
  return {
    graph,
    bestPath: critical.path,
    answer: answerNode?.thought,
    stats: {
      nodes: graph.nodes.size,
      iterations,
      pathLength: critical.path.length,
      pathScore: critical.score,
      reachedGoal: typeof goalCheck === "function" && goalCheck(answerNode),
    },
  };
}

/**
 * Find pairs of nodes connected by a "contradicts" edge (either direction).
 */
export function findContradictions(graph) {
  if (!(graph instanceof ThoughtGraph)) {
    throw new Error("graph must be a ThoughtGraph");
  }
  const out = [];
  const seen = new Set();
  for (const [fromId, adj] of graph.edges.entries()) {
    for (const [toId, edge] of adj.entries()) {
      if (edge.type !== "contradicts") continue;
      const key = [fromId, toId].sort().join("::");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        a: fromId,
        b: toId,
        aThought: graph.getNode(fromId)?.thought,
        bThought: graph.getNode(toId)?.thought,
      });
    }
  }
  return out;
}

/**
 * Resolve detected contradictions using a resolver callback.
 * resolver: ({ a, b, aThought, bThought }) => { winner: "a" | "b" | "both", note }
 * Returns array of resolution records.
 */
export function resolveContradictions(graph, resolver) {
  if (!(graph instanceof ThoughtGraph)) {
    throw new Error("graph must be a ThoughtGraph");
  }
  if (typeof resolver !== "function") {
    throw new Error("resolver must be a function");
  }
  const contradictions = findContradictions(graph);
  const resolutions = [];
  for (const c of contradictions) {
    let result;
    try {
      result = resolver(c);
    } catch {
      result = { winner: "both" };
    }
    if (!result) result = { winner: "both" };
    if (result.winner === "a") {
      graph.removeNode(c.b);
    } else if (result.winner === "b") {
      graph.removeNode(c.a);
    }
    resolutions.push({ ...c, ...result });
  }
  return resolutions;
}

function escapeDotLabel(s) {
  return String(s || "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
}

function escapeMermaidLabel(s) {
  return String(s || "")
    .replace(/"/g, "'")
    .replace(/\n/g, " ")
    .replace(/[[\]]/g, " ");
}

export function graphToDot(graph) {
  if (!(graph instanceof ThoughtGraph)) {
    throw new Error("graph must be a ThoughtGraph");
  }
  const lines = ["digraph ThoughtGraph {", "  rankdir=TB;", '  node [shape=box, style=rounded];'];
  for (const node of graph.nodes.values()) {
    const label = escapeDotLabel(node.thought);
    lines.push(`  "${node.id}" [label="${label}"];`);
  }
  for (const [fromId, adj] of graph.edges.entries()) {
    for (const [toId, edge] of adj.entries()) {
      lines.push(`  "${fromId}" -> "${toId}" [label="${edge.type}"];`);
    }
  }
  lines.push("}");
  return lines.join("\n");
}

export function graphToMermaid(graph) {
  if (!(graph instanceof ThoughtGraph)) {
    throw new Error("graph must be a ThoughtGraph");
  }
  const lines = ["graph TD"];
  for (const node of graph.nodes.values()) {
    const label = escapeMermaidLabel(node.thought);
    lines.push(`  ${node.id}["${label}"]`);
  }
  for (const [fromId, adj] of graph.edges.entries()) {
    for (const [toId, edge] of adj.entries()) {
      lines.push(`  ${fromId} -->|${edge.type}| ${toId}`);
    }
  }
  return lines.join("\n");
}

export default {
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
};
