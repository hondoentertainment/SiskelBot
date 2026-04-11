// @ts-check
/**
 * Phase 63.4: Refactoring agent.
 *
 * Pure-string multi-file refactors on plain JavaScript. Supported ops:
 *   - `rename`: rename a symbol across files
 *   - `extract_function`: wrap a range of lines in a new function
 *   - `inline_variable`: inline a `const x = expr;` declaration
 *
 * Workflow:
 *   - `planRefactor(opts)` — create a persisted plan
 *   - `previewRefactor(id, files)` — return transformed file texts (no persist)
 *   - `applyRefactor(id, files)` — persist the transformation; returns diff
 *   - `listRefactors()` — list plans
 *   - `rollbackRefactor(id)` — restore saved originals
 *
 * @module refactoring
 */
import { join } from "path";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;

function refactorsPath() {
  return join(getDataDir(), "refactoring.json");
}

async function loadRefactors() {
  const data = await readJsonPath(refactorsPath(), { version: STORE_VERSION, refactors: {} });
  if (!data.refactors || typeof data.refactors !== "object") data.refactors = {};
  return data;
}

async function saveRefactors(data) {
  await writeJsonPath(refactorsPath(), { version: STORE_VERSION, refactors: data.refactors || {} });
}

/* -------------------------------------------------------------------------- */
/* Plans                                                                      */
/* -------------------------------------------------------------------------- */

const VALID_OPS = ["rename", "extract_function", "inline_variable"];

/**
 * Create and persist a refactor plan.
 *
 * @param {object} opts
 * @returns {Promise<object>}
 */
export async function planRefactor(opts) {
  if (!opts || typeof opts !== "object") throw new Error("opts required");
  if (!VALID_OPS.includes(opts.op)) {
    throw new Error(`invalid op "${opts.op}", expected one of: ${VALID_OPS.join(", ")}`);
  }
  const path = refactorsPath();
  return withPathLock(path, async () => {
    const data = await loadRefactors();
    const now = new Date().toISOString();
    const id = `ref_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const plan = {
      id,
      op: opts.op,
      oldName: opts.oldName || null,
      newName: opts.newName || null,
      file: opts.file || null,
      startLine: Number.isFinite(opts.startLine) ? opts.startLine : null,
      endLine: Number.isFinite(opts.endLine) ? opts.endLine : null,
      variable: opts.variable || null,
      description: opts.description || "",
      status: "planned",
      originals: {},
      createdAt: now,
      updatedAt: now,
    };
    data.refactors[id] = plan;
    await saveRefactors(data);
    return plan;
  });
}

/** List refactor plans. */
export async function listRefactors() {
  const data = await loadRefactors();
  return Object.values(data.refactors);
}

/* -------------------------------------------------------------------------- */
/* Transformations                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Rename a symbol using a conservative word-boundary regex.
 *
 * @param {string} text
 * @param {string} oldName
 * @param {string} newName
 * @returns {string}
 */
export function renameSymbol(text, oldName, newName) {
  if (typeof text !== "string") return "";
  if (!oldName || !newName) return text;
  const escaped = oldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\b${escaped}\\b`, "g");
  return text.replace(re, newName);
}

/**
 * Wrap a line range in a new function declaration + call.
 *
 * @param {string} text
 * @param {number} startLine (1-indexed)
 * @param {number} endLine   (1-indexed, inclusive)
 * @param {string} fnName
 * @returns {string}
 */
export function extractFunction(text, startLine, endLine, fnName) {
  if (typeof text !== "string") return "";
  if (!fnName) return text;
  const lines = text.split(/\r?\n/);
  const s = Math.max(1, startLine);
  const e = Math.min(lines.length, endLine);
  if (s > e) return text;
  const body = lines.slice(s - 1, e).join("\n");
  const fnDecl = `function ${fnName}() {\n${body}\n}\n${fnName}();`;
  const before = lines.slice(0, s - 1);
  const after = lines.slice(e);
  return [...before, fnDecl, ...after].join("\n");
}

/**
 * Inline a `const name = expr;` declaration by replacing subsequent
 * references with the expression.
 *
 * @param {string} text
 * @param {string} variable
 * @returns {string}
 */
export function inlineVariable(text, variable) {
  if (typeof text !== "string") return "";
  if (!variable) return text;
  const lines = text.split(/\r?\n/);
  const escaped = variable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const declRe = new RegExp(`^\\s*(?:const|let|var)\\s+${escaped}\\s*=\\s*(.+?);?\\s*$`);
  let expr = null;
  let declIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(declRe);
    if (m) {
      expr = m[1].replace(/;$/, "");
      declIdx = i;
      break;
    }
  }
  if (expr === null) return text;
  // Remove the declaration line
  lines.splice(declIdx, 1);
  // Replace subsequent references
  const refRe = new RegExp(`\\b${escaped}\\b`, "g");
  for (let i = 0; i < lines.length; i += 1) {
    lines[i] = lines[i].replace(refRe, `(${expr})`);
  }
  return lines.join("\n");
}

