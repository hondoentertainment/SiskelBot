// @ts-check
/**
 * Phase 63.1: Repo-level RAG.
 *
 * Pure-JavaScript line/block indexer for source files. Given file text +
 * language hint, extract top-level symbols (functions, classes), chunk
 * the file, and build a TF-IDF search index.
 *
 *   - `indexRepo(files)` — ingest an array of { path, text, language? }
 *   - `searchRepo(query, opts)` — TF-IDF + exact-name ranking
 *   - `getFunctionByName(name)` — direct lookup
 *   - `listFiles()` — list indexed files
 *   - `rebuildIndex()` — re-ingest persisted files
 *
 * Persistence via `json-path-store.js`.
 *
 * @module repo-rag
 */
import { join } from "path";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;
const STOPWORDS = new Set([
  "a", "an", "the", "of", "in", "on", "for", "and", "or", "to", "is",
  "with", "as", "at", "be", "this", "that", "it", "if", "else", "return",
  "function", "const", "let", "var", "new", "from", "import", "export",
]);

function repoPath() {
  return join(getDataDir(), "repo-rag.json");
}

/**
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  if (text == null) return [];
  const s = String(text).toLowerCase();
  const cleaned = s.replace(/[^a-z0-9_]+/g, " ");
  return cleaned
    .split(/\s+/)
    .filter(Boolean)
    .filter((t) => !STOPWORDS.has(t) && (t.length > 1 || /\d/.test(t)));
}

/* -------------------------------------------------------------------------- */
/* Language detection & symbol extraction                                     */
/* -------------------------------------------------------------------------- */

/**
 * Guess a language from a file path.
 *
 * @param {string} path
 * @returns {string}
 */
export function detectLanguage(path) {
  if (typeof path !== "string") return "text";
  const lower = path.toLowerCase();
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return "javascript";
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "typescript";
  if (lower.endsWith(".py")) return "python";
  if (lower.endsWith(".go")) return "go";
  if (lower.endsWith(".rs")) return "rust";
  if (lower.endsWith(".java")) return "java";
  if (lower.endsWith(".rb")) return "ruby";
  if (lower.endsWith(".md")) return "markdown";
  return "text";
}

/**
 * Extract function/class names and line ranges from source text. Purely
 * regex-based; handles JS/TS, Python, Go, Java-ish.
 *
 * @param {string} text
 * @param {string} language
 * @returns {Array<{ kind: "function" | "class", name: string, startLine: number, endLine: number, snippet: string }>}
 */
export function extractSymbols(text, language = "javascript") {
  if (typeof text !== "string" || !text) return [];
  const lines = text.split(/\r?\n/);
  /** @type {Array<{ kind: "function" | "class", name: string, startLine: number, endLine: number, snippet: string }>} */
  const symbols = [];
  let pattern;
  if (language === "python") {
    pattern = /^\s*(def|class)\s+([a-zA-Z_][a-zA-Z0-9_]*)/;
  } else if (language === "go") {
    pattern = /^\s*func\s+(?:\([^)]+\)\s+)?([a-zA-Z_][a-zA-Z0-9_]*)/;
  } else {
    // JS/TS/Java-ish
    pattern = /^\s*(?:export\s+)?(?:async\s+)?(function|class)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/;
  }
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(pattern);
    if (!m) continue;
    let kind;
    let name;
    if (language === "python") {
      kind = m[1] === "class" ? "class" : "function";
      name = m[2];
    } else if (language === "go") {
      kind = "function";
      name = m[1];
    } else {
      kind = m[1] === "class" ? "class" : "function";
      name = m[2];
    }
    const endLine = findBlockEnd(lines, i, language);
    const snippet = lines.slice(i, Math.min(endLine + 1, i + 40)).join("\n");
    symbols.push({ kind, name, startLine: i + 1, endLine: endLine + 1, snippet });
  }
  return symbols;
}

/**
 * Best-effort end-of-block detection via brace matching or indentation.
 *
 * @param {string[]} lines
 * @param {number} start
 * @param {string} language
 * @returns {number}
 */
function findBlockEnd(lines, start, language) {
  if (language === "python") {
    const startIndent = (lines[start].match(/^\s*/) || [""])[0].length;
    for (let i = start + 1; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line.trim()) continue;
      const indent = (line.match(/^\s*/) || [""])[0].length;
      if (indent <= startIndent) return i - 1;
    }
    return lines.length - 1;
  }
  let depth = 0;
  let seenOpen = false;
  for (let i = start; i < lines.length; i += 1) {
    for (const c of lines[i]) {
      if (c === "{") {
        depth += 1;
        seenOpen = true;
      } else if (c === "}") {
        depth -= 1;
        if (seenOpen && depth === 0) return i;
      }
    }
  }
  return Math.min(lines.length - 1, start + 50);
}

/* -------------------------------------------------------------------------- */
/* Index                                                                      */
/* -------------------------------------------------------------------------- */

async function loadIndex() {
  const data = await readJsonPath(repoPath(), {
    version: STORE_VERSION,
    files: {},
    symbols: {},
    chunks: [],
  });
  if (!data.files || typeof data.files !== "object") data.files = {};
  if (!data.symbols || typeof data.symbols !== "object") data.symbols = {};
  if (!Array.isArray(data.chunks)) data.chunks = [];
  return data;
}

async function saveIndex(data) {
  await writeJsonPath(repoPath(), {
    version: STORE_VERSION,
    files: data.files || {},
    symbols: data.symbols || {},
    chunks: data.chunks || [],
  });
}

