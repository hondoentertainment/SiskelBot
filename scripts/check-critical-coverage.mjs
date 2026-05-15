#!/usr/bin/env node
/**
 * Enforces stricter per-file coverage thresholds for agent-critical modules.
 *
 * c8 supports a single global `check-coverage` threshold, but not different
 * thresholds per file. This script reads coverage/coverage-summary.json
 * (produced by c8's json-summary reporter) and fails if any listed module
 * misses its per-file floor.
 *
 * Wire-up: run `npm run test:coverage` first (c8 emits coverage-summary.json),
 * then `npm run coverage:critical` which invokes this script.
 *
 * Default thresholds (per file): lines >= 80, branches >= 70, functions >= 75.
 * Use PER_FILE_THRESHOLDS for narrow overrides.
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, relative, sep } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");

const CRITICAL_FILES = [
  "lib/agent-loop.js",
  "lib/agent-loop-execute-tools.js",
  "lib/agent-tools.js",
  "lib/agent-hitl-store.js",
  "lib/agent-run-control.js",
  "lib/swarm.js",
  "lib/circuit-breaker.js",
  "lib/webhook-delivery.js",
];

const PER_FILE_THRESHOLDS = {
  "lib/agent-loop.js": { lines: 75, functions: 66 },
  // Large surface area; raise floors when adding focused tests (see tests/agent-tools*.test.js).
  "lib/agent-tools.js": { lines: 73, branches: 68 },
};

const THRESHOLDS = {
  lines: 80,
  branches: 70,
  functions: 75,
};

function pct(obj, key) {
  const v = obj?.[key]?.pct;
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function normalizeKey(k) {
  if (!k || k === "total") return k;
  const rel = relative(REPO_ROOT, k);
  return rel.split(sep).join("/");
}

function findEntry(summary, relPath) {
  for (const [k, v] of Object.entries(summary)) {
    if (k === "total") continue;
    const norm = normalizeKey(k);
    if (norm === relPath) return v;
  }
  return null;
}

function main() {
  const summaryPath = join(REPO_ROOT, "coverage", "coverage-summary.json");
  if (!existsSync(summaryPath)) {
    console.error(
      `[check-critical-coverage] ${summaryPath} not found.\n` +
        "Run `npm run test:coverage` first (c8 emits json-summary into coverage/)."
    );
    process.exit(2);
  }

  let summary;
  try {
    summary = JSON.parse(readFileSync(summaryPath, "utf8"));
  } catch (e) {
    console.error("[check-critical-coverage] cannot parse coverage-summary.json:", e.message);
    process.exit(2);
  }

  let failed = false;
  const rows = [];
  for (const rel of CRITICAL_FILES) {
    const entry = findEntry(summary, rel);
    if (!entry) {
      rows.push({ file: rel, status: "MISSING", lines: 0, branches: 0, functions: 0, statements: 0 });
      failed = true;
      continue;
    }
    const lines = pct(entry, "lines");
    const branches = pct(entry, "branches");
    const functions = pct(entry, "functions");
    const statements = pct(entry, "statements");
    const floor = { ...THRESHOLDS, ...PER_FILE_THRESHOLDS[rel] };
    const ok =
      lines >= floor.lines &&
      branches >= floor.branches &&
      functions >= floor.functions;
    rows.push({ file: rel, status: ok ? "OK" : "FAIL", lines, branches, functions, statements });
    if (!ok) failed = true;
  }

  const pad = (s, n) => String(s).padEnd(n);
  console.log("");
  console.log(
    pad("file", 42),
    pad("lines", 10),
    pad("branches", 10),
    pad("functions", 10),
    pad("status", 8)
  );
  console.log("-".repeat(82));
  for (const r of rows) {
    console.log(
      pad(r.file, 42),
      pad(r.lines.toFixed(1) + "%", 10),
      pad(r.branches.toFixed(1) + "%", 10),
      pad(r.functions.toFixed(1) + "%", 10),
      pad(r.status, 8)
    );
  }
  console.log("");
  console.log(
    `Default thresholds: lines >= ${THRESHOLDS.lines}%, branches >= ${THRESHOLDS.branches}%, ` +
      `functions >= ${THRESHOLDS.functions}% (see PER_FILE_THRESHOLDS for overrides)`
  );

  if (failed) {
    console.error("[check-critical-coverage] Some critical files are below the floor.");
    process.exit(1);
  }
  console.log("[check-critical-coverage] All critical files meet the floor.");
}

main();
