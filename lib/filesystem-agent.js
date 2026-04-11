// @ts-check
/**
 * Phase 55.4: Filesystem agent with dry-run.
 *
 * Path-guarded FS operations (read, write, move, delete, mkdir, list) with
 * a "plan / preview / apply" lifecycle so the LLM can stage a set of changes,
 * ask the human to preview them, and only then commit.
 *
 * Operations are described as plain objects:
 *
 *   { op: "read",   path }
 *   { op: "write",  path, content }
 *   { op: "append", path, content }
 *   { op: "move",   from, to }
 *   { op: "delete", path }
 *   { op: "mkdir",  path }
 *   { op: "list",   path }
 *
 * Paths are always relative to `WORKSPACE_ROOT`. `lib/workspace-path-guard.js`
 * is used to resolve them, which blocks absolute paths and traversal.
 *
 * Exposed API:
 *   - `planFsOperations(ops)`      -- validate + normalize
 *   - `previewFsPlan(plan)`        -- describe what would change
 *   - `applyFsPlan(plan)`          -- execute in order, with rollback on error
 *   - `fsOpAllowed(op)`            -- allowlist check
 *
 * @module filesystem-agent
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, renameSync, statSync, readdirSync, rmSync } from "fs";
import { dirname, join, relative, resolve } from "path";
import { resolveWorkspacePath } from "./workspace-path-guard.js";

const ALLOWED_OPS = new Set(["read", "write", "append", "move", "delete", "mkdir", "list"]);

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function getRoot(overrideRoot) {
  const candidate =
    typeof overrideRoot === "string" && overrideRoot.trim()
      ? overrideRoot.trim()
      : (process.env.WORKSPACE_ROOT || "").trim();
  if (!candidate) {
    throw new Error("WORKSPACE_ROOT is not configured");
  }
  return candidate;
}

function resolveOrThrow(root, rel) {
  const res = resolveWorkspacePath(root, rel);
  if (!res.ok) {
    throw new Error(`path error (${res.code}): ${res.error}`);
  }
  return res.absPath;
}

/* -------------------------------------------------------------------------- */
/* fsOpAllowed                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Return whether an operation descriptor has an allowlisted `op` field.
 * @param {object} op
 */
export function fsOpAllowed(op) {
  if (!op || typeof op !== "object") return false;
  return ALLOWED_OPS.has(String(op.op));
}

/* -------------------------------------------------------------------------- */
/* Planning                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} PlannedOp
 * @property {string} op
 * @property {string} [path]
 * @property {string} [from]
 * @property {string} [to]
 * @property {string} [content]
 * @property {string} resolved
 * @property {string} [resolvedFrom]
 * @property {string} [resolvedTo]
 */

/**
 * @typedef {Object} FsPlan
 * @property {PlannedOp[]} operations
 * @property {string} root
 * @property {number} createdAt
 * @property {number} version
 */

/**
 * Validate an input list of operations and resolve each path inside the
 * workspace root. Throws on the first invalid op.
 *
 * @param {object[]} ops
 * @param {{ root?: string }} [opts]
 * @returns {FsPlan}
 */
export function planFsOperations(ops, opts = {}) {
  if (!Array.isArray(ops)) {
    throw new Error("ops must be an array");
  }
  const root = getRoot(opts.root);
  /** @type {PlannedOp[]} */
  const out = [];
  for (let i = 0; i < ops.length; i += 1) {
    const raw = ops[i];
    if (!fsOpAllowed(raw)) {
      throw new Error(`operation ${i} has invalid op`);
    }
    const op = raw.op;
    if (op === "move") {
      if (!raw.from || !raw.to) throw new Error(`operation ${i} (move) requires from and to`);
      out.push({
        op,
        from: raw.from,
        to: raw.to,
        resolved: "",
        resolvedFrom: resolveOrThrow(root, raw.from),
        resolvedTo: resolveOrThrow(root, raw.to),
      });
      continue;
    }
    if (!raw.path || typeof raw.path !== "string") {
      throw new Error(`operation ${i} (${op}) requires path`);
    }
    if ((op === "write" || op === "append") && typeof raw.content !== "string") {
      throw new Error(`operation ${i} (${op}) requires content string`);
    }
    out.push({
      op,
      path: raw.path,
      content: raw.content,
      resolved: resolveOrThrow(root, raw.path),
    });
  }
  return {
    operations: out,
    root,
    createdAt: Date.now(),
    version: 1,
  };
}

/* -------------------------------------------------------------------------- */
/* Preview                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} PreviewEntry
 * @property {string} op
 * @property {string} [path]
 * @property {string} [from]
 * @property {string} [to]
 * @property {string} effect                  -- human-readable change
 * @property {boolean} exists                 -- does target currently exist?
 * @property {"create"|"overwrite"|"delete"|"none"|"move"|"list"|"read"|"mkdir"} kind
 * @property {number} [byteDelta]
 */

/**
 * Describe what applying the plan would do without touching disk.
 *
 * @param {FsPlan} plan
 * @returns {{ entries: PreviewEntry[], summary: { creates: number, overwrites: number, deletes: number, moves: number } }}
 */
