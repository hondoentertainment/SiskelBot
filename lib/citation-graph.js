// @ts-check
/**
 * Phase 64.3: Citation graph.
 *
 * Directed graph of paper -> cites -> paper. Supports:
 *   - `addCitation(from, to)` — add a directed edge
 *   - `getCitations(id)` — forward (outgoing) and backward (incoming)
 *   - `findPath(from, to, maxDepth)` — BFS path between two papers
 *   - `computePageRank(opts)` — power-iteration PageRank
 *   - `exportGraph(format)` — JSON or DOT
 *
 * @module citation-graph
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
  return join(getDataDir(), "citation-graph.json");
}

async function loadGraph() {
  const data = await readJsonPath(graphPath(), {
    version: STORE_VERSION,
    nodes: {},
    edges: [],
  });
  if (!data.nodes || typeof data.nodes !== "object") data.nodes = {};
  if (!Array.isArray(data.edges)) data.edges = [];
  return data;
}

async function saveGraph(data) {
  await writeJsonPath(graphPath(), {
    version: STORE_VERSION,
    nodes: data.nodes || {},
    edges: data.edges || [],
  });
}

function ensureNode(data, id, meta = {}) {
  if (!data.nodes[id]) {
    data.nodes[id] = { id, ...meta, addedAt: new Date().toISOString() };
  } else if (meta && Object.keys(meta).length > 0) {
    Object.assign(data.nodes[id], meta);
  }
}

/* -------------------------------------------------------------------------- */
/* CRUD                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Add a citation edge.
 *
 * @param {string} from Source paper id (the one doing the citing).
 * @param {string} to   Target paper id (the cited work).
 * @param {object} [meta] Optional metadata stored on the edge.
 * @returns {Promise<object>}
 */
export async function addCitation(from, to, meta = {}) {
  if (!from || typeof from !== "string") throw new Error("from required");
  if (!to || typeof to !== "string") throw new Error("to required");
  if (from === to) throw new Error("self-citations are not allowed");
  const path = graphPath();
  return withPathLock(path, async () => {
    const data = await loadGraph();
    ensureNode(data, from, meta.fromMeta || {});
    ensureNode(data, to, meta.toMeta || {});
    const exists = data.edges.find((e) => e.from === from && e.to === to);
    if (!exists) {
      const edge = { from, to, weight: Number(meta.weight) || 1, createdAt: new Date().toISOString() };
      data.edges.push(edge);
      await saveGraph(data);
      return edge;
    }
    return exists;
  });
}

/**
 * Get a node's outgoing (cited) and incoming (cited-by) neighbors.
 *
 * @param {string} id
 * @returns {Promise<{ cited: string[], citedBy: string[] }>}
 */
export async function getCitations(id) {
  if (!id) return { cited: [], citedBy: [] };
  const data = await loadGraph();
  /** @type {Set<string>} */
  const cited = new Set();
  /** @type {Set<string>} */
  const citedBy = new Set();
  for (const e of data.edges) {
    if (e.from === id) cited.add(e.to);
    if (e.to === id) citedBy.add(e.from);
  }
  return { cited: [...cited], citedBy: [...citedBy] };
}

/* -------------------------------------------------------------------------- */
/* Path-finding                                                               */
/* -------------------------------------------------------------------------- */

/**
 * BFS from `from` to `to`, following directed edges.
 *
 * @param {string} from
 * @param {string} to
 * @param {number} [maxDepth]
 * @returns {Promise<string[] | null>}
 */
export async function findPath(from, to, maxDepth = 6) {
  if (!from || !to) return null;
  if (from === to) return [from];
  const data = await loadGraph();
  /** @type {Map<string, string[]>} */
  const outMap = new Map();
  for (const e of data.edges) {
    const arr = outMap.get(e.from) || [];
    arr.push(e.to);
    outMap.set(e.from, arr);
  }
  /** @type {Map<string, string | null>} */
  const prev = new Map();
  prev.set(from, null);
  const queue = [{ id: from, depth: 0 }];
  while (queue.length > 0) {
    const { id, depth } = queue.shift();
    if (depth >= maxDepth) continue;
    const neighbors = outMap.get(id) || [];
    for (const n of neighbors) {
      if (prev.has(n)) continue;
      prev.set(n, id);
      if (n === to) {
        // Reconstruct
        const path = [n];
        let cur = id;
        while (cur != null) {
          path.unshift(cur);
          cur = prev.get(cur);
        }
        return path;
      }
      queue.push({ id: n, depth: depth + 1 });
    }
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* PageRank                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Compute a simple PageRank over the graph.
 *
 * @param {object} [opts]
 * @param {number} [opts.damping]
 * @param {number} [opts.iterations]
 * @returns {Promise<Record<string, number>>}
 */
export async function computePageRank(opts = {}) {
  const damping = Number.isFinite(opts.damping) ? opts.damping : 0.85;
  const iterations = Number.isFinite(opts.iterations) ? opts.iterations : 30;
  const data = await loadGraph();
  const nodeIds = Object.keys(data.nodes);
  const N = nodeIds.length;
  if (N === 0) return {};
  /** @type {Record<string, number>} */
  let rank = {};
  for (const id of nodeIds) rank[id] = 1 / N;
  /** @type {Record<string, string[]>} */
  const outgoing = {};
  /** @type {Record<string, string[]>} */
  const incoming = {};
  for (const id of nodeIds) { outgoing[id] = []; incoming[id] = []; }
  for (const e of data.edges) {
    if (outgoing[e.from]) outgoing[e.from].push(e.to);
    if (incoming[e.to]) incoming[e.to].push(e.from);
  }
  for (let it = 0; it < iterations; it += 1) {
    /** @type {Record<string, number>} */
    const next = {};
    for (const id of nodeIds) {
      let sum = 0;
      for (const src of incoming[id]) {
        const outCount = outgoing[src].length || 1;
        sum += rank[src] / outCount;
      }
      next[id] = (1 - damping) / N + damping * sum;
    }
    rank = next;
  }
  // Normalize small values
  for (const id of nodeIds) rank[id] = Math.round(rank[id] * 1e6) / 1e6;
  return rank;
}

/* -------------------------------------------------------------------------- */
/* Export                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Export the graph as JSON or DOT.
 *
 * @param {"json"|"dot"} [format]
 * @returns {Promise<string | object>}
 */
export async function exportGraph(format = "json") {
  const data = await loadGraph();
  if (format === "dot") {
    const lines = ["digraph citations {"];
    for (const id of Object.keys(data.nodes)) {
      lines.push(`  "${id}";`);
    }
    for (const e of data.edges) {
      lines.push(`  "${e.from}" -> "${e.to}";`);
    }
    lines.push("}");
    return lines.join("\n");
  }
  return {
    nodes: Object.values(data.nodes),
    edges: data.edges,
  };
}
