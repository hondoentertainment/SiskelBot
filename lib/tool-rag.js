// @ts-check
/**
 * Phase 53.1: Tool RAG.
 *
 * Given a natural-language task, retrieve the top-K most relevant tools
 * using keyword + TF-IDF scoring over tool descriptions, schemas, tags,
 * and examples. Pure JavaScript — no embedding library required.
 *
 * The module exposes:
 *   - `ToolIndex` — in-memory inverted index with TF-IDF stats
 *   - `retrieveTools(query, opts)` — top-K retrieval
 *   - `retrieveToolsForTask(task, opts)` — convenience wrapper
 *   - `registerToolMetadata` / `getToolMetadata` / `listRegisteredTools`
 *     — persisted tool catalog (JSON-backed)
 *   - `recordToolUsage` / `getToolUsageStats` / `reRankByUsage`
 *     — usage-based re-ranking
 *   - `buildDefaultIndex()` — bootstraps an index from `lib/agent-tools.js`
 *     (tolerant of missing module)
 *
 * Storage is JSON-backed via `json-path-store.js` so it works across file,
 * SQLite, or Postgres KV backends.
 *
 * @module tool-rag
 */
import { join } from "path";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;

const DEFAULT_STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by",
  "for", "from", "has", "have", "he", "in", "is", "it", "its",
  "of", "on", "or", "so", "such", "that", "the", "their", "then",
  "there", "these", "they", "this", "to", "too", "was", "were",
  "will", "with", "would", "could", "should", "i", "you", "we",
  "me", "my", "your", "our", "us", "do", "does", "did", "done",
  "been", "being", "if", "else", "how", "what", "which", "who",
  "when", "where", "why", "about", "into", "over", "some", "any",
  "all", "no", "not", "can", "may", "might", "up", "down", "off",
  "out", "than", "also", "just", "now", "here",
]);

function toolCatalogPath() {
  return join(getDataDir(), "tool-rag-catalog.json");
}

function toolUsagePath() {
  return join(getDataDir(), "tool-rag-usage.json");
}

/* -------------------------------------------------------------------------- */
/* Tokenization / stopwords                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Lowercase, strip punctuation, split on whitespace.
 * Numbers and underscores are preserved as part of word characters.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  if (text == null) return [];
  const s = String(text).toLowerCase();
  // Replace anything that is not a letter, digit, or underscore with a space.
  const cleaned = s.replace(/[^a-z0-9_]+/g, " ");
  const parts = cleaned.split(/\s+/).filter(Boolean);
  // Drop 1-char tokens (except digits) which are pure noise for TF-IDF.
  return parts.filter((t) => t.length > 1 || /\d/.test(t));
}

/**
 * Remove English stopwords from a token list.
 *
 * @param {string[]} tokens
 * @param {Set<string>} [stopwords]
 * @returns {string[]}
 */
export function stopwordFilter(tokens, stopwords = DEFAULT_STOPWORDS) {
  if (!Array.isArray(tokens)) return [];
  return tokens.filter((t) => !stopwords.has(t));
}

/* -------------------------------------------------------------------------- */
/* TF-IDF primitives                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Count raw term frequencies in a token stream.
 *
 * @param {string[]} tokens
 * @returns {Record<string, number>}
 */
export function computeTf(tokens) {
  /** @type {Record<string, number>} */
  const out = {};
  if (!Array.isArray(tokens)) return out;
  for (const t of tokens) {
    out[t] = (out[t] || 0) + 1;
  }
  return out;
}

/**
 * Compute inverse-document-frequency over a corpus of documents.
 * Uses the smoothed log formula idf(t) = ln((N + 1) / (df(t) + 1)) + 1
 * so unseen terms aren't infinite and present-in-all terms aren't zero.
 *
 * @param {string[][]} documents
 * @returns {Record<string, number>}
 */
