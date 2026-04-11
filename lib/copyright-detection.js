// @ts-check
/**
 * Phase 67.2: Copyright similarity detection.
 *
 * Stores a small corpus of reference texts (or code) per corpus id and
 * measures Jaccard similarity between query text and any stored entry
 * via word n-gram shingles. Exceeding a threshold flags a match.
 *
 * This is NOT a replacement for a real plagiarism service — it is a
 * lightweight scaffolding layer for the SiskelBot copyright guardrail.
 *
 * Exports:
 *   - addCorpus
 *   - checkSimilarity
 *   - listCorpora
 *   - getMatches
 *   - removeCorpus
 *   - shingles (helper)
 *   - jaccard (helper)
 *
 * @module copyright-detection
 */
import { join } from "path";
import { randomBytes } from "crypto";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;
const DEFAULT_NGRAM = 5;
const DEFAULT_THRESHOLD = 0.4;

function storePath() {
  return join(getDataDir(), "copyright-detection.json");
}

function newId() {
  return `cp_${randomBytes(8).toString("hex")}`;
}

function nowIso() {
  return new Date().toISOString();
}

async function loadStore() {
  const data = await readJsonPath(storePath(), {
    version: STORE_VERSION,
    corpora: {},
    matches: [],
  });
  if (!data.corpora || typeof data.corpora !== "object") data.corpora = {};
  if (!Array.isArray(data.matches)) data.matches = [];
  return data;
}

async function saveStore(data) {
  await writeJsonPath(storePath(), {
    version: STORE_VERSION,
    corpora: data.corpora || {},
    matches: data.matches || [],
  });
}

/**
 * Tokenize text into simple lowercase word tokens (punctuation removed).
 * @param {string} text
 */
function tokens(text) {
  if (!text) return [];
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Compute word n-gram shingles as a Set of joined strings.
 *
 * @param {string} text
 * @param {number} [n=5]
 * @returns {Set<string>}
 */
export function shingles(text, n = DEFAULT_NGRAM) {
  const ngram = Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_NGRAM;
  const toks = tokens(text);
  const out = new Set();
  if (toks.length < ngram) {
    // Fall back to single tokens for very short inputs.
    for (const t of toks) out.add(t);
    return out;
  }
  for (let i = 0; i <= toks.length - ngram; i++) {
    out.add(toks.slice(i, i + ngram).join(" "));
  }
  return out;
}

/**
 * Jaccard similarity between two Sets.
 *
 * @param {Set<string>} a
 * @param {Set<string>} b
 * @returns {number}
 */
export function jaccard(a, b) {
  if (!a || !b) return 0;
  if (a.size === 0 && b.size === 0) return 0;
  let intersect = 0;
  for (const x of a) {
    if (b.has(x)) intersect += 1;
  }
  const union = a.size + b.size - intersect;
  if (union === 0) return 0;
  return intersect / union;
}

/**
 * Add a text to a corpus. Returns the stored entry.
 *
 * @param {{corpusId: string, title: string, text: string, ngram?: number, metadata?: object}} payload
 * @returns {Promise<object>}
 */
export async function addCorpus(payload) {
  if (!payload || typeof payload !== "object") throw new Error("payload required");
  if (!payload.corpusId) throw new Error("corpusId required");
  if (!payload.title) throw new Error("title required");
  if (typeof payload.text !== "string" || !payload.text.trim()) {
    throw new Error("text required");
  }
  const ngram = Number.isFinite(payload.ngram) && payload.ngram > 0 ? Math.floor(payload.ngram) : DEFAULT_NGRAM;
  const shingleSet = shingles(payload.text, ngram);

  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    if (!data.corpora[payload.corpusId]) {
      data.corpora[payload.corpusId] = {
        id: payload.corpusId,
        entries: {},
        createdAt: nowIso(),
      };
    }
    const id = newId();
    const ts = nowIso();
    const record = {
      id,
      corpusId: String(payload.corpusId),
      title: String(payload.title),
      ngram,
      shingles: [...shingleSet],
      metadata: payload.metadata && typeof payload.metadata === "object" ? { ...payload.metadata } : {},
      addedAt: ts,
    };
    data.corpora[payload.corpusId].entries[id] = record;
    await saveStore(data);
    // Don't echo shingles back to caller — they can be large.
    return {
      id,
      corpusId: record.corpusId,
      title: record.title,
      ngram,
      addedAt: ts,
      shingleCount: record.shingles.length,
    };
  });
}

