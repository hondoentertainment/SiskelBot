/**
 * Run eval sets in CI mode.
 * Starts the server, runs all eval sets, reports results, exits with failure if any eval fails.
 *
 * Usage: node scripts/run-eval-ci.mjs [--set=<setId>] [--threshold=0.8]
 *
 * Environment:
 *   EVAL_BASE_URL - server URL (default: http://localhost:3000)
 *   EVAL_API_KEY  - API key for auth
 *   EVAL_THRESHOLD - minimum pass rate (0-1, default 0.8)
 */

const args = process.argv.slice(2);

function getArg(name) {
  const prefix = `--${name}=`;
  const found = args.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

const baseUrl = (process.env.EVAL_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const apiKey = process.env.EVAL_API_KEY || process.env.API_KEY || "";
const threshold = parseFloat(getArg("threshold") ?? process.env.EVAL_THRESHOLD ?? "0.8");
const targetSetId = getArg("set") || null;

function headers() {
  const h = { "Content-Type": "application/json" };
  if (apiKey) {
    h["Authorization"] = `Bearer ${apiKey}`;
    h["x-api-key"] = apiKey;
  }
  return h;
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, { ...options, headers: headers() });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${options.method || "GET"} ${url} returned ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function listSets() {
  const data = await fetchJson(`${baseUrl}/api/v1/eval/sets`);
  return data.sets || [];
}

async function runSet(evalSetId) {
  return fetchJson(`${baseUrl}/api/v1/eval/run`, {
    method: "POST",
    body: JSON.stringify({ evalSetId }),
  });
}

function printTable(rows) {
  const colWidths = [30, 8, 8, 8, 10];
  const header = ["Eval Set", "Passed", "Failed", "Skipped", "Duration"];
  const sep = colWidths.map((w) => "-".repeat(w)).join("-+-");
  const fmt = (vals) =>
    vals.map((v, i) => String(v).padEnd(colWidths[i])).join(" | ");

  console.log(fmt(header));
  console.log(sep);
  for (const r of rows) {
    console.log(fmt(r));
  }
  console.log(sep);
}

async function main() {
  console.log(`Eval CI runner`);
  console.log(`  Base URL:  ${baseUrl}`);
  console.log(`  Threshold: ${threshold}`);
  if (targetSetId) console.log(`  Set:       ${targetSetId}`);
  console.log();

  let setIds;
  if (targetSetId) {
    setIds = [targetSetId];
  } else {
    const sets = await listSets();
    if (sets.length === 0) {
      console.log("No eval sets found. Exiting with success.");
      process.exit(0);
    }
    setIds = sets.map((s) => s.id);
    console.log(`Found ${setIds.length} eval set(s): ${setIds.join(", ")}`);
  }
  console.log();

  const allResults = [];
  const tableRows = [];
  let totalPassed = 0;
  let totalFailed = 0;
  let totalSkipped = 0;

  for (const setId of setIds) {
    console.log(`Running eval set: ${setId} ...`);
    try {
      const result = await runSet(setId);
      const failed = result.total - result.passed - result.skipped;
      totalPassed += result.passed;
      totalFailed += failed;
      totalSkipped += result.skipped;

      tableRows.push([
        setId,
        result.passed,
        failed,
        result.skipped,
        `${result.durationMs}ms`,
      ]);

      allResults.push({ setId, ...result });

      for (const r of result.results || []) {
        const status = r.skipped ? "SKIP" : r.pass ? "PASS" : "FAIL";
        const detail = r.reason ? ` — ${r.reason}` : "";
        console.log(`  [${status}] ${r.caseId}${detail}`);
      }
      console.log();
    } catch (err) {
      console.error(`  ERROR running ${setId}: ${err.message}`);
      allResults.push({ setId, error: err.message, passed: 0, total: 0, skipped: 0, results: [] });
      tableRows.push([setId, 0, "ERR", 0, "-"]);
      console.log();
    }
  }

  console.log("=== Summary ===");
  printTable(tableRows);

  const totalEvaluated = totalPassed + totalFailed;
  const passRate = totalEvaluated > 0 ? totalPassed / totalEvaluated : 1;
  console.log();
  console.log(`Total: ${totalPassed} passed, ${totalFailed} failed, ${totalSkipped} skipped`);
  console.log(`Pass rate: ${(passRate * 100).toFixed(1)}% (threshold: ${(threshold * 100).toFixed(1)}%)`);

  const output = {
    timestamp: new Date().toISOString(),
    baseUrl,
    threshold,
    passRate,
    totalPassed,
    totalFailed,
    totalSkipped,
    sets: allResults,
  };

  const { writeFileSync } = await import("fs");
  writeFileSync("eval-results.json", JSON.stringify(output, null, 2));
  console.log("\nResults written to eval-results.json");

  if (passRate < threshold) {
    console.error(`\nFAILED: pass rate ${(passRate * 100).toFixed(1)}% < threshold ${(threshold * 100).toFixed(1)}%`);
    process.exit(1);
  }

  console.log("\nPASSED");
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
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
