/**
 * Embedding-backed memory scoring. Complements the keyword/recency/importance
 * scorer in agent-memory-inject.js by adding a cosine-similarity score when
 * embeddings are available (OPENAI_API_KEY set and AGENT_MEMORY_SEMANTIC=1).
 *
 * When embeddings are unavailable this module is inert — callers fall back to
 * the keyword scorer.
 */

import { embed, embedBatch, isAvailable as embeddingsAvailable } from "./embeddings.js";

export function semanticMemoryEnabled() {
  return process.env.AGENT_MEMORY_SEMANTIC === "1" && embeddingsAvailable();
}

function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d > 0 ? dot / d : 0;
}

/**
 * Score memories by cosine similarity between the user goal embedding and
 * each memory's content embedding. Returns an array parallel to `memories`
 * with a number in 0..1 for each entry. On failure, returns null (caller
 * should fall back to keyword scoring).
 *
 * @param {Array<{ content: string }>} memories
 * @param {string} userGoal
 * @returns {Promise<number[] | null>}
 */
export async function scoreMemoriesSemantic(memories, userGoal) {
  if (!Array.isArray(memories) || memories.length === 0) return [];
  if (typeof userGoal !== "string" || !userGoal.trim()) return null;
  if (!embeddingsAvailable()) return null;

  try {
    const goalVec = await embed(userGoal);
    if (!goalVec) return null;
    const contents = memories.map((m) => String(m?.content || "").slice(0, 2000));
    const memVecs = await embedBatch(contents);
    if (!Array.isArray(memVecs) || memVecs.length === 0) return null;
    // embedBatch may drop invalid entries; re-align by truncating.
    const len = Math.min(memories.length, memVecs.length);
    const scores = new Array(memories.length).fill(0);
    for (let i = 0; i < len; i++) {
      scores[i] = memVecs[i] ? cosine(goalVec, memVecs[i]) : 0;
    }
    return scores;
  } catch {
    return null;
  }
}

/**
 * Combine a semantic score with the existing keyword/recency/importance score.
 * Default weighting: 0.6 semantic + 0.4 keyword-combined. Callers can override
 * via AGENT_MEMORY_SEMANTIC_WEIGHT (0..1).
 *
 * @param {number} semanticScore - 0..1
 * @param {number} keywordCombined - 0..1
 * @returns {number}
 */
export function blendScores(semanticScore, keywordCombined) {
  const wRaw = Number(process.env.AGENT_MEMORY_SEMANTIC_WEIGHT);
  const w = Number.isFinite(wRaw) && wRaw >= 0 && wRaw <= 1 ? wRaw : 0.6;
  return w * (semanticScore || 0) + (1 - w) * (keywordCombined || 0);
}
