/**
 * GBrain memory ranking utilities.
 *
 * Scoring helpers used by lib/gbrain-memory.js to merge results from the many
 * memory subsystems (facts, reasoning, documents, entities, conversations,
 * tool stats). The goal is a single relevance number on [0, 1] per memory so
 * results from different stores can be compared.
 */

const TOKEN_RX = /[a-z0-9]+/gi;
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "of", "to", "in",
  "on", "for", "with", "is", "are", "was", "were", "be", "been", "it",
  "this", "that", "these", "those", "as", "at", "by", "from", "how",
  "what", "when", "where", "why", "who", "whom", "which",
]);

function tokenize(text) {
  if (typeof text !== "string" || !text) return [];
  const raw = text.toLowerCase().match(TOKEN_RX) || [];
  const out = [];
  for (const t of raw) {
    if (t.length < 2) continue;
    if (STOPWORDS.has(t)) continue;
    out.push(t);
  }
  return out;
}

function recencyBoost(iso) {
  if (!iso || typeof iso !== "string") return 0;
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return 0;
  const ageDays = Math.max(0, (Date.now() - ts) / (1000 * 60 * 60 * 24));
  // Decay to 0 at ~365 days.
  return Math.max(0, 1 - ageDays / 365);
}

/**
 * Extract the searchable text for a memory regardless of its source shape.
 *
 * @param {object} memory
 * @returns {string}
 */
export function memoryText(memory) {
  if (!memory || typeof memory !== "object") return "";
  if (typeof memory.content === "string") return memory.content;
  if (typeof memory.snippet === "string") {
    const title = typeof memory.title === "string" ? memory.title + " " : "";
    return `${title}${memory.snippet}`;
  }
  if (typeof memory.text === "string") return memory.text;
  if (memory.step && typeof memory.step === "object") {
    const s = memory.step;
    return `${s.premise || ""} ${s.inference || ""} ${s.conclusion || ""}`.trim();
  }
  if (typeof memory.name === "string") {
    const type = typeof memory.type === "string" ? ` (${memory.type})` : "";
    return `${memory.name}${type}`;
  }
  if (typeof memory.tool === "string") {
    return memory.tool;
  }
  return "";
}

function extractIso(memory) {
  if (!memory || typeof memory !== "object") return null;
  return (
    memory.createdAt ||
    memory.updatedAt ||
    memory.timestamp ||
    (memory.step && memory.step.createdAt) ||
    null
  );
}

/**
 * Compute a TF-IDF-style keyword overlap score between query and memory text.
 * Returns a number in [0, 1].
 */
function keywordScore(queryTokens, text) {
  if (queryTokens.length === 0) return 0;
  const docTokens = tokenize(text);
  if (docTokens.length === 0) return 0;
  const docSet = new Set(docTokens);

  // IDF-ish: rarer (longer) tokens are worth more.
  let num = 0;
  let denom = 0;
  for (const q of queryTokens) {
    const weight = 1 + Math.log10(1 + q.length);
    denom += weight;
    if (docSet.has(q)) num += weight;
  }
  if (denom === 0) return 0;
  return num / denom;
}

/**
 * Score a single memory for relevance to a query.
 *
 * @param {string} query
 * @param {object} memory
 * @returns {number} 0..1
 */
export function scoreMemory(query, memory) {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return 0;
  const text = memoryText(memory);
  const key = keywordScore(queryTokens, text);
  const recency = recencyBoost(extractIso(memory));
  const importance = scoreMemoryImportance(memory);
  // Blend: keyword match dominates, recency and importance provide tie-breaks.
  const blended = key * 0.7 + recency * 0.15 + importance * 0.15;
  return Math.max(0, Math.min(1, blended));
}

/**
 * Rank memories by relevance to a query. Does not mutate the input array.
 *
 * @param {string} query
 * @param {Array<object>} memories
 * @param {object} [options] - { limit?, minScore? }
 * @returns {Array<object>} memories with `_gbrainScore` attached, sorted desc
 */
