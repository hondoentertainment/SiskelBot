// @ts-check
/**
 * Phase 63.3: Test generation.
 *
 * Coverage-gap-driven test scaffolding. Given a function signature and
 * file text, emit a test skeleton and suggest fixtures.
 *
 *   - `analyzeCoverage(coverage)` — rank files/functions by missing coverage
 *   - `listGaps()` — return persisted coverage gaps
 *   - `generateTestScaffold(opts)` — build a test stub
 *   - `recordGeneratedTest(rec)` — persist bookkeeping
 *   - `getSuggestedFixtures(signature)` — propose fixture values
 *
 * @module test-generation
 */
import { join } from "path";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;

function gapsPath() {
  return join(getDataDir(), "test-gen-gaps.json");
}

function generatedPath() {
  return join(getDataDir(), "test-gen-generated.json");
}

async function loadGaps() {
  const data = await readJsonPath(gapsPath(), { version: STORE_VERSION, gaps: [] });
  if (!Array.isArray(data.gaps)) data.gaps = [];
  return data;
}

async function saveGaps(data) {
  await writeJsonPath(gapsPath(), { version: STORE_VERSION, gaps: data.gaps || [] });
}

async function loadGenerated() {
  const data = await readJsonPath(generatedPath(), { version: STORE_VERSION, generated: [] });
  if (!Array.isArray(data.generated)) data.generated = [];
  return data;
}

async function saveGenerated(data) {
  await writeJsonPath(generatedPath(), { version: STORE_VERSION, generated: data.generated || [] });
}

/* -------------------------------------------------------------------------- */
/* Coverage analysis                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Ingest a simple coverage report and compute ranked gaps.
 *
 * Report shape:
 *   { files: [{ path, lines: number, covered: number, functions?: [{name, covered}] }] }
 *
 * Returns a sorted list of gap records, persisted.
 *
 * @param {object} coverage
 * @returns {Promise<Array<object>>}
 */
export async function analyzeCoverage(coverage) {
  if (!coverage || typeof coverage !== "object") throw new Error("coverage is required");
  const files = Array.isArray(coverage.files) ? coverage.files : [];
  /** @type {Array<object>} */
  const gaps = [];
  for (const f of files) {
    if (!f || !f.path) continue;
    const lines = Number(f.lines) || 0;
    const covered = Number(f.covered) || 0;
    const pct = lines > 0 ? covered / lines : 1;
    const uncoveredLines = Math.max(0, lines - covered);
    /** @type {Array<{name: string, covered: boolean}>} */
    const uncoveredFns = Array.isArray(f.functions)
      ? f.functions.filter((fn) => fn && fn.covered === false).map((fn) => ({ name: fn.name, covered: false }))
      : [];
    gaps.push({
      path: f.path,
      coveragePct: Math.round(pct * 10000) / 100,
      lines,
      covered,
      uncoveredLines,
      uncoveredFunctions: uncoveredFns,
      severity: pct < 0.5 ? "high" : pct < 0.8 ? "medium" : "low",
    });
  }
  gaps.sort((a, b) => a.coveragePct - b.coveragePct);
  const now = new Date().toISOString();
  await withPathLock(gapsPath(), async () => {
    await saveGaps({ gaps: gaps.map((g) => ({ ...g, analyzedAt: now })) });
  });
  return gaps;
}

/** List persisted coverage gaps. */
export async function listGaps() {
  const data = await loadGaps();
  return data.gaps;
}

/* -------------------------------------------------------------------------- */
/* Signature parsing                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Parse a JS function signature like `function name(a, b, c)` or
 * `name(a, b)` into { name, params }.
 *
 * @param {string} sig
 * @returns {{ name: string, params: string[] } | null}
 */
export function parseSignature(sig) {
  if (typeof sig !== "string") return null;
  const m = sig.match(/(?:function\s+)?([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(([^)]*)\)/);
  if (!m) return null;
  const params = m[2]
    .split(",")
    .map((p) => p.trim().replace(/[=:{}[\]].*$/, "").trim())
    .filter(Boolean);
  return { name: m[1], params };
}

/**
 * Propose default fixture values for parameter names.
 *
 * @param {string | { name: string, params: string[] }} signature
 * @returns {Record<string, any>}
 */
export function getSuggestedFixtures(signature) {
  const parsed = typeof signature === "string" ? parseSignature(signature) : signature;
  if (!parsed) return {};
  /** @type {Record<string, any>} */
  const out = {};
  for (const p of parsed.params) {
    const lower = p.toLowerCase();
    if (/count|num|len|size|idx/.test(lower)) out[p] = 1;
    else if (/name|label|title|text|msg|message/.test(lower)) out[p] = "test";
    else if (/list|arr|items|values/.test(lower)) out[p] = [];
    else if (/opts|config|options|params/.test(lower)) out[p] = {};
    else if (/flag|bool|is[A-Z]|has[A-Z]|enable/.test(lower)) out[p] = true;
    else if (/id$/.test(lower)) out[p] = "id_1";
    else out[p] = null;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Scaffold generation                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Generate a node:test scaffold for a function.
 *
 * @param {object} opts
 * @param {string} opts.signature Required. Function signature string.
 * @param {string} [opts.modulePath] Path used in `import` statement.
 * @param {string} [opts.fileText] Surrounding file text for context.
 * @returns {{ name: string, code: string, fixtures: Record<string, any> }}
 */
export function generateTestScaffold(opts = {}) {
  if (!opts || typeof opts.signature !== "string") {
    throw new Error("signature required");
  }
  const parsed = parseSignature(opts.signature);
  if (!parsed) throw new Error(`could not parse signature "${opts.signature}"`);
  const fixtures = getSuggestedFixtures(parsed);
  const modulePath = opts.modulePath || `../lib/${parsed.name}.js`;
  const argList = parsed.params.map((p) => JSON.stringify(fixtures[p])).join(", ");
  const code = `import test from "node:test";
import assert from "node:assert/strict";
import { ${parsed.name} } from "${modulePath}";

test("${parsed.name} returns a defined result for default input", () => {
  const result = ${parsed.name}(${argList});
  assert.notEqual(result, undefined);
});

test("${parsed.name} handles edge cases", () => {
  // TODO: add edge case tests
  assert.ok(true);
});
`;
  return { name: parsed.name, code, fixtures };
}

/* -------------------------------------------------------------------------- */
/* Bookkeeping                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Persist a record that a test has been generated.
 *
 * @param {object} rec
 * @returns {Promise<object>}
 */
export async function recordGeneratedTest(rec) {
  if (!rec || typeof rec !== "object") throw new Error("rec required");
  if (!rec.name || typeof rec.name !== "string") throw new Error("rec.name required");
  const path = generatedPath();
  return withPathLock(path, async () => {
    const data = await loadGenerated();
    const now = new Date().toISOString();
    const record = {
      id: `gen_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      name: rec.name,
      modulePath: rec.modulePath || null,
      signature: rec.signature || null,
      testPath: rec.testPath || null,
      createdAt: now,
    };
    data.generated.push(record);
    if (data.generated.length > 10000) data.generated = data.generated.slice(-10000);
    await saveGenerated(data);
    return record;
  });
}
