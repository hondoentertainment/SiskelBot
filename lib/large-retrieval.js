/**
 * Phase 68.2: Large-scale retrieval — document index with semantic search.
 *
 * Approach:
 *   - Documents are split into fixed-size chunks of tokens.
 *   - If OpenAI embeddings are available (OPENAI_API_KEY set), each chunk is
 *     embedded via lib/embeddings.js; otherwise we fall back to a deterministic
 *     hash-based feature vector so tests and dev setups work without network.
 *   - Chunks are grouped into IVF-style clusters using k-means-lite centroids.
 *     Search computes cosine against centroids, then scans the top clusters.
 *
 * Storage:
 *   data/large-retrieval/indexes/{id}.json   — index record (chunks + centroids)
 *   data/large-retrieval/_index.json         — registry
 */
import { randomUUID, createHash } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";
import { embedBatch, isAvailable as embeddingsAvailable } from "./embeddings.js";

const DEFAULT_CHUNK_TOKENS = 200;
const DEFAULT_CLUSTER_COUNT = 8;
const FALLBACK_DIMS = 64;

function sanitize(value) {
  return String(value || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || "default";
}

function indexFilePath(id) {
  return join(getDataDir(), "large-retrieval", "indexes", `${sanitize(id)}.json`);
}

function registryPath() {
  return join(getDataDir(), "large-retrieval", "_index.json");
}

async function updateRegistry(updater) {
  return withPathLock(registryPath(), async () => {
    const idx = await readJsonPath(registryPath(), { indexes: [] });
    idx.indexes = Array.isArray(idx.indexes) ? idx.indexes : [];
    await updater(idx);
    await writeJsonPath(registryPath(), idx);
  });
}

// ─── Chunking ──────────────────────────────────────────────────────────────

export function chunkText(text, chunkTokens = DEFAULT_CHUNK_TOKENS) {
  const tokens = String(text || "").split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  const chunks = [];
  for (let i = 0; i < tokens.length; i += chunkTokens) {
    chunks.push(tokens.slice(i, i + chunkTokens).join(" "));
  }
  return chunks;
}

// ─── Fallback embeddings ───────────────────────────────────────────────────

function deterministicVector(text, dims = FALLBACK_DIMS) {
  const tokens = String(text || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const vec = new Array(dims).fill(0);
  for (const tok of tokens) {
    const hash = createHash("sha256").update(tok).digest();
    for (let i = 0; i < 4; i += 1) {
      const idx = hash[i] % dims;
      const sign = (hash[i + 4] & 1) === 0 ? 1 : -1;
      vec[idx] += sign;
    }
  }
  // L2 normalize.
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  return vec.map((v) => v / norm);
}

async function computeVectors(texts) {
  if (embeddingsAvailable()) {
    try {
      const vecs = await embedBatch(texts);
      if (Array.isArray(vecs) && vecs.length === texts.length && vecs.every(Array.isArray)) {
        return { vectors: vecs, source: "openai" };
      }
    } catch {
      /* fall through */
    }
  }
  return { vectors: texts.map((t) => deterministicVector(t)), source: "fallback" };
}

// ─── Vector math ───────────────────────────────────────────────────────────

function cosine(a, b) {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let an = 0;
  let bn = 0;
  for (let i = 0; i < n; i += 1) {
    dot += a[i] * b[i];
    an += a[i] * a[i];
    bn += b[i] * b[i];
  }
  if (an === 0 || bn === 0) return 0;
  return dot / (Math.sqrt(an) * Math.sqrt(bn));
}

function meanVector(vectors) {
  if (vectors.length === 0) return [];
  const dims = vectors[0].length;
  const out = new Array(dims).fill(0);
  for (const v of vectors) {
    for (let i = 0; i < dims; i += 1) out[i] += v[i] || 0;
  }
  for (let i = 0; i < dims; i += 1) out[i] /= vectors.length;
  let norm = 0;
  for (const v of out) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  return out.map((v) => v / norm);
}

// Very small k-means; bounded iterations for test speed.
function kmeans(vectors, k, maxIter = 10) {
  if (vectors.length === 0 || k <= 0) return { centroids: [], assignments: [] };
  const actualK = Math.min(k, vectors.length);
  // Initialize: take evenly spaced indices.
  let centroids = [];
  const step = Math.max(1, Math.floor(vectors.length / actualK));
  for (let i = 0; i < actualK; i += 1) {
    centroids.push(vectors[Math.min(vectors.length - 1, i * step)].slice());
  }
  let assignments = new Array(vectors.length).fill(0);
  for (let iter = 0; iter < maxIter; iter += 1) {
    let changed = false;
    for (let i = 0; i < vectors.length; i += 1) {
      let best = 0;
      let bestSim = -Infinity;
      for (let c = 0; c < centroids.length; c += 1) {
        const sim = cosine(vectors[i], centroids[c]);
        if (sim > bestSim) {
          bestSim = sim;
          best = c;
        }
      }
      if (assignments[i] !== best) {
        assignments[i] = best;
        changed = true;
      }
    }
    const buckets = new Array(centroids.length).fill(0).map(() => []);
    for (let i = 0; i < vectors.length; i += 1) {
      buckets[assignments[i]].push(vectors[i]);
    }
    for (let c = 0; c < centroids.length; c += 1) {
      if (buckets[c].length > 0) centroids[c] = meanVector(buckets[c]);
    }
    if (!changed) break;
  }
  return { centroids, assignments };
}

// ─── CRUD / indexing ───────────────────────────────────────────────────────

async function loadOrCreateIndex(indexId, opts) {
  let rec = await readJsonPath(indexFilePath(indexId), null);
  if (rec && rec.id && !rec._deleted) return rec;
  const now = new Date().toISOString();
  rec = {
    id: indexId,
    name: opts?.name || indexId,
    createdAt: now,
    updatedAt: now,
    chunkTokens: Math.max(1, Math.min(4000, Number(opts?.chunkTokens) || DEFAULT_CHUNK_TOKENS)),
    clusterCount: Math.max(1, Math.min(64, Number(opts?.clusterCount) || DEFAULT_CLUSTER_COUNT)),
    documents: [],
    chunks: [],
    centroids: [],
    embeddingSource: null,
  };
  return rec;
}

/**
 * Index a document into a named index. Creates the index on first call.
 *
 * @param {string} indexName
 * @param {object} doc — { id?, title, text, metadata? }
 */
export async function indexDocument(indexName, doc, opts = {}) {
  if (!indexName || typeof indexName !== "string") {
    throw new Error("indexName is required");
  }
  if (!doc || typeof doc !== "object") {
    throw new Error("doc object is required");
  }
  if (typeof doc.text !== "string" || doc.text.trim().length === 0) {
    throw new Error("doc.text must be a non-empty string");
  }
  const indexId = sanitize(indexName);
  return withPathLock(indexFilePath(indexId), async () => {
    const rec = await loadOrCreateIndex(indexId, { ...opts, name: indexName });
    const docId = doc.id || randomUUID();
    const chunksText = chunkText(doc.text, rec.chunkTokens);
    if (chunksText.length === 0) {
      throw new Error("doc.text produced no chunks");
    }
    const { vectors, source } = await computeVectors(chunksText);
    rec.embeddingSource = source;
    rec.documents.push({
      id: docId,
      title: doc.title || docId,
      metadata: doc.metadata && typeof doc.metadata === "object" ? doc.metadata : {},
      chunkCount: chunksText.length,
      addedAt: new Date().toISOString(),
    });
    for (let i = 0; i < chunksText.length; i += 1) {
      rec.chunks.push({
        docId,
        chunkIndex: i,
        text: chunksText[i],
        vector: vectors[i],
      });
    }
    // Rebuild centroids (cheap for test-scale data).
    const allVectors = rec.chunks.map((c) => c.vector);
    const { centroids, assignments } = kmeans(allVectors, rec.clusterCount);
    rec.centroids = centroids;
    for (let i = 0; i < rec.chunks.length; i += 1) {
      rec.chunks[i].cluster = assignments[i];
    }
    rec.updatedAt = new Date().toISOString();
    await writeJsonPath(indexFilePath(indexId), rec);
    const fresh = await readJsonPath(registryPath(), { indexes: [] });
    if (!Array.isArray(fresh.indexes) || !fresh.indexes.some((e) => e.id === indexId)) {
      await updateRegistry((idx) => {
        idx.indexes = (idx.indexes || []).filter((e) => e.id !== indexId);
        idx.indexes.push({ id: indexId, name: indexName, createdAt: rec.createdAt });
      });
    }
    return {
      indexId,
      docId,
      chunkCount: chunksText.length,
      embeddingSource: source,
    };
  });
}

/**
 * Semantic search across an index. Returns the top-N chunks.
 */
export async function searchIndex(indexName, { query, topK = 5, probeClusters = 2 } = {}) {
  if (!query || typeof query !== "string") {
    throw new Error("query is required");
  }
  const indexId = sanitize(indexName);
  const rec = await readJsonPath(indexFilePath(indexId), null);
  if (!rec || !rec.id || rec._deleted) {
    const err = new Error(`index ${indexName} not found`);
    err.code = "NOT_FOUND";
    throw err;
  }
  if (rec.chunks.length === 0) {
    return { indexId, results: [], source: rec.embeddingSource };
  }
  const { vectors } = await computeVectors([query]);
  const q = vectors[0];
  // Pick top probeClusters centroids, scan only those chunks.
  const clusterScores = rec.centroids.map((c, i) => ({ i, sim: cosine(q, c) }));
  clusterScores.sort((a, b) => b.sim - a.sim);
  const probe = Math.max(1, Math.min(rec.centroids.length, Number(probeClusters) || 2));
  const scanClusters = new Set(clusterScores.slice(0, probe).map((c) => c.i));
  const candidates = rec.chunks.filter((c) => scanClusters.has(c.cluster));
  // Fallback: if centroids produced nothing (e.g. 1 cluster), scan everything.
  const pool = candidates.length > 0 ? candidates : rec.chunks;
  const scored = pool.map((c) => ({
    docId: c.docId,
    chunkIndex: c.chunkIndex,
    score: cosine(q, c.vector),
    text: c.text,
    cluster: c.cluster,
  }));
  scored.sort((a, b) => b.score - a.score);
  return {
    indexId,
    indexName: rec.name,
    source: rec.embeddingSource,
    probedClusters: probe,
    totalChunks: rec.chunks.length,
    results: scored.slice(0, Math.max(1, Number(topK) || 5)),
  };
}

export async function getIndexStats(indexName) {
  const indexId = sanitize(indexName);
  const rec = await readJsonPath(indexFilePath(indexId), null);
  if (!rec || !rec.id || rec._deleted) return null;
  const sizes = new Array(rec.centroids.length).fill(0);
  for (const c of rec.chunks) {
    if (c.cluster != null) sizes[c.cluster] = (sizes[c.cluster] || 0) + 1;
  }
  return {
    indexId,
    name: rec.name,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    documentCount: rec.documents.length,
    chunkCount: rec.chunks.length,
    clusterCount: rec.centroids.length,
    clusterSizes: sizes,
    chunkTokens: rec.chunkTokens,
    embeddingSource: rec.embeddingSource,
  };
}

export async function listIndexes() {
  const idx = await readJsonPath(registryPath(), { indexes: [] });
  const entries = Array.isArray(idx.indexes) ? idx.indexes : [];
  const out = [];
  for (const entry of entries) {
    const stats = await getIndexStats(entry.name || entry.id);
    if (stats) out.push(stats);
  }
  return out;
}

export const _internals = { indexFilePath, registryPath, chunkText, cosine, deterministicVector, kmeans };
