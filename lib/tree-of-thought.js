/**
 * Phase 52.1: Tree-of-Thought reasoning.
 *
 * A "thought" is a single step in a reasoning chain. A tree of thoughts
 * expands breadth-first (or depth-first) from a root task, generating k
 * candidate continuations per node, scoring each, and keeping only the top
 * W at each frontier (beam search). Goal detection stops a branch early
 * when a conclusion marker is produced.
 *
 * This module is intentionally LLM-agnostic: `generator` is an injected
 * async function `(context) => string[]` returning candidate child thoughts.
 * The route layer wires it to a chat completion caller when available and
 * falls back to a deterministic mock otherwise, keeping this library
 * unit-testable without a model.
 */

import { randomUUID } from "crypto";

/**
 * A node in the tree of thoughts.
 */
export class ThoughtNode {
  /**
   * @param {object} init
   * @param {string} init.thought - The text of this reasoning step.
   * @param {ThoughtNode|null} [init.parent=null]
   * @param {number} [init.depth=0]
   * @param {number} [init.score=0]
   * @param {object} [init.state={}] - Arbitrary state attached to the node.
   */
  constructor({ thought, parent = null, depth = 0, score = 0, state = {} } = {}) {
    this.id = randomUUID();
    this.thought = String(thought ?? "");
    this.parent = parent;
    this.depth = Number.isFinite(depth) ? depth : 0;
    this.score = Number.isFinite(score) ? score : 0;
    this.state = state && typeof state === "object" ? state : {};
    this.children = [];
    this.pruned = false;
    this.terminal = false;
    this.createdAt = Date.now();
  }

  addChild(child) {
    if (!(child instanceof ThoughtNode)) {
      throw new TypeError("addChild expects a ThoughtNode");
    }
    child.parent = this;
    child.depth = this.depth + 1;
    this.children.push(child);
    return child;
  }

  /**
   * Return the path from the root to this node, inclusive.
   * @returns {ThoughtNode[]}
   */
  getPath() {
    const path = [];
    let cur = this;
    while (cur) {
      path.push(cur);
      cur = cur.parent;
    }
    return path.reverse();
  }

  /**
   * Plain object representation, excluding parent back-references.
   */
  toJSON() {
    return {
      id: this.id,
      thought: this.thought,
      depth: this.depth,
      score: this.score,
      state: this.state,
      pruned: this.pruned,
      terminal: this.terminal,
      createdAt: this.createdAt,
      children: this.children.map((c) => c.toJSON()),
    };
  }
}

/**
 * Default generator used when callers do not inject one. Produces
 * k deterministic pseudo-thoughts so tests are reproducible.
 */
function defaultGenerator(context, k = 3) {
  const parentText = context?.node?.thought ?? context?.task ?? "";
  const out = [];
  for (let i = 0; i < k; i++) {
    out.push(`step-${context.node?.depth ?? 0}-${i} derived from "${parentText.slice(0, 60)}"`);
  }
  return out;
}

/**
 * Expand a node by invoking the generator and constructing k child nodes.
 * Does not mutate the parent if the generator throws.
 *
 * @param {ThoughtNode} node
 * @param {object} [options]
 * @param {(ctx: object) => (string[] | Promise<string[]>)} [options.generator]
 * @param {number} [options.k=3] - Number of children to request per expansion.
 * @param {(node: ThoughtNode, options: object) => number} [options.scorer]
 * @param {object} [options.context] - Extra context threaded through.
 * @returns {Promise<ThoughtNode[]>}
 */
export async function expandThought(node, options = {}) {
  if (!(node instanceof ThoughtNode)) {
    throw new TypeError("expandThought expects a ThoughtNode");
  }
  const k = Number.isFinite(options.k) && options.k > 0 ? Math.floor(options.k) : 3;
  const generator = typeof options.generator === "function" ? options.generator : defaultGenerator;
  const scorer = typeof options.scorer === "function" ? options.scorer : scoreThought;

  const ctx = {
    node,
    path: node.getPath().map((n) => n.thought),
    depth: node.depth,
    k,
    ...(options.context || {}),
  };

  let raw;
  try {
    raw = await generator(ctx, k);
  } catch (err) {
    throw new Error(`generator failed: ${err?.message || err}`, { cause: err });
  }
  if (!Array.isArray(raw)) {
    throw new Error("generator must return an array of strings");
  }

  const children = [];
  for (const text of raw.slice(0, k)) {
    const t = typeof text === "string" ? text : String(text ?? "");
    const child = new ThoughtNode({
      thought: t,
      parent: node,
      depth: node.depth + 1,
      state: {},
    });
    child.score = scorer(child, options);
    if (defaultGoalCheck(child)) child.terminal = true;
    node.addChild(child);
    children.push(child);
  }
  return children;
}