export function computeIdf(documents) {
  /** @type {Record<string, number>} */
  const idf = {};
  if (!Array.isArray(documents) || documents.length === 0) return idf;
  const N = documents.length;
  /** @type {Record<string, number>} */
  const df = {};
  for (const doc of documents) {
    if (!Array.isArray(doc)) continue;
    const seen = new Set();
    for (const t of doc) {
      if (seen.has(t)) continue;
      seen.add(t);
      df[t] = (df[t] || 0) + 1;
    }
  }
  for (const [term, freq] of Object.entries(df)) {
    idf[term] = Math.log((N + 1) / (freq + 1)) + 1;
  }
  return idf;
}

/**
 * Score a single document against a query using cosine-like TF-IDF.
 * Returns a dictionary with the final score and matched terms.
 *
 * @param {string[]} queryTokens
 * @param {string[]} docTokens
 * @param {Record<string, number>} idf
 * @returns {{ score: number, matchedTerms: string[] }}
 */
export function tfIdfScore(queryTokens, docTokens, idf) {
  if (!Array.isArray(queryTokens) || queryTokens.length === 0) {
    return { score: 0, matchedTerms: [] };
  }
  if (!Array.isArray(docTokens) || docTokens.length === 0) {
    return { score: 0, matchedTerms: [] };
  }
  const docTf = computeTf(docTokens);
  const docLen = docTokens.length;
  /** @type {Set<string>} */
  const matched = new Set();
  let score = 0;
  for (const qt of queryTokens) {
    const tf = docTf[qt];
    if (!tf) continue;
    const w = (idf && idf[qt]) || 1;
    // Normalize tf by document length so long descriptions don't dominate.
    score += (tf / docLen) * w * w;
    matched.add(qt);
  }
  return { score, matchedTerms: [...matched] };
}

/* -------------------------------------------------------------------------- */
/* ToolIndex                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Join the searchable text for a tool record.
 * @param {object} tool
 * @returns {string}
 */
function toolText(tool) {
  if (!tool || typeof tool !== "object") return "";
  const parts = [];
  if (tool.name) parts.push(String(tool.name).replace(/_/g, " "));
  if (tool.description) parts.push(String(tool.description));
  if (Array.isArray(tool.tags)) parts.push(tool.tags.join(" "));
  if (Array.isArray(tool.examples)) {
    for (const ex of tool.examples) {
      if (typeof ex === "string") parts.push(ex);
      else if (ex && typeof ex === "object") {
        if (ex.description) parts.push(String(ex.description));
        if (ex.query) parts.push(String(ex.query));
        if (ex.task) parts.push(String(ex.task));
      }
    }
  }
  if (tool.schema && typeof tool.schema === "object") {
    // Pull property names & descriptions from JSON-schema-like shape.
    const props = tool.schema.properties;
    if (props && typeof props === "object") {
      for (const [pname, pdef] of Object.entries(props)) {
        parts.push(pname.replace(/_/g, " "));
        if (pdef && typeof pdef === "object" && /** @type {any} */ (pdef).description) {
          parts.push(String(/** @type {any} */ (pdef).description));
        }
      }
    }
  }
  return parts.join(" ");
}

/**
 * In-memory index of tools with TF-IDF statistics.
 * Call `addTool` for each tool, then `retrieveTools` to rank.
 */
export class ToolIndex {
  constructor() {
    /** @type {Map<string, { name: string, description: string, schema: any, tags: string[], examples: any[] }>} */
    this.tools = new Map();
    /** @type {Map<string, string[]>} */
    this.tokenized = new Map();
    /** @type {Record<string, number>} */
    this.idf = {};
    /** @type {boolean} */
    this._dirty = false;
  }

  /**
   * Insert or replace a tool by name.
   * @param {{name: string, description?: string, schema?: any, tags?: string[], examples?: any[]}} tool
   */
  addTool(tool) {
    if (!tool || typeof tool !== "object") return;
    const name = String(tool.name || "").trim();
    if (!name) return;
    const record = {
      name,
      description: String(tool.description || ""),
      schema: tool.schema || null,
      tags: Array.isArray(tool.tags) ? tool.tags.slice() : [],
      examples: Array.isArray(tool.examples) ? tool.examples.slice() : [],
    };
    this.tools.set(name, record);
    const tokens = stopwordFilter(tokenize(toolText(record)));
    this.tokenized.set(name, tokens);
    this._dirty = true;
  }

