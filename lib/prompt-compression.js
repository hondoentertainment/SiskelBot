// @ts-check
/**
 * Phase 58.3: Prompt compression.
 *
 * LLMLingua-style token reduction. Given an input prompt, produce a
 * shorter representation that preserves meaning and can be partially
 * reconstructed. The algorithm is pure JS, no external models:
 *
 *   1. Sentence-split on . ! ? and newlines.
 *   2. Remove English stopwords and punctuation from each sentence.
 *   3. Dedupe 2-gram and 3-gram phrases so repetitive content gets
 *      collapsed.
 *   4. Rank sentences with TF-IDF over the remaining vocabulary and
 *      keep the top `ratio` (default 0.5) by score.
 *   5. Re-emit the surviving sentences in original order.
 *
 * A minimal reverse-map (`_map`) is returned so `decompressPrompt`
 * can re-hydrate skipped sentences with placeholders ("[...]") for
 * observability.
 *
 * The module exposes:
 *   - `compressPrompt(text, opts)`
 *   - `decompressPrompt(compressed)`
 *   - `computeCompressionRatio(original, compressed)`
 *   - `rankSentences(text)`
 *
 * @module prompt-compression
 */
import { join } from "path";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;

function historyPath() {
  return join(getDataDir(), "prompt-compression-history.json");
}

/* -------------------------------------------------------------------------- */
/* Shared primitives                                                          */
/* -------------------------------------------------------------------------- */

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

function tokenize(text) {
  if (text == null) return [];
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function stripStopwords(tokens, stopwords = DEFAULT_STOPWORDS) {
  return tokens.filter((t) => !stopwords.has(t) && t.length > 1);
}

function splitSentences(text) {
  if (!text || typeof text !== "string") return [];
  const parts = text
    .split(/(?<=[.!?])\s+|\n+/g)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts;
}

function computeTf(tokens) {
  const tf = {};
  for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
  return tf;
}

function computeIdf(docs) {
  const N = docs.length;
  const df = {};
  for (const doc of docs) {
    const seen = new Set();
    for (const t of doc) {
      if (seen.has(t)) continue;
      seen.add(t);
      df[t] = (df[t] || 0) + 1;
    }
  }
  const idf = {};
  for (const [term, freq] of Object.entries(df)) {
    idf[term] = Math.log((N + 1) / (freq + 1)) + 1;
  }
  return idf;
}

function ngrams(tokens, n) {
  const out = [];
  for (let i = 0; i + n <= tokens.length; i += 1) {
    out.push(tokens.slice(i, i + n).join(" "));
  }
  return out;
}

/**
 * Drop repeated 2-grams and 3-grams from a token list, keeping only
 * the first occurrence. Used to collapse boilerplate repetition.
 *
 * @param {string[]} tokens
 * @returns {string[]}
 */
export function dedupeNgrams(tokens) {
  if (!Array.isArray(tokens) || tokens.length < 2) return tokens || [];
  const seen2 = new Set();
  const seen3 = new Set();
  const keep = new Array(tokens.length).fill(true);

  for (let i = 0; i + 1 < tokens.length; i += 1) {
    const g = `${tokens[i]} ${tokens[i + 1]}`;
    if (seen2.has(g)) {
      keep[i + 1] = false;
    } else {
      seen2.add(g);
    }
  }
  for (let i = 0; i + 2 < tokens.length; i += 1) {
    const g = `${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}`;
    if (seen3.has(g)) {
      keep[i + 2] = false;
    } else {
      seen3.add(g);
    }
  }
  const out = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (keep[i]) out.push(tokens[i]);
  }
  // Also guarantee ngrams is referenced so the helper stays available.
  void ngrams;
  return out;
}

/* -------------------------------------------------------------------------- */
/* Ranking                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Rank sentences in a text by their TF-IDF informativeness score.
 *
 * @param {string} text
 * @param {{ stopwords?: Set<string> }} [opts]
 * @returns {Array<{ index: number, sentence: string, score: number, tokens: string[] }>}
 */
export function rankSentences(text, opts = {}) {
  const stopwords = opts.stopwords instanceof Set ? opts.stopwords : DEFAULT_STOPWORDS;
  const sentences = splitSentences(text);
  if (sentences.length === 0) return [];
  const docs = sentences.map((s) => stripStopwords(tokenize(s), stopwords));
  const idf = computeIdf(docs);
  const ranked = sentences.map((sentence, index) => {
    const tokens = docs[index];
    const tf = computeTf(tokens);
    let score = 0;
    for (const [term, freq] of Object.entries(tf)) {
      score += (freq / Math.max(1, tokens.length)) * Math.pow(idf[term] || 1, 2);
    }
    return {
      index,
      sentence,
      tokens,
      score: Math.round(score * 10000) / 10000,
    };
  });
  ranked.sort((a, b) => b.score - a.score);
  return ranked;
}

/* -------------------------------------------------------------------------- */
/* Compress / decompress                                                      */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} CompressedPrompt
 * @property {number} version
 * @property {string} text           The compressed prompt.
 * @property {number} originalLength Original character length.
 * @property {number} compressedLength Compressed character length.
 * @property {number} ratio          originalLength / compressedLength (1 = no change).
 * @property {Array<{ index: number, kept: boolean, preview: string }>} _map
 * @property {string} createdAt
 */

