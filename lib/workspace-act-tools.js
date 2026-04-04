/**
 * Phase 4 workspace "act" tools: scoped writes, git CLI (read/write opt-in), allowlisted commands.
 * Requires WORKSPACE_ROOT. Mutations gated by separate env flags (see each export).
 */
import { spawn } from "child_process";
import { dirname, basename } from "path";
import { mkdir, copyFile, writeFile as fsWriteFile } from "fs/promises";
import { existsSync } from "fs";
import { resolveWorkspacePath } from "./workspace-path-guard.js";

const DEFAULT_WRITE_MAX = Math.min(2_000_000, Math.max(1024, Number(process.env.WORKSPACE_FILE_WRITE_MAX_BYTES) || 512_000));
const DEFAULT_GIT_OUT_MAX = Math.min(2_000_000, Math.max(4096, Number(process.env.WORKSPACE_GIT_MAX_OUTPUT_BYTES) || 256_000));
const DEFAULT_CMD_TIMEOUT_MS = Math.min(600_000, Math.max(5_000, Number(process.env.WORKSPACE_COMMAND_TIMEOUT_MS) || 120_000));
const DEFAULT_CMD_OUT_MAX = Math.min(1_000_000, Math.max(4096, Number(process.env.WORKSPACE_COMMAND_MAX_OUTPUT_BYTES) || 500_000));

function getRoot(ctx) {
  const fromCtx = ctx?.workspaceFilesystemRoot;
  if (typeof fromCtx === "string" && fromCtx.trim()) return fromCtx.trim();
  return (process.env.WORKSPACE_ROOT || "").trim();
}

export function workspaceFileWriteToolsEnabled() {
  return process.env.WORKSPACE_FILE_WRITE_TOOLS === "1";
}

export function workspaceGitReadToolsEnabled() {
  return process.env.WORKSPACE_GIT_TOOLS === "1";
}

export function workspaceGitWriteEnabled() {
  return process.env.WORKSPACE_GIT_WRITE === "1";
}

/**
 * @returns {Set<string>|null} lowercased executable base names; null = command runner off
 */
export function parseWorkspaceCommandAllowlist() {
  const raw = (process.env.WORKSPACE_COMMAND_ALLOWLIST || "").trim();
  if (!raw) return null;
  const parts = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return parts.length ? new Set(parts) : null;
}

function normalizeExeName(cmd0) {
  const tail = String(cmd0 || "")
    .split(/[/\\]/)
    .pop();
  if (!tail) return "";
  return tail.replace(/\.(cmd|exe|bat)$/i, "").toLowerCase();
}

export function commandRunnerAllowed(argv) {
  const allow = parseWorkspaceCommandAllowlist();
  if (!allow || !Array.isArray(argv) || argv.length === 0) return { ok: false, code: "COMMAND_RUNNER_DISABLED" };
  const exe = normalizeExeName(argv[0]);
  if (!exe || !allow.has(exe)) {
    return { ok: false, code: "COMMAND_NOT_ALLOWLISTED", exe };
  }
  return { ok: true, allow };
}

/**
 * @param {string} rootAbs
 * @param {string[]} gitArgs - subcommand + args after `git -C root`
 * @param {{ timeoutMs?: number, maxBytes?: number }} [opts]
 */
export function runGitInWorkspace(rootAbs, gitArgs, opts = {}) {
  const root = String(rootAbs || "").trim();
  if (!root) {
    return Promise.resolve({ ok: false, code: "NO_ROOT", error: "WORKSPACE_ROOT not set" });
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CMD_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_GIT_OUT_MAX;
  const args = ["-C", root, ...gitArgs];
  return spawnCapture("git", args, { timeoutMs, maxBytes, cwd: undefined });
}

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd?: string, timeoutMs?: number, maxBytes?: number }} opts
 */