  /**
   * Remove a tool by name.
   * @param {string} name
   */
  removeTool(name) {
    if (!name) return;
    this.tools.delete(name);
    this.tokenized.delete(name);
    this._dirty = true;
  }

  /**
   * Shallow-merge updates into an existing tool (or create if missing).
   * @param {string} name
   * @param {object} updates
   */
  updateTool(name, updates) {
    if (!name || !updates || typeof updates !== "object") return;
    const existing = this.tools.get(name) || { name, description: "", schema: null, tags: [], examples: [] };
    this.addTool({ ...existing, ...updates, name });
  }

  /** @returns {Array<object>} */
  getTools() {
    return [...this.tools.values()];
  }

  /** @returns {number} */
  size() {
    return this.tools.size;
  }

  /** Recompute IDF across all indexed tools. */
  recomputeIdf() {
    const docs = [...this.tokenized.values()];
    this.idf = computeIdf(docs);
    this._dirty = false;
  }

  /**
   * Score every indexed tool against a query.
   * @param {string} query
   * @returns {Array<{ name: string, score: number, matchedTerms: string[], description: string }>}
   */
  search(query) {
    if (this._dirty) this.recomputeIdf();
    const qTokens = stopwordFilter(tokenize(query || ""));
    const results = [];
    for (const [name, docTokens] of this.tokenized.entries()) {
      const { score, matchedTerms } = tfIdfScore(qTokens, docTokens, this.idf);
      if (score <= 0 && qTokens.length > 0) continue;
      const rec = this.tools.get(name);
      results.push({
        name,
        score: Math.round(score * 10000) / 10000,
        matchedTerms,
        description: rec?.description || "",
      });
    }
    results.sort((a, b) => b.score - a.score);
    return results;
  }
}

/* -------------------------------------------------------------------------- */
/* Process-wide default index                                                 */
/* -------------------------------------------------------------------------- */

let _defaultIndex = /** @type {ToolIndex | null} */ (null);

/**
 * Get (lazily building) the process-wide default ToolIndex.
 * @returns {Promise<ToolIndex>}
 */
export async function getDefaultIndex() {
  if (!_defaultIndex) {
    _defaultIndex = await buildDefaultIndex();
  }
  return _defaultIndex;
}

/**
 * Force a rebuild of the process-wide default index.
 * @returns {Promise<ToolIndex>}
 */
export async function rebuildDefaultIndex() {
  _defaultIndex = await buildDefaultIndex();
  return _defaultIndex;
}

/* -------------------------------------------------------------------------- */
/* Retrieval                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Expand a query with a simple synonym map. Each synonym list is joined
 * with the original query so tokenization picks them up.
 *
 * @param {string} query
 * @param {Record<string, string[]>} [synonyms]
 * @returns {string}
 */
export function expandQuery(query, synonyms = {}) {
  if (!query || typeof query !== "string") return "";
  if (!synonyms || typeof synonyms !== "object") return query;
  const tokens = tokenize(query);
  const extras = [];
  for (const t of tokens) {
    const syns = synonyms[t];
    if (Array.isArray(syns)) {
      for (const s of syns) {
        if (typeof s === "string" && s.trim()) extras.push(s.trim());
      }
    }
  }
  if (extras.length === 0) return query;
  return `${query} ${extras.join(" ")}`;
}

/**
 * @typedef {Object} RetrieveOptions
 * @property {number} [k]          Top-K cut. Defaults to 5.
 * @property {number} [minScore]   Discard results below this score. Defaults to 0.
 * @property {string[]} [tags]     Only include tools matching any of these tags.
 * @property {ToolIndex} [index]   Override the process-wide index.
 * @property {Record<string, string[]>} [synonyms] Query expansion map.
 */

/**
 * Retrieve top-K tools ranked by TF-IDF score.
 *
 * @param {string} query
 * @param {RetrieveOptions} [options]
 * @returns {Promise<Array<{ name: string, score: number, matchedTerms: string[], description: string }>>}
 */
