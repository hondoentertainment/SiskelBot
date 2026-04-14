/**
 * Phase 64.3: Citation graph.
 *
 * Directed graph of papers linked by citations. Supports neighbor lookup,
 * BFS subgraph extraction, and shortest-path queries (undirected).
 *
 * Storage layout:
 *   data/citation-graph/{workspaceId}.json
 *     { papers: { [paperId]: metadata },
 *       cites:   { [paperId]: [citedIds] },
 *       citedBy: { [paperId]: [citerIds] } }
 *   data/citation-graph/_index.json — known workspaces
 */
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

export const VALID_DIRECTIONS = Object.freeze(["in", "out", "both"]);

function sanitizeId(val, fallback = "default") {
  if (typeof val !== "string" || !val.trim()) return fallback;
  return val.trim().replace(/[^a-zA-Z0-9._:-]/g, "_").slice(0, 200) || fallback;
}

function workspacePath(workspaceId) {
  return join(getDataDir(), "citation-graph", `${sanitizeId(workspaceId)}.json`);
}

function indexPath() {
  return join(getDataDir(), "citation-graph", "_index.json");
}

async function touchIndex(workspaceId) {
  const ws = sanitizeId(workspaceId);
  return withPathLock(indexPath(), async () => {
    const idx = await readJsonPath(indexPath(), { workspaces: [] });
    const list = Array.isArray(idx.workspaces) ? idx.workspaces : [];
    if (!list.includes(ws)) {
      list.push(ws);
      await writeJsonPath(indexPath(), { workspaces: list });
    }
  });
}

function emptyStore() {
  return { papers: {}, cites: {}, citedBy: {} };
}

async function readStore(workspaceId) {
  const store = await readJsonPath(workspacePath(workspaceId), emptyStore());
  return {
    papers: store.papers && typeof store.papers === "object" ? store.papers : {},
    cites: store.cites && typeof store.cites === "object" ? store.cites : {},
    citedBy: store.citedBy && typeof store.citedBy === "object" ? store.citedBy : {},
  };
}

/**
 * Add or update a paper in the graph.
 */
export async function addPaper({ workspaceId, paperId, metadata } = {}) {
  const ws = sanitizeId(workspaceId);
  const pid = sanitizeId(paperId, "");
  if (!pid) throw new Error("paperId is required");
  const file = workspacePath(ws);
  let record;
  await withPathLock(file, async () => {
    const store = await readStore(ws);
    store.papers[pid] = {
      id: pid,
      metadata: metadata && typeof metadata === "object" ? metadata : {},
      addedAt: store.papers[pid]?.addedAt || Date.now(),
      updatedAt: Date.now(),
    };
    record = store.papers[pid];
    await writeJsonPath(file, store);
  });
  await touchIndex(ws);
  return record;
}

/**
 * Add a directed citation edge: citerId -> citedId.
 */
export async function addCitation({ workspaceId, citerId, citedId } = {}) {
  const ws = sanitizeId(workspaceId);
  const from = sanitizeId(citerId, "");
  const to = sanitizeId(citedId, "");
  if (!from) throw new Error("citerId is required");
  if (!to) throw new Error("citedId is required");
  if (from === to) throw new Error("citerId and citedId must differ");
  const file = workspacePath(ws);
  let created = false;
  await withPathLock(file, async () => {
    const store = await readStore(ws);
    // Ensure both papers exist (stubs if missing).
    if (!store.papers[from]) store.papers[from] = { id: from, metadata: {}, addedAt: Date.now(), updatedAt: Date.now() };
    if (!store.papers[to]) store.papers[to] = { id: to, metadata: {}, addedAt: Date.now(), updatedAt: Date.now() };

    const outEdges = Array.isArray(store.cites[from]) ? store.cites[from] : [];
    const inEdges = Array.isArray(store.citedBy[to]) ? store.citedBy[to] : [];
    if (!outEdges.includes(to)) {
      outEdges.push(to);
      store.cites[from] = outEdges;
      created = true;
    }
    if (!inEdges.includes(from)) {
      inEdges.push(from);
      store.citedBy[to] = inEdges;
    }
    await writeJsonPath(file, store);
  });
  await touchIndex(ws);
  return { citerId: from, citedId: to, created };
}

/**
 * List all papers in the workspace.
 */
export async function listPapers(workspaceId) {
  const ws = sanitizeId(workspaceId);
  const store = await readStore(ws);
  return Object.values(store.papers).sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
}

/**
 * Get neighbors of a paper.
 *
 * @param {{ workspaceId: string, paperId: string, direction?: "in"|"out"|"both" }} input
 */
