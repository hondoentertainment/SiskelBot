/**
 * Memory consolidation. When the memory count for a user/workspace
 * approaches the global cap (MAX_MEMORIES in agent-memory.js), find clusters
 * of near-duplicate memories and collapse each cluster into a single
 * summary memory. This keeps the memory store useful instead of filling
 * with redundant observations.
 *
 * Deterministic (no LLM call) — uses keyword Jaccard similarity for
 * clustering. Enabled when AGENT_MEMORY_CONSOLIDATE=1.
 */

import { listMemories, forget, remember } from "./agent-memory.js";

const DEFAULT_TRIGGER_THRESHOLD = 0.8; // consolidate when >= 80% of cap
const DEFAULT_JACCARD_THRESHOLD = 0.6;
const GLOBAL_MAX_MEMORIES = 1000;
const MIN_CLUSTER_SIZE = 2;

export function consolidationEnabled() {
  return process.env.AGENT_MEMORY_CONSOLIDATE === "1";
}

function tokenize(text) {
  return new Set(
    String(text || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3),
  );
}

/**
 * Jaccard similarity between two token sets.
 * @param {Set<string>} a
 * @param {Set<string>} b
 * @returns {number}
 */
export function jaccard(a, b) {
  if (!a || !b || a.size === 0 || b.size === 0) return 0;
  let intersect = 0;
  for (const t of a) if (b.has(t)) intersect++;
  const union = a.size + b.size - intersect;
  return union > 0 ? intersect / union : 0;
}

/**
 * Group memories into clusters where every pair within a cluster has
 * Jaccard similarity above the threshold. Greedy single-link clustering.
 *
 * @param {Array<{ id: string, content: string, category?: string, importance?: number }>} memories
 * @param {number} [threshold]
 * @returns {Array<Array<{ id: string, content: string, category?: string, importance?: number }>>}
 */
export function clusterMemories(memories, threshold = DEFAULT_JACCARD_THRESHOLD) {
  if (!Array.isArray(memories) || memories.length === 0) return [];
  const tokens = memories.map((m) => tokenize(m?.content || ""));
  const assigned = new Array(memories.length).fill(-1);
  const clusters = [];
  for (let i = 0; i < memories.length; i++) {
    if (assigned[i] !== -1) continue;
    const cluster = [memories[i]];
    assigned[i] = clusters.length;
    for (let j = i + 1; j < memories.length; j++) {
      if (assigned[j] !== -1) continue;
      if (memories[i].category && memories[j].category && memories[i].category !== memories[j].category) continue;
      if (jaccard(tokens[i], tokens[j]) >= threshold) {
        cluster.push(memories[j]);
        assigned[j] = clusters.length;
      }
    }
    clusters.push(cluster);
  }
  return clusters;
}

/**
 * Build a short summary line from a cluster of near-duplicates.
 * @param {Array<{ content: string, importance?: number }>} cluster
 * @returns {string}
 */
export function summarizeCluster(cluster) {
  if (!Array.isArray(cluster) || cluster.length === 0) return "";
  // Pick the highest-importance, longest content as the representative
  // and annotate with count so we don't lose the "this happened N times" signal.
  const sorted = [...cluster].sort((a, b) => {
    const ia = Number(a.importance || 3);
    const ib = Number(b.importance || 3);
    if (ib !== ia) return ib - ia;
    return (String(b.content || "").length) - (String(a.content || "").length);
  });
  const rep = sorted[0];
  const count = cluster.length;
  return `${String(rep.content || "").slice(0, 400)} (consolidated ×${count})`;
}

/**
 * Run consolidation for one user+workspace. Returns a summary of actions.
 * Best-effort: never throws.
 *
 * @param {string} userId
 * @param {string} workspaceId
 * @param {{ triggerRatio?: number, jaccardThreshold?: number }} [opts]
 * @returns {Promise<{ consolidated: number, removed: number, skipped: boolean }>}
 */
export async function consolidateIfNeeded(userId, workspaceId, opts = {}) {
  if (!consolidationEnabled()) return { consolidated: 0, removed: 0, skipped: true };
  if (!userId || !workspaceId) return { consolidated: 0, removed: 0, skipped: true };
  const triggerRatio = Number(opts.triggerRatio) || DEFAULT_TRIGGER_THRESHOLD;
  const threshold = Number(opts.jaccardThreshold) || DEFAULT_JACCARD_THRESHOLD;

  try {
    const all = await listMemories(userId, workspaceId, { limit: GLOBAL_MAX_MEMORIES });
    const memories = (all?.memories || []).filter((m) => m && typeof m.content === "string");
    if (memories.length < Math.floor(GLOBAL_MAX_MEMORIES * triggerRatio)) {
      return { consolidated: 0, removed: 0, skipped: true };
    }
    const clusters = clusterMemories(memories, threshold).filter((c) => c.length >= MIN_CLUSTER_SIZE);
    if (clusters.length === 0) return { consolidated: 0, removed: 0, skipped: false };

    let consolidated = 0;
    let removed = 0;
    for (const cluster of clusters) {
      const summary = summarizeCluster(cluster);
      if (!summary) continue;
      // Delete originals, then write the summary
      for (const mem of cluster) {
        try { await forget(userId, workspaceId, mem.id); removed++; } catch { /* best-effort */ }
      }
      try {
        await remember(userId, workspaceId, {
          content: summary,
          category: cluster[0].category || "observation",
          importance: Math.max(1, Math.min(5, Math.max(...cluster.map((c) => Number(c.importance) || 3)))),
          source: "agent-memory-consolidate",
          metadata: { consolidatedFrom: cluster.length },
        });
        consolidated++;
      } catch { /* best-effort */ }
    }
    return { consolidated, removed, skipped: false };
  } catch {
    return { consolidated: 0, removed: 0, skipped: true };
  }
}