export async function retrieveTools(query, options = {}) {
  const k = Number.isFinite(options.k) && options.k > 0 ? Math.floor(options.k) : 5;
  const minScore = Number.isFinite(options.minScore) ? options.minScore : 0;
  const tagFilter = Array.isArray(options.tags) && options.tags.length > 0
    ? new Set(options.tags.map((t) => String(t).toLowerCase()))
    : null;

  const index = options.index instanceof ToolIndex
    ? options.index
    : await getDefaultIndex();

  if (!query || typeof query !== "string" || !query.trim()) return [];
  if (index.size() === 0) return [];

  const expanded = options.synonyms ? expandQuery(query, options.synonyms) : query;
  let results = index.search(expanded);

  if (tagFilter) {
    results = results.filter((r) => {
      const rec = index.tools.get(r.name);
      if (!rec || !Array.isArray(rec.tags)) return false;
      return rec.tags.some((t) => tagFilter.has(String(t).toLowerCase()));
    });
  }

  if (minScore > 0) {
    results = results.filter((r) => r.score >= minScore);
  }

  return results.slice(0, k);
}

/**
 * Natural-language wrapper around `retrieveTools`. Strips instruction
 * boilerplate ("please", "can you", "I want to"), then delegates.
 *
 * @param {string} task
 * @param {RetrieveOptions} [options]
 */
