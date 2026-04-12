/**
 * Phase 55.4: Filesystem agent.
 *
 * Path-guarded FS operations with dry-run preview, backups, and undo.
 * All public operations accept an optional `guard` (PathGuard instance) that
 * validates each resolved path against an allow/block list before touching
 * the disk. Session history supports single-step undo of the most recent
 * mutating operation (write / append / delete / rename / copy / mkdir).
 */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

// ---------------------------------------------------------------------------
// Path guards
// ---------------------------------------------------------------------------

export const SYSTEM_BLOCKED = [
  /^\/etc\//,
  /^\/sys\//,
  /^\/proc\//,
  /^\/dev\//,
  /\.ssh\//,
  /\.aws\//,
  /\.gnupg\//,
  /\/\.env$/,
  /\.pem$/,
  /\.key$/,
];

function defaultAllowedRoots() {
  const root = (process.env.WORKSPACE_ROOT || "").trim();
  return root ? [root] : [];
}

export class PathGuard {
  constructor({ allowedRoots = null, blockedPatterns = [] } = {}) {
    const roots = Array.isArray(allowedRoots) && allowedRoots.length > 0
      ? allowedRoots
      : defaultAllowedRoots();
    this.allowedRoots = roots.map((r) => path.resolve(String(r)));
    this.blockedPatterns = [...SYSTEM_BLOCKED, ...blockedPatterns];
  }

  /**
   * Strip any `..` segments from a raw path string. Null bytes are preserved
   * so callers can still reject them explicitly.
   */
  sanitize(p) {
    const raw = String(p ?? "");
    if (!raw) return "";
    const mixed = raw.replace(/\\/g, "/");
    const parts = mixed.split("/").filter((part) => part !== "" && part !== "." && part !== "..");
    const leading = mixed.startsWith("/") ? "/" : "";
    return leading + parts.join("/");
  }

  /**
   * Resolve a relative-or-absolute path against the first allowed root
   * (or the provided cwd). Does not touch the disk; returns an absolute path.
   */
  resolve(relOrAbsPath, cwd) {
    const raw = String(relOrAbsPath ?? "").trim();
    if (!raw) throw new Error("path is required");
    if (raw.includes("\0")) throw new Error("path contains null byte");
    if (path.isAbsolute(raw)) return path.resolve(raw);
    const base = cwd
      ? path.resolve(cwd)
      : this.allowedRoots[0] || process.cwd();
    return path.resolve(base, raw);
  }

  /**
   * Returns true iff `absPath` is inside one of the allowed roots and does
   * not match any blocked pattern. Absolute paths are required.
   */
  isAllowed(absPath) {
    const raw = String(absPath ?? "");
    if (!raw || raw.includes("\0")) return false;
    const resolved = path.resolve(raw);

    // Reject `..` traversal attempts even after resolution anomalies.
    if (raw.includes("..")) {
      const parts = raw.replace(/\\/g, "/").split("/");
      if (parts.includes("..")) return false;
    }

    for (const pattern of this.blockedPatterns) {
      if (pattern.test(resolved)) return false;
    }

    if (this.allowedRoots.length === 0) {
      // No roots configured → deny by default (safer for agent use).
      return false;
    }
    for (const root of this.allowedRoots) {
      const withSep = root.endsWith(path.sep) ? root : root + path.sep;
      if (resolved === root || resolved.startsWith(withSep)) return true;
    }
    return false;
  }
}

function ensureAllowed(guard, absPath) {
  const g = guard || new PathGuard();
  if (!g.isAllowed(absPath)) {
    const err = new Error(`Path not allowed: ${absPath}`);
    err.code = "PATH_DENIED";
    throw err;
  }
  return g;
}

function resolvePath(filepath, options = {}) {
  const guard = options.guard || new PathGuard();
  if (path.isAbsolute(String(filepath))) return { abs: path.resolve(String(filepath)), guard };
  const abs = guard.resolve(filepath, options.cwd);
  return { abs, guard };
}

// ---------------------------------------------------------------------------
// File operations
// ---------------------------------------------------------------------------

const DEFAULT_MAX_READ_BYTES = 2_000_000;

