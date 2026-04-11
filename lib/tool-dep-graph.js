// @ts-check
/**
 * Phase 53.2: Tool dependency graph.
 *
 * Builds a directed graph over tools using their input/output JSON schemas:
 * an edge A -> B means A's output can (structurally) flow into at least one
 * required input of B. Supports:
 *
 *   - `buildGraphFromTools(tools)`    -- infer edges from input/output schemas
 *   - `topoSort(graph)`               -- deterministic topological order (Kahn)
 *   - `findCycles(graph)`             -- all simple cycles (Tarjan-like)
 *   - `matchTypes(srcSchema, dstSchema)` -- structural compatibility check
 *   - `suggestPipeline(from, to)`     -- shortest path of tools that produces
 *                                        `to`'s inputs starting from `from`'s
 *                                        outputs
 *   - `validatePipeline(pipeline)`    -- sanity-check a tool sequence
 *
 * The graph is persisted via `json-path-store.js` so previously built graphs
 * can be reloaded without re-scanning every registered tool.
 *
 * @module tool-dep-graph
 */
import { join } from "path";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;

function graphPath() {
  return join(getDataDir(), "tool-dep-graph.json");
}

async function loadGraphStore() {
  const data = await readJsonPath(graphPath(), {
    version: STORE_VERSION,
    graphs: {},
  });
  if (!data || typeof data !== "object") return { version: STORE_VERSION, graphs: {} };
  if (!data.graphs || typeof data.graphs !== "object") data.graphs = {};
  return data;
}

async function saveGraphStore(data) {
  await writeJsonPath(graphPath(), {
    version: STORE_VERSION,
    graphs: data.graphs || {},
  });
}

/* -------------------------------------------------------------------------- */
/* Type compatibility                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Normalize a schema type field into a canonical set. JSON-schema allows
 * either a string or an array; we fold both into a Set for comparison.
 *
 * @param {any} schema
 * @returns {Set<string>}
 */
function typesOf(schema) {
  if (!schema || typeof schema !== "object") return new Set();
  const t = schema.type;
  if (Array.isArray(t)) return new Set(t.map((x) => String(x)));
  if (typeof t === "string") return new Set([t]);
  // If no explicit type but has properties, treat as object.
  if (schema.properties && typeof schema.properties === "object") {
    return new Set(["object"]);
  }
  if (schema.items) return new Set(["array"]);
  return new Set();
}

/**
 * Structural type-match. Returns a compatibility score 0..1.
 *
 *   - 0     -- no compatibility
 *   - 0.5   -- types overlap but structure differs
 *   - 0.75  -- same type + partial property match
 *   - 1     -- exact match (all required props present)
 *
 * @param {any} srcSchema
 * @param {any} dstSchema
 * @returns {number}
 */
export function matchTypes(srcSchema, dstSchema) {
  if (!srcSchema || !dstSchema) return 0;
  const srcTypes = typesOf(srcSchema);
  const dstTypes = typesOf(dstSchema);
  if (srcTypes.size === 0 || dstTypes.size === 0) return 0;
  let overlap = false;
  for (const t of srcTypes) {
    if (dstTypes.has(t)) {
      overlap = true;
      break;
    }
  }
  if (!overlap) {
    // Allow integer/number interchange.
    if (
      (srcTypes.has("integer") && dstTypes.has("number")) ||
      (srcTypes.has("number") && dstTypes.has("integer"))
    ) {
      return 0.75;
    }
    return 0;
  }
  if (dstTypes.has("object") && srcTypes.has("object")) {
    const srcProps = (srcSchema.properties && typeof srcSchema.properties === "object") ? srcSchema.properties : null;
    const dstProps = (dstSchema.properties && typeof dstSchema.properties === "object") ? dstSchema.properties : null;
    if (!dstProps) return 0.5;
    const required = Array.isArray(dstSchema.required) ? dstSchema.required : Object.keys(dstProps);
    if (required.length === 0) return 0.75;
    if (!srcProps) return 0;
    let present = 0;
    let compat = 0;
    for (const r of required) {
      if (Object.prototype.hasOwnProperty.call(srcProps, r)) {
        present += 1;
        const sub = matchTypes(srcProps[r], dstProps[r]);
        if (sub > 0) compat += sub;
      }
    }
    if (present === 0) return 0;
    if (present === required.length && compat >= required.length * 0.9) return 1;
    return 0.5 + 0.25 * (compat / Math.max(1, required.length));
  }
  if (dstTypes.has("array") && srcTypes.has("array")) {
    return matchTypes(srcSchema.items || {}, dstSchema.items || {}) >= 0.5 ? 1 : 0.5;
  }
  return 1;
}