/**
 * Apply a plan's transformation to a set of files, returning the new texts.
 *
 * @param {object} plan
 * @param {Record<string, string>} files
 * @returns {Record<string, string>}
 */
export function applyPlanToFiles(plan, files) {
  if (!plan || !files) return {};
  /** @type {Record<string, string>} */
  const out = {};
  for (const [path, text] of Object.entries(files)) {
    if (plan.file && path !== plan.file) {
      out[path] = text;
      continue;
    }
    if (plan.op === "rename") {
      out[path] = renameSymbol(text, plan.oldName, plan.newName);
    } else if (plan.op === "extract_function") {
      out[path] = extractFunction(text, plan.startLine, plan.endLine, plan.newName || "extracted");
    } else if (plan.op === "inline_variable") {
      out[path] = inlineVariable(text, plan.variable);
    } else {
      out[path] = text;
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Preview / Apply / Rollback                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Dry-run a refactor plan.
 *
 * @param {string} id
 * @param {Record<string, string>} files
 * @returns {Promise<{ plan: object, files: Record<string, string> }>}
 */
export async function previewRefactor(id, files) {
  if (!id) throw new Error("id required");
  if (!files || typeof files !== "object") throw new Error("files required");
  const data = await loadRefactors();
  const plan = data.refactors[id];
  if (!plan) throw new Error(`plan "${id}" not found`);
  const out = applyPlanToFiles(plan, files);
  return { plan, files: out };
}

/**
 * Apply a plan, saving originals for rollback.
 *
 * @param {string} id
 * @param {Record<string, string>} files
 * @returns {Promise<{ plan: object, files: Record<string, string> }>}
 */
export async function applyRefactor(id, files) {
  if (!id) throw new Error("id required");
  if (!files || typeof files !== "object") throw new Error("files required");
  const path = refactorsPath();
  return withPathLock(path, async () => {
    const data = await loadRefactors();
    const plan = data.refactors[id];
    if (!plan) throw new Error(`plan "${id}" not found`);
    // Save originals
    plan.originals = { ...files };
    const out = applyPlanToFiles(plan, files);
    plan.applied = out;
    plan.status = "applied";
    plan.updatedAt = new Date().toISOString();
    await saveRefactors(data);
    return { plan, files: out };
  });
}

/**
 * Restore the saved originals.
 *
 * @param {string} id
 * @returns {Promise<Record<string, string>>}
 */
export async function rollbackRefactor(id) {
  if (!id) throw new Error("id required");
  const path = refactorsPath();
  return withPathLock(path, async () => {
    const data = await loadRefactors();
    const plan = data.refactors[id];
    if (!plan) throw new Error(`plan "${id}" not found`);
    if (plan.status !== "applied") throw new Error("plan has not been applied");
    const originals = { ...(plan.originals || {}) };
    plan.status = "rolled_back";
    plan.updatedAt = new Date().toISOString();
    await saveRefactors(data);
    return originals;
  });
}