const CONFIDENCE_MARKERS = [
  "therefore",
  "thus",
  "hence",
  "clearly",
  "certainly",
  "definitely",
  "proves",
  "conclude",
  "conclusion",
  "final answer",
  "in summary",
];

const HEDGE_MARKERS = ["maybe", "perhaps", "possibly", "might", "unsure", "i think"];

/**
 * Default scorer: length sweet-spot, novelty vs ancestors, confidence markers.
 * Returns a number in [0, 1]. Deterministic for identical inputs.
 *
 * @param {ThoughtNode} node
 * @param {object} [options]
 * @returns {number}
 */
export function scoreThought(node, options = {}) {
  if (typeof options.scorer === "function" && options.scorer !== scoreThought) {
    return clamp01(options.scorer(node, options));
  }
  if (!(node instanceof ThoughtNode)) return 0;

  const text = String(node.thought || "").toLowerCase().trim();
  if (!text) return 0;

  // Length component: peaks near ~150 chars, falls off beyond 800.
  const len = text.length;
  let lenScore;
  if (len <= 8) lenScore = 0.1;
  else if (len <= 150) lenScore = 0.4 + (len / 150) * 0.4;
  else if (len <= 800) lenScore = 0.8 - ((len - 150) / 650) * 0.3;
  else lenScore = 0.35;

  // Confidence markers bump the score, hedges penalize it.
  let markerScore = 0;
  for (const m of CONFIDENCE_MARKERS) if (text.includes(m)) markerScore += 0.08;
  for (const m of HEDGE_MARKERS) if (text.includes(m)) markerScore -= 0.05;
  markerScore = Math.max(-0.2, Math.min(0.25, markerScore));

  // Novelty: fraction of word tokens not already present in ancestors.
  let noveltyScore = 0.15;
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length > 0) {
    const seen = new Set();
    let cur = node.parent;
    while (cur) {
      for (const t of String(cur.thought || "").toLowerCase().split(/\s+/).filter(Boolean)) {
        seen.add(t);
      }
      cur = cur.parent;
    }
    if (seen.size > 0) {
      let novel = 0;
      for (const t of tokens) if (!seen.has(t)) novel++;
      noveltyScore = 0.05 + (novel / tokens.length) * 0.2;
    }
  }

  const raw = lenScore * 0.6 + markerScore + noveltyScore;
  return clamp01(raw);
}

function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/**
 * Default goal detector: looks for "final answer:" / "conclusion:" markers
 * near the end of a thought, or an explicit `state.goal === true`.
 * @param {ThoughtNode} node
 * @returns {boolean}
 */
export function defaultGoalCheck(node) {
  if (!(node instanceof ThoughtNode)) return false;
  if (node.state && node.state.goal === true) return true;
  const t = String(node.thought || "").toLowerCase();
  if (!t) return false;
  return (
    t.includes("final answer:") ||
    t.includes("final answer is") ||
    t.includes("the answer is") ||
    t.includes("conclusion:") ||
    /\bqed\b/.test(t)
  );
}

/**
 * Remove children whose score falls below threshold.
 * Returns the kept nodes; pruned nodes are flagged `pruned = true` but
 * remain attached to their parent for later inspection.
 * @param {ThoughtNode[]} nodes
 * @param {number} threshold
 * @returns {ThoughtNode[]}
 */
export function pruneLowScoring(nodes, threshold) {
  if (!Array.isArray(nodes)) return [];
  const t = Number.isFinite(threshold) ? threshold : 0;
  const kept = [];
  for (const n of nodes) {
    if (!(n instanceof ThoughtNode)) continue;
    if (n.score < t) {
      n.pruned = true;
    } else {
      kept.push(n);
    }
  }
  return kept;
}

/**
 * Beam search over the tree of thoughts.
 *
 * @param {string|ThoughtNode} rootThought
 * @param {object} [options]
 * @param {number} [options.depth=3]          Maximum depth to explore.
 * @param {number} [options.beamWidth=3]      Maximum nodes kept per frontier.
 * @param {number} [options.k=3]              Children generated per node.
 * @param {number} [options.pruneThreshold=0] Min score to keep a child.
 * @param {(ctx) => (string[]|Promise<string[]>)} [options.generator]
 * @param {(node, options) => number} [options.scorer]
 * @param {(node) => boolean} [options.goalCheck]
 * @returns {Promise<{bestPath: ThoughtNode[], tree: ThoughtNode, allPaths: ThoughtNode[][], stats: object}>}
 */