export async function getNeighbors({ workspaceId, paperId, direction = "both" } = {}) {
  const ws = sanitizeId(workspaceId);
  const pid = sanitizeId(paperId, "");
  if (!pid) throw new Error("paperId is required");
  const dir = VALID_DIRECTIONS.includes(direction) ? direction : "both";
  const store = await readStore(ws);
  const out = Array.isArray(store.cites[pid]) ? store.cites[pid] : [];
  const inn = Array.isArray(store.citedBy[pid]) ? store.citedBy[pid] : [];
  let neighborIds;
  if (dir === "out") neighborIds = out.slice();
  else if (dir === "in") neighborIds = inn.slice();
  else neighborIds = Array.from(new Set([...out, ...inn]));
  return neighborIds.map((id) => store.papers[id] || { id, metadata: {} });
}

/**
 * BFS subgraph around a paper, up to the given depth (undirected).
 */
export async function getSubgraph({ workspaceId, paperId, depth = 1 } = {}) {
  const ws = sanitizeId(workspaceId);
  const pid = sanitizeId(paperId, "");
  if (!pid) throw new Error("paperId is required");
  const d = Math.max(0, Math.min(10, Number(depth) || 0));
  const store = await readStore(ws);
  if (!store.papers[pid]) return { nodes: [], edges: [] };

  const visited = new Set([pid]);
  const edgeSet = new Set();
  let frontier = [pid];
  for (let step = 0; step < d; step += 1) {
    const next = [];
    for (const node of frontier) {
      const out = Array.isArray(store.cites[node]) ? store.cites[node] : [];
      const inn = Array.isArray(store.citedBy[node]) ? store.citedBy[node] : [];
      for (const n of out) {
        edgeSet.add(`${node}|${n}`);
        if (!visited.has(n)) { visited.add(n); next.push(n); }
      }
      for (const n of inn) {
        edgeSet.add(`${n}|${node}`);
        if (!visited.has(n)) { visited.add(n); next.push(n); }
      }
    }
    frontier = next;
    if (!frontier.length) break;
  }
  const nodes = Array.from(visited).map((id) => store.papers[id] || { id, metadata: {} });
  const edges = Array.from(edgeSet).map((e) => {
    const [from, to] = e.split("|");
    return { from, to };
  });
  return { nodes, edges };
}

/**
 * BFS shortest path treating edges as undirected.
 * Returns the array of paperIds in order, or null when no path exists.
 */
export async function findShortestPath({ workspaceId, fromId, toId } = {}) {
  const ws = sanitizeId(workspaceId);
  const from = sanitizeId(fromId, "");
  const to = sanitizeId(toId, "");
  if (!from) throw new Error("fromId is required");
  if (!to) throw new Error("toId is required");
  if (from === to) return [from];
  const store = await readStore(ws);
  if (!store.papers[from] || !store.papers[to]) return null;

  const visited = new Set([from]);
  const queue = [[from]];
  while (queue.length) {
    const path = queue.shift();
    const tail = path[path.length - 1];
    const out = Array.isArray(store.cites[tail]) ? store.cites[tail] : [];
    const inn = Array.isArray(store.citedBy[tail]) ? store.citedBy[tail] : [];
    const neighbors = Array.from(new Set([...out, ...inn]));
    for (const n of neighbors) {
      if (n === to) return [...path, n];
      if (!visited.has(n)) {
        visited.add(n);
        queue.push([...path, n]);
      }
    }
  }
  return null;
}

/**
 * Get inbound and outbound citation counts for a paper.
 */
export async function getCitationCount({ workspaceId, paperId } = {}) {
  const ws = sanitizeId(workspaceId);
  const pid = sanitizeId(paperId, "");
  if (!pid) throw new Error("paperId is required");
  const store = await readStore(ws);
  const outCount = Array.isArray(store.cites[pid]) ? store.cites[pid].length : 0;
  const inCount = Array.isArray(store.citedBy[pid]) ? store.citedBy[pid].length : 0;
  return { paperId: pid, cites: outCount, citedBy: inCount };
}

export async function _reset(workspaceId) {
  if (workspaceId) {
    await writeJsonPath(workspacePath(workspaceId), emptyStore());
    return;
  }
  const idx = await readJsonPath(indexPath(), { workspaces: [] });
  const list = Array.isArray(idx.workspaces) ? idx.workspaces : [];
  for (const ws of list) {
    await writeJsonPath(workspacePath(ws), emptyStore());
  }
  await writeJsonPath(indexPath(), { workspaces: [] });
}

export const _internals = { sanitizeId, workspacePath, indexPath };
