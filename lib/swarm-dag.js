/**
 * DAG (Directed Acyclic Graph) data structure and execution engine for
 * dependency-aware swarm orchestration.
 *
 * Nodes represent subtasks. Edges represent "must complete before" dependencies.
 * `executeDAG` runs nodes in topological order, parallelizing independent nodes,
 * retrying on failure, and skipping dependents of failed nodes.
 *
 * @module swarm-dag
 */

/**
 * @typedef {Object} DAGNodeConfig
 * @property {string} goal - The subtask goal / prompt.
 * @property {string} [profile] - Agent profile name (researcher, executor, etc.).
 * @property {string[]} [deps] - IDs of nodes that must complete before this one.
 * @property {string} [model] - Model override for this node.
 * @property {Record<string, unknown>} [meta] - Arbitrary metadata.
 */

/**
 * @typedef {"pending"|"running"|"completed"|"failed"|"skipped_dep_failed"} DAGNodeStatus
 */

/**
 * @typedef {Object} DAGNode
 * @property {string} id
 * @property {DAGNodeConfig} config
 * @property {DAGNodeStatus} status
 * @property {unknown} [result]
 * @property {Error} [error]
 */

/**
 * @typedef {Object} DAGExecutionResult
 * @property {Map<string, unknown>} results - nodeId → result for completed nodes.
 * @property {string[]} failed - IDs of nodes that failed after all retries.
 * @property {string[]} skipped - IDs of nodes skipped due to a failed dependency.
 * @property {string[]} executionOrder - Topological order used for scheduling.
 */

/**
 * @typedef {Object} ExecuteDAGOptions
 * @property {number} [retries=1] - How many times to retry a failed node before marking it failed.
 * @property {AbortSignal} [signal] - Optional abort signal to cancel execution.
 */

/**
 * Create a new DAG instance.
 *
 * @returns {{
 *   addNode: (id: string, config: DAGNodeConfig) => void,
 *   getExecutionOrder: () => string[],
 *   getNode: (id: string) => DAGNode | undefined,
 *   nodes: () => DAGNode[],
 * }}
 */
export function createDAG() {
  /** @type {Map<string, DAGNode>} */
  const nodeMap = new Map();

  return {
    /**
     * Add a task node to the DAG.
     * @param {string} id - Unique node identifier.
     * @param {DAGNodeConfig} config - Node configuration.
     */
    addNode(id, config) {
      if (nodeMap.has(id)) {
        throw new Error(`Duplicate node id: ${id}`);
      }
      if (typeof id !== "string" || !id.trim()) {
        throw new Error("Node id must be a non-empty string");
      }
      const deps = Array.isArray(config.deps) ? [...config.deps] : [];
      nodeMap.set(id, {
        id,
        config: { ...config, deps },
        status: "pending",
        result: undefined,
        error: undefined,
      });
    },

    /**
     * Return a valid topological ordering of node IDs. Throws on cycles.
     * @returns {string[]}
     */
    getExecutionOrder() {
      return topologicalSort(nodeMap);
    },

    /**
     * Get a single node by id.
     * @param {string} id
     * @returns {DAGNode | undefined}
     */
    getNode(id) {
      return nodeMap.get(id);
    },

    /**
     * Return all nodes (snapshot).
     * @returns {DAGNode[]}
     */
    nodes() {
      return [...nodeMap.values()];
    },
  };
}

/**
 * Kahn's algorithm for topological sort. Throws on cycles.
 * @param {Map<string, DAGNode>} nodeMap
 * @returns {string[]}
 */
function topologicalSort(nodeMap) {
  if (nodeMap.size === 0) return [];

  // Validate that all deps reference existing nodes
  for (const [id, node] of nodeMap) {
    for (const dep of node.config.deps || []) {
      if (!nodeMap.has(dep)) {
        throw new Error(`Node "${id}" depends on unknown node "${dep}"`);
      }
    }
  }

  // Build in-degree map
  /** @type {Map<string, number>} */
  const inDegree = new Map();
  /** @type {Map<string, string[]>} */
  const outEdges = new Map();

  for (const id of nodeMap.keys()) {
    inDegree.set(id, 0);
    outEdges.set(id, []);
  }

  for (const [id, node] of nodeMap) {
    for (const dep of node.config.deps || []) {
      // dep → id (dep must complete before id)
      outEdges.get(dep).push(id);
      inDegree.set(id, (inDegree.get(id) || 0) + 1);
    }
  }

  // Seed queue with zero-indegree nodes
  const queue = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const sorted = [];
  while (queue.length > 0) {
    // Sort the queue for deterministic ordering
    queue.sort();
    const current = queue.shift();
    sorted.push(current);

    for (const neighbor of outEdges.get(current) || []) {
      const newDeg = (inDegree.get(neighbor) || 1) - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) {
        queue.push(neighbor);
      }
    }
  }

  if (sorted.length !== nodeMap.size) {
    throw new Error("Cycle detected in DAG");
  }

  return sorted;
}