export async function retrieveToolsForTask(task, options = {}) {
  if (!task || typeof task !== "string") return [];
  const cleaned = task
    .replace(/\b(please|kindly|could you|can you|would you|i want to|i need to|help me)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return retrieveTools(cleaned, options);
}

/* -------------------------------------------------------------------------- */
/* Persisted tool catalog                                                     */
/* -------------------------------------------------------------------------- */

async function loadCatalog() {
  const data = await readJsonPath(toolCatalogPath(), { version: STORE_VERSION, tools: {} });
  if (!data.tools || typeof data.tools !== "object") data.tools = {};
  return data;
}

async function saveCatalog(data) {
  await writeJsonPath(toolCatalogPath(), {
    version: STORE_VERSION,
    tools: data.tools || {},
  });
}

/**
 * Persist metadata for a tool so it survives restarts.
 * @param {string} name
 * @param {object} metadata
 * @returns {Promise<object>}
 */
export async function registerToolMetadata(name, metadata) {
  if (!name || typeof name !== "string") {
    throw new Error("tool name is required");
  }
  if (!metadata || typeof metadata !== "object") {
    throw new Error("metadata is required");
  }
  const path = toolCatalogPath();
  return withPathLock(path, async () => {
    const data = await loadCatalog();
    const now = new Date().toISOString();
    const existing = data.tools[name] || { createdAt: now };
    data.tools[name] = {
      ...existing,
      ...metadata,
      name,
      updatedAt: now,
    };
    await saveCatalog(data);
    return data.tools[name];
  });
}

/**
 * Fetch previously registered metadata.
 * @param {string} name
 */
export async function getToolMetadata(name) {
  if (!name || typeof name !== "string") return null;
  const data = await loadCatalog();
  return data.tools[name] || null;
}

/** List every registered tool. */
export async function listRegisteredTools() {
  const data = await loadCatalog();
  return Object.values(data.tools || {});
}

/* -------------------------------------------------------------------------- */
/* Usage stats & re-ranking                                                   */
/* -------------------------------------------------------------------------- */

async function loadUsage() {
  const data = await readJsonPath(toolUsagePath(), { version: STORE_VERSION, usage: {} });
  if (!data.usage || typeof data.usage !== "object") data.usage = {};
  return data;
}

async function saveUsage(data) {
  await writeJsonPath(toolUsagePath(), {
    version: STORE_VERSION,
    usage: data.usage || {},
  });
}

/**
 * Record a single tool invocation. `context` is free-form metadata such
 * as task type, success flag, or latency; only recognized fields are
 * summarized.
 *
 * @param {string} name
 * @param {object} [context]
 * @returns {Promise<object>}
 */
export async function recordToolUsage(name, context = {}) {
  if (!name || typeof name !== "string") {
    throw new Error("tool name is required");
  }
  const path = toolUsagePath();
  return withPathLock(path, async () => {
    const data = await loadUsage();
    const cur = data.usage[name] || { uses: 0, successes: 0, lastUsedAt: null, contexts: [] };
    cur.uses += 1;
    if (context && context.success !== false) cur.successes += 1;
    cur.lastUsedAt = new Date().toISOString();
    if (context && Object.keys(context).length > 0) {
      cur.contexts = Array.isArray(cur.contexts) ? cur.contexts : [];
      cur.contexts.push({ at: cur.lastUsedAt, ...context });
      if (cur.contexts.length > 50) cur.contexts = cur.contexts.slice(-50);
    }
    data.usage[name] = cur;
    await saveUsage(data);
    return cur;
  });
}

/**
 * Fetch usage stats for a single tool. Returns an empty record when unknown.
 * @param {string} name
 */
export async function getToolUsageStats(name) {
  if (!name || typeof name !== "string") return null;
  const data = await loadUsage();
  return data.usage[name] || { uses: 0, successes: 0, lastUsedAt: null, contexts: [] };
}

/** Return the full usage map. */
export async function getAllToolUsage() {
  const data = await loadUsage();
  return data.usage || {};
}

/**
 * Re-rank retrieval results by blending TF-IDF score with usage counts.
 * The usage bump is log-scaled so a handful of uses can't outweigh the
 * semantic score of a better-matching tool.
 *
 * @param {Array<{ name: string, score: number }>} results
 * @param {Record<string, { uses?: number, successes?: number }>} stats
 * @returns {Array<object>}
 */
export function reRankByUsage(results, stats) {
  if (!Array.isArray(results)) return [];
  const safeStats = stats && typeof stats === "object" ? stats : {};
  const out = results.map((r) => {
    const s = safeStats[r.name] || { uses: 0, successes: 0 };
    const uses = Number(s.uses) || 0;
    const successes = Number(s.successes) || 0;
    const successRate = uses > 0 ? successes / uses : 0;
    // Bump is log(1 + uses) * (0.5 + 0.5 * successRate), capped at +1.
    const bump = Math.min(1, Math.log(1 + uses) * (0.5 + 0.5 * successRate));
    const finalScore = r.score + bump;
    return { ...r, baseScore: r.score, usageBump: Math.round(bump * 10000) / 10000, score: Math.round(finalScore * 10000) / 10000 };
  });
  out.sort((a, b) => b.score - a.score);
  return out;
}

/* -------------------------------------------------------------------------- */
/* Default index (bootstrapped from agent-tools.js)                           */
/* -------------------------------------------------------------------------- */

/**
 * Build a ToolIndex seeded with the built-in agent tools. Dynamically
 * imports `lib/agent-tools.js` so tests can run with the module missing
 * or mocked; also merges any persisted registry entries.
 *
 * @returns {Promise<ToolIndex>}
 */
export async function buildDefaultIndex() {
  const index = new ToolIndex();
  try {
    const mod = await import("./agent-tools.js");
    const tools = Array.isArray(mod.TOOLS) ? mod.TOOLS : [];
    for (const t of tools) {
      if (!t || typeof t !== "object") continue;
      const fn = /** @type {any} */ (t).function;
      if (!fn || typeof fn !== "object") continue;
      if (!fn.name) continue;
      index.addTool({
        name: String(fn.name),
        description: String(fn.description || ""),
        schema: fn.parameters || null,
        tags: [],
        examples: [],
      });
    }
  } catch (err) {
    // Tolerant of missing / broken agent-tools module; tests can pass a mock.
    console.warn("[tool-rag] buildDefaultIndex could not load agent-tools:", err?.message || err);
  }
  try {
    const registered = await listRegisteredTools();
    for (const meta of registered) {
      if (!meta || !meta.name) continue;
      index.addTool({
        name: String(meta.name),
        description: String(meta.description || ""),
        schema: meta.schema || null,
        tags: Array.isArray(meta.tags) ? meta.tags : [],
        examples: Array.isArray(meta.examples) ? meta.examples : [],
      });
    }
  } catch (err) {
    console.warn("[tool-rag] buildDefaultIndex could not load registered tools:", err?.message || err);
  }
  index.recomputeIdf();
  return index;
}
