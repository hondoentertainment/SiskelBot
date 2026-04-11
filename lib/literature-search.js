// @ts-check
/**
 * Phase 64.1: Literature search.
 *
 * Thin abstraction over arXiv / PubMed / Semantic Scholar. The real HTTP
 * clients are injected via a `fetch` callback so tests can mock them.
 * Papers are cached in a persisted store for replay + offline access.
 *
 *   - `searchLiterature(query, opts)` — query one or more providers
 *   - `getPaper(id, opts)` — fetch a single paper from cache or provider
 *   - `listProviders()` — list enabled providers
 *   - `cachePaper(paper)` — persist a paper manually
 *   - `clearCache()` — wipe the cache
 *
 * @module literature-search
 */
import { join } from "path";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;

function cachePath() {
  return join(getDataDir(), "literature-cache.json");
}

async function loadCache() {
  const data = await readJsonPath(cachePath(), { version: STORE_VERSION, papers: {} });
  if (!data.papers || typeof data.papers !== "object") data.papers = {};
  return data;
}

async function saveCache(data) {
  await writeJsonPath(cachePath(), { version: STORE_VERSION, papers: data.papers || {} });
}

/* -------------------------------------------------------------------------- */
/* Providers                                                                  */
/* -------------------------------------------------------------------------- */

const PROVIDERS = {
  arxiv: {
    id: "arxiv",
    name: "arXiv",
    searchUrl: (q) => `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(q)}&max_results=20`,
    parseSearch: (json) => normalizeList(json, "arxiv"),
  },
  pubmed: {
    id: "pubmed",
    name: "PubMed",
    searchUrl: (q) => `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(q)}`,
    parseSearch: (json) => normalizeList(json, "pubmed"),
  },
  semantic_scholar: {
    id: "semantic_scholar",
    name: "Semantic Scholar",
    searchUrl: (q) => `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(q)}&limit=20`,
    parseSearch: (json) => normalizeList(json, "semantic_scholar"),
  },
};

/**
 * Normalize a provider-specific response to our canonical shape.
 * @param {any} json
 * @param {string} provider
 * @returns {Array<object>}
 */
function normalizeList(json, provider) {
  if (!json) return [];
  /** @type {any[]} */
  let rows = [];
  if (Array.isArray(json)) rows = json;
  else if (Array.isArray(json.data)) rows = json.data;
  else if (Array.isArray(json.papers)) rows = json.papers;
  else if (Array.isArray(json.results)) rows = json.results;
  else if (Array.isArray(json.entries)) rows = json.entries;
  return rows.map((r) => ({
    id: String(r.id || r.paperId || r.arxivId || r.pmid || `${provider}:${r.title || Math.random()}`),
    provider,
    title: r.title || "",
    authors: Array.isArray(r.authors) ? r.authors.map((a) => (typeof a === "string" ? a : a.name)) : [],
    abstract: r.abstract || r.summary || "",
    year: Number(r.year) || null,
    url: r.url || r.link || "",
    doi: r.doi || null,
  }));
}

/** @returns {Array<{ id: string, name: string }>} */
export function listProviders() {
  return Object.values(PROVIDERS).map((p) => ({ id: p.id, name: p.name }));
}

/* -------------------------------------------------------------------------- */
/* Search                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} SearchOptions
 * @property {string[]} [providers] Which providers to query. Defaults to all.
 * @property {(url: string) => Promise<any>} [fetch] Injectable fetch.
 * @property {boolean} [useCache] If false, bypass cache.
 */

/**
 * Search the literature across providers.
 *
 * @param {string} query
 * @param {SearchOptions} [opts]
 * @returns {Promise<{ query: string, results: Array<object>, sources: string[] }>}
 */
export async function searchLiterature(query, opts = {}) {
  if (!query || typeof query !== "string") {
    return { query: "", results: [], sources: [] };
  }
  const providerIds = Array.isArray(opts.providers) && opts.providers.length
    ? opts.providers
    : Object.keys(PROVIDERS);
  const fetcher = typeof opts.fetch === "function" ? opts.fetch : null;
  /** @type {Array<object>} */
  const all = [];
  /** @type {string[]} */
  const sources = [];
  for (const pid of providerIds) {
    const p = PROVIDERS[pid];
    if (!p) continue;
    sources.push(pid);
    if (!fetcher) continue;
    try {
      const json = await fetcher(p.searchUrl(query));
      const rows = p.parseSearch(json);
      for (const r of rows) all.push(r);
    } catch (_e) {
      // Provider errors are non-fatal; return whatever we got.
    }
  }
  // Cache any unique results
  if (all.length > 0 && opts.useCache !== false) {
    await withPathLock(cachePath(), async () => {
      const data = await loadCache();
      for (const r of all) {
        if (r.id && !data.papers[r.id]) {
          data.papers[r.id] = { ...r, cachedAt: new Date().toISOString() };
        }
      }
      await saveCache(data);
    });
  }
  return { query, results: all, sources };
}

/* -------------------------------------------------------------------------- */
/* Single-paper retrieval                                                     */
/* -------------------------------------------------------------------------- */

/**
 * @param {string} id
 * @param {SearchOptions} [opts]
 * @returns {Promise<object | null>}
 */
export async function getPaper(id, opts = {}) {
  if (!id) throw new Error("id required");
  if (opts.useCache !== false) {
    const data = await loadCache();
    if (data.papers[id]) return data.papers[id];
  }
  const fetcher = typeof opts.fetch === "function" ? opts.fetch : null;
  if (!fetcher) return null;
  try {
    const json = await fetcher(`https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(id)}`);
    if (!json) return null;
    const normalized = {
      id,
      provider: "semantic_scholar",
      title: json.title || "",
      authors: Array.isArray(json.authors) ? json.authors.map((a) => a.name || a) : [],
      abstract: json.abstract || "",
      year: Number(json.year) || null,
      url: json.url || "",
      doi: json.doi || null,
    };
    await cachePaper(normalized);
    return normalized;
  } catch (_e) {
    return null;
  }
}

/**
 * Manually add a paper to the cache.
 *
 * @param {object} paper
 * @returns {Promise<object>}
 */
export async function cachePaper(paper) {
  if (!paper || typeof paper !== "object") throw new Error("paper required");
  if (!paper.id) throw new Error("paper.id required");
  const path = cachePath();
  return withPathLock(path, async () => {
    const data = await loadCache();
    data.papers[paper.id] = {
      ...paper,
      cachedAt: new Date().toISOString(),
    };
    await saveCache(data);
    return data.papers[paper.id];
  });
}

/** Clear the cache. */
export async function clearCache() {
  const path = cachePath();
  return withPathLock(path, async () => {
    await saveCache({ papers: {} });
    return { cleared: true };
  });
}

/** List cached papers. */
export async function listCached() {
  const data = await loadCache();
  return Object.values(data.papers);
}
