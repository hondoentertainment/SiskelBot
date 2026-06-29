/**
 * Phase 8 (I8.2): Offline structural lint for session planDag when it uses graph shape
 * ({ nodes, edges }). Free-form objects (e.g. { steps: [...] }) skip lint.
 *
 * Enable rejection at persist time: AGENT_SESSION_PLAN_DAG_LINT=strict (see validateAgentSessionPlanInput).
 */
const MAX_NODES = Math.min(512, Math.max(8, Number(process.env.AGENT_SESSION_PLAN_DAG_MAX_NODES) || 128));
const MAX_EDGES = Math.min(4096, Math.max(16, Number(process.env.AGENT_SESSION_PLAN_DAG_MAX_EDGES) || 512));

/**
 * @param {unknown} planDag
 * @returns {boolean}
 */
export function planDagLooksLikeGraph(planDag) {
  if (!planDag || typeof planDag !== "object" || Array.isArray(planDag)) return false;
  return Array.isArray(/** @type {object} */ (planDag).nodes) || Array.isArray(/** @type {object} */ (planDag).edges);
}

/**
 * @param {unknown} planDag
 * @returns {{ ok: boolean; issues: string[]; skipped: boolean; nodeCount?: number; edgeCount?: number }}
 */
export function lintPlanDag(planDag) {
  const issues = [];
  if (!planDag || typeof planDag !== "object" || Array.isArray(planDag)) {
    return { ok: false, issues: ["planDag must be a plain object"], skipped: false };
  }
  if (!planDagLooksLikeGraph(planDag)) {
    return { ok: true, issues: [], skipped: true };
  }

  const nodes = /** @type {object} */ (planDag).nodes;
  const edges = /** @type {object} */ (planDag).edges;
  if (!Array.isArray(nodes)) {
    issues.push("planDag.nodes must be an array when using graph shape");
  }
  if (!Array.isArray(edges)) {
    issues.push("planDag.edges must be an array when using graph shape");
  }
  if (issues.length) {
    return { ok: false, issues, skipped: false };
  }

  if (nodes.length > MAX_NODES) {
    issues.push(`planDag.nodes length ${nodes.length} exceeds max ${MAX_NODES}`);
  }
  if (edges.length > MAX_EDGES) {
    issues.push(`planDag.edges length ${edges.length} exceeds max ${MAX_EDGES}`);
  }

  const ids = new Set();
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (!n || typeof n !== "object" || Array.isArray(n)) {
      issues.push(`planDag.nodes[${i}] must be an object`);
      continue;
    }
    const id = n.id;
    if (typeof id !== "string" || !id.trim()) {
      issues.push(`planDag.nodes[${i}].id must be a non-empty string`);
    } else if (ids.has(id)) {
      issues.push(`duplicate planDag node id "${id}"`);
    } else {
      ids.add(id);
    }
  }

  /** @type {Array<[string, string]>} */
  const pairs = [];
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    if (!e || typeof e !== "object" || Array.isArray(e)) {
      issues.push(`planDag.edges[${i}] must be an object`);
      continue;
    }
    const from = e.from ?? e.source;
    const to = e.to ?? e.target;
    if (typeof from !== "string" || !from.trim()) {
      issues.push(`planDag.edges[${i}] requires string "from" or "source"`);
    }
    if (typeof to !== "string" || !to.trim()) {
      issues.push(`planDag.edges[${i}] requires string "to" or "target"`);
    }
    if (typeof from === "string" && typeof to === "string" && from.trim() && to.trim()) {
      const a = from.trim();
      const b = to.trim();
      if (!ids.has(a)) {
        issues.push(`planDag.edges[${i}] references unknown node "${a}"`);
      }
      if (!ids.has(b)) {
        issues.push(`planDag.edges[${i}] references unknown node "${b}"`);
      }
      pairs.push([a, b]);
    }
  }

  if (issues.length) {
    return { ok: false, issues, skipped: false };
  }

  const adj = new Map();
  for (const [a, b] of pairs) {
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a).push(b);
  }

  const state = new Map();
  let cyclic = false;
  function visit(u) {
    state.set(u, 1);
    for (const v of adj.get(u) || []) {
      const s = state.get(v) ?? 0;
      if (s === 1) {
        cyclic = true;
        return;
      }
      if (s === 0) visit(v);
      if (cyclic) return;
    }
    state.set(u, 2);
  }
  for (const id of ids) {
    if ((state.get(id) ?? 0) === 0) visit(id);
    if (cyclic) break;
  }
  if (cyclic) {
    issues.push("planDag contains a directed cycle (expected acyclic graph)");
  }

  return {
    ok: issues.length === 0,
    issues,
    skipped: false,
    nodeCount: ids.size,
    edgeCount: pairs.length,
  };
}
