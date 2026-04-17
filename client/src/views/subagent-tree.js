/**
 * Subagent tree — pure functions for building, rendering, and updating a
 * hierarchical subagent fan-out tree from SSE events.
 *
 * Event types consumed:
 *   subagent.spawned  { childSessionId, parentRunId, goal, profile }
 *   subagent.done     { childSessionId, result?, error?, iterations?, toolCallCount? }
 *   cost.update       { childSessionId?, childCostUsd?, totalUsd?, costUsd? }
 *
 * Usage:
 *   import { buildTree, renderTreeHtml, updateNodeInTree } from "./subagent-tree.js";
 */

/**
 * Build a tree from an array of { type, payload } events.
 *
 * The root node represents the current (parent) session. Each
 * `subagent.spawned` event adds a child. `subagent.done` and `cost.update`
 * events update existing nodes.
 *
 * @param {Array<{ type: string, payload: object }>} events
 * @param {{ sessionId?: string, title?: string }} [rootInfo]
 * @returns {{ id: string, title: string, profile: string, status: string, costUsd: number, iterations: number, children: object[] }}
 */
export function buildTree(events, rootInfo) {
  const root = {
    id: rootInfo?.sessionId || "root",
    title: rootInfo?.title || "root",
    profile: "root",
    status: "running",
    costUsd: 0,
    iterations: 0,
    children: [],
  };

  const nodeMap = new Map();
  nodeMap.set(root.id, root);

  const arr = Array.isArray(events) ? events : [];
  for (const ev of arr) {
    if (!ev || typeof ev !== "object") continue;
    const { type, payload } = ev;
    if (!payload) continue;

    if (type === "subagent.spawned") {
      const childId = payload.childSessionId;
      if (!childId || nodeMap.has(childId)) continue;
      const node = {
        id: childId,
        title: payload.goal ? String(payload.goal).slice(0, 120) : childId,
        profile: payload.profile || "default",
        status: "pending",
        costUsd: 0,
        iterations: 0,
        children: [],
      };
      nodeMap.set(childId, node);
      // Attach to root (flat — parent linkage could be added if events carry parentSessionId for nesting)
      root.children.push(node);
    } else if (type === "subagent.done") {
      const childId = payload.childSessionId;
      if (!childId) continue;
      const node = nodeMap.get(childId);
      if (!node) continue;
      if (payload.error) {
        node.status = "failed";
      } else {
        node.status = "complete";
      }
      if (typeof payload.iterations === "number") node.iterations = payload.iterations;
      if (typeof payload.toolCallCount === "number" && !payload.iterations) {
        node.iterations = payload.toolCallCount;
      }
    } else if (type === "cost.update") {
      const childId = payload.childSessionId;
      const cost = Number(payload.childCostUsd ?? payload.costUsd ?? payload.totalUsd);
      if (childId && Number.isFinite(cost)) {
        const node = nodeMap.get(childId);
        if (node) node.costUsd = cost;
      } else if (!childId && Number.isFinite(cost)) {
        root.costUsd = cost;
      }
    } else if (type === "status.change") {
      // Root status updates
      if (payload.status) root.status = String(payload.status);
    } else if (type === "tool.call") {
      root.iterations += 1;
    }
  }

  return root;
}

/**
 * Render the tree as an HTML string (nested <ul>/<li>).
 *
 * Each node: <li class="sat-node sat-depth-{n} sat-status-{status}">
 * Includes collapse/expand toggle and click-to-navigate data attribute.
 *
 * @param {object} tree - tree node from buildTree()
 * @param {number} [depth=0]
 * @param {Set<string>} [collapsed] - set of node ids that are collapsed
 * @returns {string}
 */
export function renderTreeHtml(tree, depth = 0, collapsed) {
  if (!tree) return "";
  const collapsedSet = collapsed instanceof Set ? collapsed : new Set();
  const isCollapsed = collapsedSet.has(tree.id);
  const hasChildren = Array.isArray(tree.children) && tree.children.length > 0;
  const toggle = hasChildren ? (isCollapsed ? "\u25B6" : "\u25BC") : "\u00A0";
  const costStr = tree.costUsd > 0 ? `$${tree.costUsd.toFixed(tree.costUsd < 1 ? 4 : 2)}` : "\u2014";
  const iterStr = typeof tree.iterations === "number" && tree.iterations > 0
    ? `iter ${tree.iterations}`
    : "";
  const titleTrunc = tree.title && tree.title.length > 50
    ? tree.title.slice(0, 47) + "..."
    : (tree.title || tree.id);
  const profileLabel = tree.profile && tree.profile !== "root" ? tree.profile : "";

  let html = `<li class="sat-node sat-depth-${depth} sat-status-${cssSafe(tree.status)}" data-session-id="${esc(tree.id)}">`;
  html += `<span class="sat-toggle" data-node-id="${esc(tree.id)}">${toggle}</span>`;
  html += `<span class="sat-label">`;
  if (profileLabel) html += `<span class="sat-profile">${esc(profileLabel)}</span> `;
  html += `<span class="sat-title">${esc(titleTrunc)}</span>`;
  html += `</span>`;
  html += `<span class="sat-badge sat-badge-${cssSafe(tree.status)}">${esc(tree.status)}</span>`;
  html += `<span class="sat-cost">${costStr}</span>`;
  if (iterStr) html += `<span class="sat-iter">${esc(iterStr)}</span>`;
  html += `</li>`;

  if (hasChildren && !isCollapsed) {
    html += `<ul class="sat-children">`;
    for (const child of tree.children) {
      html += renderTreeHtml(child, depth + 1, collapsedSet);
    }
    html += `</ul>`;
  }

  return html;
}

/**
 * Immutable update: return a new tree with the matching node's fields merged.
 *
 * @param {object} tree
 * @param {string} childSessionId
 * @param {object} updates
 * @returns {object} new tree (or same reference if node not found)
 */
export function updateNodeInTree(tree, childSessionId, updates) {
  if (!tree || typeof tree !== "object") return tree;
  if (!childSessionId || typeof updates !== "object") return tree;

  if (tree.id === childSessionId) {
    return { ...tree, ...updates, children: tree.children };
  }

  if (!Array.isArray(tree.children) || tree.children.length === 0) return tree;

  let changed = false;
  const newChildren = tree.children.map((child) => {
    const updated = updateNodeInTree(child, childSessionId, updates);
    if (updated !== child) changed = true;
    return updated;
  });

  return changed ? { ...tree, children: newChildren } : tree;
}

// ── Internal helpers ────────────────────────────────────────────────────────

function cssSafe(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9_-]/g, "-");
}

function esc(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
