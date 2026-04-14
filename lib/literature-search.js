/**
 * Phase 64.1: Literature search.
 *
 * Unified interface over academic literature sources (arXiv, PubMed,
 * Semantic Scholar). This module does NOT make live HTTP calls — it
 * returns deterministic mock results based on a hash of the query. A
 * live-mode toggle `LITERATURE_SEARCH_LIVE=1` is documented but not
 * wired up (stubs only). The deterministic output is useful for offline
 * dev, reproducible evals, and agent-integration tests.
 *
 * Storage layout:
 *   data/literature-search/{workspaceId}.json
 *     { searches: [{ id, query, sources, resultCount, results, timestamp }] }
 *   data/literature-search/_index.json — known workspaces
 */
import { createHash, randomUUID } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

export const LITERATURE_SOURCES = Object.freeze(["arxiv", "pubmed", "s2"]);

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const MAX_HISTORY = 500;

function sanitizeId(val, fallback = "default") {
  if (typeof val !== "string" || !val.trim()) return fallback;
  return val.trim().replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || fallback;
}

function workspacePath(workspaceId) {
  return join(getDataDir(), "literature-search", `${sanitizeId(workspaceId)}.json`);
}

function indexPath() {
  return join(getDataDir(), "literature-search", "_index.json");
}

async function touchIndex(workspaceId) {
  const ws = sanitizeId(workspaceId);
  return withPathLock(indexPath(), async () => {
    const idx = await readJsonPath(indexPath(), { workspaces: [] });
    const list = Array.isArray(idx.workspaces) ? idx.workspaces : [];
    if (!list.includes(ws)) {
      list.push(ws);
      await writeJsonPath(indexPath(), { workspaces: list });
    }
  });
}

function clampLimit(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.max(1, Math.floor(v)), MAX_LIMIT);
}

function normQuery(q) {
  return typeof q === "string" ? q.trim().toLowerCase() : "";
}

function hashHex(query, source, index) {
  return createHash("sha256")
    .update(`${source}::${query}::${index}`)
    .digest("hex");
}

function hexToNumber(hex, bytes = 4) {
  return parseInt(hex.slice(0, bytes * 2), 16);
}

const TITLE_WORDS = [
  "Scalable", "Robust", "Efficient", "Learning", "Understanding",
  "Probing", "Rethinking", "Beyond", "Toward", "Revisiting",
  "Adaptive", "Self-Supervised", "Interpretable", "Causal", "Federated",
  "Large-Scale", "Generative", "Compositional", "Unified", "Multi-Task",
];

const TOPIC_WORDS = [
  "Transformers", "Graph Networks", "Diffusion Models", "Reinforcement Learning",
  "Language Models", "Vision-Language", "Protein Design", "Drug Discovery",
  "Time Series", "Recommendation", "Anomaly Detection", "Knowledge Graphs",
];

const AUTHOR_SURNAMES = [
  "Nakamura", "Okonkwo", "Patel", "Larsson", "Ferreira", "Kapoor",
  "Rashid", "Silva", "Tanaka", "Mbeki", "Dvořák", "Kovačević",
];

function pickFromHex(hex, arr, offset = 0) {
  return arr[hexToNumber(hex.slice(offset, offset + 8)) % arr.length];
}

function deterministicTitle(query, source, index) {
  const hex = hashHex(query, source, index);
  const a = pickFromHex(hex, TITLE_WORDS, 0);
  const b = pickFromHex(hex, TOPIC_WORDS, 8);
  const q = (query || "general methods").split(/\s+/).slice(0, 3).join(" ");
  return `${a} ${b} for ${q || "General Methods"}`;
}

function deterministicAuthors(query, source, index) {
  const hex = hashHex(query, source, index);
  const n = 2 + (hexToNumber(hex.slice(0, 2)) % 3);
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const name = pickFromHex(hex, AUTHOR_SURNAMES, 4 + i * 6);
    const initial = String.fromCharCode(65 + (hexToNumber(hex.slice(10 + i * 2, 12 + i * 2)) % 26));
    out.push(`${initial}. ${name}`);
  }
  return out;
}

function deterministicYear(query, source, index) {
  const hex = hashHex(query, source, index);
  return 2015 + (hexToNumber(hex.slice(16, 20)) % 11); // 2015..2025
}

function deterministicAbstract(query, source, index) {
  const hex = hashHex(query, source, index);
  const q = query || "the problem";
  const fragments = [
    `We study ${q} in the context of modern ${pickFromHex(hex, TOPIC_WORDS, 0).toLowerCase()}.`,
    `Our approach introduces a novel technique that improves results on standard benchmarks.`,
    `Results show measurable gains over prior work, with ablations confirming the key components.`,
    `We discuss limitations and open directions for future research on ${q}.`,
  ];
  return fragments.join(" ");
}

function deterministicIdForArxiv(query, index) {
  const hex = hashHex(query, "arxiv", index);
  const month = 1 + (hexToNumber(hex.slice(0, 2)) % 12);
  const year = 23 + (hexToNumber(hex.slice(2, 4)) % 3); // 23..25
  const num = (hexToNumber(hex.slice(4, 10)) % 99999).toString().padStart(5, "0");
  return `arxiv:${year}${String(month).padStart(2, "0")}.${num}`;
}

function deterministicIdForPubmed(query, index) {
  const hex = hashHex(query, "pubmed", index);
  const num = (hexToNumber(hex.slice(0, 8)) % 89999999) + 10000000;
  return `pubmed:${num}`;
}

