/**
 * Phase 67.2: Copyright similarity — text/code overlap against user-provided corpora.
 *
 * IMPORTANT: this module does NOT ship any content. Callers index their own
 * corpus of licensed or owned material, then query candidate text/code to
 * detect likely copies.
 *
 * Approach:
 *   - Tokenize to word shingles of length K (default 7).
 *   - Weight shingles by inverse document frequency across the corpus.
 *   - Compute cosine similarity between the query's TF-IDF vector and each
 *     corpus entry's TF-IDF vector, falling back to Jaccard for resilience.
 *
 * Storage:
 *   data/copyright-similarity/{corpusId}.json   — corpus record (entries + IDF)
 *   data/copyright-similarity/_index.json       — registry
 */
import { randomUUID, createHash } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const DEFAULT_SHINGLE_SIZE = 7;

function sanitize(value) {
  return String(value || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || "default";
}

function corpusPath(id) {
  return join(getDataDir(), "copyright-similarity", `${sanitize(id)}.json`);
}

function indexPath() {
  return join(getDataDir(), "copyright-similarity", "_index.json");
}

async function updateIndex(id, remove = false, entry = null) {
  return withPathLock(indexPath(), async () => {
    const idx = await readJsonPath(indexPath(), { corpora: [] });
    const list = Array.isArray(idx.corpora) ? idx.corpora : [];
    const filtered = list.filter((e) => e.id !== id);
    if (!remove && entry) filtered.push(entry);
    await writeJsonPath(indexPath(), { corpora: filtered });
  });
}

// ─── Tokenization + shingles ───────────────────────────────────────────────

export function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

export function shingles(text, size = DEFAULT_SHINGLE_SIZE) {
  const tokens = tokenize(text);
  if (tokens.length < size) {
    // For short inputs, produce a single shingle of whatever we have.
    return tokens.length > 0 ? [tokens.join(" ")] : [];
  }
  const out = [];
  for (let i = 0; i <= tokens.length - size; i += 1) {
    out.push(tokens.slice(i, i + size).join(" "));
  }
  return out;
}

function shingleHash(shingle) {
  // Short fingerprints reduce storage; sha1 prefix is sufficient for similarity.
  return createHash("sha1").update(shingle).digest("hex").slice(0, 16);
}

function shingleCounts(text, size) {
  const arr = shingles(text, size);
  const counts = Object.create(null);
  for (const s of arr) {
    const h = shingleHash(s);
    counts[h] = (counts[h] || 0) + 1;
  }
  return { counts, total: arr.length };
}

// ─── TF-IDF ─────────────────────────────────────────────────────────────────

function computeIdf(entries) {
  const df = Object.create(null);
  const N = entries.length;
  for (const e of entries) {
    for (const h of Object.keys(e.counts || {})) {
      df[h] = (df[h] || 0) + 1;
    }
  }
  const idf = Object.create(null);
  for (const [h, d] of Object.entries(df)) {
    idf[h] = Math.log((1 + N) / (1 + d)) + 1; // smoothed IDF
  }
  return idf;
}

function tfidfVector(counts, idf) {
  const vec = Object.create(null);
  for (const [h, c] of Object.entries(counts)) {
    const w = idf[h];
    if (w == null || w === 0) continue;
    vec[h] = c * w;
  }
  return vec;
}

function cosine(a, b) {
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  for (const [k, v] of Object.entries(a)) {
    aNorm += v * v;
    if (b[k] != null) dot += v * b[k];
  }
  for (const v of Object.values(b)) {
    bNorm += v * v;
  }
  if (aNorm === 0 || bNorm === 0) return 0;
  return dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm));
}

function jaccard(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  if (keys.size === 0) return 0;
  let inter = 0;
  let union = 0;
  for (const k of keys) {
    const x = a[k] ? 1 : 0;
    const y = b[k] ? 1 : 0;
    if (x || y) union += 1;
    if (x && y) inter += 1;
  }
  if (union === 0) return 0;
  return inter / union;
}

// ─── CRUD ───────────────────────────────────────────────────────────────────