export async function readFile(filepath, options = {}) {
  const { abs, guard } = resolvePath(filepath, options);
  ensureAllowed(guard, abs);
  const encoding = options.encoding ?? "utf8";
  const maxBytes = Math.max(1, Number(options.maxBytes) || DEFAULT_MAX_READ_BYTES);
  const st = await fs.stat(abs);
  if (!st.isFile()) {
    const err = new Error("Not a regular file");
    err.code = "NOT_A_FILE";
    throw err;
  }
  if (st.size > maxBytes) {
    const err = new Error(`File size ${st.size} exceeds maxBytes ${maxBytes}`);
    err.code = "FILE_TOO_LARGE";
    throw err;
  }
  const buf = await fs.readFile(abs);
  return encoding ? buf.toString(encoding) : buf;
}

export async function writeFile(filepath, content, options = {}) {
  const { abs, guard } = resolvePath(filepath, options);
  ensureAllowed(guard, abs);
  const data = Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ""), options.encoding || "utf8");
  if (options.dryRun) {
    return { wouldWrite: true, path: abs, size: data.length };
  }
  await fs.mkdir(path.dirname(abs), { recursive: true });
  if (options.atomic) {
    await atomicWrite(abs, data, { guard });
  } else {
    await fs.writeFile(abs, data, { mode: options.mode });
  }
  return { ok: true, path: abs, size: data.length };
}

export async function appendFile(filepath, content, options = {}) {
  const { abs, guard } = resolvePath(filepath, options);
  ensureAllowed(guard, abs);
  const data = Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ""), options.encoding || "utf8");
  if (options.dryRun) {
    return { wouldAppend: true, path: abs, size: data.length };
  }
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.appendFile(abs, data);
  return { ok: true, path: abs, size: data.length };
}

export async function deleteFile(filepath, options = {}) {
  const { abs, guard } = resolvePath(filepath, options);
  ensureAllowed(guard, abs);
  if (options.dryRun) {
    return { wouldDelete: true, path: abs };
  }
  await fs.unlink(abs);
  return { ok: true, path: abs };
}

export async function renameFile(src, dest, options = {}) {
  const { abs: srcAbs, guard } = resolvePath(src, options);
  const destAbs = (options.guard || guard).isAllowed(path.resolve(String(dest)))
    ? path.resolve(String(dest))
    : resolvePath(dest, { ...options, guard }).abs;
  ensureAllowed(guard, srcAbs);
  ensureAllowed(guard, destAbs);
  if (options.dryRun) {
    return { wouldRename: true, from: srcAbs, to: destAbs };
  }
  await fs.mkdir(path.dirname(destAbs), { recursive: true });
  await fs.rename(srcAbs, destAbs);
  return { ok: true, from: srcAbs, to: destAbs };
}

export async function copyFile(src, dest, options = {}) {
  const { abs: srcAbs, guard } = resolvePath(src, options);
  const destAbs = path.isAbsolute(String(dest))
    ? path.resolve(String(dest))
    : resolvePath(dest, { ...options, guard }).abs;
  ensureAllowed(guard, srcAbs);
  ensureAllowed(guard, destAbs);
  if (options.dryRun) {
    return { wouldCopy: true, from: srcAbs, to: destAbs };
  }
  await fs.mkdir(path.dirname(destAbs), { recursive: true });
  await fs.copyFile(srcAbs, destAbs);
  return { ok: true, from: srcAbs, to: destAbs };
}

export async function createDir(dirpath, options = {}) {
  const { abs, guard } = resolvePath(dirpath, options);
  ensureAllowed(guard, abs);
  if (options.dryRun) {
    return { wouldCreate: true, path: abs };
  }
  await fs.mkdir(abs, { recursive: true });
  return { ok: true, path: abs };
}

export async function removeDir(dirpath, options = {}) {
  const { abs, guard } = resolvePath(dirpath, options);
  ensureAllowed(guard, abs);
  if (options.dryRun) {
    return { wouldRemove: true, path: abs };
  }
  await fs.rm(abs, { recursive: Boolean(options.recursive), force: Boolean(options.force) });
  return { ok: true, path: abs };
}