function deterministicIdForS2(query, index) {
  const hex = hashHex(query, "s2", index);
  return `s2:${hex.slice(0, 16)}`;
}

function mkResult({ query, source, index, id, urlPrefix }) {
  return {
    id,
    title: deterministicTitle(query, source, index),
    authors: deterministicAuthors(query, source, index),
    year: deterministicYear(query, source, index),
    abstract: deterministicAbstract(query, source, index),
    source,
    url: `${urlPrefix}${id.split(":").slice(1).join(":")}`,
  };
}

/**
 * arXiv stub search.
 * @param {{ query: string, limit?: number }} input
 */
export async function searchArxiv({ query = "", limit = DEFAULT_LIMIT } = {}) {
  const q = normQuery(query);
  const lim = clampLimit(limit);
  const out = [];
  for (let i = 0; i < lim; i += 1) {
    const id = deterministicIdForArxiv(q, i);
    out.push(mkResult({ query: q, source: "arxiv", index: i, id, urlPrefix: "https://arxiv.org/abs/" }));
  }
  return out;
}

/**
 * PubMed stub search.
 */
export async function searchPubmed({ query = "", limit = DEFAULT_LIMIT } = {}) {
  const q = normQuery(query);
  const lim = clampLimit(limit);
  const out = [];
  for (let i = 0; i < lim; i += 1) {
    const id = deterministicIdForPubmed(q, i);
    out.push(mkResult({ query: q, source: "pubmed", index: i, id, urlPrefix: "https://pubmed.ncbi.nlm.nih.gov/" }));
  }
  return out;
}

/**
 * Semantic Scholar stub search.
 */
export async function searchSemanticScholar({ query = "", limit = DEFAULT_LIMIT } = {}) {
  const q = normQuery(query);
  const lim = clampLimit(limit);
  const out = [];
  for (let i = 0; i < lim; i += 1) {
    const id = deterministicIdForS2(q, i);
    out.push(mkResult({ query: q, source: "s2", index: i, id, urlPrefix: "https://www.semanticscholar.org/paper/" }));
  }
  return out;
}

/**
 * Unified search: interleaves results from requested sources.
 *
 * @param {{ query: string, sources?: string[], limit?: number }} input
 */
export async function unifiedSearch({ query = "", sources, limit = DEFAULT_LIMIT } = {}) {
  const requested = Array.isArray(sources) && sources.length
    ? sources.filter((s) => LITERATURE_SOURCES.includes(s))
    : LITERATURE_SOURCES.slice();
  if (!requested.length) return [];
  const perSource = clampLimit(limit);
  const perBucket = [];
  for (const src of requested) {
    if (src === "arxiv") perBucket.push(await searchArxiv({ query, limit: perSource }));
    else if (src === "pubmed") perBucket.push(await searchPubmed({ query, limit: perSource }));
    else if (src === "s2") perBucket.push(await searchSemanticScholar({ query, limit: perSource }));
  }
  // Interleave round-robin.
  const out = [];
  const max = Math.max(...perBucket.map((b) => b.length));
  for (let i = 0; i < max; i += 1) {
    for (const bucket of perBucket) {
      if (bucket[i]) out.push(bucket[i]);
      if (out.length >= perSource) break;
    }
    if (out.length >= perSource) break;
  }
  return out.slice(0, perSource);
}

/**
 * Persist a search query + results to the workspace history.
 */
export async function recordSearch({ workspaceId, query, results } = {}) {
  const ws = sanitizeId(workspaceId);
  const record = {
    id: randomUUID(),
    query: typeof query === "string" ? query : "",
    sources: Array.isArray(results) ? Array.from(new Set(results.map((r) => r?.source).filter(Boolean))) : [],
    resultCount: Array.isArray(results) ? results.length : 0,
    results: Array.isArray(results) ? results.slice(0, 50) : [],
    timestamp: Date.now(),
  };
  const file = workspacePath(ws);
  await withPathLock(file, async () => {
    const store = await readJsonPath(file, { searches: [] });
    const searches = Array.isArray(store.searches) ? store.searches : [];
    searches.push(record);
    const trimmed = searches.length > MAX_HISTORY ? searches.slice(-MAX_HISTORY) : searches;
    await writeJsonPath(file, { searches: trimmed });
  });
  await touchIndex(ws);
  return record;
}

export async function listSearches(workspaceId) {
  const ws = sanitizeId(workspaceId);
  const store = await readJsonPath(workspacePath(ws), { searches: [] });
  const entries = Array.isArray(store.searches) ? store.searches : [];
  return entries.slice().sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
}

export function listSources() {
  return [
    { id: "arxiv", name: "arXiv", url: "https://arxiv.org", live: process.env.LITERATURE_SEARCH_LIVE === "1" },
    { id: "pubmed", name: "PubMed", url: "https://pubmed.ncbi.nlm.nih.gov", live: process.env.LITERATURE_SEARCH_LIVE === "1" },
    { id: "s2", name: "Semantic Scholar", url: "https://www.semanticscholar.org", live: process.env.LITERATURE_SEARCH_LIVE === "1" },
  ];
}

export async function _reset(workspaceId) {
  if (workspaceId) {
    await writeJsonPath(workspacePath(workspaceId), { searches: [] });
    return;
  }
  const idx = await readJsonPath(indexPath(), { workspaces: [] });
  const list = Array.isArray(idx.workspaces) ? idx.workspaces : [];
  for (const ws of list) {
    await writeJsonPath(workspacePath(ws), { searches: [] });
  }
  await writeJsonPath(indexPath(), { workspaces: [] });
}

export const _internals = { sanitizeId, workspacePath, indexPath };
