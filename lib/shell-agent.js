// @ts-check
/**
 * Phase 55.3: Shell agent — sandboxed terminal with rollback checkpoints.
 *
 * Provides command validation, guarded execution, and filesystem checkpointing
 * so that an agent can safely operate a terminal-like environment without
 * destroying state. All shell sessions are persisted through
 * `json-path-store.js`, and every command goes through a restrictive default
 * policy (allowlist + blocklist patterns, timeouts, and per-session rate
 * limits).
 *
 * This module intentionally avoids any new dependencies — it relies on the
 * Node.js built-in `node:child_process`, `node:fs`, and `node:crypto`
 * primitives to implement the shell and checkpointing logic.
 *
 * @module shell-agent
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const STORE_VERSION = 1;

// ---------------------------------------------------------------------------
// Policy defaults
// ---------------------------------------------------------------------------

export const DEFAULT_ALLOWED_COMMANDS = [
  "ls",
  "cat",
  "grep",
  "find",
  "echo",
  "pwd",
  "git status",
  "git diff",
  "git log",
];

export const DEFAULT_BLOCKED_PATTERNS = [
  /rm\s+-rf/,
  /dd\s+if=/,
  /mkfs/,
  /:\(\)\s*\{\s*:\|:&\s*\}\s*;:/,
  />/, // redirect
  /sudo/,
  /chmod\s+777/,
  /curl.*\|\s*sh/,
  /wget.*\|\s*sh/,
];

export const DEFAULT_LIMITS = {
  timeoutMs: 10000,
  maxBufferBytes: 1024 * 1024,
  maxCommandsPerMinute: 30,
};

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

function storePath() {
  return join(getDataDir(), "shell-agent.json");
}

function normalizeStore(raw) {
  const base = raw && typeof raw === "object" ? raw : {};
  return {
    _version: STORE_VERSION,
    sessions: base.sessions && typeof base.sessions === "object" ? base.sessions : {},
    history: base.history && typeof base.history === "object" ? base.history : {},
    checkpoints: base.checkpoints && typeof base.checkpoints === "object" ? base.checkpoints : {},
  };
}

async function loadStore() {
  return normalizeStore(
    await readJsonPath(storePath(), {
      _version: STORE_VERSION,
      sessions: {},
      history: {},
      checkpoints: {},
    }),
  );
}

async function saveStore(store) {
  await writeJsonPath(storePath(), store);
}

async function mutate(fn) {
  return withPathLock(storePath(), async () => {
    const store = await loadStore();
    const result = await fn(store);
    await saveStore(store);
    return result;
  });
}

function now() {
  return Date.now();
}

// ---------------------------------------------------------------------------
// Command parsing & validation
// ---------------------------------------------------------------------------

/**
 * Parse a raw command string into argv, env assignments, and redirect targets.
 * This is a *very* small shell-compatible parser — it only supports the tiny
 * subset needed for validation (quoted arguments, environment VAR=value
 * prefixes, and simple redirect operators like `>` and `>>`).
 * @param {string} command
 * @returns {{ argv: string[], env: Record<string,string>, redirects: string[] }}
 */
export function parseCommand(command) {
  const env = {};
  const redirects = [];
  const argv = [];
  if (typeof command !== "string" || command.trim() === "") {
    return { argv, env, redirects };
  }
  const tokens = tokenize(command);
  let i = 0;
  // Strip leading VAR=value assignments.
  while (i < tokens.length) {
    const tok = tokens[i];
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(tok);
    if (m && argv.length === 0) {
      env[m[1]] = m[2];
      i += 1;
      continue;
    }
    break;
  }
  for (; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (tok === ">" || tok === ">>" || tok === "2>" || tok === "&>") {
      const next = tokens[i + 1];
      if (next) {
        redirects.push(next);
        i += 1;
      }
      continue;
    }
    argv.push(tok);
  }
  return { argv, env, redirects };
}

