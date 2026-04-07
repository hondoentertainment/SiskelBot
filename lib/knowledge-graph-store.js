/**
 * Per-workspace knowledge graph persistence.
 * Loads/saves graph data alongside knowledge documents using json-path-store.
 */
import { join } from "path";
import { readJsonPath, writeJsonPath } from "./json-path-store.js";
import { createKnowledgeGraph } from "./knowledge-graph.js";

const DEFAULT_DATA_DIR = join(process.cwd(), "data", "knowledge");

function getGraphPath(dataDir, workspace) {
  const safe = String(workspace).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 50) || "default";
  return join(dataDir, `${safe}-graph.json`);
}

/** @type {Map<string, ReturnType<typeof createKnowledgeGraph>>} */
const graphCache = new Map();

/**
 * Get or load the knowledge graph for a workspace.
 * @param {string} workspace
 * @param {string} [dataDir]
 * @returns {Promise<ReturnType<typeof createKnowledgeGraph>>}
 */
export async function getWorkspaceKnowledgeGraph(workspace, dataDir) {
  const ws = workspace || "default";
  const dir = dataDir || process.env.KNOWLEDGE_DATA_DIR || DEFAULT_DATA_DIR;
  const cacheKey = `${dir}:${ws}`;

  if (graphCache.has(cacheKey)) {
    return graphCache.get(cacheKey);
  }

  const graph = createKnowledgeGraph();
  const graphPath = getGraphPath(dir, ws);
  try {
    const data = await readJsonPath(graphPath, { entities: [], relations: [] });
    graph.deserialize(data);
  } catch {
    // No existing graph file, start empty
  }

  graphCache.set(cacheKey, graph);
  return graph;
}

/**
 * Persist the knowledge graph for a workspace to disk.
 * @param {string} workspace
 * @param {ReturnType<typeof createKnowledgeGraph>} graph
 * @param {string} [dataDir]
 */
export async function persistWorkspaceKnowledgeGraph(workspace, graph, dataDir) {
  const ws = workspace || "default";
  const dir = dataDir || process.env.KNOWLEDGE_DATA_DIR || DEFAULT_DATA_DIR;
  const graphPath = getGraphPath(dir, ws);
  await writeJsonPath(graphPath, graph.serialize());
}

/**
 * Clear the cached graph for a workspace (useful after external modification).
 * @param {string} [workspace]
 */
export function clearGraphCache(workspace) {
  if (workspace) {
    for (const key of graphCache.keys()) {
      if (key.endsWith(`:${workspace}`)) graphCache.delete(key);
    }
  } else {
    graphCache.clear();
  }
}