export function rankByRelevance(query, memories, options = {}) {
  if (!Array.isArray(memories) || memories.length === 0) return [];
  if (tokenize(query).length === 0) return [];
  const minScore = typeof options.minScore === "number" ? options.minScore : 0;
  const scored = memories
    .map((m) => {
      const score = scoreMemory(query, m);
      return { ...m, _gbrainScore: Math.round(score * 1000) / 1000 };
    })
    .filter((m) => m._gbrainScore >= minScore);
  scored.sort((a, b) => b._gbrainScore - a._gbrainScore);
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? options.limit : scored.length;
  return scored.slice(0, limit);
}

/**
 * Importance heuristic. Bigger = more authoritative.
 *
 * Signals:
 *  - explicit 1..5 importance (facts)
 *  - reference count / uses
 *  - user flag `important` / `pinned`
 *  - source credibility ("user", "verified" > "observation")
 *
 * @returns {number} in [0, 1]
 */
export function scoreMemoryImportance(memory) {
  if (!memory || typeof memory !== "object") return 0;
  let score = 0;

  if (Number.isFinite(memory.importance)) {
    score = Math.max(score, Math.min(1, memory.importance / 5));
  }
  if (memory.pinned === true || memory.important === true) {
    score = Math.max(score, 0.9);
  }
  if (Number.isFinite(memory.refCount) && memory.refCount > 0) {
    score = Math.max(score, Math.min(1, Math.log10(1 + memory.refCount) / 2));
  }
  if (Number.isFinite(memory.uses) && memory.uses > 0) {
    score = Math.max(score, Math.min(1, Math.log10(1 + memory.uses) / 3));
  }
  if (typeof memory.source === "string") {
    const s = memory.source.toLowerCase();
    if (s.includes("user") || s.includes("verified")) {
      score = Math.max(score, 0.8);
    } else if (s.includes("observation") || s.includes("auto")) {
      score = Math.max(score, 0.3);
    }
  }
  return Math.max(0, Math.min(1, score));
}

/**
 * Given a mixed list of memories from multiple sources, drop near-duplicates
 * keeping the most authoritative copy.
 *
 * Authority priority (high -> low):
 *   fact > entity > document > reasoning > conversation > toolInsight
 *
 * Two memories are considered duplicates when their normalized text overlaps
 * by >= 0.7 Jaccard similarity on token sets.
 *
 * @param {Array<object>} memories
 * @returns {Array<object>}
 */
export function deduplicateAcrossSystems(memories) {
  if (!Array.isArray(memories) || memories.length === 0) return [];

  const priority = {
    fact: 6,
    entity: 5,
    document: 4,
    reasoning: 3,
    conversation: 2,
    toolInsight: 1,
    preference: 6,
  };

  const normalized = memories.map((m) => {
    const tokens = new Set(tokenize(memoryText(m)));
    const sourceRank = priority[m._gbrainSource] || 0;
    return { mem: m, tokens, sourceRank };
  });

  const kept = [];
  for (const candidate of normalized) {
    if (candidate.tokens.size === 0) {
      kept.push(candidate);
      continue;
    }
    let duplicateIndex = -1;
    for (let i = 0; i < kept.length; i++) {
      const existing = kept[i];
      if (existing.tokens.size === 0) continue;
      let intersect = 0;
      for (const t of candidate.tokens) {
        if (existing.tokens.has(t)) intersect++;
      }
      const union = candidate.tokens.size + existing.tokens.size - intersect;
      const jaccard = union > 0 ? intersect / union : 0;
      if (jaccard >= 0.7) {
        duplicateIndex = i;
        break;
      }
    }
    if (duplicateIndex === -1) {
      kept.push(candidate);
    } else {
      const existing = kept[duplicateIndex];
      if (candidate.sourceRank > existing.sourceRank) {
        kept[duplicateIndex] = candidate;
      } else if (
        candidate.sourceRank === existing.sourceRank &&
        (candidate.mem._gbrainScore || 0) > (existing.mem._gbrainScore || 0)
      ) {
        kept[duplicateIndex] = candidate;
      }
    }
  }
  return kept.map((k) => k.mem);
}

/**
 * Estimate token count for a text (approx 4 chars per token).
 */
export function estimateTokens(text) {
  if (typeof text !== "string" || !text) return 0;
  return Math.ceil(text.length / 4);
}
