/**
 * In-memory inverted index for fast full-text search with TF-IDF ranking.
 * Supports tokenization, stopword removal, snippet extraction, and JSON persistence.
 */
import { readFile, writeFile, mkdir } from "fs/promises";
import { dirname } from "path";

const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "dare", "ought",
  "used", "to", "of", "in", "for", "on", "with", "at", "by", "from",
  "as", "into", "through", "during", "before", "after", "above", "below",
  "between", "out", "off", "over", "under", "again", "further", "then",
  "once", "here", "there", "when", "where", "why", "how", "all", "each",
  "every", "both", "few", "more", "most", "other", "some", "such", "no",
  "not", "only", "own", "same", "so", "than", "too", "very", "just",
  "because", "but", "and", "or", "if", "while", "about", "up", "it",
  "its", "this", "that", "these", "those", "i", "me", "my", "we", "our",
  "you", "your", "he", "him", "his", "she", "her", "they", "them", "their",
  "what", "which", "who", "whom",
]);

const SNIPPET_CONTEXT_CHARS = 100;

/**
 * Tokenize text: split on non-alphanumeric, lowercase, remove stopwords.
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  if (!text || typeof text !== "string") return [];
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/**
 * Simple Porter-like suffix stripping for English.
 * Not a full stemmer but handles common suffixes.
 * @param {string} token
 * @returns {string}
 */
function stem(token) {
  if (token.length < 4) return token;
  let w = token;
  if (w.endsWith("ing") && w.length > 5) w = w.slice(0, -3);
  else if (w.endsWith("tion") && w.length > 6) w = w.slice(0, -4);
  else if (w.endsWith("ness") && w.length > 6) w = w.slice(0, -4);
  else if (w.endsWith("ment") && w.length > 6) w = w.slice(0, -4);
  else if (w.endsWith("able") && w.length > 6) w = w.slice(0, -4);
  else if (w.endsWith("ies") && w.length > 4) w = w.slice(0, -3) + "y";
  else if (w.endsWith("es") && w.length > 4) w = w.slice(0, -2);
  else if (w.endsWith("ed") && w.length > 4) w = w.slice(0, -2);
  else if (w.endsWith("ly") && w.length > 4) w = w.slice(0, -2);
  else if (w.endsWith("s") && !w.endsWith("ss") && w.length > 3) w = w.slice(0, -1);
  return w;
}

/**
 * Tokenize and stem text.
 * @param {string} text
 * @returns {string[]}
 */
function tokenizeAndStem(text) {
  return tokenize(text).map(stem);
}

/**
 * Create a new inverted index instance.
 * @returns {object}
 */
