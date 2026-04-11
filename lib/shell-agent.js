// @ts-check
/**
 * Phase 55.3: Sandboxed shell agent.
 *
 * Run operator-approved shell commands inside a directory jail with a
 * timeout, output capture, an allowlist filter, and checkpoint/rollback
 * support so dangerous operations can be undone on failure.
 *
 * Design notes:
 *   - `child_process` is injected via the `exec` option on `runShellCommand`
 *     so unit tests can replace it with a mock and never spawn a real shell.
 *   - Checkpoints snapshot the directory tree with relative paths + content
 *     and store the snapshot via `json-path-store.js`. Restoration writes
 *     each file back to its original location and deletes files created
 *     after the checkpoint.
 *   - The allowlist is a list of exact command names OR regex strings; the
 *     first token (before any whitespace) must match.
 *
 * Exposed API:
 *   - `runShellCommand(cmd, opts)`  -- returns `{ stdout, stderr, code, duration }`
 *   - `createCheckpoint(dir, label)`
 *   - `restoreCheckpoint(id)`
 *   - `listCheckpoints()`
 *   - `isCommandAllowed(cmd, allowlist)`
 *   - `setDefaultAllowlist(list)` / `getDefaultAllowlist()`
 *
 * @module shell-agent
 */
import { randomUUID } from "crypto";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, readdirSync, statSync, rmSync } from "fs";
import { dirname, join, relative, resolve, isAbsolute } from "path";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;

const DEFAULT_ALLOWLIST = [
  "ls",
  "pwd",
  "cat",
  "echo",
  "node",
  "npm",
  "git",
  "grep",
  "head",
  "tail",
  "wc",
  "find",
];

let _allowlist = [...DEFAULT_ALLOWLIST];

/* -------------------------------------------------------------------------- */
/* Allowlist                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Is the command's leading token allowed by the given (or default) list?
 *
 * @param {string} cmd
 * @param {string[]} [allowlist]
 * @returns {boolean}
 */