function tokenize(input) {
  const out = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i];
    if (c === " " || c === "\t") {
      i += 1;
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      i += 1;
      let buf = "";
      while (i < input.length && input[i] !== quote) {
        if (input[i] === "\\" && i + 1 < input.length) {
          buf += input[i + 1];
          i += 2;
          continue;
        }
        buf += input[i];
        i += 1;
      }
      i += 1;
      out.push(buf);
      continue;
    }
    let buf = "";
    while (i < input.length && input[i] !== " " && input[i] !== "\t") {
      buf += input[i];
      i += 1;
    }
    out.push(buf);
  }
  return out;
}

/**
 * Validate a command string against the policy. Returns `{ allowed, reason? }`.
 * @param {string} command
 * @param {{ allowedCommands?: string[], blockedPatterns?: RegExp[], allowAny?: boolean }} [policy]
 */
export function validateCommand(command, policy = {}) {
  if (typeof command !== "string" || command.trim() === "") {
    return { allowed: false, reason: "command must be a non-empty string" };
  }
  const trimmed = command.trim();
  if (trimmed.length > 4096) {
    return { allowed: false, reason: "command exceeds 4096 characters" };
  }
  const blocked = policy.blockedPatterns || DEFAULT_BLOCKED_PATTERNS;
  for (const pattern of blocked) {
    if (pattern.test(trimmed)) {
      return { allowed: false, reason: `blocked by pattern ${pattern}` };
    }
  }
  if (policy.allowAny === true) {
    return { allowed: true };
  }
  const allowed = policy.allowedCommands || DEFAULT_ALLOWED_COMMANDS;
  for (const prefix of allowed) {
    if (trimmed === prefix) return { allowed: true };
    if (trimmed.startsWith(prefix + " ")) return { allowed: true };
  }
  return { allowed: false, reason: `command "${trimmed.split(" ")[0]}" not in allowlist` };
}

/**
 * Remove obviously dangerous constructs from a command and return the
 * sanitized version. Does not make the result safe to execute; always run
 * `validateCommand` before executing.
 * @param {string} command
 */