export function previewFsPlan(plan) {
  if (!plan || !Array.isArray(plan.operations)) {
    throw new Error("plan is required");
  }
  /** @type {PreviewEntry[]} */
  const entries = [];
  const summary = { creates: 0, overwrites: 0, deletes: 0, moves: 0 };
  for (const op of plan.operations) {
    switch (op.op) {
      case "read": {
        const exists = existsSync(op.resolved);
        entries.push({
          op: op.op,
          path: op.path,
          effect: exists ? `read ${op.path}` : `read ${op.path} (missing)`,
          exists,
          kind: "read",
        });
        break;
      }
      case "list": {
        const exists = existsSync(op.resolved);
        entries.push({
          op: op.op,
          path: op.path,
          effect: exists ? `list ${op.path}` : `list ${op.path} (missing)`,
          exists,
          kind: "list",
        });
        break;
      }
      case "write": {
        const exists = existsSync(op.resolved);
        const nextSize = (op.content || "").length;
        const prevSize = exists ? safeSize(op.resolved) : 0;
        entries.push({
          op: op.op,
          path: op.path,
          effect: exists ? `overwrite ${op.path}` : `create ${op.path}`,
          exists,
          kind: exists ? "overwrite" : "create",
          byteDelta: nextSize - prevSize,
        });
        if (exists) summary.overwrites += 1;
        else summary.creates += 1;
        break;
      }
      case "append": {
        const exists = existsSync(op.resolved);
        entries.push({
          op: op.op,
          path: op.path,
          effect: exists ? `append ${(op.content || "").length} bytes` : `create + write`,
          exists,
          kind: exists ? "overwrite" : "create",
          byteDelta: (op.content || "").length,
        });
        if (exists) summary.overwrites += 1;
        else summary.creates += 1;
        break;
      }
      case "mkdir": {
        const exists = existsSync(op.resolved);
        entries.push({
          op: op.op,
          path: op.path,
          effect: exists ? `mkdir ${op.path} (exists)` : `mkdir ${op.path}`,
          exists,
          kind: exists ? "none" : "mkdir",
        });
        if (!exists) summary.creates += 1;
        break;
      }
      case "delete": {
        const exists = existsSync(op.resolved);
        entries.push({
          op: op.op,
          path: op.path,
          effect: exists ? `delete ${op.path}` : `delete ${op.path} (no-op)`,
          exists,
          kind: exists ? "delete" : "none",
        });
        if (exists) summary.deletes += 1;
        break;
      }
      case "move": {
        const fromExists = op.resolvedFrom ? existsSync(op.resolvedFrom) : false;
        entries.push({
          op: op.op,
          from: op.from,
          to: op.to,
          effect: fromExists ? `move ${op.from} -> ${op.to}` : `move ${op.from} (missing)`,
          exists: fromExists,
          kind: "move",
        });
        if (fromExists) summary.moves += 1;
        break;
      }
      default:
        break;
    }
  }
  return { entries, summary };
}

function safeSize(abs) {
  try {
    return statSync(abs).size;
  } catch (_) {
    return 0;
  }
}

/* -------------------------------------------------------------------------- */
/* Apply                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} ApplyResult
 * @property {number} applied
 * @property {number} skipped
 * @property {Array<{ index: number, op: string, status: string, detail?: any }>} results
 * @property {boolean} rolledBack
 * @property {string} [error]
 */

/**
 * Execute a plan. If `dryRun` is true, delegates to `previewFsPlan` and
 * returns a synthetic result. Otherwise each op is performed in order; on
 * the first failure, the agent attempts a best-effort rollback using the
 * snapshots it took before each mutating op.
 *
 * @param {FsPlan} plan
 * @param {{ dryRun?: boolean }} [opts]
 * @returns {Promise<ApplyResult | { dryRun: true, preview: ReturnType<typeof previewFsPlan> }>}
 */