export async function beamSearch(rootThought, options = {}) {
  const root = toRoot(rootThought);
  const depth = nonNegativeInt(options.depth, 3);
  const beamWidth = positiveInt(options.beamWidth, 3);
  const k = positiveInt(options.k, 3);
  const pruneThreshold = Number.isFinite(options.pruneThreshold) ? options.pruneThreshold : 0;
  const goalCheck = typeof options.goalCheck === "function" ? options.goalCheck : defaultGoalCheck;
  const generator = typeof options.generator === "function" ? options.generator : defaultGenerator;
  const scorer = typeof options.scorer === "function" ? options.scorer : undefined;

  const stats = {
    nodesCreated: 1,
    nodesExpanded: 0,
    nodesPruned: 0,
    goalsFound: 0,
    maxDepthReached: 0,
    startedAt: Date.now(),
  };

  let frontier = [root];
  const terminals = [];

  // Score the root using the provided scorer (or default).
  root.score = scorer ? clamp01(scorer(root, options)) : scoreThought(root);
  if (goalCheck(root)) {
    root.terminal = true;
    terminals.push(root);
    stats.goalsFound++;
  }

  for (let d = 0; d < depth && frontier.length > 0; d++) {
    const nextCandidates = [];
    for (const node of frontier) {
      if (node.terminal) {
        // Terminals should not be expanded further.
        continue;
      }
      stats.nodesExpanded++;
      const children = await expandThought(node, {
        generator,
        k,
        scorer,
        context: options.context,
      });
      stats.nodesCreated += children.length;
      for (const child of children) {
        if (goalCheck(child)) {
          child.terminal = true;
          terminals.push(child);
          stats.goalsFound++;
        }
        nextCandidates.push(child);
      }
    }

    // Prune low scorers, then keep top `beamWidth` by score.
    const afterThreshold = pruneLowScoring(nextCandidates, pruneThreshold);
    stats.nodesPruned += nextCandidates.length - afterThreshold.length;

    afterThreshold.sort((a, b) => b.score - a.score);
    const beam = afterThreshold.slice(0, beamWidth);
    for (const dropped of afterThreshold.slice(beamWidth)) {
      dropped.pruned = true;
      stats.nodesPruned++;
    }

    frontier = beam;
    if (beam.length > 0) stats.maxDepthReached = beam[0].depth;

    // If every beam slot is already terminal, we can stop early.
    if (beam.length > 0 && beam.every((n) => n.terminal)) break;
  }

  // Best path: prefer terminals by score, else deepest surviving beam node.
  const candidates = terminals.length > 0 ? [...terminals] : [...frontier];
  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.depth - a.depth;
  });
  const best = candidates[0] || root;

  const allPaths = collectLeaves(root).map((leaf) => leaf.getPath());
  stats.finishedAt = Date.now();
  stats.durationMs = stats.finishedAt - stats.startedAt;

  return {
    bestPath: best.getPath(),
    tree: root,
    allPaths,
    stats,
  };
}

/**
 * Depth-first traversal: expand the highest-scoring child at each step.
 */
export async function dfsSearch(rootThought, options = {}) {
  const root = toRoot(rootThought);
  const depth = nonNegativeInt(options.depth, 3);
  const k = positiveInt(options.k, 3);
  const goalCheck = typeof options.goalCheck === "function" ? options.goalCheck : defaultGoalCheck;
  const generator = typeof options.generator === "function" ? options.generator : defaultGenerator;
  const scorer = typeof options.scorer === "function" ? options.scorer : undefined;

  const stats = {
    nodesCreated: 1,
    nodesExpanded: 0,
    nodesPruned: 0,
    goalsFound: 0,
    maxDepthReached: 0,
    startedAt: Date.now(),
  };

  root.score = scorer ? clamp01(scorer(root, options)) : scoreThought(root);
  const visited = [];
  const terminals = [];

  async function walk(node) {
    visited.push(node);
    if (node.depth > stats.maxDepthReached) stats.maxDepthReached = node.depth;
    if (goalCheck(node)) {
      node.terminal = true;
      terminals.push(node);
      stats.goalsFound++;
      return;
    }
    if (node.depth >= depth) return;
    stats.nodesExpanded++;
    const children = await expandThought(node, {
      generator,
      k,
      scorer,
      context: options.context,
    });
    stats.nodesCreated += children.length;
    children.sort((a, b) => b.score - a.score);
    for (const child of children) {
      await walk(child);
      if (terminals.length > 0 && options.stopOnFirstGoal !== false) return;
    }
  }

  await walk(root);

  const best = (terminals[0] || visited.sort((a, b) => b.score - a.score)[0]) || root;
  stats.finishedAt = Date.now();
  stats.durationMs = stats.finishedAt - stats.startedAt;

  return {
    bestPath: best.getPath(),
    tree: root,
    allPaths: collectLeaves(root).map((leaf) => leaf.getPath()),
    stats,
  };
}

