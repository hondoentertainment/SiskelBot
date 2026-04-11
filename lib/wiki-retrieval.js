// @ts-check
/**
 * Phase 68.2: Wikipedia-scale retrieval.
 *
 * A durable full-text index over free-form articles. Uses a simple
 * in-memory inverted index + TF-IDF scoring, persisted to JSON so it
 * survives restarts. No external dependencies.
 *
 * Exports:
 *   - indexArticle
 *   - searchArticles
 *   - getArticle
 *   - listArticles
 *   - clearIndex
 *
 * @module wiki-retrieval
 */
import { join } from "path";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from",
  "has", "have", "he", "in", "is", "it", "its", "of", "on", "or", "so",
  "such", "that", "the", "their", "then", "there", "these", "they", "this",
  "to", "too", "was", "were", "will", "with", "would", "could", "should",
  "i", "you", "we", "me", "my", "your", "our", "us", "do", "does", "did",
  "been", "being", "if", "else", "how", "what", "which", "who", "when",
  "where", "why", "about", "into", "over", "some", "any", "all", "no",
  "not", "can", "may", "might",
]);

function indexPath() {
  return join(getDataDir(), "wiki-retrieval-index.json");
}

/**
 * Tokenize a string into lowercase word tokens, stripping punctuation.
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  if (text == null) return [];
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

async function loadIndex() {
  const data = await readJsonPath(indexPath(), {
    version: STORE_VERSION,
    articles: {},
  });
  if (!data.articles || typeof data.articles !== "object") data.articles = {};
  return data;
}

async function saveIndex(data) {
  await writeJsonPath(indexPath(), {
    version: STORE_VERSION,
    articles: data.articles || {},
  });
}

function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 100);
}

/**
 * Insert or update an article. Token frequencies and length are
 * cached alongside the raw text for faster retrieval.
 *
 * @param {{ id?: string, title: string, text: string, tags?: string[], url?: string }} article
 * @returns {Promise<object>}
 */
export async function indexArticle(article) {
  if (!article || typeof article !== "object") {
    throw new Error("article is required");
  }
  if (!article.title || typeof article.title !== "string") {
    throw new Error("title is required");
  }
  if (typeof article.text !== "string") {
    throw new Error("text is required");
  }
  const id = article.id && typeof article.id === "string"
    ? article.id
    : slugify(article.title) || `art_${Date.now()}`;
  const path = indexPath();
  return withPathLock(path, async () => {
    const data = await loadIndex();
    const now = new Date().toISOString();
    const tokens = tokenize(`${article.title} ${article.text}`);
    /** @type {Record<string, number>} */
    const tf = {};
    for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
    const record = {
      id,
      title: article.title,
      text: article.text,
      url: typeof article.url === "string" ? article.url : "",
      tags: Array.isArray(article.tags) ? article.tags.slice() : [],
      tf,
      length: tokens.length,
      createdAt: data.articles[id]?.createdAt || now,
      updatedAt: now,
    };
    data.articles[id] = record;
    await saveIndex(data);
    return record;
  });
}

/**
 * Compute IDF across all indexed articles, excluding any scoring cache.
 * @param {object[]} articles
 * @returns {Record<string, number>}
 */
function computeIdf(articles) {
  const N = articles.length;
  /** @type {Record<string, number>} */
  const df = {};
  for (const a of articles) {
    if (!a.tf) continue;
    for (const term of Object.keys(a.tf)) {
      df[term] = (df[term] || 0) + 1;
    }
  }
  /** @type {Record<string, number>} */
  const idf = {};
  for (const [term, freq] of Object.entries(df)) {
    idf[term] = Math.log((N + 1) / (freq + 1)) + 1;
  }
  return idf;
}

/**
 * Search for the top-K articles matching a query using TF-IDF scoring.
 * A small semantic hint is applied: exact title match doubles the score.
 *
 * @param {string} query
 * @param {{ k?: number, tag?: string }} [opts]
 * @returns {Promise<Array<{ id: string, title: string, score: number, snippet: string }>>}
 */
export async function searchArticles(query, opts = {}) {
  if (!query || typeof query !== "string" || !query.trim()) return [];
  const k = Number.isFinite(opts.k) && opts.k > 0 ? Math.floor(opts.k) : 5;
  const tag = typeof opts.tag === "string" && opts.tag ? opts.tag.toLowerCase() : null;
  const data = await loadIndex();
  let articles = Object.values(data.articles || {});
  if (tag) {
    articles = articles.filter((a) => Array.isArray(a.tags) && a.tags.some((t) => String(t).toLowerCase() === tag));
  }
  if (articles.length === 0) return [];
  const idf = computeIdf(articles);
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return [];
  const qLower = query.toLowerCase();
  /** @type {Array<{ id: string, title: string, score: number, snippet: string }>} */
  const results = [];
  for (const a of articles) {
    let score = 0;
    for (const qt of qTokens) {
      const tf = a.tf?.[qt];
      if (!tf) continue;
      const w = idf[qt] || 1;
      score += (tf / Math.max(1, a.length)) * w * w;
    }
    if (score <= 0) continue;
    if (String(a.title || "").toLowerCase() === qLower) score *= 2;
    const snippet = buildSnippet(a.text, qTokens);
    results.push({
      id: a.id,
      title: a.title,
      score: Math.round(score * 10000) / 10000,
      snippet,
    });
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, k);
}

function buildSnippet(text, qTokens) {
  const s = String(text || "");
  if (!s) return "";
  const lower = s.toLowerCase();
  for (const t of qTokens) {
    const i = lower.indexOf(t);
    if (i >= 0) {
      const start = Math.max(0, i - 40);
      const end = Math.min(s.length, i + 80);
      return (start > 0 ? "..." : "") + s.slice(start, end) + (end < s.length ? "..." : "");
    }
  }
  return s.slice(0, 120);
}

/**
 * Retrieve an article by id.
 * @param {string} id
 * @returns {Promise<object | null>}
 */
export async function getArticle(id) {
  if (!id || typeof id !== "string") return null;
  const data = await loadIndex();
  const rec = data.articles[id];
  if (!rec) return null;
  const { tf: _tf, ...rest } = rec;
  return rest;
}

/**
 * List all indexed articles (without the TF cache).
 * @returns {Promise<object[]>}
 */
export async function listArticles() {
  const data = await loadIndex();
  return Object.values(data.articles || {}).map((a) => {
    const { tf: _tf, text: _text, ...rest } = a;
    return rest;
  });
}

/**
 * Remove every indexed article. Intended for tests and admin reset.
 * @returns {Promise<{ cleared: number }>}
 */
export async function clearIndex() {
  const path = indexPath();
  return withPathLock(path, async () => {
    const data = await loadIndex();
    const n = Object.keys(data.articles || {}).length;
    data.articles = {};
    await saveIndex(data);
    return { cleared: n };
  });
}
