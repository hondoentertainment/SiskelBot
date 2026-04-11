// @ts-check
/**
 * Phase 57.4: Data lineage tracking.
 *
 * Records an end-to-end provenance graph where nodes are datasets
 * (or any asset) and edges are transformations. Supports:
 *
 *   - recordLineage({job, inputs, outputs, metadata})
 *   - getLineage(nodeId)       -- both upstream + downstream
 *   - findUpstream(nodeId)     -- transitive predecessors
 *   - findDownstream(nodeId)   -- transitive successors
 *   - exportGraph()            -- nodes + edges for visualization
 *
 * The graph is stored as an edge list so incremental `recordLineage`
 * calls don't need to rewrite the whole thing.
 *
 * @module data-lineage
 */
import { join } from "path";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;

function storePath() {
  return join(getDataDir(), "data-lineage.json");
}

function now() {
  return new Date().toISOString();
}

function randomId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/* -------------------------------------------------------------------------- */
/* Store                                                                      */
/* -------------------------------------------------------------------------- */

async function loadStore() {
  const raw = await readJsonPath(storePath(), {
    version: STORE_VERSION,
    nodes: {},
    edges: [],
  });
  if (!raw || typeof raw !== "object") {
    return { version: STORE_VERSION, nodes: {}, edges: [] };
  }
  if (!raw.nodes || typeof raw.nodes !== "object") raw.nodes = {};
  if (!Array.isArray(raw.edges)) raw.edges = [];
  raw.version = STORE_VERSION;
  return raw;
}

async function saveStore(store) {
  await writeJsonPath(storePath(), {
    version: STORE_VERSION,
    nodes: store.nodes || {},
    edges: store.edges || [],
  });
}

/* -------------------------------------------------------------------------- */
/* Recording                                                                  */
/* -------------------------------------------------------------------------- */

function ensureNode(store, id, kind) {
  if (!id || typeof id !== "string") throw new Error("node id required");
  if (!store.nodes[id]) {
    store.nodes[id] = {
      id,
      kind: kind || "dataset",
      firstSeen: now(),
      lastTouched: now(),
      jobs: [],
    };
  } else {
    store.nodes[id].lastTouched = now();
    if (kind && !store.nodes[id].kind) store.nodes[id].kind = kind;
  }
  return store.nodes[id];
}

/**
 * Record a lineage event.
 * @param {object} spec
 * @param {string} spec.job
 * @param {string[]} [spec.inputs]
 * @param {string[]} [spec.outputs]
 * @param {object} [spec.metadata]
 */
export async function recordLineage(spec) {
  if (!spec || typeof spec !== "object") throw new Error("spec required");
  const job = typeof spec.job === "string" && spec.job.trim() ? spec.job.trim() : "";
  if (!job) throw new Error("job required");
  const inputs = Array.isArray(spec.inputs) ? spec.inputs.map(String) : [];
  const outputs = Array.isArray(spec.outputs) ? spec.outputs.map(String) : [];
  if (inputs.length === 0 && outputs.length === 0) {
    throw new Error("at least one input or output required");
  }
  return withPathLock(storePath(), async () => {
    const store = await loadStore();
    const eventId = randomId("lin");
    const ts = now();
    const event = {
      id: eventId,
      job,
      inputs,
      outputs,
      metadata: spec.metadata && typeof spec.metadata === "object" ? spec.metadata : {},
      at: ts,
    };
    for (const i of inputs) ensureNode(store, i, "dataset");
    for (const o of outputs) ensureNode(store, o, "dataset");
    for (const node of inputs) {
      if (!store.nodes[node].jobs.includes(job)) store.nodes[node].jobs.push(job);
    }
    for (const node of outputs) {
      if (!store.nodes[node].jobs.includes(job)) store.nodes[node].jobs.push(job);
    }
    for (const i of inputs) {
      for (const o of outputs) {
        store.edges.push({ from: i, to: o, job, eventId, at: ts });
      }
    }
    if (store.edges.length > 100000) store.edges = store.edges.slice(-100000);
    await saveStore(store);
    return event;
  });
}

/* -------------------------------------------------------------------------- */
/* Queries                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Get both directions (upstream + downstream) from a node.
 * @param {string} nodeId
 */
export async function getLineage(nodeId) {
  if (!nodeId) throw new Error("nodeId required");
  const store = await loadStore();
  const node = store.nodes[nodeId];
  if (!node) return null;
  const upstream = traverse(store, nodeId, "up");
  const downstream = traverse(store, nodeId, "down");
  return {
    node,
    upstream,
    downstream,
  };
}

function traverse(store, startId, direction) {
  const visited = new Set();
  const out = [];
  const queue = [startId];
  while (queue.length > 0) {
    const cur = queue.shift();
    for (const edge of store.edges) {
      let next = null;
      if (direction === "up" && edge.to === cur) next = edge.from;
      else if (direction === "down" && edge.from === cur) next = edge.to;
      if (next && !visited.has(next)) {
        visited.add(next);
        out.push({ node: next, via: edge.job, at: edge.at });
        queue.push(next);
      }
    }
  }
  return out;
}

/**
 * Upstream predecessors (transitive).
 * @param {string} nodeId
 */
export async function findUpstream(nodeId) {
  if (!nodeId) throw new Error("nodeId required");
  const store = await loadStore();
  if (!store.nodes[nodeId]) return [];
  return traverse(store, nodeId, "up");
}

/**
 * Downstream successors (transitive).
 * @param {string} nodeId
 */
export async function findDownstream(nodeId) {
  if (!nodeId) throw new Error("nodeId required");
  const store = await loadStore();
  if (!store.nodes[nodeId]) return [];
  return traverse(store, nodeId, "down");
}

/**
 * Export the whole graph in a cytoscape-friendly shape.
 */
export async function exportGraph() {
  const store = await loadStore();
  const nodes = Object.values(store.nodes || {}).map((n) => ({
    data: { id: n.id, kind: n.kind, jobs: n.jobs, firstSeen: n.firstSeen, lastTouched: n.lastTouched },
  }));
  const edges = (store.edges || []).map((e, i) => ({
    data: { id: `e_${i}`, source: e.from, target: e.to, job: e.job, at: e.at },
  }));
  return { nodes, edges, nodeCount: nodes.length, edgeCount: edges.length };
}

/** Clear all nodes/edges (test helper). */
export async function clearGraph() {
  await withPathLock(storePath(), async () => {
    await saveStore({ nodes: {}, edges: [] });
  });
}