/**
 * Breadth-first traversal: expand entire level before descending.
 */
export async function bfsSearch(rootThought, options = {}) {
  const root = toRoot(rootThought);
  const depth = nonNegativeInt(options.depth, 3);
  const k = positiveInt(options.k, 3);
  const goalCheck = typeof options.goalCheck === "function" ? options.goalCheck : defaultGoalCheck;
  const generator = typeof options.generator === "function" ? options.generator : defaultGenerator;
  const scorer = typeof options.scorer === "function" ? options.scorer : undefined;

  const stats = {
    nodesCreated: 1,
    nodesExpanded: 0,
    nodesPruned: 0,
    goalsFound: 0,
    maxDepthReached: 0,
    startedAt: Date.now(),
  };

  root.score = scorer ? clamp01(scorer(root, options)) : scoreThought(root);
  const terminals = [];
  let frontier = [root];
  const visitOrder = [root];

  for (let d = 0; d < depth && frontier.length > 0; d++) {
    const next = [];
    for (const node of frontier) {
      if (goalCheck(node)) {
        node.terminal = true;
        terminals.push(node);
        stats.goalsFound++;
        continue;
      }
      stats.nodesExpanded++;
      const children = await expandThought(node, {
        generator,
        k,
        scorer,
        context: options.context,
      });
      stats.nodesCreated += children.length;
      for (const c of children) {
        visitOrder.push(c);
        if (goalCheck(c)) {
          c.terminal = true;
          terminals.push(c);
          stats.goalsFound++;
        } else {
          next.push(c);
        }
      }
    }
    frontier = next;
    if (frontier.length > 0) stats.maxDepthReached = frontier[0].depth;
  }

  const candidates = terminals.length > 0 ? [...terminals] : [...visitOrder];
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0] || root;

  stats.finishedAt = Date.now();
  stats.durationMs = stats.finishedAt - stats.startedAt;

  return {
    bestPath: best.getPath(),
    tree: root,
    allPaths: collectLeaves(root).map((leaf) => leaf.getPath()),
    stats,
    visitOrder,
  };
}

/**
 * Extract a final answer from a path of thoughts. Looks for "final answer:"
 * or "the answer is" markers; otherwise returns the last thought.
 * @param {ThoughtNode[]} path
 * @returns {string}
 */
export function extractAnswer(path) {
  if (!Array.isArray(path) || path.length === 0) return "";
  // Walk from leaf back to root looking for an explicit answer marker.
  for (let i = path.length - 1; i >= 0; i--) {
    const t = String(path[i]?.thought || "");
    const lower = t.toLowerCase();
    const markers = ["final answer:", "final answer is", "the answer is", "conclusion:"];
    for (const m of markers) {
      const idx = lower.indexOf(m);
      if (idx >= 0) return t.slice(idx + m.length).trim() || t;
    }
  }
  return String(path[path.length - 1]?.thought || "");
}

/**
 * Serialize the tree to Graphviz DOT format for visualization.
 * @param {ThoughtNode} root
 * @returns {string}
 */
export function treeToDot(root) {
  if (!(root instanceof ThoughtNode)) return "digraph ToT {}";
  const lines = ["digraph ToT {", "  rankdir=LR;", "  node [shape=box, fontname=\"Helvetica\"];"];
  const stack = [root];
  while (stack.length > 0) {
    const n = stack.pop();
    const label = escapeDot(`${n.thought} [score=${n.score.toFixed(2)}]`);
    const color = n.terminal ? "green" : n.pruned ? "gray" : "black";
    lines.push(`  "${n.id}" [label="${label}", color=${color}];`);
    for (const c of n.children) {
      lines.push(`  "${n.id}" -> "${c.id}";`);
      stack.push(c);
    }
  }
  lines.push("}");
  return lines.join("\n");
}

function escapeDot(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");
}

/**
 * Plain-object tree (same as ThoughtNode.toJSON on the root).
 */
export function treeToJson(root) {
  if (!(root instanceof ThoughtNode)) return null;
  return root.toJSON();
}

// --- internal helpers ---

function toRoot(rootThought) {
  if (rootThought instanceof ThoughtNode) return rootThought;
  return new ThoughtNode({ thought: String(rootThought ?? ""), depth: 0 });
}

function positiveInt(v, fallback) {
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

function nonNegativeInt(v, fallback) {
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : fallback;
}

function collectLeaves(root) {
  const leaves = [];
  const stack = [root];
  while (stack.length > 0) {
    const n = stack.pop();
    if (!n.children || n.children.length === 0) {
      leaves.push(n);
    } else {
      for (const c of n.children) stack.push(c);
    }
  }
  return leaves;
}