export function sanitizeCommand(command) {
  if (typeof command !== "string") return "";
  let out = command;
  // Strip shell metacharacters that are never allowed in sandbox mode.
  out = out.replace(/`[^`]*`/g, "");
  out = out.replace(/\$\([^)]*\)/g, "");
  out = out.replace(/[;&|]{1,2}/g, " ");
  out = out.replace(/>{1,2}/g, " ");
  out = out.replace(/\s+/g, " ").trim();
  return out;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/**
 * Execute a single command with the given options. Runs without a shell
 * (so shell metacharacters are not expanded) unless `options.useShell` is
 * explicitly set.
 *
 * @param {string} command
 * @param {{ cwd?: string, env?: Record<string,string>, timeout?: number, maxBuffer?: number, stdin?: string, dryRun?: boolean, policy?: object, useShell?: boolean }} [options]
 * @returns {Promise<{ stdout: string, stderr: string, exitCode: number, durationMs: number, truncated: boolean, command: string, dryRun?: boolean }>}
 */
export async function executeCommand(command, options = {}) {
  const policy = options.policy || {};
  const validation = validateCommand(command, policy);
  if (!validation.allowed) {
    const err = new Error(validation.reason || "command blocked");
    err.code = "COMMAND_BLOCKED";
    throw err;
  }

  if (options.dryRun) {
    return {
      stdout: "",
      stderr: "",
      exitCode: 0,
      durationMs: 0,
      truncated: false,
      command,
      dryRun: true,
    };
  }

  const parsed = parseCommand(command);
  if (parsed.argv.length === 0) {
    const err = new Error("no argv parsed from command");
    err.code = "COMMAND_INVALID";
    throw err;
  }
  const [program, ...args] = parsed.argv;

  const timeout = Number.isFinite(options.timeout) ? options.timeout : DEFAULT_LIMITS.timeoutMs;
  const maxBuffer = Number.isFinite(options.maxBuffer) ? options.maxBuffer : DEFAULT_LIMITS.maxBufferBytes;
  const cwd = typeof options.cwd === "string" ? options.cwd : process.cwd();
  const envVars = { ...process.env, ...parsed.env, ...(options.env || {}) };

  const started = now();
  return await new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(program, args, {
        cwd,
        env: envVars,
        shell: options.useShell === true,
      });
    } catch (err) {
      resolvePromise({
        stdout: "",
        stderr: String(err?.message || err),
        exitCode: -1,
        durationMs: now() - started,
        truncated: false,
        command,
      });
      return;
    }

    let stdoutBuf = "";
    let stderrBuf = "";
    let truncated = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, timeout);

    child.stdout.on("data", (chunk) => {
      if (stdoutBuf.length >= maxBuffer) {
        truncated = true;
        return;
      }
      const str = chunk.toString("utf8");
      const room = maxBuffer - stdoutBuf.length;
      if (str.length > room) {
        stdoutBuf += str.slice(0, room);
        truncated = true;
      } else {
        stdoutBuf += str;
      }
    });
    child.stderr.on("data", (chunk) => {
      if (stderrBuf.length >= maxBuffer) {
        truncated = true;
        return;
      }
      const str = chunk.toString("utf8");
      const room = maxBuffer - stderrBuf.length;
      if (str.length > room) {
        stderrBuf += str.slice(0, room);
        truncated = true;
      } else {
        stderrBuf += str;
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolvePromise({
        stdout: stdoutBuf,
        stderr: String(err?.message || err),
        exitCode: -1,
        durationMs: now() - started,
        truncated,
        command,
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({
        stdout: stdoutBuf,
        stderr: timedOut ? stderrBuf + "\n[timed out]" : stderrBuf,
        exitCode: timedOut ? 124 : code ?? -1,
        durationMs: now() - started,
        truncated,
        command,
      });
    });

    if (typeof options.stdin === "string" && options.stdin.length > 0) {
      try {
        child.stdin.write(options.stdin);
      } catch {
        /* ignore */
      }
    }
    try {
      child.stdin.end();
    } catch {
      /* ignore */
    }
  });
}

/**
 * Execute a multi-line script, line by line. Stops on the first non-zero
 * exit unless `options.continueOnError` is set.
 * @param {string} script
 * @param {object} [options]
 */
export async function executeScript(script, options = {}) {
  const lines = String(script || "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
  const results = [];
  for (const line of lines) {
    const result = await executeCommand(line, options);
    results.push(result);
    if (result.exitCode !== 0 && !options.continueOnError) break;
  }
  return results;
}

/**
 * Report what would happen if a command were executed, without running it.
 * @param {string} command
 * @param {object} [policy]
 */
export function dryRun(command, policy = {}) {
  const validation = validateCommand(command, policy);
  const parsed = parseCommand(command);
  return {
    command,
    wouldExecute: validation.allowed,
    reason: validation.reason || null,
    argv: parsed.argv,
    env: parsed.env,
    redirects: parsed.redirects,
  };
}

// ---------------------------------------------------------------------------
// Checkpoints (filesystem snapshot for rollback)
// ---------------------------------------------------------------------------

function hashFile(filepath) {
  try {
    const buf = readFileSync(filepath);
    return crypto.createHash("sha256").update(buf).digest("hex");
  } catch {
    return null;
  }
}

function snapshotDirectory(dir, { maxFiles = 500, maxDepth = 5, captureContent = false } = {}) {
  const files = {};
  const stack = [{ path: dir, depth: 0 }];
  let count = 0;
  while (stack.length > 0 && count < maxFiles) {
    const { path: cur, depth } = stack.pop();
    if (depth > maxDepth) continue;
    let entries;
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (count >= maxFiles) break;
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const abs = join(cur, entry.name);
      if (entry.isDirectory()) {
        stack.push({ path: abs, depth: depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      const hash = hashFile(abs);
      const record = { size: st.size, mtimeMs: st.mtimeMs, hash };
      if (captureContent && st.size <= 64 * 1024) {
        try {
          record.content = readFileSync(abs, "utf8");
        } catch {
          /* binary */
        }
      }
      files[abs] = record;
      count += 1;
    }
  }
  return files;
}

/**
 * Create a filesystem checkpoint for a session. Records the hashes and mtimes
 * of files under `options.dir` so the snapshot can be compared later.
 * When `options.captureContent` is true, file contents are stored in-memory
 * (up to 64 KiB per file) so a rollback can restore them verbatim.
 */
export async function createCheckpoint(sessionId, name, options = {}) {
  if (!sessionId) throw new Error("sessionId is required");
  if (!name) throw new Error("checkpoint name is required");
  const dir = options.dir || process.cwd();
  const snapshot = snapshotDirectory(dir, {
    maxFiles: options.maxFiles,
    maxDepth: options.maxDepth,
    captureContent: options.captureContent === true,
  });
  return mutate(async (store) => {
    if (!store.checkpoints[sessionId]) store.checkpoints[sessionId] = {};
    const checkpoint = {
      id: crypto.randomUUID(),
      name,
      sessionId,
      dir,
      createdAt: now(),
      fileCount: Object.keys(snapshot).length,
      files: snapshot,
      capturedContent: options.captureContent === true,
    };
    store.checkpoints[sessionId][name] = checkpoint;
    return checkpoint;
  });
}

export async function listCheckpoints(sessionId) {
  const store = await loadStore();
  const map = store.checkpoints[sessionId] || {};
  return Object.values(map).map((cp) => ({
    id: cp.id,
    name: cp.name,
    sessionId: cp.sessionId,
    dir: cp.dir,
    createdAt: cp.createdAt,
    fileCount: cp.fileCount,
    capturedContent: cp.capturedContent,
  }));
}

export async function getCheckpoint(sessionId, name) {
  const store = await loadStore();
  return store.checkpoints[sessionId]?.[name] || null;
}

/**
 * Compare the current on-disk state to a stored checkpoint. Returns the set
 * of added, removed, and modified files.
 */
export async function compareToCheckpoint(sessionId, name) {
  const checkpoint = await getCheckpoint(sessionId, name);
  if (!checkpoint) throw new Error(`checkpoint ${name} not found`);
  const current = snapshotDirectory(checkpoint.dir);
  const added = [];
  const removed = [];
  const modified = [];
  for (const [path, rec] of Object.entries(current)) {
    const prev = checkpoint.files[path];
    if (!prev) {
      added.push(path);
    } else if (prev.hash !== rec.hash) {
      modified.push(path);
    }
  }
  for (const path of Object.keys(checkpoint.files)) {
    if (!current[path]) removed.push(path);
  }
  return { added, removed, modified, checkpointName: name, checkpointId: checkpoint.id };
}

/**
 * Restore files from a checkpoint. This only works for checkpoints created
 * with `captureContent: true`; otherwise only a diff is returned and no files
 * are touched (rollback is "simulated").
 */
export async function rollbackToCheckpoint(sessionId, name, options = {}) {
  const checkpoint = await getCheckpoint(sessionId, name);
  if (!checkpoint) throw new Error(`checkpoint ${name} not found`);
  const diff = await compareToCheckpoint(sessionId, name);
  const restored = [];
  const removed = [];
  const skipped = [];
  if (!checkpoint.capturedContent || options.simulate === true) {
    return { ...diff, restored, removed, skipped, simulated: true };
  }
  for (const path of diff.modified.concat(diff.removed)) {
    const rec = checkpoint.files[path];
    if (!rec || typeof rec.content !== "string") {
      skipped.push(path);
      continue;
    }
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, rec.content, "utf8");
      restored.push(path);
    } catch {
      skipped.push(path);
    }
  }
  for (const path of diff.added) {
    try {
      rmSync(path, { force: true });
      removed.push(path);
    } catch {
      skipped.push(path);
    }
  }
  return { ...diff, restored, removed, skipped, simulated: false };
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export async function createShellSession(name, options = {}) {
  const id = crypto.randomUUID();
  const session = {
    id,
    name: name || `session-${id.slice(0, 8)}`,
    cwd: options.cwd || process.cwd(),
    env: options.env || {},
    policy: options.policy || {},
    createdAt: now(),
    closedAt: null,
    status: "active",
  };
  return mutate(async (store) => {
    store.sessions[id] = session;
    store.history[id] = [];
    return session;
  });
}

export async function getShellSession(sessionId) {
  const store = await loadStore();
  return store.sessions[sessionId] || null;
}

export async function listShellSessions() {
  const store = await loadStore();
  return Object.values(store.sessions);
}

export async function closeShellSession(sessionId) {
  return mutate(async (store) => {
    const session = store.sessions[sessionId];
    if (!session) return null;
    session.status = "closed";
    session.closedAt = now();
    return session;
  });
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export async function recordCommand(sessionId, command, result) {
  return mutate(async (store) => {
    if (!store.history[sessionId]) store.history[sessionId] = [];
    const entry = {
      id: crypto.randomUUID(),
      sessionId,
      command,
      exitCode: result?.exitCode ?? null,
      durationMs: result?.durationMs ?? null,
      truncated: result?.truncated ?? false,
      stdoutLen: result?.stdout ? result.stdout.length : 0,
      stderrLen: result?.stderr ? result.stderr.length : 0,
      at: now(),
    };
    store.history[sessionId].push(entry);
    // Trim to last 1000 entries
    if (store.history[sessionId].length > 1000) {
      store.history[sessionId] = store.history[sessionId].slice(-1000);
    }
    return entry;
  });
}

export async function getCommandHistory(sessionId, limit = 100) {
  const store = await loadStore();
  const all = store.history[sessionId] || [];
  return all.slice(-limit);
}

// ---------------------------------------------------------------------------
// Safe wrappers — thin convenience helpers that always go through executeCommand
// ---------------------------------------------------------------------------

export async function safeLs(path, options = {}) {
  const target = typeof path === "string" && path.length > 0 ? path : ".";
  const result = await executeCommand(`ls ${quote(target)}`, options);
  const entries = result.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return { entries, ...result };
}

export async function safeCat(filepath, options = {}) {
  if (!filepath) throw new Error("filepath is required");
  const result = await executeCommand(`cat ${quote(filepath)}`, options);
  return { content: result.stdout, ...result };
}

export async function safeGrep(pattern, path, options = {}) {
  if (!pattern) throw new Error("pattern is required");
  const target = typeof path === "string" && path.length > 0 ? path : ".";
  const result = await executeCommand(`grep ${quote(pattern)} ${quote(target)}`, options);
  return {
    matches: result.stdout.split("\n").filter((s) => s.length > 0),
    ...result,
  };
}

export async function safeFind(path, options = {}) {
  const target = typeof path === "string" && path.length > 0 ? path : ".";
  const result = await executeCommand(`find ${quote(target)}`, options);
  return {
    paths: result.stdout.split("\n").filter((s) => s.length > 0),
    ...result,
  };
}

function quote(arg) {
  if (typeof arg !== "string") return "";
  if (/^[A-Za-z0-9_./-]+$/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '\\"')}"`;
}