export async function listDir(dirpath, options = {}) {
  const { abs, guard } = resolvePath(dirpath, options);
  ensureAllowed(guard, abs);
  const entries = await fs.readdir(abs, { withFileTypes: true });
  const limit = Math.max(1, Number(options.limit) || 500);
  const out = entries.slice(0, limit).map((e) => ({
    name: e.name,
    type: e.isDirectory() ? "dir" : e.isFile() ? "file" : e.isSymbolicLink() ? "symlink" : "other",
  }));
  return { path: abs, entries: out, truncated: entries.length > limit, total: entries.length };
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

export async function getStats(filepath, options = {}) {
  const { abs, guard } = resolvePath(filepath, options);
  ensureAllowed(guard, abs);
  const st = await fs.stat(abs);
  return {
    path: abs,
    size: st.size,
    mode: st.mode,
    mtimeMs: st.mtimeMs,
    ctimeMs: st.ctimeMs,
    birthtimeMs: st.birthtimeMs,
    isFile: st.isFile(),
    isDirectory: st.isDirectory(),
    isSymlink: st.isSymbolicLink(),
  };
}

export async function exists(filepath, options = {}) {
  try {
    const { abs, guard } = resolvePath(filepath, options);
    ensureAllowed(guard, abs);
    await fs.access(abs);
    return true;
  } catch {
    return false;
  }
}

export async function isFile(filepath, options = {}) {
  try {
    const st = await getStats(filepath, options);
    return st.isFile;
  } catch {
    return false;
  }
}

export async function isDir(filepath, options = {}) {
  try {
    const st = await getStats(filepath, options);
    return st.isDirectory;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

const DEFAULT_FIND_MAX = 500;
const DEFAULT_SEARCH_MAX = 200;
const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage"]);

function globToRegex(glob) {
  if (!glob) return /.*/;
  // Escape regex specials, then convert glob tokens.
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if ("\\^$.|()+{}[]".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}

export async function findFiles(root, pattern, options = {}) {
  const { abs: rootAbs, guard } = resolvePath(root, options);
  ensureAllowed(guard, rootAbs);
  const re = globToRegex(String(pattern || "*"));
  const maxResults = Math.max(1, Number(options.maxResults) || DEFAULT_FIND_MAX);
  const results = [];

  async function walk(dir) {
    if (results.length >= maxResults) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (results.length >= maxResults) return;
      const full = path.join(dir, ent.name);
      if (!guard.isAllowed(full)) continue;
      if (ent.isDirectory()) {
        if (IGNORE_DIRS.has(ent.name)) continue;
        await walk(full);
        continue;
      }
      if (ent.isFile() && re.test(ent.name)) {
        results.push(full);
      }
    }
  }

  await walk(rootAbs);
  return { root: rootAbs, pattern: String(pattern || "*"), matches: results, truncated: results.length >= maxResults };
}

export async function searchInFiles(root, searchPattern, options = {}) {
  const { abs: rootAbs, guard } = resolvePath(root, options);
  ensureAllowed(guard, rootAbs);
  const query = String(searchPattern || "");
  if (!query) {
    const err = new Error("searchPattern is required");
    err.code = "INVALID_INPUT";
    throw err;
  }
  const maxMatches = Math.max(1, Number(options.maxMatches) || DEFAULT_SEARCH_MAX);
  const maxBytes = Math.max(1, Number(options.maxBytes) || DEFAULT_MAX_READ_BYTES);
  const useRegex = options.regex === true;
  const re = useRegex ? new RegExp(query) : null;
  const matches = [];
  let filesScanned = 0;

  async function walk(dir) {
    if (matches.length >= maxMatches) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (matches.length >= maxMatches) return;
      const full = path.join(dir, ent.name);
      if (!guard.isAllowed(full)) continue;
      if (ent.isDirectory()) {
        if (IGNORE_DIRS.has(ent.name)) continue;
        await walk(full);
        continue;
      }
      if (!ent.isFile()) continue;
      filesScanned++;
      let content;
      try {
        const st = await fs.stat(full);
        if (st.size > maxBytes) continue;
        content = await fs.readFile(full, "utf8");
      } catch {
        continue;
      }
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length && matches.length < maxMatches; i++) {
        const line = lines[i];
        const hit = re ? re.test(line) : line.includes(query);
        if (hit) {
          const excerpt = line.length > 240 ? line.slice(0, 240) + "…" : line;
          matches.push({ file: full, line: i + 1, excerpt });
        }
      }
    }
  }

  await walk(rootAbs);
  return { root: rootAbs, query, filesScanned, matchCount: matches.length, matches, truncated: matches.length >= maxMatches };
}

// ---------------------------------------------------------------------------
// Dry-run preview
// ---------------------------------------------------------------------------

const PREVIEW_OPS = {
  write: (args) => writeFile(args.path, args.content ?? "", { ...args, dryRun: true }),
  append: (args) => appendFile(args.path, args.content ?? "", { ...args, dryRun: true }),
  delete: (args) => deleteFile(args.path, { ...args, dryRun: true }),
  rename: (args) => renameFile(args.src, args.dest, { ...args, dryRun: true }),
  copy: (args) => copyFile(args.src, args.dest, { ...args, dryRun: true }),
  mkdir: (args) => createDir(args.path, { ...args, dryRun: true }),
  rmdir: (args) => removeDir(args.path, { ...args, dryRun: true }),
};

export async function previewOperation(operation, options = {}) {
  const op = operation || {};
  const type = String(op.type || "");
  const fn = PREVIEW_OPS[type];
  if (!fn) {
    const err = new Error(`Unknown operation type: ${type}`);
    err.code = "UNKNOWN_OP";
    throw err;
  }
  const merged = { ...(op.args || {}) };
  if (options.guard) merged.guard = options.guard;
  const args = merged;
  try {
    const preview = await fn(args);
    return { ok: true, type, preview };
  } catch (e) {
    return { ok: false, type, error: e?.message || String(e), code: e?.code || "ERROR" };
  }
}

export async function batchPreview(operations) {
  const list = Array.isArray(operations) ? operations : [];
  const out = [];
  for (const op of list) {
    // eslint-disable-next-line no-await-in-loop
    out.push(await previewOperation(op));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Backup / undo
// ---------------------------------------------------------------------------

function backupIndexPath() {
  return path.join(getDataDir(), "fs-agent-backups.json");
}

function defaultBackupDir() {
  return path.join(getDataDir(), "fs-agent-backups");
}

export async function backupFile(filepath, backupDir) {
  const guard = new PathGuard();
  const abs = path.isAbsolute(String(filepath)) ? path.resolve(String(filepath)) : guard.resolve(filepath);
  ensureAllowed(guard, abs);
  const dir = backupDir ? path.resolve(backupDir) : defaultBackupDir();
  await fs.mkdir(dir, { recursive: true });
  const id = crypto.randomBytes(8).toString("hex");
  const dest = path.join(dir, `${id}.bak`);
  const content = await fs.readFile(abs);
  await fs.writeFile(dest, content);
  const entry = { id, originalPath: abs, backupPath: dest, size: content.length, createdAt: new Date().toISOString() };
  await withPathLock(backupIndexPath(), async () => {
    const store = await readJsonPath(backupIndexPath(), { backups: [] });
    store.backups = Array.isArray(store.backups) ? store.backups : [];
    store.backups.push(entry);
    await writeJsonPath(backupIndexPath(), store);
  });
  return entry;
}

export async function restoreBackup(backupId) {
  const store = await readJsonPath(backupIndexPath(), { backups: [] });
  const entry = Array.isArray(store.backups) ? store.backups.find((b) => b.id === backupId) : null;
  if (!entry) {
    const err = new Error(`Backup ${backupId} not found`);
    err.code = "NOT_FOUND";
    throw err;
  }
  const guard = new PathGuard();
  ensureAllowed(guard, entry.originalPath);
  const content = await fs.readFile(entry.backupPath);
  await fs.mkdir(path.dirname(entry.originalPath), { recursive: true });
  await fs.writeFile(entry.originalPath, content);
  return { ok: true, restored: entry.originalPath, id: backupId };
}

export async function listBackups(filepath = null) {
  const store = await readJsonPath(backupIndexPath(), { backups: [] });
  const all = Array.isArray(store.backups) ? store.backups : [];
  if (!filepath) return all;
  const target = path.resolve(String(filepath));
  return all.filter((b) => b.originalPath === target);
}

// ---------------------------------------------------------------------------
// Atomic writes
// ---------------------------------------------------------------------------

export async function atomicWrite(filepath, content, options = {}) {
  const abs = path.isAbsolute(String(filepath)) ? path.resolve(String(filepath)) : resolvePath(filepath, options).abs;
  if (options.guard) ensureAllowed(options.guard, abs);
  const dir = path.dirname(abs);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(abs)}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  const data = Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ""), "utf8");
  await fs.writeFile(tmp, data);
  try {
    await fs.rename(tmp, abs);
  } catch (e) {
    // Best-effort cleanup on rename failure.
    try { await fs.unlink(tmp); } catch {}
    throw e;
  }
  return { ok: true, path: abs, size: data.length };
}

