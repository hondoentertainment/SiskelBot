#!/usr/bin/env node
/**
 * Offline eval gate for CI: golden trace + staging_trace (no LLM, no server).
 * Prints each failing case id and reason for actionable logs.
 *
 * Usage: node scripts/run-eval-ci.mjs
 * Optional: EVAL_CI_SET_PATH=path/to.json (default: data/eval-sets/ci-offline.json)
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runEvalSet } from "../lib/eval-runner.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const setPath = resolve(root, process.env.EVAL_CI_SET_PATH || "data/eval-sets/ci-offline.json");

if (!existsSync(setPath)) {
  console.error(`run-eval-ci: eval set not found: ${setPath}`);
  process.exit(1);
}

const raw = readFileSync(setPath, "utf8");
const evalSet = JSON.parse(raw);

const out = await runEvalSet(evalSet, {
  baseUrl: "http://127.0.0.1:9",
  stagingTraceRoot: root,
}); // stagingTraceRoot: resolve paths from repo root when cwd differs

const lines = [];
lines.push(`Eval CI: set=${evalSet.id || "unknown"} total=${out.total} passed=${out.passed} skipped=${out.skipped ?? 0}`);

let failed = 0;
for (const r of out.results || []) {
  if (r.skipped) continue;
  if (!r.pass) {
    failed++;
    lines.push(`  FAIL caseId=${r.caseId} reason=${r.reason || "(no reason)"}`);
  }
}

console.log(lines.join("\n"));

if (failed > 0) {
  console.error(`\nrun-eval-ci: ${failed} case(s) failed. Fix golden trace expectations or staging export.`);
  process.exit(1);
}

process.exit(0);