/**
 * Index a corpus of user-provided works.
 *
 * @param {object} opts
 * @param {string} opts.name
 * @param {Array<{id?,title,text}>} opts.items — caller-supplied content
 * @param {number} [opts.shingleSize]
 */
export async function indexCorpus({ name, items, shingleSize, description } = {}) {
  if (!name || typeof name !== "string") {
    throw new Error("name is required");
  }
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("items array is required");
  }
  const size = Math.max(2, Math.min(20, Number(shingleSize) || DEFAULT_SHINGLE_SIZE));
  const id = randomUUID();
  const now = new Date().toISOString();
  const entries = items.map((item, i) => {
    if (!item || typeof item !== "object") throw new Error(`items[${i}] must be an object`);
    if (typeof item.text !== "string" || item.text.trim().length === 0) {
      throw new Error(`items[${i}].text must be a non-empty string`);
    }
    const { counts, total } = shingleCounts(item.text, size);
    return {
      id: item.id || randomUUID(),
      title: item.title || `item-${i}`,
      counts,
      totalShingles: total,
    };
  });
  const idf = computeIdf(entries);
  const record = {
    id,
    name,
    description: description || "",
    shingleSize: size,
    createdAt: now,
    updatedAt: now,
    entries,
    idf,
  };
  await writeJsonPath(corpusPath(id), record);
  await updateIndex(id, false, { id, name, createdAt: now, entries: entries.length });
  return { id, name, entries: entries.length, shingleSize: size, createdAt: now };
}

async function loadCorpus(id) {
  const rec = await readJsonPath(corpusPath(id), null);
  if (!rec || !rec.id || rec._deleted) return null;
  return rec;
}

export async function getCorpus(id) {
  const rec = await loadCorpus(id);
  if (!rec) return null;
  // Summarize without exposing the full shingle counts externally.
  return {
    id: rec.id,
    name: rec.name,
    description: rec.description,
    shingleSize: rec.shingleSize,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    entries: rec.entries.map((e) => ({ id: e.id, title: e.title, totalShingles: e.totalShingles })),
  };
}

export async function listCorpora() {
  const idx = await readJsonPath(indexPath(), { corpora: [] });
  const entries = Array.isArray(idx.corpora) ? idx.corpora : [];
  const records = [];
  for (const entry of entries) {
    const sum = await getCorpus(entry.id);
    if (sum) records.push(sum);
  }
  return records;
}

export async function deleteCorpus(id) {
  const rec = await loadCorpus(id);
  if (!rec) return { ok: false, code: "NOT_FOUND" };
  await writeJsonPath(corpusPath(id), { _deleted: true });
  await updateIndex(id, true);
  return { ok: true };
}

// ─── Query ──────────────────────────────────────────────────────────────────

/**
 * Find similar entries in a corpus. Returns results ranked by cosine similarity.
 */
export async function findSimilar(corpusId, { text, minScore = 0.2, limit = 10 } = {}) {
  if (!text || typeof text !== "string") {
    throw new Error("text is required");
  }
  const rec = await loadCorpus(corpusId);
  if (!rec) {
    const err = new Error(`corpus ${corpusId} not found`);
    err.code = "NOT_FOUND";
    throw err;
  }
  const { counts: qCounts } = shingleCounts(text, rec.shingleSize);
  if (Object.keys(qCounts).length === 0) {
    return { corpusId, query: { shingleHashes: 0 }, results: [] };
  }
  const qVec = tfidfVector(qCounts, rec.idf);
  const results = [];
  for (const entry of rec.entries) {
    const eVec = tfidfVector(entry.counts, rec.idf);
    const score = cosine(qVec, eVec);
    const overlap = jaccard(qCounts, entry.counts);
    if (score >= minScore || overlap >= minScore) {
      results.push({
        entryId: entry.id,
        title: entry.title,
        score,
        jaccard: overlap,
        totalShingles: entry.totalShingles,
      });
    }
  }
  results.sort((a, b) => b.score - a.score);
  return {
    corpusId: rec.id,
    corpusName: rec.name,
    query: { shingleHashes: Object.keys(qCounts).length },
    results: results.slice(0, Math.max(1, Number(limit) || 10)),
  };
}

export const _internals = { corpusPath, indexPath, cosine, jaccard, tfidfVector, computeIdf };
