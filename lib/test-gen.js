/**
 * Phase 63.3: Test generation.
 *
 * Consumes an lcov coverage report, identifies modules with uncovered lines,
 * and produces minimal test stubs targeting those gaps. This is a deterministic
 * surface — the stubs are scaffolding the engineer fills in.
 *
 * Storage layout:
 *   data/test-gen/{workspaceId}.json
 *     { gaps: [{ path, linesFound, linesHit, uncoveredLines, analyzedAt }],
 *       history: [{ id, createdAt, modulePath, uncoveredLines, stub }] }
 */
import { randomUUID } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const MAX_HISTORY = 500;

function sanitizeId(val, fallback = "default") {
  if (typeof val !== "string" || !val.trim()) return fallback;
  return val.trim().replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || fallback;
}

function storePath(workspaceId) {
  return join(getDataDir(), "test-gen", `${sanitizeId(workspaceId)}.json`);
}

/**
 * Parse LCOV text. Handles SF: (source file), DA:<line>,<hits>, LF:, LH:, end_of_record.
 */
export function parseLcov(text) {
  if (typeof text !== "string" || !text.trim()) return { files: [] };
  const files = [];
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("SF:")) {
      current = {
        path: line.slice(3).trim(),
        linesFound: 0,
        linesHit: 0,
        uncoveredLines: [],
      };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("DA:")) {
      const rest = line.slice(3);
      const [ln, hits] = rest.split(",");
      const lineNum = Number(ln);
      const hitCount = Number(hits);
      if (Number.isFinite(lineNum) && hitCount === 0) {
        current.uncoveredLines.push(lineNum);
      }
      continue;
    }
    if (line.startsWith("LF:")) {
      current.linesFound = Number(line.slice(3)) || 0;
      continue;
    }
    if (line.startsWith("LH:")) {
      current.linesHit = Number(line.slice(3)) || 0;
      continue;
    }
    if (line === "end_of_record") {
      // If LF/LH were absent, compute from DA.
      if (!current.linesFound && current.uncoveredLines.length) {
        current.linesFound = current.uncoveredLines.length + current.linesHit;
      }
      files.push(current);
      current = null;
      continue;
    }
  }
  if (current) files.push(current);
  return { files };
}

/**
 * Parse lcov, persist gaps, return them.
 */
export async function identifyGaps({ workspaceId, lcov } = {}) {
  const ws = sanitizeId(workspaceId);
  const parsed = parseLcov(lcov || "");
  const analyzedAt = Date.now();
  const gaps = parsed.files
    .filter((f) => f.uncoveredLines.length > 0)
    .map((f) => ({ ...f, analyzedAt }));
  const file = storePath(ws);
  await withPathLock(file, async () => {
    const store = await readJsonPath(file, { gaps: [], history: [] });
    store.gaps = gaps;
    await writeJsonPath(file, store);
  });
  return { files: parsed.files, gaps };
}

/**
 * Produce a minimal test stub string targeting a module's uncovered lines.
 * Also stores the generation in history.
 */
export async function generateTestStub({ workspaceId, modulePath, uncoveredLines, moduleSource } = {}) {
  const ws = sanitizeId(workspaceId);
  if (typeof modulePath !== "string" || !modulePath.trim()) {
    throw new Error("modulePath is required");
  }
  const lines = Array.isArray(uncoveredLines)
    ? uncoveredLines.filter((n) => Number.isFinite(Number(n))).map((n) => Number(n))
    : [];
  const moduleName = modulePath.replace(/\\/g, "/").split("/").pop().replace(/\.(js|mjs|ts|cjs)$/, "");
  const importPath = modulePath.startsWith(".") || modulePath.startsWith("/")
    ? modulePath
    : `../${modulePath}`;
  // Extract exported symbol names from moduleSource if available.
  const exported = [];
  if (typeof moduleSource === "string" && moduleSource) {
    const exportRe = /export\s+(?:async\s+)?(?:function|const|let|var|class)\s+(\w+)/g;
    let m;
    while ((m = exportRe.exec(moduleSource)) !== null) {
      if (!exported.includes(m[1])) exported.push(m[1]);
    }
  }
  const importLine = exported.length
    ? `import { ${exported.slice(0, 8).join(", ")} } from "${importPath}";`
    : `import * as target from "${importPath}";`;
  const stub = [
    `/**`,
    ` * Auto-generated test stub for ${modulePath}.`,
    ` * Uncovered lines flagged by coverage run:`,
    ` *   ${lines.length ? lines.join(", ") : "(none)"}`,
    ` * TODO: replace scaffolding below with real assertions.`,
    ` */`,
    `import test from "node:test";`,
    `import assert from "node:assert/strict";`,
    importLine,
    ``,
    `test("${moduleName}: smoke test (auto-generated)", () => {`,
    `  // TODO: exercise uncovered lines — ${lines.slice(0, 20).join(", ") || "n/a"}`,
    exported.length
      ? `  assert.ok(${exported[0]});`
      : `  assert.ok(target);`,
    `});`,
    ``,
  ].join("\n");

  const record = {
    id: randomUUID(),
    createdAt: Date.now(),
    modulePath,
    uncoveredLines: lines,
    stub,
  };
  const file = storePath(ws);
  await withPathLock(file, async () => {
    const store = await readJsonPath(file, { gaps: [], history: [] });
    const history = Array.isArray(store.history) ? store.history : [];
    history.push(record);
    store.history = history.length > MAX_HISTORY ? history.slice(-MAX_HISTORY) : history;
    await writeJsonPath(file, store);
  });
  return { stub, record };
}

export async function listGaps(workspaceId) {
  const ws = sanitizeId(workspaceId);
  const store = await readJsonPath(storePath(ws), { gaps: [], history: [] });
  return { gaps: store.gaps || [] };
}

export async function listHistory(workspaceId) {
  const ws = sanitizeId(workspaceId);
  const store = await readJsonPath(storePath(ws), { gaps: [], history: [] });
  const history = (store.history || []).slice().sort((a, b) => b.createdAt - a.createdAt);
  return { history };
}

export async function _reset(workspaceId) {
  if (workspaceId) {
    await writeJsonPath(storePath(workspaceId), { gaps: [], history: [] });
    return;
  }
  await writeJsonPath(storePath("default"), { gaps: [], history: [] });
}

export const _internals = { sanitizeId, storePath };
