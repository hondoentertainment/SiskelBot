/**
 * Personal Knowledge System store (Phase 5).
 * Phase 28: Optional embeddings for semantic search; keyword/substring search remains default.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { embed as embedText } from "./embeddings.js";
import { chunkPlainText } from "./knowledge-chunking.js";
import { withSpan, addSpanEvent } from "./tracing-spans.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_MAX_DOC_BYTES = 1 * 1024 * 1024; // 1MB
const DEFAULT_DATA_DIR = join(process.cwd(), "data", "knowledge");
const WORKSPACE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,49}$/;
const SNIPPET_LENGTH = 300;
const MAX_SNIPPETS = 10;
const DEFAULT_SEMANTIC_TOP_K = 5;
const SEARCH_CACHE_TTL_MS = Math.min(
  600_000,
  Math.max(5_000, Number(process.env.KNOWLEDGE_SEARCH_CACHE_TTL_MS) || 30_000),
);
const SEARCH_CACHE_MAX = Math.min(500, Math.max(20, Number(process.env.KNOWLEDGE_SEARCH_CACHE_MAX) || 200));

/** @type {Map<string, { at: number, value: unknown }>} */
const searchResultCache = new Map();

function searchCacheSet(key, value) {
  searchResultCache.set(key, { at: Date.now(), value });
  while (searchResultCache.size > SEARCH_CACHE_MAX) {
    const first = searchResultCache.keys().next().value;
    if (first === undefined) break;
    searchResultCache.delete(first);
  }
}

/**
 * Invalidate cached keyword/semantic search results (call after index changes).
 * @param {string} [workspace] - If set, only keys for that workspace; otherwise clear all.
 */
export function clearKnowledgeSearchCache(workspace) {
  if (workspace == null || workspace === "") {
    searchResultCache.clear();
    return;
  }
  const w = String(workspace);
  const pKw = `kw\t${w}\t`;
  const pSem = `sem\t${w}\t`;
  for (const k of [...searchResultCache.keys()]) {
    if (k.startsWith(pKw) || k.startsWith(pSem)) searchResultCache.delete(k);
  }
}

function ensureDir(dir) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function getDataPath(dataDir, workspace) {
  const safe = String(workspace).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 50) || "default";
  return join(dataDir, `${safe}.json`);
}

function loadIndex(dataPath) {
  try {
    if (existsSync(dataPath)) {
      const raw = readFileSync(dataPath, "utf8");
      const data = JSON.parse(raw);
      return Array.isArray(data.docs) ? data.docs : [];
    }
  } catch (e) {
    console.warn("Knowledge store: failed to load index", e.message);
  }
  return [];
}

function saveIndex(dataPath, docs) {
  ensureDir(dirname(dataPath));
  writeFileSync(dataPath, JSON.stringify({ docs, _updated: new Date().toISOString() }, null, 0), "utf8");
}

/**
 * Add a document to the knowledge index.
 * @param {Object} opts
 * @param {string} opts.text - Document text content
 * @param {string} [opts.workspace='default'] - Workspace/conversation id
 * @param {string} [opts.title] - Optional title
 * @param {number[]} [opts.embedding] - Optional embedding vector (Phase 28: for semantic search)
 * @param {string} [opts.dataDir] - Override data directory
 * @param {number} [opts.maxBytes] - Max bytes per doc (default 1MB)
 * @returns {{ id: string, workspace: string, title?: string, createdAt: string } | { error: string, code: string, hint: string }}
 */