/* -------------------------------------------------------------------------- */
/* Graph build                                                                */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} ToolSpec
 * @property {string} name
 * @property {any}    [input]    -- JSON schema describing input
 * @property {any}    [output]   -- JSON schema describing output
 * @property {string} [description]
 */

/**
 * @typedef {Object} DepGraph
 * @property {Record<string, ToolSpec>} nodes
 * @property {Record<string, Array<{ to: string, score: number, reason: string }>>} edges
 * @property {number} builtAt
 * @property {number} version
 */

/**
 * Build a dependency graph from a list of tool specs. An edge A -> B is added
 * whenever `matchTypes(A.output, B.input)` > 0.
 *
 * @param {ToolSpec[]} tools
 * @returns {DepGraph}
 */
export function buildGraphFromTools(tools) {
  /** @type {DepGraph} */
  const graph = {
    nodes: {},
    edges: {},
    builtAt: Date.now(),
    version: STORE_VERSION,
  };
  if (!Array.isArray(tools)) return graph;
  for (const t of tools) {
    if (!t || typeof t !== "object" || !t.name) continue;
    graph.nodes[t.name] = {
      name: String(t.name),
      input: t.input || null,
      output: t.output || null,
      description: t.description || "",
    };
    graph.edges[t.name] = [];
  }
  const names = Object.keys(graph.nodes);
  for (const a of names) {
    for (const b of names) {
      if (a === b) continue;
      const src = graph.nodes[a];
      const dst = graph.nodes[b];
      if (!src.output || !dst.input) continue;
      const score = matchTypes(src.output, dst.input);
      if (score > 0) {
        graph.edges[a].push({
          to: b,
          score: Math.round(score * 1000) / 1000,
          reason: `${a}.output → ${b}.input (score=${score.toFixed(2)})`,
        });
      }
    }
    graph.edges[a].sort((x, y) => y.score - x.score || x.to.localeCompare(y.to));
  }
  return graph;
}

/**
 * Persist a named graph.
 * @param {string} name
 * @param {DepGraph} graph
 */
export async function saveGraph(name, graph) {
  if (!name) throw new Error("name is required");
  if (!graph || typeof graph !== "object") throw new Error("graph is required");
  const path = graphPath();
  return withPathLock(path, async () => {
    const store = await loadGraphStore();
    store.graphs[name] = graph;
    await saveGraphStore(store);
    return graph;
  });
}

/** Fetch a persisted graph by name. */
export async function loadGraph(name) {
  const store = await loadGraphStore();
  return store.graphs[name] || null;
}

/** List persisted graph names. */
export async function listGraphs() {
  const store = await loadGraphStore();
  return Object.keys(store.graphs || {});
}

/* -------------------------------------------------------------------------- */
/* Topological sort                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Kahn's algorithm. Returns `{ order, cyclic }` where `cyclic` lists nodes
 * that could not be placed because they belong to a cycle.
 *
 * @param {DepGraph} graph
 * @returns {{ order: string[], cyclic: string[] }}
 */
export function topoSort(graph) {
  if (!graph || typeof graph !== "object") {
    throw new Error("graph is required");
  }
  const nodes = Object.keys(graph.nodes || {});
  /** @type {Record<string, number>} */
  const inDeg = {};
  for (const n of nodes) inDeg[n] = 0;
  for (const src of nodes) {
    const edges = graph.edges && graph.edges[src] ? graph.edges[src] : [];
    for (const e of edges) {
      if (inDeg[e.to] == null) continue;
      inDeg[e.to] += 1;
    }
  }
  /** @type {string[]} */
  const ready = nodes.filter((n) => inDeg[n] === 0).sort();
  /** @type {string[]} */
  const order = [];
  while (ready.length > 0) {
    const n = ready.shift();
    if (!n) break;
    order.push(n);
    const edges = graph.edges && graph.edges[n] ? graph.edges[n] : [];
    for (const e of edges) {
      if (inDeg[e.to] == null) continue;
      inDeg[e.to] -= 1;
      if (inDeg[e.to] === 0) {
        // Keep ready sorted to make output deterministic.
        let i = 0;
        while (i < ready.length && ready[i] < e.to) i += 1;
        ready.splice(i, 0, e.to);
      }
    }
  }
  const cyclic = nodes.filter((n) => !order.includes(n));
  return { order, cyclic };
}