/**
 * Split file text into chunks of N lines for keyword search.
 *
 * @param {string} text
 * @param {number} chunkSize
 * @returns {Array<{ startLine: number, endLine: number, text: string }>}
 */
export function chunkFile(text, chunkSize = 40) {
  if (typeof text !== "string" || !text) return [];
  const lines = text.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i += chunkSize) {
    const slice = lines.slice(i, i + chunkSize);
    out.push({
      startLine: i + 1,
      endLine: i + slice.length,
      text: slice.join("\n"),
    });
  }
  return out;
}

/**
 * Build / rebuild the persisted index from a list of files.
 *
 * @param {Array<{ path: string, text: string, language?: string }>} files
 * @returns {Promise<{ fileCount: number, symbolCount: number, chunkCount: number }>}
 */
export async function indexRepo(files) {
  if (!Array.isArray(files)) throw new Error("files must be an array");
  const path = repoPath();
  return withPathLock(path, async () => {
    const now = new Date().toISOString();
    /** @type {Record<string, object>} */
    const filesMap = {};
    /** @type {Record<string, Array<object>>} */
    const symbolsMap = {};
    /** @type {Array<object>} */
    const chunks = [];
    for (const f of files) {
      if (!f || typeof f !== "object" || !f.path) continue;
      const lang = f.language || detectLanguage(f.path);
      const text = typeof f.text === "string" ? f.text : "";
      const symbols = extractSymbols(text, lang);
      const fileChunks = chunkFile(text, 40);
      filesMap[f.path] = {
        path: f.path,
        language: lang,
        text,
        indexedAt: now,
        symbolCount: symbols.length,
        lineCount: text.split(/\r?\n/).length,
      };
      for (const s of symbols) {
        if (!symbolsMap[s.name]) symbolsMap[s.name] = [];
        symbolsMap[s.name].push({ ...s, path: f.path, language: lang });
      }
      for (const ch of fileChunks) {
        chunks.push({
          path: f.path,
          language: lang,
          startLine: ch.startLine,
          endLine: ch.endLine,
          text: ch.text,
          tokens: tokenize(ch.text),
        });
      }
    }
    const data = { files: filesMap, symbols: symbolsMap, chunks };
    await saveIndex(data);
    return {
      fileCount: Object.keys(filesMap).length,
      symbolCount: Object.values(symbolsMap).reduce((a, b) => a + b.length, 0),
      chunkCount: chunks.length,
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Search                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * TF-IDF-ish search across indexed chunks.
 *
 * @param {string} query
 * @param {object} [opts]
 * @returns {Promise<Array<object>>}
 */
export async function searchRepo(query, opts = {}) {
  if (!query || typeof query !== "string") return [];
  const data = await loadIndex();
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return [];
  const k = Number.isFinite(opts.k) && opts.k > 0 ? Math.floor(opts.k) : 10;
  const language = opts.language;
  /** @type {Record<string, number>} */
  const df = {};
  for (const ch of data.chunks) {
    const seen = new Set();
    for (const t of ch.tokens) {
      if (seen.has(t)) continue;
      seen.add(t);
      df[t] = (df[t] || 0) + 1;
    }
  }
  const N = data.chunks.length || 1;
  /** @type {Array<{ path: string, startLine: number, endLine: number, score: number, snippet: string, language: string }>} */
  const results = [];
  for (const ch of data.chunks) {
    if (language && ch.language !== language) continue;
    /** @type {Record<string, number>} */
    const tf = {};
    for (const t of ch.tokens) tf[t] = (tf[t] || 0) + 1;
    const len = ch.tokens.length || 1;
    let score = 0;
    for (const qt of qTokens) {
      const f = tf[qt];
      if (!f) continue;
      const idf = Math.log((N + 1) / ((df[qt] || 0) + 1)) + 1;
      score += (f / len) * idf * idf;
    }
    if (score > 0) {
      results.push({
        path: ch.path,
        startLine: ch.startLine,
        endLine: ch.endLine,
        language: ch.language,
        score: Math.round(score * 10000) / 10000,
        snippet: ch.text.slice(0, 400),
      });
    }
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, k);
}

/**
 * Direct lookup of a function/class by name across the index.
 *
 * @param {string} name
 * @returns {Promise<Array<object>>}
 */
export async function getFunctionByName(name) {
  if (!name || typeof name !== "string") return [];
  const data = await loadIndex();
  return data.symbols[name] || [];
}

/** List indexed files (metadata only; not full text). */
export async function listFiles() {
  const data = await loadIndex();
  return Object.values(data.files).map((f) => ({
    path: /** @type {any} */ (f).path,
    language: /** @type {any} */ (f).language,
    symbolCount: /** @type {any} */ (f).symbolCount,
    lineCount: /** @type {any} */ (f).lineCount,
    indexedAt: /** @type {any} */ (f).indexedAt,
  }));
}

/**
 * Rebuild the index from the persisted file texts.
 *
 * @returns {Promise<{ fileCount: number, symbolCount: number, chunkCount: number }>}
 */
export async function rebuildIndex() {
  const data = await loadIndex();
  const files = Object.values(data.files).map((f) => ({
    path: /** @type {any} */ (f).path,
    text: /** @type {any} */ (f).text || "",
    language: /** @type {any} */ (f).language,
  }));
  return indexRepo(files);
}