export async function indexDocument(opts) {
  const {
    text,
    workspace = "default",
    title,
    embedding,
    dataDir = process.env.KNOWLEDGE_DATA_DIR || DEFAULT_DATA_DIR,
    maxBytes = Number(process.env.KNOWLEDGE_MAX_DOC_BYTES) || DEFAULT_MAX_DOC_BYTES,
  } = opts || {};

  if (typeof text !== "string") {
    return { error: "text is required", code: "INVALID_INPUT", hint: "Send { text: string } in the request body." };
  }

  const content = text.trim();
  if (!content) {
    return { error: "text cannot be empty", code: "INVALID_INPUT", hint: "Provide non-empty document text." };
  }

  const textBytes = Buffer.byteLength(content, "utf8");
  if (textBytes > maxBytes) {
    return {
      error: `Document exceeds max size (${maxBytes} bytes)`,
      code: "DOC_TOO_LARGE",
      hint: `Reduce document size. Max ${Math.round(maxBytes / 1024)}KB per document.`,
    };
  }

  if (!WORKSPACE_PATTERN.test(workspace)) {
    return {
      error: "Invalid workspace",
      code: "INVALID_INPUT",
      hint: "Workspace must be alphanumeric, 1–50 chars (e.g. default, my-workspace).",
    };
  }

  // Phase 69: span for index operation
  addSpanEvent("knowledge.index.start", {
    "knowledge.doc_type": title ? "titled" : "untitled",
    "knowledge.doc_size": textBytes,
  });

  const dataPath = getDataPath(dataDir, workspace);
  const docs = loadIndex(dataPath);

  const maxChunks = Math.min(200, Math.max(1, Number(process.env.KNOWLEDGE_MAX_CHUNKS_PER_DOC) || 50));
  const chunkMax = Number(process.env.KNOWLEDGE_CHUNK_MAX_CHARS) || 4000;
  const chunkOverlap = Number(process.env.KNOWLEDGE_CHUNK_OVERLAP) || 200;
  const useChunking = process.env.KNOWLEDGE_CHUNKING === "1";
  const pieces = useChunking ? chunkPlainText(content, chunkMax, chunkOverlap).slice(0, maxChunks) : [content];

  const baseTitle = typeof title === "string" && title.trim() ? title.trim().slice(0, 200) : undefined;
  const ids = [];
  const now = new Date().toISOString();

  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i];
    const id = randomUUID();
    const doc = {
      id,
      workspace,
      title:
        pieces.length > 1
          ? `${baseTitle || "Document"} (part ${i + 1}/${pieces.length})`.slice(0, 200)
          : baseTitle,
      content: piece,
      createdAt: now,
      ...(useChunking && pieces.length > 1 ? { chunkIndex: i, chunkOf: pieces.length } : {}),
    };
    if (pieces.length === 1 && Array.isArray(embedding) && embedding.length > 0) {
      doc.embedding = embedding;
    } else if (useChunking && process.env.OPENAI_API_KEY && piece.length > 0) {
      const emb = await embedText(piece.slice(0, 8000));
      if (emb) doc.embedding = emb;
    } else if (pieces.length === 1 && process.env.KNOWLEDGE_AUTO_EMBED === "1" && process.env.OPENAI_API_KEY && piece.length > 0) {
      const emb = await embedText(piece.slice(0, 8000));
      if (emb) doc.embedding = emb;
    }
    docs.push(doc);
    ids.push(id);
  }
  saveIndex(dataPath, docs);
  clearKnowledgeSearchCache(workspace);

  addSpanEvent("knowledge.index.complete", {
    "knowledge.doc_type": title ? "titled" : "untitled",
    "knowledge.doc_size": textBytes,
    "knowledge.chunks_count": ids.length,
  });

  if (ids.length === 1) {
    const d = docs[docs.length - 1];
    return { id: ids[0], workspace, title: d.title, createdAt: d.createdAt };
  }
  return {
    ids,
    chunkCount: ids.length,
    workspace,
    title: baseTitle,
    createdAt: now,
  };
}

/**
 * Phase 72: Recompute embeddings for all docs in a workspace (incremental semantic refresh).
 */
export async function reindexKnowledgeEmbeddingsInWorkspace(workspace, dataDir) {
  if (!WORKSPACE_PATTERN.test(workspace)) {
    return { error: "Invalid workspace", code: "INVALID_INPUT" };
  }
  const dataPath = getDataPath(dataDir || process.env.KNOWLEDGE_DATA_DIR || DEFAULT_DATA_DIR, workspace);
  const docs = loadIndex(dataPath);
  let updated = 0;
  for (const doc of docs) {
    const c = doc.content || "";
    if (!c.trim()) continue;
    const emb = await embedText(c.slice(0, 8000));
    if (emb) {
      doc.embedding = emb;
      updated++;
    }
  }
  saveIndex(dataPath, docs);
  clearKnowledgeSearchCache(workspace);
  return { ok: true, workspace, documents: docs.length, embeddingsUpdated: updated };
}

