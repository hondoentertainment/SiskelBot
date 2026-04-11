// @ts-check
/**
 * Phase 63.5: Migration assistant.
 *
 * Framework/language upgrade automation. Ships a registry of rule-based
 * codemods (regex find/replace with context hints). Users can preview,
 * plan, and apply migrations across a bundle of files.
 *
 *   - `listCodemods()` — builtin + registered codemods
 *   - `applyCodemod(id, text)` — run one codemod on a single string
 *   - `previewCodemod(id, files)` — dry-run on multiple files
 *   - `getMigrationPlan(codemods, files)` — aggregate preview
 *   - `runMigration(codemods, files)` — persist a plan and return new files
 *
 * @module migration-assistant
 */
import { join } from "path";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;

function migrationsPath() {
  return join(getDataDir(), "migration-assistant.json");
}

async function loadMigrations() {
  const data = await readJsonPath(migrationsPath(), { version: STORE_VERSION, migrations: [], custom: [] });
  if (!Array.isArray(data.migrations)) data.migrations = [];
  if (!Array.isArray(data.custom)) data.custom = [];
  return data;
}

async function saveMigrations(data) {
  await writeJsonPath(migrationsPath(), {
    version: STORE_VERSION,
    migrations: data.migrations || [],
    custom: data.custom || [],
  });
}

/* -------------------------------------------------------------------------- */
/* Built-in codemods                                                          */
/* -------------------------------------------------------------------------- */

const BUILTIN_CODEMODS = [
  {
    id: "var-to-const",
    title: "var -> const",
    description: "Replace bare `var` with `const` (conservative).",
    pattern: /\bvar\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=/g,
    replacement: "const $1 =",
  },
  {
    id: "commonjs-to-esm-require",
    title: "require -> import",
    description: "Convert top-level `const x = require('y')` to `import x from 'y'`.",
    pattern: /const\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*require\(["']([^"']+)["']\);?/g,
    replacement: 'import $1 from "$2";',
  },
  {
    id: "commonjs-exports",
    title: "module.exports -> export default",
    description: "Convert `module.exports = X` to `export default X`.",
    pattern: /module\.exports\s*=\s*/g,
    replacement: "export default ",
  },
  {
    id: "function-expression-to-arrow",
    title: "function(x) -> (x) =>",
    description: "Convert anonymous function expression in a callback to an arrow.",
    pattern: /function\s*\(([^)]*)\)\s*\{/g,
    replacement: "($1) => {",
  },
  {
    id: "deprecated-assert-equal",
    title: "assert.equal -> assert.strictEqual",
    description: "Upgrade lax assert to strict.",
    pattern: /\bassert\.equal\b/g,
    replacement: "assert.strictEqual",
  },
];

/**
 * List all codemods (builtin + custom from storage).
 *
 * @returns {Promise<Array<object>>}
 */
export async function listCodemods() {
  const data = await loadMigrations();
  return [
    ...BUILTIN_CODEMODS.map(({ id, title, description }) => ({ id, title, description, builtin: true })),
    ...data.custom.map((c) => ({ ...c, builtin: false })),
  ];
}

/** Look up a codemod by id across builtin + custom. */
async function findCodemod(id) {
  const builtin = BUILTIN_CODEMODS.find((c) => c.id === id);
  if (builtin) return builtin;
  const data = await loadMigrations();
  const custom = data.custom.find((c) => c.id === id);
  if (!custom) return null;
  // Custom codemods are persisted as string patterns — rehydrate regex.
  try {
    return {
      id: custom.id,
      title: custom.title,
      description: custom.description,
      pattern: new RegExp(custom.pattern, custom.flags || "g"),
      replacement: custom.replacement || "",
    };
  } catch (_e) {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Single-file application                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Apply a single codemod to a text string.
 *
 * @param {string} id
 * @param {string} text
 * @returns {Promise<{ text: string, changes: number }>}
 */
export async function applyCodemod(id, text) {
  if (!id) throw new Error("codemod id required");
  if (typeof text !== "string") throw new Error("text must be a string");
  const mod = await findCodemod(id);
  if (!mod) throw new Error(`unknown codemod "${id}"`);
  let count = 0;
  const out = text.replace(mod.pattern, (...args) => {
    count += 1;
    const replacement = mod.replacement || "";
    // Support $1, $2 capture groups
    return replacement.replace(/\$(\d+)/g, (_m, idx) => args[Number(idx)] || "");
  });
  return { text: out, changes: count };
}

/**
 * Dry-run a codemod across multiple files. Returns the modified files
 * and a diff summary without persisting.
 *
 * @param {string} id
 * @param {Record<string, string>} files
 * @returns {Promise<{ files: Record<string, string>, changes: Record<string, number>, total: number }>}
 */
export async function previewCodemod(id, files) {
  if (!files || typeof files !== "object") throw new Error("files required");
  /** @type {Record<string, string>} */
  const out = {};
  /** @type {Record<string, number>} */
  const changes = {};
  let total = 0;
  for (const [path, text] of Object.entries(files)) {
    if (typeof text !== "string") continue;
    const { text: newText, changes: n } = await applyCodemod(id, text);
    out[path] = newText;
    changes[path] = n;
    total += n;
  }
  return { files: out, changes, total };
}

/* -------------------------------------------------------------------------- */
/* Migration plans                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Compute an aggregate plan for running multiple codemods.
 *
 * @param {string[]} codemodIds
 * @param {Record<string, string>} files
 * @returns {Promise<{ steps: Array<object>, totalChanges: number }>}
 */
export async function getMigrationPlan(codemodIds, files) {
  if (!Array.isArray(codemodIds)) throw new Error("codemodIds array required");
  if (!files || typeof files !== "object") throw new Error("files required");
  /** @type {Record<string, string>} */
  let current = { ...files };
  const steps = [];
  let total = 0;
  for (const id of codemodIds) {
    const result = await previewCodemod(id, current);
    steps.push({
      codemodId: id,
      changes: result.changes,
      totalChanges: result.total,
    });
    current = result.files;
    total += result.total;
  }
  return { steps, totalChanges: total, finalFiles: current };
}

/**
 * Run a migration: apply a sequence of codemods and persist a record.
 *
 * @param {string[]} codemodIds
 * @param {Record<string, string>} files
 * @returns {Promise<{ id: string, files: Record<string, string>, totalChanges: number, steps: Array<object> }>}
 */
export async function runMigration(codemodIds, files) {
  const plan = await getMigrationPlan(codemodIds, files);
  const path = migrationsPath();
  return withPathLock(path, async () => {
    const data = await loadMigrations();
    const now = new Date().toISOString();
    const id = `mig_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const record = {
      id,
      codemodIds,
      steps: plan.steps,
      totalChanges: plan.totalChanges,
      fileCount: Object.keys(files).length,
      startedAt: now,
      completedAt: now,
    };
    data.migrations.push(record);
    if (data.migrations.length > 1000) data.migrations = data.migrations.slice(-1000);
    await saveMigrations(data);
    return { id, files: plan.finalFiles, totalChanges: plan.totalChanges, steps: plan.steps };
  });
}

/** List recent migration runs. */
export async function listMigrations() {
  const data = await loadMigrations();
  return data.migrations;
}