/* -------------------------------------------------------------------------- */
/* Cycle detection                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Return all simple cycles using DFS-based detection. Each cycle is a list
 * of node names where the first and last are the same.
 *
 * @param {DepGraph} graph
 * @returns {string[][]}
 */
export function findCycles(graph) {
  if (!graph || typeof graph !== "object") return [];
  const nodes = Object.keys(graph.nodes || {});
  /** @type {string[][]} */
  const cycles = [];
  /** @type {Set<string>} */
  const seen = new Set();

  for (const start of nodes) {
    /** @type {Array<{ node: string, path: string[], visited: Set<string> }>} */
    const stack = [{ node: start, path: [start], visited: new Set([start]) }];
    while (stack.length > 0) {
      const frame = stack.pop();
      if (!frame) break;
      const edges = graph.edges && graph.edges[frame.node] ? graph.edges[frame.node] : [];
      for (const e of edges) {
        if (e.to === start) {
          const cycle = [...frame.path, start];
          const key = canonicalCycleKey(cycle);
          if (!seen.has(key)) {
            seen.add(key);
            cycles.push(cycle);
          }
          continue;
        }
        if (frame.visited.has(e.to)) continue;
        const nv = new Set(frame.visited);
        nv.add(e.to);
        stack.push({ node: e.to, path: [...frame.path, e.to], visited: nv });
      }
    }
  }
  return cycles;
}

function canonicalCycleKey(cycle) {
  // Strip trailing duplicate, rotate to the lexicographically smallest start.
  const core = cycle.slice(0, -1);
  if (core.length === 0) return "";
  let minIdx = 0;
  for (let i = 1; i < core.length; i += 1) {
    if (core[i] < core[minIdx]) minIdx = i;
  }
  const rotated = core.slice(minIdx).concat(core.slice(0, minIdx));
  return rotated.join("→");
}

/* -------------------------------------------------------------------------- */
/* Pipeline suggestion                                                        */
/* -------------------------------------------------------------------------- */

/**
 * BFS over the graph from `from` to `to`, returning the shortest path (as
 * tool names) or `null` if unreachable. Passing through the graph's edges
 * guarantees every hop is type-compatible.
 *
 * @param {DepGraph} graph
 * @param {string} from
 * @param {string} to
 * @returns {string[] | null}
 */
export function suggestPipeline(graph, from, to) {
  if (!graph || typeof graph !== "object") return null;
  if (!from || !to) return null;
  if (!graph.nodes[from] || !graph.nodes[to]) return null;
  if (from === to) return [from];
  const queue = [[from]];
  const visited = new Set([from]);
  while (queue.length > 0) {
    const path = queue.shift();
    if (!path) break;
    const tail = path[path.length - 1];
    const edges = graph.edges && graph.edges[tail] ? graph.edges[tail] : [];
    for (const e of edges) {
      if (e.to === to) return [...path, to];
      if (visited.has(e.to)) continue;
      visited.add(e.to);
      queue.push([...path, e.to]);
    }
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Pipeline validation                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Validate a sequence of tool names as a pipeline. Each consecutive pair
 * must have a compatible edge in the graph (score > 0).
 *
 * @param {DepGraph} graph
 * @param {string[]} pipeline
 * @returns {{ ok: boolean, issues: string[], score: number }}
 */
export function validatePipeline(graph, pipeline) {
  if (!graph || typeof graph !== "object") {
    return { ok: false, issues: ["graph missing"], score: 0 };
  }
  if (!Array.isArray(pipeline) || pipeline.length === 0) {
    return { ok: false, issues: ["empty pipeline"], score: 0 };
  }
  /** @type {string[]} */
  const issues = [];
  let total = 0;
  for (const name of pipeline) {
    if (!graph.nodes[name]) issues.push(`unknown tool: ${name}`);
  }
  for (let i = 0; i < pipeline.length - 1; i += 1) {
    const a = pipeline[i];
    const b = pipeline[i + 1];
    const edges = graph.edges && graph.edges[a] ? graph.edges[a] : [];
    const edge = edges.find((e) => e.to === b);
    if (!edge) {
      issues.push(`no edge ${a} -> ${b}`);
      continue;
    }
    total += edge.score;
  }
  const score = pipeline.length > 1 ? total / (pipeline.length - 1) : 1;
  return { ok: issues.length === 0, issues, score: Math.round(score * 1000) / 1000 };
}