// ---------------------------------------------------------------------------
// Session / history / undo
// ---------------------------------------------------------------------------

function sessionStorePath() {
  return path.join(getDataDir(), "fs-agent-sessions.json");
}

async function readSessionStore() {
  return await readJsonPath(sessionStorePath(), { sessions: {} });
}

async function writeSessionStore(data) {
  await writeJsonPath(sessionStorePath(), data);
}

export async function createFsSession(name, options = {}) {
  const id = crypto.randomBytes(8).toString("hex");
  const session = {
    id,
    name: String(name || "unnamed"),
    allowedRoots: Array.isArray(options.allowedRoots) ? options.allowedRoots : null,
    createdAt: new Date().toISOString(),
    history: [],
  };
  await withPathLock(sessionStorePath(), async () => {
    const store = await readSessionStore();
    store.sessions = store.sessions || {};
    store.sessions[id] = session;
    await writeSessionStore(store);
  });
  return session;
}

export async function recordFsOperation(sessionId, operation, result) {
  const entry = {
    ts: new Date().toISOString(),
    operation: operation || null,
    result: result || null,
  };
  await withPathLock(sessionStorePath(), async () => {
    const store = await readSessionStore();
    const session = store.sessions?.[sessionId];
    if (!session) {
      const err = new Error(`Session ${sessionId} not found`);
      err.code = "NOT_FOUND";
      throw err;
    }
    session.history = Array.isArray(session.history) ? session.history : [];
    session.history.push(entry);
    await writeSessionStore(store);
  });
  return entry;
}

