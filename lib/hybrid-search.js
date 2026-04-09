/**
 * Phase 27: Hybrid search — combines keyword (TF-IDF) and semantic (embedding) search
 * results using Reciprocal Rank Fusion (RRF).
 */
import { search as keywordSearch, semanticSearch } from "./knowledge-store.js";

const DEFAULT_RRF_K = 60;
const DEFAULT_LIMIT = 10;
const SNIPPET_LENGTH = 300;

/**
 * Reciprocal Rank Fusion: merge multiple ranked lists into a single ranking.
 * Formula: score(doc) = sum(1 / (k + rank_i)) for each ranking list where doc appears.
 *
 * @param {Array<Array<{ id: string, [key: string]: unknown }>>} rankings - Array of ranked result lists
 * @param {number} [k=60] - RRF constant (higher = less emphasis on top ranks)
 * @returns {Map<string, number>} Map of docId -> fused score
 */
export function reciprocalRankFusion(rankings, k = DEFAULT_RRF_K) {
  const scores = new Map();

  for (const ranking of rankings) {
    if (!Array.isArray(ranking)) continue;
    for (let rank = 0; rank < ranking.length; rank++) {
      const item = ranking[rank];
      if (!item || !item.id) continue;
      const docId = item.id;
      const rrfScore = 1 / (k + rank + 1); // rank is 0-based, formula uses 1-based
      scores.set(docId, (scores.get(docId) || 0) + rrfScore);
    }
  }

  return scores;
}

/**
 * Run hybrid search: keyword + semantic search fused with RRF.
 *
 * @param {string} query - Search query text
 * @param {string} workspaceId - Workspace to search
 * @param {object} [options]
 * @param {string} [options.mode='hybrid'] - Search mode: 'hybrid', 'keyword', or 'semantic'
 * @param {number} [options.limit=10] - Max results to return
 * @param {number} [options.k=60] - RRF constant
 * @param {string} [options.dataDir] - Override data directory
 * @returns {Promise<{ results: Array<{ docId: string, title: string, snippet: string, score: number, source: string }>, mode: string, query: string }>}
 */
export async function hybridSearch(query, workspaceId, options = {}) {
  const {
    mode = "hybrid",
    limit = DEFAULT_LIMIT,
    k = DEFAULT_RRF_K,
    dataDir,
  } = options;

  if (!query || typeof query !== "string" || !query.trim()) {
    return { results: [], mode, query: query || "" };
  }

  const q = query.trim();
  const workspace = workspaceId || "default";
  const searchOpts = { query: q, workspace };
  if (dataDir) searchOpts.dataDir = dataDir;

  // Keyword-only mode
  if (mode === "keyword") {
    const kwResult = await keywordSearch(searchOpts);
    if (kwResult.error) {
      return { results: [], mode, query: q, error: kwResult.error, code: kwResult.code };
    }
    const results = (kwResult.snippets || []).slice(0, limit).map((s) => ({
      docId: s.id,
      title: s.title || "",
      snippet: s.snippet || "",
      score: s.score || 0,
      source: "keyword",
    }));
    return { results, mode, query: q };
  }

  // Semantic-only mode
  if (mode === "semantic") {
    const semResult = await semanticSearch({ ...searchOpts, topK: limit });
    if (semResult.error) {
      return { results: [], mode, query: q, error: semResult.error, code: semResult.code };
    }
    const results = (semResult.snippets || []).slice(0, limit).map((s) => ({
      docId: s.id,
      title: s.title || "",
      snippet: s.snippet || "",
      score: s.score || 0,
      source: "semantic",
    }));
    return { results, mode, query: q };
  }

  // Hybrid mode: run both searches in parallel
  const [kwResult, semResult] = await Promise.all([
    keywordSearch(searchOpts),
    semanticSearch({ ...searchOpts, topK: Math.max(limit, 20) }).catch(() => ({ snippets: [] })),
  ]);

  const kwSnippets = kwResult.error ? [] : (kwResult.snippets || []);
  const semSnippets = semResult.error ? [] : (semResult.snippets || []);

  // Build lookup maps for metadata
  const docMeta = new Map();
  for (const s of kwSnippets) {
    docMeta.set(s.id, { title: s.title || "", snippet: s.snippet || "", kwScore: s.score || 0 });
  }
  for (const s of semSnippets) {
    const existing = docMeta.get(s.id);
    if (existing) {
      existing.semScore = s.score || 0;
      // Keep the longer snippet
      if (s.snippet && s.snippet.length > (existing.snippet || "").length) {
        existing.snippet = s.snippet;
      }
    } else {
      docMeta.set(s.id, { title: s.title || "", snippet: s.snippet || "", semScore: s.score || 0 });
    }
  }

  // RRF fusion
  const fusedScores = reciprocalRankFusion([kwSnippets, semSnippets], k);

  // Determine source for each doc
  const kwIds = new Set(kwSnippets.map((s) => s.id));
  const semIds = new Set(semSnippets.map((s) => s.id));

  // Sort by fused score descending
  const ranked = [...fusedScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);

  const results = ranked.map(([docId, score]) => {
    const meta = docMeta.get(docId) || {};
    const inKw = kwIds.has(docId);
    const inSem = semIds.has(docId);
    const source = inKw && inSem ? "both" : inKw ? "keyword" : "semantic";

    return {
      docId,
      title: meta.title || "",
      snippet: meta.snippet || "",
      score: Math.round(score * 100000) / 100000,
      source,
    };
  });

  return { results, mode: "hybrid", query: q };
}