export function isCommandAllowed(cmd, allowlist) {
  if (typeof cmd !== "string" || !cmd.trim()) return false;
  const list = Array.isArray(allowlist) ? allowlist : _allowlist;
  // Reject shell metacharacters the caller didn't intend.
  if (/[;&|`$<>]/.test(cmd)) return false;
  const firstToken = cmd.trim().split(/\s+/)[0] || "";
  const base = firstToken.split("/").pop() || firstToken;
  for (const entry of list) {
    if (typeof entry !== "string" || !entry) continue;
    if (entry === base) return true;
    if (entry.startsWith("^") || entry.endsWith("$")) {
      try {
        const re = new RegExp(entry);
        if (re.test(base)) return true;
      } catch (_) { /* skip bad regex */ }
    }
  }
  return false;
}

/**
 * Replace the process-wide default allowlist.
 * @param {string[]} list
 */
export function setDefaultAllowlist(list) {
  if (!Array.isArray(list)) throw new Error("allowlist must be an array");
  _allowlist = [...list];
}

/** Get a copy of the default allowlist. */
export function getDefaultAllowlist() {
  return [..._allowlist];
}

/* -------------------------------------------------------------------------- */
/* Jail resolution                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Ensure `cwd` is a real directory inside `root`. Throws on escape attempts.
 * @param {string} root
 * @param {string} cwd
 * @returns {string}
 */
function jailedCwd(root, cwd) {
  if (!root || typeof root !== "string") {
    throw new Error("root directory is required");
  }
  if (!existsSync(root)) {
    throw new Error(`root does not exist: ${root}`);
  }
  const absRoot = resolve(root);
  const absCwd = cwd ? resolve(absRoot, cwd) : absRoot;
  const rel = relative(absRoot, absCwd);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("cwd escapes root");
  }
  return absCwd;
}

/* -------------------------------------------------------------------------- */
/* runShellCommand                                                            */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} RunResult
 * @property {string} stdout
 * @property {string} stderr
 * @property {number|null} code
 * @property {number} duration
 * @property {boolean} timedOut
 * @property {string} command
 * @property {string} cwd
 */

/**
 * Execute a command inside a jailed working directory.
 *
 * The caller MUST pass an `exec` function (matching child_process.exec's
 * signature) or one will be dynamically imported. Tests should pass a mock.
 *
 * @param {string} cmd
 * @param {{ root: string, cwd?: string, timeoutMs?: number, allowlist?: string[], exec?: Function, env?: Record<string,string> }} opts
 * @returns {Promise<RunResult>}
 */
export async function runShellCommand(cmd, opts = {}) {
  if (typeof cmd !== "string" || !cmd.trim()) {
    throw new Error("command is required");
  }
  if (!opts || !opts.root) {
    throw new Error("opts.root is required");
  }
  if (!isCommandAllowed(cmd, opts.allowlist)) {
    throw new Error(`command not in allowlist: ${cmd}`);
  }
  const cwd = jailedCwd(opts.root, opts.cwd || "");
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
    ? Math.floor(opts.timeoutMs)
    : 10_000;

  const execFn = opts.exec || (await defaultExecFactory());
  const started = Date.now();

  /** @type {RunResult} */
  const result = {
    stdout: "",
    stderr: "",
    code: null,
    duration: 0,
    timedOut: false,
    command: cmd,
    cwd,
  };

  return new Promise((resolvePromise) => {
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      result.timedOut = true;
      result.duration = Date.now() - started;
      resolvePromise(result);
    }, timeoutMs);

    try {
      execFn(
        cmd,
        { cwd, env: opts.env || process.env, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          result.stdout = stdout != null ? String(stdout) : "";
          result.stderr = stderr != null ? String(stderr) : "";
          result.code = err && typeof err.code === "number" ? err.code : err ? 1 : 0;
          result.duration = Date.now() - started;
          resolvePromise(result);
        },
      );
    } catch (err) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      result.stderr = String(err?.message || err);
      result.code = 1;
      result.duration = Date.now() - started;
      resolvePromise(result);
    }
  });
}

async function defaultExecFactory() {
  try {
    const mod = await import("child_process");
    return mod.exec;
  } catch (_) {
    throw new Error("child_process unavailable; pass opts.exec for tests");
  }
}

/* -------------------------------------------------------------------------- */
/* Checkpoints                                                                */
/* -------------------------------------------------------------------------- */

function checkpointsPath() {
  return join(getDataDir(), "shell-agent-checkpoints.json");
}

async function loadCheckpoints() {
  const data = await readJsonPath(checkpointsPath(), {
    version: STORE_VERSION,
    checkpoints: {},
  });
  if (!data || typeof data !== "object") return { version: STORE_VERSION, checkpoints: {} };
  if (!data.checkpoints || typeof data.checkpoints !== "object") data.checkpoints = {};
  return data;
}

async function saveCheckpointsStore(data) {
  await writeJsonPath(checkpointsPath(), {
    version: STORE_VERSION,
    checkpoints: data.checkpoints || {},
  });
}

/**
 * Walk a directory and return `[{ relPath, content, mode }]` for every file.
 * @param {string} root
 */
function snapshotDir(root) {
  const absRoot = resolve(root);
  if (!existsSync(absRoot) || !statSync(absRoot).isDirectory()) {
    throw new Error(`checkpoint root is not a directory: ${absRoot}`);
  }
  /** @type {Array<{ relPath: string, content: string, isFile: boolean }>} */
  const files = [];
  /** @type {string[]} */
  const dirs = [];
  walkDir(absRoot, absRoot, files, dirs);
  return { root: absRoot, files, dirs };
}

function walkDir(root, current, files, dirs) {
  let entries;
  try {
    entries = readdirSync(current, { withFileTypes: true });
  } catch (_) {
    return;
  }
  for (const e of entries) {
    const full = join(current, e.name);
    const rel = relative(root, full);
    if (rel.startsWith(".checkpoints")) continue; // skip our own storage
    if (e.isDirectory()) {
      dirs.push(rel);
      walkDir(root, full, files, dirs);
      continue;
    }
    if (e.isFile()) {
      try {
        const content = readFileSync(full, "utf8");
        files.push({ relPath: rel, content, isFile: true });
      } catch (_) { /* skip unreadable files */ }
    }
  }
}

/**
 * Create a checkpoint for a directory. Returns the checkpoint id.
 *
 * @param {string} root
 * @param {string} [label]
 * @returns {Promise<{ id: string, fileCount: number, createdAt: string, root: string, label: string }>}
 */
export async function createCheckpoint(root, label = "") {
  const snap = snapshotDir(root);
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const record = {
    id,
    root: snap.root,
    label: label || "",
    createdAt,
    files: snap.files,
    dirs: snap.dirs,
    version: STORE_VERSION,
  };
  const path = checkpointsPath();
  await withPathLock(path, async () => {
    const data = await loadCheckpoints();
    data.checkpoints[id] = record;
    await saveCheckpointsStore(data);
  });
  return { id, fileCount: snap.files.length, createdAt, root: snap.root, label };
}

/**
 * Restore a checkpoint: rewrite every captured file and delete any files
 * created after the checkpoint was taken.
 *
 * @param {string} id
 */
export async function restoreCheckpoint(id) {
  if (!id || typeof id !== "string") throw new Error("id is required");
  const data = await loadCheckpoints();
  const record = data.checkpoints[id];
  if (!record) throw new Error(`checkpoint not found: ${id}`);
  const root = record.root;
  if (!existsSync(root)) {
    mkdirSync(root, { recursive: true });
  }
  // Recreate directories.
  for (const d of record.dirs || []) {
    const abs = join(root, d);
    if (!existsSync(abs)) mkdirSync(abs, { recursive: true });
  }
  // Rewrite files.
  /** @type {Set<string>} */
  const knownRel = new Set();
  for (const f of record.files || []) {
    const abs = join(root, f.relPath);
    const parent = dirname(abs);
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
    writeFileSync(abs, typeof f.content === "string" ? f.content : "", "utf8");
    knownRel.add(f.relPath);
  }
  // Delete files created after checkpoint.
  const current = snapshotDir(root);
  for (const f of current.files) {
    if (!knownRel.has(f.relPath)) {
      try {
        unlinkSync(join(root, f.relPath));
      } catch (_) { /* best effort */ }
    }
  }
  return {
    id,
    filesRestored: record.files.length,
    root,
  };
}

/**
 * List checkpoints (without file contents).
 * @returns {Promise<Array<{ id: string, root: string, label: string, createdAt: string, fileCount: number }>>}
 */
export async function listCheckpoints() {
  const data = await loadCheckpoints();
  return Object.values(data.checkpoints || {})
    .map((c) => ({
      id: c.id,
      root: c.root,
      label: c.label || "",
      createdAt: c.createdAt,
      fileCount: Array.isArray(c.files) ? c.files.length : 0,
    }))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

/**
 * Delete a single checkpoint record. Does NOT touch the file system.
 * @param {string} id
 */
export async function deleteCheckpoint(id) {
  if (!id) return false;
  const path = checkpointsPath();
  return withPathLock(path, async () => {
    const data = await loadCheckpoints();
    if (!data.checkpoints[id]) return false;
    delete data.checkpoints[id];
    await saveCheckpointsStore(data);
    return true;
  });
}

/**
 * Convenience: nuke everything recursively under a directory that lives
 * inside `root`. Unused by runShellCommand but exported for tests that
 * want to exercise checkpoint restoration after a destructive op.
 *
 * @param {string} root
 * @param {string} relPath
 */
export function rmDirUnderRoot(root, relPath) {
  const abs = jailedCwd(root, relPath || ".");
  rmSync(abs, { recursive: true, force: true });
}