export async function getFsHistory(sessionId) {
  const store = await readSessionStore();
  const session = store.sessions?.[sessionId];
  if (!session) {
    const err = new Error(`Session ${sessionId} not found`);
    err.code = "NOT_FOUND";
    throw err;
  }
  return Array.isArray(session.history) ? session.history : [];
}

/**
 * Undo the most recent mutating operation recorded for a session.
 *
 * Supported ops (best-effort):
 *   write   → restore from backup if one was captured, else delete the file
 *   append  → truncate the file back to its pre-append size if known
 *   delete  → restore from backup if one was captured
 *   rename  → rename back from dest → src
 *   copy    → delete the copied destination
 *   mkdir   → remove the directory if empty
 *
 * Undo entries are removed from history once processed.
 */
export async function undoLastFsOperation(sessionId) {
  let undone = null;
  await withPathLock(sessionStorePath(), async () => {
    const store = await readSessionStore();
    const session = store.sessions?.[sessionId];
    if (!session) {
      const err = new Error(`Session ${sessionId} not found`);
      err.code = "NOT_FOUND";
      throw err;
    }
    const hist = Array.isArray(session.history) ? session.history : [];
    const entry = hist.pop();
    if (!entry) {
      undone = { ok: false, reason: "empty history" };
      await writeSessionStore(store);
      return;
    }
    try {
      const op = entry.operation || {};
      const result = entry.result || {};
      const type = op.type;
      if (type === "write") {
        if (result.backupId) {
          await restoreBackup(result.backupId);
        } else if (result.path) {
          try { await fs.unlink(result.path); } catch {}
        }
      } else if (type === "append") {
        if (typeof result.previousSize === "number" && result.path) {
          await fs.truncate(result.path, result.previousSize);
        }
      } else if (type === "delete") {
        if (result.backupId) {
          await restoreBackup(result.backupId);
        }
      } else if (type === "rename") {
        if (result.from && result.to) {
          await fs.rename(result.to, result.from);
        }
      } else if (type === "copy") {
        if (result.to) {
          try { await fs.unlink(result.to); } catch {}
        }
      } else if (type === "mkdir") {
        if (result.path) {
          try { await fs.rmdir(result.path); } catch {}
        }
      }
      undone = { ok: true, type, entry };
    } catch (e) {
      undone = { ok: false, error: e?.message || String(e) };
    }
    await writeSessionStore(store);
  });
  return undone;
}

export default {
  PathGuard,
  SYSTEM_BLOCKED,
  readFile,
  writeFile,
  appendFile,
  deleteFile,
  renameFile,
  copyFile,
  createDir,
  removeDir,
  listDir,
  getStats,
  exists,
  isFile,
  isDir,
  findFiles,
  searchInFiles,
  previewOperation,
  batchPreview,
  backupFile,
  restoreBackup,
  listBackups,
  atomicWrite,
  createFsSession,
  recordFsOperation,
  getFsHistory,
  undoLastFsOperation,
};