export async function applyFsPlan(plan, opts = {}) {
  if (!plan || !Array.isArray(plan.operations)) {
    throw new Error("plan is required");
  }
  if (opts.dryRun) {
    return { dryRun: true, preview: previewFsPlan(plan) };
  }

  /** @type {Array<{ index: number, op: string, status: string, detail?: any }>} */
  const results = [];
  /** @type {Array<() => void>} */
  const undo = [];
  let applied = 0;
  let skipped = 0;

  try {
    for (let i = 0; i < plan.operations.length; i += 1) {
      const op = plan.operations[i];
      switch (op.op) {
        case "read": {
          if (!existsSync(op.resolved)) {
            results.push({ index: i, op: op.op, status: "skipped", detail: "missing" });
            skipped += 1;
            break;
          }
          const content = readFileSync(op.resolved, "utf8");
          results.push({ index: i, op: op.op, status: "ok", detail: { bytes: content.length, content } });
          applied += 1;
          break;
        }
        case "list": {
          if (!existsSync(op.resolved)) {
            results.push({ index: i, op: op.op, status: "skipped", detail: "missing" });
            skipped += 1;
            break;
          }
          const entries = readdirSync(op.resolved, { withFileTypes: true }).map((d) => ({
            name: d.name,
            type: d.isDirectory() ? "dir" : d.isFile() ? "file" : "other",
          }));
          results.push({ index: i, op: op.op, status: "ok", detail: { entries } });
          applied += 1;
          break;
        }
        case "write": {
          const prev = existsSync(op.resolved) ? readFileSync(op.resolved, "utf8") : null;
          const hadFile = prev !== null;
          const parent = dirname(op.resolved);
          if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
          writeFileSync(op.resolved, op.content || "", "utf8");
          undo.push(() => {
            if (hadFile) writeFileSync(op.resolved, prev, "utf8");
            else if (existsSync(op.resolved)) unlinkSync(op.resolved);
          });
          results.push({ index: i, op: op.op, status: "ok", detail: { bytes: (op.content || "").length } });
          applied += 1;
          break;
        }
        case "append": {
          const prev = existsSync(op.resolved) ? readFileSync(op.resolved, "utf8") : "";
          const hadFile = existsSync(op.resolved);
          const next = prev + (op.content || "");
          const parent = dirname(op.resolved);
          if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
          writeFileSync(op.resolved, next, "utf8");
          undo.push(() => {
            if (hadFile) writeFileSync(op.resolved, prev, "utf8");
            else if (existsSync(op.resolved)) unlinkSync(op.resolved);
          });
          results.push({ index: i, op: op.op, status: "ok", detail: { bytes: (op.content || "").length } });
          applied += 1;
          break;
        }
        case "mkdir": {
          const existed = existsSync(op.resolved);
          if (!existed) {
            mkdirSync(op.resolved, { recursive: true });
            undo.push(() => {
              try {
                rmSync(op.resolved, { recursive: true, force: true });
              } catch (_) { /* best effort */ }
            });
          }
          results.push({ index: i, op: op.op, status: existed ? "noop" : "ok" });
          if (existed) skipped += 1;
          else applied += 1;
          break;
        }
        case "delete": {
          if (!existsSync(op.resolved)) {
            results.push({ index: i, op: op.op, status: "skipped", detail: "missing" });
            skipped += 1;
            break;
          }
          const s = statSync(op.resolved);
          if (s.isDirectory()) {
            // Capture tree for rollback.
            const snapshot = captureSubtree(op.resolved);
            rmSync(op.resolved, { recursive: true, force: true });
            undo.push(() => restoreSubtree(op.resolved, snapshot));
          } else {
            const prev = readFileSync(op.resolved, "utf8");
            unlinkSync(op.resolved);
            undo.push(() => writeFileSync(op.resolved, prev, "utf8"));
          }
          results.push({ index: i, op: op.op, status: "ok" });
          applied += 1;
          break;
        }
        case "move": {
          if (!op.resolvedFrom || !op.resolvedTo) {
            throw new Error("move op missing resolved paths");
          }
          if (!existsSync(op.resolvedFrom)) {
            results.push({ index: i, op: op.op, status: "skipped", detail: "missing source" });
            skipped += 1;
            break;
          }
          const parent = dirname(op.resolvedTo);
          if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
          const from = op.resolvedFrom;
          const to = op.resolvedTo;
          renameSync(from, to);
          undo.push(() => {
            if (existsSync(to) && !existsSync(from)) renameSync(to, from);
          });
          results.push({ index: i, op: op.op, status: "ok" });
          applied += 1;
          break;
        }
        default:
          results.push({ index: i, op: op.op, status: "skipped", detail: "unknown op" });
          skipped += 1;
      }
    }
    return { applied, skipped, results, rolledBack: false };
  } catch (err) {
    // Roll back in reverse order.
    while (undo.length > 0) {
      const u = undo.pop();
      try { u && u(); } catch (_) { /* best effort */ }
    }
    return {
      applied,
      skipped,
      results,
      rolledBack: true,
      error: err && err.message ? String(err.message) : String(err),
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Subtree snapshot helpers                                                   */
/* -------------------------------------------------------------------------- */

function captureSubtree(root) {
  /** @type {Array<{ kind: "dir" | "file", rel: string, content?: string }>} */
  const out = [{ kind: "dir", rel: "" }];
  const abs = resolve(root);
  walk(abs, abs, out);
  return out;
}

function walk(root, current, out) {
  let entries;
  try {
    entries = readdirSync(current, { withFileTypes: true });
  } catch (_) {
    return;
  }
  for (const e of entries) {
    const full = join(current, e.name);
    const rel = relative(root, full);
    if (e.isDirectory()) {
      out.push({ kind: "dir", rel });
      walk(root, full, out);
    } else if (e.isFile()) {
      try {
        out.push({ kind: "file", rel, content: readFileSync(full, "utf8") });
      } catch (_) { /* skip */ }
    }
  }
}

function restoreSubtree(root, snapshot) {
  for (const s of snapshot) {
    if (s.kind === "dir") {
      const abs = join(root, s.rel);
      if (!existsSync(abs)) mkdirSync(abs, { recursive: true });
    }
  }
  for (const s of snapshot) {
    if (s.kind === "file") {
      const abs = join(root, s.rel);
      const parent = dirname(abs);
      if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
      writeFileSync(abs, s.content || "", "utf8");
    }
  }
}
