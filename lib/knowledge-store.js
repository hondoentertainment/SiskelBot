/**
 * Personal Knowledge System store (Phase 5).
 * Phase 28: Optional embeddings for semantic search; keyword/substring search remains default.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { embed as embedText } from "./embeddings.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_MAX_DOC_BYTES = 1 * 1024 * 1024; // 1MB
const DEFAULT_DATA_DIR = join(process.cwd(), "data", "knowledge");
const WORKSPACE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,49}$/;
const SNIPPET_LENGTH = 300;
const MAX_SNIPPETS = 10;
const DEFAULT_SEMANTIC_TOP_K = 5;

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
export function indexDocument(opts) {
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

  const dataPath = getDataPath(dataDir, workspace);
  const docs = loadIndex(dataPath);

  const id = randomUUID();
  const doc = {
    id,
    workspace,
    title: typeof title === "string" && title.trim() ? title.trim().slice(0, 200) : undefined,
    content,
    createdAt: new Date().toISOString(),
  };
  if (Array.isArray(embedding) && embedding.length > 0) doc.embedding = embedding;
  docs.push(doc);
  saveIndex(dataPath, docs);

  return { id, workspace, title: doc.title, createdAt: doc.createdAt };
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

  return { snippets, query: q };
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

  const queryEmbedding = await embedText(q);
  if (!queryEmbedding) {
    return {
      error: "Embeddings unavailable",
      code: "EMBEDDINGS_UNAVAILABLE",
      hint: "Set OPENAI_API_KEY to enable semantic search.",
    };
  }

  const dataPath = getDataPath(dataDir, workspace);
  const docs = loadIndex(dataPath);
  const withEmbedding = docs.filter((d) => Array.isArray(d.embedding) && d.embedding.length > 0);
  if (withEmbedding.length === 0) return { snippets: [], query: q };

  const scored = withEmbedding.map((doc) => {
    const sim = cosineSimilarity(queryEmbedding, doc.embedding);
    const content = doc.content || "";
    const snippet =
      content.length <= SNIPPET_LENGTH ? content : content.slice(0, SNIPPET_LENGTH) + "…";
    return { id: doc.id, title: doc.title, snippet, score: sim };
  });
  scored.sort((a, b) => b.score - a.score);

  const snippets = scored.slice(0, Math.min(topK, MAX_SNIPPETS));
  return { snippets, query: q };
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