function spawnCapture(cmd, args, opts) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CMD_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_CMD_OUT_MAX;
  const cwd = opts.cwd;

  return new Promise((resolve) => {
    /** @type {Buffer[]} */
    const out = [];
    /** @type {Buffer[]} */
    const err = [];
    let killed = false;
    const child = spawn(cmd, args, {
      cwd,
      windowsHide: true,
      shell: false,
    });

    const timer = setTimeout(() => {
      killed = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }, timeoutMs);

    child.stdout?.on("data", (d) => {
      out.push(Buffer.isBuffer(d) ? d : Buffer.from(String(d)));
    });
    child.stderr?.on("data", (d) => {
      err.push(Buffer.isBuffer(d) ? d : Buffer.from(String(d)));
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, code: "SPAWN_ERROR", error: String(e?.message || e) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const stdoutBuf = Buffer.concat(out);
      const stderrBuf = Buffer.concat(err);
      let stdout = stdoutBuf.toString("utf8");
      let stderr = stderrBuf.toString("utf8");
      let truncated = false;
      if (stdout.length > maxBytes) {
        stdout = stdout.slice(0, maxBytes) + "\n…(stdout truncated)";
        truncated = true;
      }
      if (stderr.length > maxBytes) {
        stderr = stderr.slice(0, maxBytes) + "\n…(stderr truncated)";
        truncated = true;
      }
      resolve({
        ok: code === 0 && !killed,
        exitCode: code,
        killed,
        stdout,
        stderr,
        truncated,
      });
    });
  });
}

/**
 * @param {import("./types.d.ts").ToolContext} ctx
 * @param {{ path: string, content: string, createOnly?: boolean }} opts
 */
export async function workspaceWriteFile(ctx, opts) {
  if (!workspaceFileWriteToolsEnabled()) {
    return { ok: false, code: "WRITE_DISABLED", error: "Set WORKSPACE_FILE_WRITE_TOOLS=1 to enable workspace_write_file" };
  }
  const root = getRoot(ctx);
  const rel = typeof opts?.path === "string" ? opts.path.trim() : "";
  if (!rel) return { ok: false, error: "path is required" };
  const resolved = resolveWorkspacePath(root, rel);
  if (!resolved.ok) return { ok: false, ...resolved };
  const content = typeof opts?.content === "string" ? opts.content : "";
  if (content.length > DEFAULT_WRITE_MAX) {
    return { ok: false, code: "CONTENT_TOO_LARGE", error: `content exceeds ${DEFAULT_WRITE_MAX} bytes` };
  }
  const createOnly = opts?.createOnly === true;
  if (createOnly && existsSync(resolved.absPath)) {
    return { ok: false, code: "CREATE_ONLY_CONFLICT", error: "File already exists (createOnly)" };
  }

  try {
    await mkdir(dirname(resolved.absPath), { recursive: true });
    if (!createOnly && existsSync(resolved.absPath)) {
      const bak = `${resolved.absPath}.bak.${Date.now()}`;
      await copyFile(resolved.absPath, bak);
    }
    await fsWriteFile(resolved.absPath, content, "utf8");
    return { ok: true, path: rel, bytesWritten: Buffer.byteLength(content, "utf8") };
  } catch (e) {
    return { ok: false, code: "FS_ERROR", error: String(e?.message || e) };
  }
}

/**
 * @param {import("./types.d.ts").ToolContext} ctx
 */
export async function workspaceGitStatus(ctx) {
  if (!workspaceGitReadToolsEnabled()) {
    return { ok: false, code: "GIT_READ_DISABLED", error: "Set WORKSPACE_GIT_TOOLS=1" };
  }
  const root = getRoot(ctx);
  if (!root) return { ok: false, code: "NO_ROOT", error: "WORKSPACE_ROOT not set" };
  const r = await runGitInWorkspace(root, ["status", "--porcelain=v1", "-b"]);
  if (!r.ok && r.error) return r;
  return { ok: r.ok, ...r };
}

/**
 * @param {import("./types.d.ts").ToolContext} ctx
 * @param {{ maxCount?: number }} [opts]
 */
export async function workspaceGitLog(ctx, opts) {
  if (!workspaceGitReadToolsEnabled()) {
    return { ok: false, code: "GIT_READ_DISABLED", error: "Set WORKSPACE_GIT_TOOLS=1" };
  }
  const root = getRoot(ctx);
  if (!root) return { ok: false, code: "NO_ROOT", error: "WORKSPACE_ROOT not set" };
  const n = Math.min(200, Math.max(1, Number(opts?.maxCount) || 30));
  const r = await runGitInWorkspace(root, ["log", `-n${n}`, "--no-color", "--date=iso", "--pretty=format:%h %ad %s"]);
  return { ok: r.ok, ...r };
}