/**
 * Search documents by substring match (case-insensitive).
 * @param {Object} opts
 * @param {string} opts.query - Search query
 * @param {string} [opts.workspace='default'] - Workspace to search
 * @param {string} [opts.dataDir] - Override data directory
 * @returns {{ snippets: Array<{ id: string, title?: string, snippet: string, score?: number }> } | { error: string, code: string, hint: string }}
 */
export function search(opts) {
  const {
    query,
    workspace = "default",
    dataDir = process.env.KNOWLEDGE_DATA_DIR || DEFAULT_DATA_DIR,
  } = opts || {};

  if (typeof query !== "string") {
    return { error: "query is required", code: "INVALID_INPUT", hint: "Use ?q=your+search+term" };
  }

  const q = query.trim();
  if (!q) {
    return { snippets: [], query: q };
  }

  if (!WORKSPACE_PATTERN.test(workspace)) {
    return {
      error: "Invalid workspace",
      code: "INVALID_INPUT",
      hint: "Workspace must be alphanumeric, 1–50 chars.",
    };
  }

  const cacheKey = `kw\t${workspace}\t${q}`;
  const hit = searchResultCache.get(cacheKey);
  if (hit && Date.now() - hit.at < SEARCH_CACHE_TTL_MS) {
    // Phase 69: note cache hit
    addSpanEvent("knowledge.search.cache_hit", { "knowledge.search_type": "keyword" });
    return hit.value;
  }

  const dataPath = getDataPath(dataDir, workspace);
  const docs = loadIndex(dataPath);
  const qLower = q.toLowerCase();
  const snippets = [];

  for (const doc of docs) {
    const content = doc.content || "";
    const idx = content.toLowerCase().indexOf(qLower);
    if (idx === -1) continue;

    // Extract snippet around match
    const start = Math.max(0, idx - Math.floor(SNIPPET_LENGTH / 2));
    const end = Math.min(content.length, start + SNIPPET_LENGTH);
    let snippet = content.slice(start, end);
    if (start > 0) snippet = "…" + snippet;
    if (end < content.length) snippet = snippet + "…";

    snippets.push({
      id: doc.id,
      title: doc.title,
      snippet,
      score: 1,
    });

    if (snippets.length >= MAX_SNIPPETS) break;
  }

  const out = { snippets, query: q };
  searchCacheSet(cacheKey, out);

  // Phase 69: span event for keyword search completion
  addSpanEvent("knowledge.search.complete", {
    "knowledge.search_type": "keyword",
    "knowledge.results_count": snippets.length,
    "knowledge.query_length": q.length,
  });

  return out;
}

/** Cosine similarity between two vectors (higher = more similar). */
function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

/**
 * Semantic search: embed query, find nearest docs by embedding distance.
 * Only searches docs that have stored embeddings. Returns same snippet shape as keyword search.
 * @param {Object} opts
 * @param {string} opts.query - Search query
 * @param {string} [opts.workspace='default'] - Workspace to search
 * @param {number} [opts.topK=5] - Max results
 * @param {string} [opts.dataDir] - Override data directory
 * @returns {Promise<{ snippets: Array<{ id: string, title?: string, snippet: string, score: number }>, query: string } | { error: string, code: string, hint: string }>}
 */