/**
 * Compare query text against all entries (optionally in a single corpus)
 * and return matches above the threshold.
 *
 * @param {{text: string, corpusId?: string, threshold?: number, ngram?: number, persist?: boolean}} payload
 * @returns {Promise<{matches: Array<{id: string, corpusId: string, title: string, score: number}>, threshold: number}>}
 */
export async function checkSimilarity(payload) {
  if (!payload || typeof payload !== "object") throw new Error("payload required");
  if (typeof payload.text !== "string" || !payload.text.trim()) {
    throw new Error("text required");
  }
  const ngram = Number.isFinite(payload.ngram) && payload.ngram > 0 ? Math.floor(payload.ngram) : DEFAULT_NGRAM;
  const threshold = Number.isFinite(payload.threshold) ? payload.threshold : DEFAULT_THRESHOLD;
  const querySet = shingles(payload.text, ngram);

  const data = await loadStore();
  const corpora = payload.corpusId
    ? [data.corpora[payload.corpusId]].filter(Boolean)
    : Object.values(data.corpora || {});

  const matches = [];
  for (const c of corpora) {
    for (const entry of Object.values(c.entries || {})) {
      const entrySet = new Set(entry.shingles || []);
      const score = jaccard(querySet, entrySet);
      if (score >= threshold) {
        matches.push({
          id: entry.id,
          corpusId: entry.corpusId,
          title: entry.title,
          score: Math.round(score * 10000) / 10000,
        });
      }
    }
  }
  matches.sort((a, b) => b.score - a.score);

  if (payload.persist && matches.length > 0) {
    const path = storePath();
    await withPathLock(path, async () => {
      const fresh = await loadStore();
      fresh.matches.push({
        at: nowIso(),
        threshold,
        matches,
      });
      if (fresh.matches.length > 500) {
        fresh.matches = fresh.matches.slice(-500);
      }
      await saveStore(fresh);
    });
  }

  return { matches, threshold };
}

/**
 * List all corpora (entry counts only).
 *
 * @returns {Promise<Array<{id: string, entries: number, createdAt: string}>>}
 */
export async function listCorpora() {
  const data = await loadStore();
  return Object.values(data.corpora || {}).map((c) => ({
    id: c.id,
    entries: Object.keys(c.entries || {}).length,
    createdAt: c.createdAt,
  }));
}

/**
 * Retrieve previously persisted matches, newest first.
 *
 * @param {{limit?: number}} [filter]
 * @returns {Promise<object[]>}
 */
export async function getMatches(filter = {}) {
  const data = await loadStore();
  let all = [...(data.matches || [])];
  all.reverse();
  const limit = Number.isFinite(filter.limit) && filter.limit > 0 ? Math.floor(filter.limit) : 100;
  return all.slice(0, limit);
}

/**
 * Remove an entire corpus or a single entry from one.
 *
 * @param {{corpusId: string, entryId?: string}} payload
 * @returns {Promise<boolean>}
 */
export async function removeCorpus(payload) {
  if (!payload || typeof payload !== "object") throw new Error("payload required");
  if (!payload.corpusId) throw new Error("corpusId required");
  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    const c = data.corpora[payload.corpusId];
    if (!c) return false;
    if (payload.entryId) {
      if (!c.entries[payload.entryId]) return false;
      delete c.entries[payload.entryId];
    } else {
      delete data.corpora[payload.corpusId];
    }
    await saveStore(data);
    return true;
  });
}
