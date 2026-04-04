/**
 * Read-only workspace filesystem tools (WORKSPACE_ROOT + WORKSPACE_FILE_TOOLS).
 */
import { readdir, readFile, lstat } from "fs/promises";
import { resolveWorkspacePath } from "./workspace-path-guard.js";

const DEFAULT_READ_MAX = Math.min(2_000_000, Math.max(4096, Number(process.env.WORKSPACE_FILE_READ_MAX_BYTES) || 512_000));
const DEFAULT_LIST_MAX = Math.min(500, Math.max(20, Number(process.env.WORKSPACE_FILE_LIST_MAX_ENTRIES) || 200));
const DEFAULT_SEARCH_MAX = Math.min(500, Math.max(10, Number(process.env.WORKSPACE_FILE_SEARCH_MAX_MATCHES) || 80));
const MAX_SEARCH_FILES = Math.min(2000, Math.max(50, Number(process.env.WORKSPACE_FILE_SEARCH_MAX_FILES) || 400));

function getRoot(ctx) {
  const fromCtx = ctx?.workspaceFilesystemRoot;
  if (typeof fromCtx === "string" && fromCtx.trim()) return fromCtx.trim();
  return (process.env.WORKSPACE_ROOT || "").trim();
}

/**
 * @param {import("./types.d.ts").ToolContext} ctx
 * @param {string} relativeDir
 */
export async function workspaceListDir(ctx, relativeDir) {
  const root = getRoot(ctx);
  const rel = typeof relativeDir === "string" ? relativeDir.trim() : "";
  const resolved = resolveWorkspacePath(root, rel || ".");
  if (!resolved.ok) return { ok: false, ...resolved };
  try {
    const st = await lstat(resolved.absPath);
    if (!st.isDirectory()) {
      return { ok: false, code: "NOT_A_DIRECTORY", error: "Path is not a directory" };
    }
    const names = await readdir(resolved.absPath, { withFileTypes: true });
    const max = DEFAULT_LIST_MAX;
    const slice = names.slice(0, max).map((d) => ({
      name: d.name,
      type: d.isDirectory() ? "dir" : d.isFile() ? "file" : "other",
    }));
    return {
      ok: true,
      path: rel || ".",
      entries: slice,
      truncated: names.length > max,
      total: names.length,
    };
  } catch (e) {
    return { ok: false, code: "FS_ERROR", error: String(e?.message || e) };
  }
}

/**
 * @param {import("./types.d.ts").ToolContext} ctx
 * @param {string} relativePath
 * @param {number} [maxBytes]
 */
export async function workspaceReadFile(ctx, relativePath, maxBytes) {
  const root = getRoot(ctx);
  const resolved = resolveWorkspacePath(root, relativePath);
  if (!resolved.ok) return { ok: false, ...resolved };
  const cap = Math.min(DEFAULT_READ_MAX, Math.max(256, Number(maxBytes) || DEFAULT_READ_MAX));
  try {
    const st = await lstat(resolved.absPath);
    if (!st.isFile()) {
      return { ok: false, code: "NOT_A_FILE", error: "Path is not a regular file" };
    }
    if (st.size > cap) {
      return {
        ok: false,
        code: "FILE_TOO_LARGE",
        error: `File size ${st.size} exceeds limit ${cap} bytes`,
      };
    }
    const buf = await readFile(resolved.absPath);
    const text = buf.toString("utf8");
    return {
      ok: true,
      path: relativePath,
      content: text,
      byteLength: buf.length,
      encoding: "utf8",
    };
  } catch (e) {
    return { ok: false, code: "FS_ERROR", error: String(e?.message || e) };
  }
}

/**
 * Naive recursive text search under a directory (dev/small workspaces).
 * @param {import("./types.d.ts").ToolContext} ctx
 * @param {{ rootRelative?: string, query: string, maxMatches?: number }} opts
 */
export async function workspaceSearchText(ctx, opts) {
  const root = getRoot(ctx);
  const query = typeof opts?.query === "string" ? opts.query.trim() : "";
  if (!query) return { ok: false, code: "QUERY_EMPTY", error: "query is required" };
  const baseRel = typeof opts?.rootRelative === "string" ? opts.rootRelative.trim() : ".";
  const resolved = resolveWorkspacePath(root, baseRel || ".");
  if (!resolved.ok) return { ok: false, ...resolved };
  const maxMatches = Math.min(DEFAULT_SEARCH_MAX, Math.max(1, Number(opts?.maxMatches) || DEFAULT_SEARCH_MAX));
  let filesScanned = 0;
  /** @type {Array<{ file: string; line: number; excerpt: string }>} */
  const matches = [];

  const ignoreDir = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    ".next",
    "coverage",
  ]);

  async function walkDir(dirAbs, relPrefix) {
    if (matches.length >= maxMatches || filesScanned >= MAX_SEARCH_FILES) return;
    let entries;
    try {
      entries = await readdir(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (matches.length >= maxMatches || filesScanned >= MAX_SEARCH_FILES) break;
      const childRel = relPrefix ? `${relPrefix}/${ent.name}` : ent.name;
      const guard = resolveWorkspacePath(root, childRel);
      if (!guard.ok) continue;
      const childAbs = guard.absPath;
      if (ent.isDirectory()) {
        if (ignoreDir.has(ent.name)) continue;
        await walkDir(childAbs, childRel);
        continue;
      }
      if (!ent.isFile()) continue;
      filesScanned++;
      let content;
      try {
        const st = await lstat(childAbs);
        if (!st.isFile() || st.size > DEFAULT_READ_MAX) continue;
        content = await readFile(childAbs, "utf8");
      } catch {
        continue;
      }
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length && matches.length < maxMatches; i++) {
        if (lines[i].includes(query)) {
          const excerpt = lines[i].length > 240 ? `${lines[i].slice(0, 240)}…` : lines[i];
          matches.push({ file: childRel.replace(/\\/g, "/"), line: i + 1, excerpt });
        }
      }
    }
  }

  try {
    const st = await lstat(resolved.absPath);
    if (st.isFile()) {
      filesScanned++;
      const content = await readFile(resolved.absPath, "utf8");
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length && matches.length < maxMatches; i++) {
        if (lines[i].includes(query)) {
          matches.push({
            file: String(baseRel || ".").replace(/\\/g, "/"),
            line: i + 1,
            excerpt: lines[i].slice(0, 240),
          });
        }
      }
    } else if (st.isDirectory()) {
      const prefix = baseRel === "." || baseRel === "" ? "" : baseRel.replace(/\\/g, "/");
      await walkDir(resolved.absPath, prefix);
    } else {
      return { ok: false, code: "UNSUPPORTED_ENTRY", error: "Not a file or directory" };
    }
  } catch (e) {
    return { ok: false, code: "FS_ERROR", error: String(e?.message || e) };
  }

  return {
    ok: true,
    query,
    rootRelative: baseRel || ".",
    matchCount: matches.length,
    truncated: matches.length >= maxMatches,
    filesScanned,
    matches,
  };
}