export async function semanticSearch(opts) {
  const {
    query,
    workspace = "default",
    topK = DEFAULT_SEMANTIC_TOP_K,
    dataDir = process.env.KNOWLEDGE_DATA_DIR || DEFAULT_DATA_DIR,
  } = opts || {};

  if (typeof query !== "string") {
    return { error: "query is required", code: "INVALID_INPUT", hint: "Use ?q=your+search+term" };
  }

  const q = query.trim();
  if (!q) return { snippets: [], query: q };

  if (!WORKSPACE_PATTERN.test(workspace)) {
    return {
      error: "Invalid workspace",
      code: "INVALID_INPUT",
      hint: "Workspace must be alphanumeric, 1–50 chars.",
    };
  }

  const cacheTop = Math.min(topK, MAX_SNIPPETS);
  const cacheKey = `sem\t${workspace}\t${q}\t${cacheTop}`;
  const hit = searchResultCache.get(cacheKey);
  if (hit && Date.now() - hit.at < SEARCH_CACHE_TTL_MS) {
    addSpanEvent("knowledge.search.cache_hit", { "knowledge.search_type": "semantic" });
    return hit.value;
  }

  // Phase 69: span for semantic search operation
  return withSpan("knowledge.semantic_search", {
    "knowledge.search_type": "semantic",
    "knowledge.query_length": q.length,
  }, async (searchSpan) => {
    const queryEmbedding = await embedText(q);
    if (!queryEmbedding) {
      searchSpan.setAttributes({ "knowledge.results_count": 0 });
      return {
        error: "Embeddings unavailable",
        code: "EMBEDDINGS_UNAVAILABLE",
        hint: "Set OPENAI_API_KEY to enable semantic search.",
      };
    }

    const dataPath = getDataPath(dataDir, workspace);
    const docs = loadIndex(dataPath);
    const withEmbedding = docs.filter((d) => Array.isArray(d.embedding) && d.embedding.length > 0);
    if (withEmbedding.length === 0) {
      const empty = { snippets: [], query: q };
      searchCacheSet(cacheKey, empty);
      searchSpan.setAttributes({ "knowledge.results_count": 0 });
      return empty;
    }

    const scored = withEmbedding.map((doc) => {
      const sim = cosineSimilarity(queryEmbedding, doc.embedding);
      const content = doc.content || "";
      const snippet =
        content.length <= SNIPPET_LENGTH ? content : content.slice(0, SNIPPET_LENGTH) + "…";
      return { id: doc.id, title: doc.title, snippet, score: sim };
    });
    scored.sort((a, b) => b.score - a.score);

    const snippets = scored.slice(0, Math.min(topK, MAX_SNIPPETS));
    const out = { snippets, query: q };
    searchCacheSet(cacheKey, out);
    searchSpan.setAttributes({ "knowledge.results_count": snippets.length });
    return out;
  });
}

/**
 * Fetch a single indexed document by id (for agent drill-down after search).
 * @param {Object} opts
 * @param {string} opts.id - Document uuid
 * @param {string} [opts.workspace='default']
 * @param {string} [opts.dataDir]
 * @returns {{ id: string, title?: string, content: string, createdAt?: string } | { error: string, code: string, hint?: string }}
 */
export function getDocumentById(opts) {
  const {
    id,
    workspace = "default",
    dataDir = process.env.KNOWLEDGE_DATA_DIR || DEFAULT_DATA_DIR,
  } = opts || {};

  if (typeof id !== "string" || !id.trim()) {
    return { error: "id is required", code: "INVALID_INPUT", hint: "Pass the document id from search_context or list_context." };
  }

  if (!WORKSPACE_PATTERN.test(workspace)) {
    return {
      error: "Invalid workspace",
      code: "INVALID_INPUT",
      hint: "Workspace must be alphanumeric, 1–50 chars.",
    };
  }

  const dataPath = getDataPath(dataDir, workspace);
  const docs = loadIndex(dataPath);
  const doc = docs.find((d) => d && d.id === id.trim());
  if (!doc) {
    return { error: "Document not found", code: "NOT_FOUND", hint: "Use list_context or search_context to find valid ids." };
  }

  return {
    id: doc.id,
    title: doc.title,
    content: doc.content || "",
    createdAt: doc.createdAt,
  };
}

/**
 * List indexed documents for a workspace.
 * @param {Object} opts
 * @param {string} [opts.workspace='default'] - Workspace
 * @param {string} [opts.dataDir] - Override data directory
 * @returns {{ items: Array<{ id: string, title?: string, createdAt: string }> } | { error: string, code: string, hint: string }}
 */
export function list(opts) {
  const {
    workspace = "default",
    dataDir = process.env.KNOWLEDGE_DATA_DIR || DEFAULT_DATA_DIR,
  } = opts || {};

  if (!WORKSPACE_PATTERN.test(workspace)) {
    return {
      error: "Invalid workspace",
      code: "INVALID_INPUT",
      hint: "Workspace must be alphanumeric, 1–50 chars.",
    };
  }

  const dataPath = getDataPath(dataDir, workspace);
  const docs = loadIndex(dataPath);

  const items = docs.map((d) => ({
    id: d.id,
    title: d.title || "(untitled)",
    createdAt: d.createdAt,
  }));

  return { items };
}
