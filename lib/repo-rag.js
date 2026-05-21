/**
 * Phase 63.1: Repo-level RAG.
 *
 * Indexes repository source files into a per-workspace inverted index so agents
 * can search relevant code snippets by keyword. Unlike the general knowledge
 * base, this keeps per-file, per-line position info so results can point at a
 * specific line range.
 *
 * Storage layout:
 *   data/repo-rag/{workspaceId}.json
 *     { repos: { [repoId]: { files: [{ path, language, lines, tokenCount }] } },
 *       index: { token: [{ repoId, path, line, count }] } }
 */
import { randomUUID } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const DEFAULT_MAX_FILES = 5000;
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

export class RepoRagLimitError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RepoRagLimitError";
    this.code = code;
  }
}

function indexLimits() {
  const maxFiles = Number(process.env.REPO_RAG_MAX_FILES);
  const maxBytes = Number(process.env.REPO_RAG_MAX_BYTES);
  return {
    maxFiles: Number.isFinite(maxFiles) && maxFiles > 0 ? maxFiles : DEFAULT_MAX_FILES,
    maxBytes: Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_MAX_BYTES,
  };
}

function assertIndexWithinLimits(files) {
  const { maxFiles, maxBytes } = indexLimits();
  if (!Array.isArray(files)) return;
  if (files.length > maxFiles) {
    throw new RepoRagLimitError(
      "REPO_RAG_FILE_LIMIT",
      `files array exceeds limit of ${maxFiles} (set REPO_RAG_MAX_FILES to raise)`,
    );
  }
  let totalBytes = 0;
  for (const f of files) {
    const content = typeof f?.content === "string" ? f.content : "";
    totalBytes += Buffer.byteLength(content, "utf8");
    if (totalBytes > maxBytes) {
      throw new RepoRagLimitError(
        "REPO_RAG_SIZE_LIMIT",
        `corpus exceeds ${maxBytes} bytes (set REPO_RAG_MAX_BYTES to raise)`,
      );
    }
  }
}

const EXT_TO_LANG = Object.freeze({
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  py: "python",
  go: "go",
  rs: "rust",
  java: "java",
  rb: "ruby",
  cs: "csharp",
  cpp: "cpp",
  c: "c",
  h: "c",
  hpp: "cpp",
  php: "php",
  md: "markdown",
  json: "json",
  yml: "yaml",
  yaml: "yaml",
  sh: "shell",
});

function sanitizeId(val, fallback = "default") {
  if (typeof val !== "string" || !val.trim()) return fallback;
  return val.trim().replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || fallback;
}

function storePath(workspaceId) {
  return join(getDataDir(), "repo-rag", `${sanitizeId(workspaceId)}.json`);
}

function detectLanguage(path, explicit) {
  if (explicit && typeof explicit === "string") return explicit;
  const m = String(path || "").toLowerCase().match(/\.([a-z0-9]+)$/);
  if (!m) return "plaintext";
  return EXT_TO_LANG[m[1]] || "plaintext";
}

function tokenize(text) {
  if (typeof text !== "string" || !text) return [];
  return text.toLowerCase().split(/\W+/).filter((t) => t && t.length > 1 && t.length < 64);
}

async function readStore(workspaceId) {
  return readJsonPath(storePath(workspaceId), { repos: {}, index: {} });
}

async function writeStore(workspaceId, store) {
  return writeJsonPath(storePath(workspaceId), store);
}

/**
 * Index a repository's files.
 * @param {{ workspaceId?: string, repoId: string, files: Array<{path,content,language?}> }} input
 */