export function createSearchIndex() {
  // postings: Map<term, Map<docId, { tf: number, positions: number[] }>>
  const postings = new Map();
  // docs: Map<docId, { text: string, metadata: object, tokenCount: number }>
  const docs = new Map();

  function add(docId, text, metadata = {}) {
    if (!docId || typeof text !== "string") return;

    // Remove old version if re-indexing
    if (docs.has(docId)) {
      remove(docId);
    }

    const tokens = tokenizeAndStem(text);
    docs.set(docId, { text, metadata, tokenCount: tokens.length });

    // Build term frequency map with positions
    const tfMap = new Map();
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (!tfMap.has(t)) {
        tfMap.set(t, { count: 0, positions: [] });
      }
      const entry = tfMap.get(t);
      entry.count++;
      entry.positions.push(i);
    }

    for (const [term, { count, positions }] of tfMap) {
      if (!postings.has(term)) {
        postings.set(term, new Map());
      }
      postings.get(term).set(docId, { tf: count, positions });
    }
  }

  function remove(docId) {
    const doc = docs.get(docId);
    if (!doc) return false;

    const tokens = tokenizeAndStem(doc.text);
    const seen = new Set();
    for (const t of tokens) {
      if (seen.has(t)) continue;
      seen.add(t);
      const termPostings = postings.get(t);
      if (termPostings) {
        termPostings.delete(docId);
        if (termPostings.size === 0) {
          postings.delete(t);
        }
      }
    }

    docs.delete(docId);
    return true;
  }

  function search(query, options = {}) {
    const { limit = 20, offset = 0, type } = options;

    if (!query || typeof query !== "string" || !query.trim()) {
      return { results: [], total: 0 };
    }

    const queryTokens = tokenizeAndStem(query);
    if (queryTokens.length === 0) {
      return { results: [], total: 0 };
    }

    const N = docs.size;
    if (N === 0) return { results: [], total: 0 };

    // Score each document using TF-IDF
    const scores = new Map();

    for (const term of queryTokens) {
      const termPostings = postings.get(term);
      if (!termPostings) continue;

      const df = termPostings.size;
      const idf = Math.log(1 + N / df);

      for (const [docId, { tf }] of termPostings) {
        const doc = docs.get(docId);
        if (!doc) continue;

        // Filter by type if specified
        if (type && doc.metadata.type !== type) continue;

        const tfNorm = tf / (doc.tokenCount || 1);
        const tfidf = tfNorm * idf;

        scores.set(docId, (scores.get(docId) || 0) + tfidf);
      }
    }

    // Sort by score descending
    const ranked = [...scores.entries()]
      .sort((a, b) => b[1] - a[1]);

    const total = ranked.length;
    const page = ranked.slice(offset, offset + limit);

    const results = page.map(([docId, score]) => {
      const doc = docs.get(docId);
      return {
        docId,
        score: Math.round(score * 10000) / 10000,
        snippet: extractSnippet(doc.text, query),
        metadata: doc.metadata,
      };
    });

    return { results, total };
  }

  function size() {
    return docs.size;
  }

  function clear() {
    postings.clear();
    docs.clear();
  }

  function serialize() {
    const postingsObj = {};
    for (const [term, docMap] of postings) {
      const entries = {};
      for (const [docId, data] of docMap) {
        entries[docId] = { tf: data.tf };
      }
      postingsObj[term] = entries;
    }

    const docsObj = {};
    for (const [docId, doc] of docs) {
      docsObj[docId] = {
        text: doc.text,
        metadata: doc.metadata,
        tokenCount: doc.tokenCount,
      };
    }

    return JSON.stringify({ postings: postingsObj, docs: docsObj });
  }

  function deserialize(data) {
    clear();

    let parsed;
    if (typeof data === "string") {
      parsed = JSON.parse(data);
    } else {
      parsed = data;
    }

    if (!parsed || !parsed.docs) return;

    // Restore docs
    for (const [docId, doc] of Object.entries(parsed.docs)) {
      docs.set(docId, {
        text: doc.text,
        metadata: doc.metadata || {},
        tokenCount: doc.tokenCount || 0,
      });
    }

    // Restore postings
    if (parsed.postings) {
      for (const [term, entries] of Object.entries(parsed.postings)) {
        const docMap = new Map();
        for (const [docId, data] of Object.entries(entries)) {
          docMap.set(docId, { tf: data.tf, positions: [] });
        }
        postings.set(term, docMap);
      }
    }
  }

  return { add, remove, search, size, clear, serialize, deserialize };
}

/**
 * Extract a snippet around the best matching position with <mark> highlighting.
 * @param {string} text
 * @param {string} query
 * @param {number} [contextChars]
 * @returns {string}
 */
export function extractSnippet(text, query, contextChars = SNIPPET_CONTEXT_CHARS) {
  if (!text || !query) return "";

  const textLower = text.toLowerCase();
  const queryTerms = query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1);

  // Find best position (position where most query terms cluster)
  let bestPos = -1;
  for (const term of queryTerms) {
    const idx = textLower.indexOf(term);
    if (idx >= 0) {
      bestPos = idx;
      break;
    }
  }

  if (bestPos < 0) {
    // Fallback: return start of text
    const slice = text.slice(0, contextChars * 2);
    return highlightTerms(slice, queryTerms);
  }

  const start = Math.max(0, bestPos - Math.floor(contextChars / 2));
  const end = Math.min(text.length, start + contextChars);
  let snippet = text.slice(start, end);
  if (start > 0) snippet = "..." + snippet;
  if (end < text.length) snippet = snippet + "...";

  return highlightTerms(snippet, queryTerms);
}

/**
 * Wrap matching terms in <mark> tags.
 * @param {string} text
 * @param {string[]} terms
 * @returns {string}
 */
function highlightTerms(text, terms) {
  if (!terms.length) return text;

  // Sort longer terms first to avoid partial replacements
  const sorted = [...terms].sort((a, b) => b.length - a.length);
  let result = text;

  for (const term of sorted) {
    const regex = new RegExp(`(${escapeRegex(term)})`, "gi");
    result = result.replace(regex, "<mark>$1</mark>");
  }

  return result;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Save index to a JSON file.
 * @param {object} index - Search index instance
 * @param {string} filePath - Path to save to
 */
export async function saveIndex(index, filePath) {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  await writeFile(filePath, index.serialize(), "utf8");
}

/**
 * Load index from a JSON file.
 * @param {object} index - Search index instance
 * @param {string} filePath - Path to load from
 * @returns {Promise<boolean>} true if loaded, false if file not found
 */
export async function loadIndex(index, filePath) {
  try {
    const data = await readFile(filePath, "utf8");
    index.deserialize(data);
    return true;
  } catch (e) {
    if (e.code === "ENOENT") return false;
    console.warn("[search-index] Failed to load index:", e.message);
    return false;
  }
}