/**
 * @param {import("./types.d.ts").ToolContext} ctx
 * @param {{ staged?: boolean, paths?: string[] }} [opts]
 */
export async function workspaceGitDiff(ctx, opts) {
  if (!workspaceGitReadToolsEnabled()) {
    return { ok: false, code: "GIT_READ_DISABLED", error: "Set WORKSPACE_GIT_TOOLS=1" };
  }
  const root = getRoot(ctx);
  if (!root) return { ok: false, code: "NO_ROOT", error: "WORKSPACE_ROOT not set" };
  const args = ["diff", "--no-color"];
  if (opts?.staged === true) args.push("--cached");
  const paths = Array.isArray(opts?.paths) ? opts.paths : [];
  if (paths.length > 0) {
    args.push("--");
    for (const p of paths) {
      const g = resolveWorkspacePath(root, String(p).trim());
      if (!g.ok) return { ok: false, ...g };
      args.push(String(p).trim());
    }
  }
  const r = await runGitInWorkspace(root, args, { maxBytes: DEFAULT_GIT_OUT_MAX });
  return { ok: r.ok, ...r };
}

/**
 * @param {import("./types.d.ts").ToolContext} ctx
 * @param {{ message: string, paths: string[] }} opts
 */
export async function workspaceGitCommit(ctx, opts) {
  if (!workspaceGitWriteEnabled()) {
    return { ok: false, code: "GIT_WRITE_DISABLED", error: "Set WORKSPACE_GIT_WRITE=1" };
  }
  const root = getRoot(ctx);
  if (!root) return { ok: false, code: "NO_ROOT", error: "WORKSPACE_ROOT not set" };
  const msg = typeof opts?.message === "string" ? opts.message.trim().replace(/\r?\n/g, " ") : "";
  if (!msg) return { ok: false, error: "message is required" };
  const paths = Array.isArray(opts?.paths) ? opts.paths.map((p) => String(p).trim()).filter(Boolean) : [];
  if (paths.length === 0) {
    return { ok: false, error: "paths must list at least one relative file to stage" };
  }
  for (const p of paths) {
    const g = resolveWorkspacePath(root, p);
    if (!g.ok) return { ok: false, ...g };
  }

  const addArgs = ["add", "--", ...paths];
  const addR = await runGitInWorkspace(root, addArgs);
  if (!addR.ok) {
    return { ok: false, step: "git_add", ...addR };
  }
  const commitR = await runGitInWorkspace(root, ["commit", "-m", msg]);
  if (!commitR.ok) {
    return { ok: false, step: "git_commit", ...commitR };
  }
  return { ok: true, message: msg, paths };
}

/**
 * @param {import("./types.d.ts").ToolContext} ctx
 * @param {string[]} argv - argv[0] must match WORKSPACE_COMMAND_ALLOWLIST (no shell)
 */
export async function workspaceRunCommand(ctx, argv) {
  const root = getRoot(ctx);
  if (!root) return { ok: false, code: "NO_ROOT", error: "WORKSPACE_ROOT not set" };
  const check = commandRunnerAllowed(argv);
  if (!check.ok) {
    return {
      ok: false,
      code: check.code,
      error:
        check.code === "COMMAND_RUNNER_DISABLED"
          ? "Set WORKSPACE_COMMAND_ALLOWLIST (comma-separated executables, e.g. npm,git)"
          : `Executable not allowlisted: ${check.exe}`,
    };
  }
  const prog = String(argv[0]);
  const args = argv.slice(1).map((a) => String(a));
  const r = await spawnCapture(prog, args, {
    cwd: root,
    timeoutMs: DEFAULT_CMD_TIMEOUT_MS,
    maxBytes: DEFAULT_CMD_OUT_MAX,
  });
  return {
    ok: r.ok,
    exitCode: r.exitCode,
    stdout: r.stdout,
    stderr: r.stderr,
    truncated: r.truncated,
    killed: r.killed,
    argv0: basename(prog),
  };
}