export async function indexRepository({ workspaceId, repoId, files } = {}) {
  const ws = sanitizeId(workspaceId);
  const rid = sanitizeId(repoId, "");
  if (!rid) throw new Error("repoId is required");
  if (!Array.isArray(files)) throw new Error("files must be an array");
  assertIndexWithinLimits(files);
  const file = storePath(ws);
  let summary;
  await withPathLock(file, async () => {
    const store = await readStore(ws);
    store.repos = store.repos || {};
    store.index = store.index || {};
    // Drop prior index entries for this repoId.
    for (const tok of Object.keys(store.index)) {
      const keep = store.index[tok].filter((p) => p.repoId !== rid);
      if (keep.length === 0) delete store.index[tok];
      else store.index[tok] = keep;
    }
    const indexedFiles = [];
    let tokenCount = 0;
    for (const f of files) {
      if (!f || typeof f.path !== "string") continue;
      const content = typeof f.content === "string" ? f.content : "";
      const language = detectLanguage(f.path, f.language);
      const lines = content.split(/\r?\n/);
      let fileTokens = 0;
      for (let i = 0; i < lines.length; i += 1) {
        const toks = tokenize(lines[i]);
        fileTokens += toks.length;
        const perLine = {};
        for (const t of toks) {
          perLine[t] = (perLine[t] || 0) + 1;
        }
        for (const [t, count] of Object.entries(perLine)) {
          if (!store.index[t]) store.index[t] = [];
          store.index[t].push({ repoId: rid, path: f.path, line: i + 1, count });
        }
      }
      tokenCount += fileTokens;
      indexedFiles.push({ path: f.path, language, lines: lines.length, tokenCount: fileTokens });
    }
    store.repos[rid] = {
      repoId: rid,
      indexedAt: Date.now(),
      files: indexedFiles,
      tokenCount,
    };
    await writeStore(ws, store);
    summary = { repoId: rid, fileCount: indexedFiles.length, tokenCount };
  });
  return summary;
}

/**
 * Search indexed repos. Scores by simple TF (sum of per-token counts per file).
 */
export async function searchRepo({ workspaceId, query, limit } = {}) {
  const ws = sanitizeId(workspaceId);
  const q = tokenize(query || "");
  const max = Math.max(1, Math.min(500, Number(limit) || 20));
  if (q.length === 0) return { hits: [] };
  const store = await readStore(ws);
  const index = store.index || {};
  // Aggregate: { `${repoId}:${path}`: { score, lines:Set, repoId, path } }
  const agg = new Map();
  for (const tok of q) {
    const postings = index[tok];
    if (!Array.isArray(postings)) continue;
    for (const p of postings) {
      const key = `${p.repoId}:${p.path}`;
      let entry = agg.get(key);
      if (!entry) {
        entry = { repoId: p.repoId, path: p.path, score: 0, lines: new Set() };
        agg.set(key, entry);
      }
      entry.score += p.count;
      entry.lines.add(p.line);
    }
  }
  const hits = Array.from(agg.values())
    .map((e) => ({
      repoId: e.repoId,
      path: e.path,
      score: e.score,
      lines: Array.from(e.lines).sort((a, b) => a - b).slice(0, 20),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, max);
  return { hits };
}

export async function getRepoStats(workspaceId) {
  const ws = sanitizeId(workspaceId);
  const store = await readStore(ws);
  const repos = Object.values(store.repos || {});
  let totalFiles = 0;
  let totalTokens = 0;
  for (const r of repos) {
    totalFiles += (r.files || []).length;
    totalTokens += Number(r.tokenCount) || 0;
  }
  return { repos: repos.length, totalFiles, totalTokens };
}

export async function listRepos(workspaceId) {
  const ws = sanitizeId(workspaceId);
  const store = await readStore(ws);
  const repos = Object.values(store.repos || {}).map((r) => ({
    repoId: r.repoId,
    indexedAt: r.indexedAt,
    fileCount: (r.files || []).length,
    tokenCount: r.tokenCount,
  }));
  return { repos };
}

export async function removeRepo({ workspaceId, repoId } = {}) {
  const ws = sanitizeId(workspaceId);
  const rid = sanitizeId(repoId, "");
  if (!rid) throw new Error("repoId is required");
  const file = storePath(ws);
  let removed = false;
  await withPathLock(file, async () => {
    const store = await readStore(ws);
    if (store.repos && store.repos[rid]) {
      delete store.repos[rid];
      removed = true;
    }
    if (store.index) {
      for (const tok of Object.keys(store.index)) {
        const keep = store.index[tok].filter((p) => p.repoId !== rid);
        if (keep.length === 0) delete store.index[tok];
        else store.index[tok] = keep;
      }
    }
    await writeStore(ws, store);
  });
  return { removed, repoId: rid };
}

export async function _reset(workspaceId) {
  if (workspaceId) {
    await writeJsonPath(storePath(workspaceId), { repos: {}, index: {} });
    return;
  }
  // Wipe by resetting "default" plus any known workspaces is not tracked; best-effort.
  await writeJsonPath(storePath("default"), { repos: {}, index: {} });
}

export const _internals = { sanitizeId, storePath, tokenize, detectLanguage };