/**
 * Execute a DAG according to dependency order.
 *
 * Nodes whose dependencies are all satisfied run in parallel.
 * On failure: the node is retried up to `opts.retries` times (default 1).
 * If still failing, dependents are marked "skipped_dep_failed".
 *
 * @param {ReturnType<typeof createDAG>} dag - The DAG instance.
 * @param {(nodeId: string, nodeConfig: DAGNodeConfig, parentResults: Map<string, unknown>) => Promise<unknown>} executor
 *   Called for each node that is ready to run. Should return the node's result.
 * @param {ExecuteDAGOptions} [opts]
 * @returns {Promise<DAGExecutionResult>}
 */
export async function executeDAG(dag, executor, opts = {}) {
  const retries = typeof opts.retries === "number" && opts.retries >= 0 ? opts.retries : 1;
  const signal = opts.signal || null;

  const executionOrder = dag.getExecutionOrder();
  const allNodes = dag.nodes();
  const nodeMap = new Map(allNodes.map((n) => [n.id, n]));

  /** @type {Map<string, unknown>} */
  const results = new Map();
  /** @type {string[]} */
  const failed = [];
  /** @type {string[]} */
  const skipped = [];
  /** @type {Set<string>} */
  const failedSet = new Set();

  // Build dependency lookup: nodeId → [depId, ...]
  const depsOf = new Map();
  for (const node of allNodes) {
    depsOf.set(node.id, node.config.deps || []);
  }

  // Build reverse lookup: nodeId → [dependent IDs]
  const dependentsOf = new Map();
  for (const node of allNodes) {
    dependentsOf.set(node.id, []);
  }
  for (const node of allNodes) {
    for (const dep of node.config.deps || []) {
      dependentsOf.get(dep)?.push(node.id);
    }
  }

  // Track completed nodes
  /** @type {Set<string>} */
  const completedSet = new Set();

  // Process nodes in waves: at each wave, run all nodes whose deps are complete
  const pending = new Set(executionOrder);

  while (pending.size > 0) {
    if (signal?.aborted) {
      // Mark all remaining as skipped
      for (const id of pending) {
        const node = nodeMap.get(id);
        if (node) node.status = "skipped_dep_failed";
        skipped.push(id);
      }
      break;
    }

    // Find nodes that are ready (all deps completed, not failed/skipped)
    const ready = [];
    for (const id of pending) {
      const deps = depsOf.get(id) || [];
      const allDepsComplete = deps.every((d) => completedSet.has(d));
      const anyDepFailed = deps.some((d) => failedSet.has(d));

      if (anyDepFailed) {
        // Skip this node — a dependency failed
        const node = nodeMap.get(id);
        if (node) node.status = "skipped_dep_failed";
        skipped.push(id);
        failedSet.add(id); // propagate failure to transitive dependents
        pending.delete(id);
      } else if (allDepsComplete) {
        ready.push(id);
      }
      // else: still waiting on deps
    }

    if (ready.length === 0 && pending.size > 0) {
      // All remaining nodes have unresolvable deps (should not happen with
      // valid topo sort, but guard against it)
      for (const id of pending) {
        const node = nodeMap.get(id);
        if (node) node.status = "skipped_dep_failed";
        skipped.push(id);
      }
      break;
    }

    // Execute ready nodes in parallel
    await Promise.all(
      ready.map(async (id) => {
        pending.delete(id);
        const node = nodeMap.get(id);
        if (!node) return;

        node.status = "running";
        let lastError = null;
        let succeeded = false;

        for (let attempt = 0; attempt <= retries; attempt++) {
          if (signal?.aborted) break;
          try {
            const result = await executor(id, node.config, results);
            node.result = result;
            node.status = "completed";
            results.set(id, result);
            completedSet.add(id);
            succeeded = true;
            break;
          } catch (err) {
            lastError = err;
            // If we have retries left, continue the loop
          }
        }

        if (!succeeded) {
          node.status = "failed";
          node.error = lastError;
          failed.push(id);
          failedSet.add(id);
        }
      })
    );
  }

  return { results, failed, skipped, executionOrder };
}
