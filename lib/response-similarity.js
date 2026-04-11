// @ts-check
/**
 * Phase 47.4: Response similarity utilities for consensus mechanisms.
 *
 * Used by the multi-agent consensus engine (lib/agent-consensus.js) to
 * cluster semantically equivalent responses for majority voting. Embedding
 * similarity is preferred when an embeddings backend is available, with a
 * lexical Jaccard fallback that requires no external services.
 *
 * @module response-similarity
 */
import { embed, isAvailable as embeddingsAvailable } from "./embeddings.js";

const DEFAULT_THRESHOLD = 0.78;
const TOKEN_SPLIT = /[^a-z0-9]+/i;

/**
 * Tokenize a string into a lowercase set of unique alphanumeric tokens.
 * Empty / non-string inputs return an empty Set.
 * @param {string} text
 * @returns {Set<string>}
 */
function tokenize(text) {
  if (typeof text !== "string" || !text) return new Set();
  const out = new Set();
  for (const raw of text.toLowerCase().split(TOKEN_SPLIT)) {
    if (raw && raw.length > 1) out.add(raw);
  }
  return out;
}

/**
 * Cosine similarity for two equal-length numeric vectors. Returns 0 when
 * either vector is empty/missing or the magnitudes are zero.
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return 0;
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = Number(a[i]) || 0;
    const y = Number(b[i]) || 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Jaccard similarity (|A ∩ B| / |A ∪ B|) over tokenized strings. Returns 1
 * when both strings tokenize to the same empty set, 0 when only one is empty.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function jaccardSimilarity(a, b) {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size === 0 && tb.size === 0) {
    // Two identical empty/whitespace responses are trivially equivalent.
    return typeof a === "string" && typeof b === "string" && a.trim() === b.trim() ? 1 : 0;
  }
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersect = 0;
  for (const tok of ta) if (tb.has(tok)) intersect++;
  const union = ta.size + tb.size - intersect;
  if (union === 0) return 0;
  return intersect / union;
}

/**
 * Compute similarity between two text strings.
 *
 * If precomputed `aEmbedding` / `bEmbedding` vectors are provided, cosine
 * similarity is used. Otherwise this falls back to lexical Jaccard. The
 * function is intentionally synchronous; callers that want embedding
 * similarity should embed up front via `groupSimilarResponses`.
 *
 * @param {string} a
 * @param {string} b
 * @param {{ aEmbedding?: number[]|null, bEmbedding?: number[]|null }} [options]
 * @returns {number} similarity in [0, 1]
 */
export function computeTextSimilarity(a, b, options = {}) {
  const ae = options.aEmbedding;
  const be = options.bEmbedding;
  if (Array.isArray(ae) && Array.isArray(be) && ae.length && be.length) {
    // Cosine produces [-1, 1]; clamp to [0, 1] for downstream thresholding.
    const c = cosineSimilarity(ae, be);
    if (c < 0) return 0;
    if (c > 1) return 1;
    return c;
  }
  return jaccardSimilarity(a ?? "", b ?? "");
}

/**
 * Cluster a list of responses by mutual similarity above a threshold using
 * single-pass leader assignment. The first response above the threshold
 * "wins" each member, so order matters slightly when many responses are
 * near the threshold; for consensus this is acceptable because the largest
 * group is what we surface.
 *
 * Each input response may be either a plain string or `{ text, ... }`.
 * Returns an array of clusters sorted by descending member count.
 *
 * @param {Array<string|{text: string}>} responses
 * @param {number} [threshold]
 * @returns {Promise<Array<{ representative: string, members: number[], count: number, avgSimilarity: number }>>}
 */
export async function groupSimilarResponses(responses, threshold = DEFAULT_THRESHOLD) {
  if (!Array.isArray(responses) || responses.length === 0) return [];
  const t = Number.isFinite(threshold) ? Math.max(0, Math.min(1, Number(threshold))) : DEFAULT_THRESHOLD;

  const texts = responses.map((r) => {
    if (r == null) return "";
    if (typeof r === "string") return r;
    if (typeof r === "object" && typeof r.text === "string") return r.text;
    return String(r);
  });

  /** @type {Array<number[]|null>} */
  const embeddings = new Array(texts.length).fill(null);
  if (embeddingsAvailable()) {
    await Promise.all(
      texts.map(async (text, i) => {
        try {
          const v = await embed(text);
          if (Array.isArray(v) && v.length) embeddings[i] = v;
        } catch (_) {
          // Embedding failures fall back to Jaccard for that pair.
        }
      }),
    );
  }

  /** @type {Array<{ leader: number, members: number[], simSum: number }>} */
  const clusters = [];
  for (let i = 0; i < texts.length; i++) {
    let bestIdx = -1;
    let bestSim = 0;
    for (let c = 0; c < clusters.length; c++) {
      const leader = clusters[c].leader;
      const sim = computeTextSimilarity(texts[i], texts[leader], {
        aEmbedding: embeddings[i],
        bEmbedding: embeddings[leader],
      });
      if (sim >= t && sim > bestSim) {
        bestSim = sim;
        bestIdx = c;
      }
    }
    if (bestIdx === -1) {
      clusters.push({ leader: i, members: [i], simSum: 1 });
    } else {
      clusters[bestIdx].members.push(i);
      clusters[bestIdx].simSum += bestSim;
    }
  }

  return clusters
    .map((c) => ({
      representative: texts[c.leader],
      members: c.members.slice(),
      count: c.members.length,
      avgSimilarity: c.members.length > 0 ? c.simSum / c.members.length : 0,
    }))
    .sort((a, b) => b.count - a.count || b.avgSimilarity - a.avgSimilarity);
}

export const _internals = { tokenize, DEFAULT_THRESHOLD };