/**
 * Compress a prompt by keeping only the top `ratio` sentences by
 * TF-IDF score and running stopword / n-gram dedup on the survivors.
 *
 * @param {string} text
 * @param {{ ratio?: number, minSentences?: number, stopwords?: Set<string>, persist?: boolean, label?: string }} [opts]
 * @returns {Promise<CompressedPrompt>}
 */
export async function compressPrompt(text, opts = {}) {
  const ratio = Number.isFinite(opts.ratio) && opts.ratio > 0 && opts.ratio <= 1
    ? Number(opts.ratio)
    : 0.5;
  const minSentences = Number.isFinite(opts.minSentences) && opts.minSentences > 0
    ? Math.floor(opts.minSentences)
    : 1;
  const input = typeof text === "string" ? text : "";
  const originalLength = input.length;

  const sentences = splitSentences(input);
  if (sentences.length === 0) {
    return {
      version: STORE_VERSION,
      text: "",
      originalLength,
      compressedLength: 0,
      ratio: 1,
      _map: [],
      createdAt: new Date().toISOString(),
    };
  }

  const ranked = rankSentences(input, { stopwords: opts.stopwords });
  const keepCount = Math.max(minSentences, Math.ceil(sentences.length * ratio));
  const keptIndices = new Set(
    ranked.slice(0, keepCount).map((r) => r.index),
  );

  // Re-emit surviving sentences in original order, with stopwords removed
  // and n-grams deduped inline.
  const outParts = [];
  /** @type {Array<{ index: number, kept: boolean, preview: string }>} */
  const map = [];
  for (let i = 0; i < sentences.length; i += 1) {
    const sentence = sentences[i];
    const kept = keptIndices.has(i);
    map.push({
      index: i,
      kept,
      preview: sentence.slice(0, 40),
    });
    if (!kept) continue;
    const toks = stripStopwords(tokenize(sentence), opts.stopwords || DEFAULT_STOPWORDS);
    const deduped = dedupeNgrams(toks);
    if (deduped.length > 0) outParts.push(deduped.join(" "));
  }
  const compressed = outParts.join(". ");
  const compressedLength = compressed.length;
  const compressionRatio = computeCompressionRatio(originalLength, compressedLength);
  const record = {
    version: STORE_VERSION,
    text: compressed,
    originalLength,
    compressedLength,
    ratio: compressionRatio,
    _map: map,
    createdAt: new Date().toISOString(),
  };

  if (opts.persist) {
    await persistHistory(opts.label || "unlabeled", record);
  }

  return record;
}

/**
 * Rehydrate a compressed prompt. Since we only keep previews of the
 * dropped sentences, decompression produces "[preview...]" placeholders
 * for missing content. Still useful for audit / traceability.
 *
 * @param {CompressedPrompt} compressed
 * @returns {string}
 */
export function decompressPrompt(compressed) {
  if (!compressed || typeof compressed !== "object") return "";
  if (!Array.isArray(compressed._map)) return String(compressed.text || "");
  const keptText = String(compressed.text || "");
  // Split the compressed body back into per-sentence chunks so we can
  // interleave with dropped placeholders in the correct order.
  const keptSentences = keptText.split(/\.\s+/).filter(Boolean);
  const out = [];
  let kIdx = 0;
  for (const entry of compressed._map) {
    if (entry.kept) {
      out.push(keptSentences[kIdx] || entry.preview);
      kIdx += 1;
    } else {
      out.push(`[...${entry.preview}]`);
    }
  }
  return out.join(". ");
}

/**
 * Compute a compression ratio from character lengths. Returns 1 when
 * nothing changes, >1 when compression shrinks the text.
 *
 * @param {number | string} original
 * @param {number | string} compressed
 * @returns {number}
 */
export function computeCompressionRatio(original, compressed) {
  const o = typeof original === "string" ? original.length : Number(original) || 0;
  const c = typeof compressed === "string" ? compressed.length : Number(compressed) || 0;
  if (c === 0 && o === 0) return 1;
  if (c === 0) return Infinity;
  return Math.round((o / c) * 10000) / 10000;
}

/* -------------------------------------------------------------------------- */
/* History persistence                                                        */
/* -------------------------------------------------------------------------- */

async function persistHistory(label, record) {
  const path = historyPath();
  await withPathLock(path, async () => {
    const data = await readJsonPath(path, { version: STORE_VERSION, entries: [] });
    if (!Array.isArray(data.entries)) data.entries = [];
    data.entries.push({ label, ...record });
    if (data.entries.length > 500) {
      data.entries = data.entries.slice(-500);
    }
    await writeJsonPath(path, {
      version: STORE_VERSION,
      entries: data.entries,
      updatedAt: new Date().toISOString(),
    });
  });
}

/** Read the persisted compression history. */
export async function listCompressionHistory() {
  const data = await readJsonPath(historyPath(), { version: STORE_VERSION, entries: [] });
  return Array.isArray(data.entries) ? data.entries : [];
}