// ---------------------------------------------------------------------------
// Resource limits
// ---------------------------------------------------------------------------

/**
 * Enforce per-session rate limits. Throws an Error with code
 * `RATE_LIMIT_EXCEEDED` when the quota is exceeded.
 */
export async function enforceLimits(command, session) {
  if (!session || !session.id) {
    throw new Error("session is required");
  }
  const store = await loadStore();
  const history = store.history[session.id] || [];
  const since = now() - 60 * 1000;
  const recent = history.filter((h) => h.at >= since);
  const limit = session.policy?.maxCommandsPerMinute ?? DEFAULT_LIMITS.maxCommandsPerMinute;
  if (recent.length >= limit) {
    const err = new Error(
      `rate limit exceeded (${recent.length}/${limit} commands in the last minute)`,
    );
    err.code = "RATE_LIMIT_EXCEEDED";
    throw err;
  }
  return { allowed: true, recent: recent.length, limit };
}

// ---------------------------------------------------------------------------
// Convenience: run a command within a session, enforcing limits and history.
// ---------------------------------------------------------------------------

export async function runInSession(sessionId, command, options = {}) {
  const session = await getShellSession(sessionId);
  if (!session) throw new Error(`session ${sessionId} not found`);
  if (session.status !== "active") throw new Error(`session ${sessionId} is closed`);
  await enforceLimits(command, session);
  const result = await executeCommand(command, {
    cwd: session.cwd,
    env: session.env,
    policy: session.policy,
    ...options,
  });
  await recordCommand(sessionId, command, result);
  return result;
}

// Exported for tests: resolve the effective store path (useful for cleanup).
export function __storePath() {
  return resolve(storePath());
}
