// @ts-check
/**
 * Phase 64.2: Paper summarization.
 *
 * Turns an abstract + optional full text into a structured summary:
 * tl;dr, methods, results, limitations. Rule-based sentence extraction
 * with optional LLM callback for polish.
 *
 *   - `summarizePaper(paper, opts)`
 *   - `extractSections(text)` — section-heading splitter
 *   - `rankBySalience(sentences, query?)` — TF-IDF-ish salience
 *   - `getSummary(id)` / `listSummaries()`
 *
 * @module paper-summary
 */
import { join } from "path";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;

function summariesPath() {
  return join(getDataDir(), "paper-summaries.json");
}

async function loadSummaries() {
  const data = await readJsonPath(summariesPath(), { version: STORE_VERSION, summaries: {} });
  if (!data.summaries || typeof data.summaries !== "object") data.summaries = {};
  return data;
}

async function saveSummaries(data) {
  await writeJsonPath(summariesPath(), { version: STORE_VERSION, summaries: data.summaries || {} });
}

/* -------------------------------------------------------------------------- */
/* Sentence splitting                                                         */
/* -------------------------------------------------------------------------- */

/**
 * @param {string} text
 * @returns {string[]}
 */
export function splitSentences(text) {
  if (typeof text !== "string") return [];
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z0-9])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Extract conventional paper sections by detecting headings.
 *
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function extractSections(text) {
  if (typeof text !== "string" || !text) return {};
  const headings = ["abstract", "introduction", "methods", "method", "results", "discussion", "conclusion", "limitations", "related work", "experiments"];
  const lines = text.split(/\r?\n/);
  /** @type {Record<string, string[]>} */
  const buckets = {};
  let current = "abstract";
  for (const line of lines) {
    const lower = line.trim().toLowerCase();
    const m = headings.find((h) => lower === h || lower === `${h}:` || lower.startsWith(`${h} `) && lower.length < h.length + 10);
    if (m) {
      current = m.replace("method", "methods");
      if (!buckets[current]) buckets[current] = [];
      continue;
    }
    if (!buckets[current]) buckets[current] = [];
    buckets[current].push(line);
  }
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of Object.entries(buckets)) {
    out[k] = v.join(" ").trim();
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Salience ranking                                                           */
/* -------------------------------------------------------------------------- */

const STOPWORDS = new Set([
  "a", "an", "the", "of", "in", "on", "and", "or", "to", "is", "are", "was",
  "were", "for", "as", "at", "be", "this", "that", "it", "with", "by", "we",
  "our", "which", "these", "those", "from", "into", "such", "any", "all",
]);

function tokenize(text) {
  if (text == null) return [];
  return String(text).toLowerCase().replace(/[^a-z0-9_]+/g, " ").split(/\s+/).filter((t) => t && !STOPWORDS.has(t));
}

/**
 * Rank sentences by a TF-IDF-ish salience score.
 *
 * @param {string[]} sentences
 * @param {string} [query]
 * @returns {Array<{ text: string, score: number }>}
 */
export function rankBySalience(sentences, query = "") {
  if (!Array.isArray(sentences) || sentences.length === 0) return [];
  /** @type {Record<string, number>} */
  const df = {};
  const tokenized = sentences.map((s) => tokenize(s));
  for (const toks of tokenized) {
    const seen = new Set();
    for (const t of toks) {
      if (seen.has(t)) continue;
      seen.add(t);
      df[t] = (df[t] || 0) + 1;
    }
  }
  const N = sentences.length;
  const qTokens = tokenize(query);
  const out = sentences.map((s, i) => {
    const toks = tokenized[i];
    const len = toks.length || 1;
    /** @type {Record<string, number>} */
    const tf = {};
    for (const t of toks) tf[t] = (tf[t] || 0) + 1;
    let score = 0;
    for (const [t, count] of Object.entries(tf)) {
      const idf = Math.log((N + 1) / ((df[t] || 0) + 1)) + 1;
      score += (count / len) * idf;
    }
    if (qTokens.length > 0) {
      let hit = 0;
      for (const q of qTokens) if (tf[q]) hit += 1;
      score += hit * 0.5;
    }
    return { text: s, score: Math.round(score * 10000) / 10000 };
  });
  out.sort((a, b) => b.score - a.score);
  return out;
}

/* -------------------------------------------------------------------------- */
/* Summarization                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Produce a structured summary from a paper-like object.
 *
 * @param {object} paper
 * @param {object} [opts]
 * @returns {Promise<object>}
 */
export async function summarizePaper(paper, opts = {}) {
  if (!paper || typeof paper !== "object") throw new Error("paper required");
  const text = paper.abstract || paper.text || "";
  if (!text) throw new Error("paper.abstract or paper.text required");
  const sections = extractSections(text);
  const sentences = splitSentences(text);
  const ranked = rankBySalience(sentences);
  const tldr = ranked.slice(0, 2).map((r) => r.text).join(" ");
  const methods = sections.methods
    ? splitSentences(sections.methods).slice(0, 3).join(" ")
    : pickContaining(sentences, ["method", "approach", "propose"]) || "";
  const results = sections.results
    ? splitSentences(sections.results).slice(0, 3).join(" ")
    : pickContaining(sentences, ["result", "achieve", "improv", "accuracy"]) || "";
  const limitations = sections.limitations
    ? splitSentences(sections.limitations).slice(0, 2).join(" ")
    : pickContaining(sentences, ["limit", "future work", "however"]) || "";
  let summary = {
    id: paper.id || `sum_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    paperId: paper.id || null,
    title: paper.title || "",
    tldr,
    methods,
    results,
    limitations,
    polished: false,
    createdAt: new Date().toISOString(),
  };
  if (typeof opts.llm === "function") {
    try {
      const polishedTldr = await opts.llm(tldr);
      if (polishedTldr && typeof polishedTldr === "string") {
        summary.tldr = polishedTldr;
        summary.polished = true;
      }
    } catch (_e) {
      // LLM polish is best-effort.
    }
  }
  await withPathLock(summariesPath(), async () => {
    const data = await loadSummaries();
    data.summaries[summary.id] = summary;
    await saveSummaries(data);
  });
  return summary;
}

/**
 * Pick the first sentence that contains any of the hint words.
 * @param {string[]} sentences
 * @param {string[]} hints
 * @returns {string}
 */
function pickContaining(sentences, hints) {
  for (const s of sentences) {
    const lower = s.toLowerCase();
    if (hints.some((h) => lower.includes(h))) return s;
  }
  return "";
}

/**
 * Fetch a persisted summary by id.
 * @param {string} id
 * @returns {Promise<object | null>}
 */
export async function getSummary(id) {
  if (!id) return null;
  const data = await loadSummaries();
  return data.summaries[id] || null;
}

/** List all persisted summaries. */
export async function listSummaries() {
  const data = await loadSummaries();
  return Object.values(data.summaries);
}
