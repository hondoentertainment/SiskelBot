#!/usr/bin/env node
/**
 * Renders a regression-gate JSON report as a GitHub-flavored markdown comment.
 *
 * Usage:
 *   node scripts/ci-pr-comment.js --input report.json [--output comment.md]
 *
 * The pure renderer (buildMarkdownComment) is exported so tests and other
 * scripts can format a report without touching the filesystem.
 */
import { readFileSync, writeFileSync } from "node:fs";

const PASS_ICON = "\u2705"; // white heavy check mark
const FAIL_ICON = "\u274C"; // cross mark
const WARN_ICON = "\u26A0\uFE0F"; // warning sign

/**
 * Build the full markdown comment for a report object.
 * @param {object} report - shape from ci-regression-gate.js buildReport()
 * @returns {string}
 */
export function buildMarkdownComment(report) {
  if (!report || typeof report !== "object") {
    return "## Agent regression gate — " + FAIL_ICON + " FAIL\n\n_No report available._\n";
  }
  const overallIcon = report.status === "pass" ? PASS_ICON : FAIL_ICON;
  const overallLabel = report.status === "pass" ? "PASS" : "FAIL";
  const lines = [];
  lines.push(`## Agent regression gate — ${overallIcon} ${overallLabel}`);
  lines.push("");
  lines.push("| Gate | Value | Threshold | Status |");
  lines.push("|---|---|---|---|");
  lines.push(renderBenchmarkRow(report.gates && report.gates.benchmark));
  lines.push(renderSafetyRow(report.gates && report.gates.safety));
  lines.push(renderEvalRow(report.gates && report.gates.eval));
  lines.push("");

  if (report.status === "fail") {
    const failed = collectFailedGates(report.gates || {});
    if (failed.length > 0) {
      lines.push("### Failed gates");
      for (const f of failed) {
        lines.push(`- **${f.name}**: ${f.reason}`);
      }
      lines.push("");
    }
  }

  const commit = report.commit ? String(report.commit).slice(0, 7) : "unknown";
  const runtime = typeof report.runtimeSec === "number" ? `${report.runtimeSec}s` : "?";
  lines.push(`Commit: \`${commit}\` · Runtime: ${runtime}`);
  if (report.timestamp) lines.push(`_Generated at ${report.timestamp}_`);
  lines.push("");
  return lines.join("\n");
}

function renderBenchmarkRow(gate) {
  if (!gate) return `| Benchmark | n/a | n/a | ${WARN_ICON} missing |`;
  const icon = gate.status === "pass" ? PASS_ICON : FAIL_ICON;
  const suite = gate.details && gate.details.suite ? gate.details.suite : "mini";
  if (typeof gate.passRate !== "number") {
    return `| Benchmark (${suite}) | n/a | ≥ ${pct(gate.threshold)} | ${icon} ${gate.reason || gate.status} |`;
  }
  return `| Benchmark (${suite}) | ${pct(gate.passRate)} (${gate.passed}/${gate.total}) | ≥ ${pct(gate.threshold)} | ${icon} |`;
}

function renderSafetyRow(gate) {
  if (!gate) return `| Safety | n/a | n/a | ${WARN_ICON} missing |`;
  const icon = gate.status === "pass" ? PASS_ICON : FAIL_ICON;
  const category = gate.details && gate.details.category ? gate.details.category : "all";
  if (typeof gate.passRate !== "number") {
    return `| Safety (${category}) | n/a | ≥ ${pct(gate.threshold)} | ${icon} ${gate.reason || gate.status} |`;
  }
  return `| Safety (${category}) | ${pct(gate.passRate)} (${gate.passed}/${gate.total}) | ≥ ${pct(gate.threshold)} | ${icon} |`;
}

function renderEvalRow(gate) {
  if (!gate) return `| Internal evals | n/a | n/a | ${WARN_ICON} missing |`;
  const icon = gate.status === "pass" ? PASS_ICON : FAIL_ICON;
  if (typeof gate.total !== "number" || gate.total === 0) {
    return `| Internal evals | n/a | ≥ ${pct(gate.threshold)} | ${icon} ${gate.reason || gate.status} |`;
  }
  return `| Internal evals | ${gate.passed}/${gate.total} pass | ≥ ${pct(gate.threshold)} | ${icon} |`;
}

function collectFailedGates(gates) {
  const out = [];
  for (const [name, gate] of Object.entries(gates)) {
    if (!gate || gate.status !== "fail") continue;
    let description = gate.reason || "failed";
    if (typeof gate.passRate === "number") {
      description = `${pct(gate.passRate)} (${gate.passed}/${gate.total}) below threshold ${pct(gate.threshold)}`;
    } else if (typeof gate.total === "number" && gate.total > 0) {
      description = `${gate.passed}/${gate.total} (${pct(gate.passed / gate.total)}) below threshold ${pct(gate.threshold)}`;
    }
    out.push({ name: prettyName(name), reason: description });
  }
  return out;
}

function prettyName(name) {
  switch (name) {
    case "benchmark": return "Benchmark";
    case "safety": return "Safety";
    case "eval": return "Internal evals";
    default: return name;
  }
}

function pct(n) {
  if (typeof n !== "number" || Number.isNaN(n)) return "n/a";
  return `${(n * 100).toFixed(1)}%`;
}

// -------- CLI wiring --------

function parseArgs(argv) {
  const out = { input: null, output: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    switch (a) {
      case "--input": out.input = next; i++; break;
      case "--output": out.output = next; i++; break;
      case "--help":
      case "-h":
        console.log("Usage: node scripts/ci-pr-comment.js --input report.json [--output comment.md]");
        process.exit(0);
        break;
      default:
        if (a.startsWith("--")) console.error("Unknown flag:", a);
    }
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.input) {
    console.error("--input is required");
    process.exit(2);
  }
  let report;
  try {
    report = JSON.parse(readFileSync(args.input, "utf8"));
  } catch (e) {
    console.error("Failed to read/parse", args.input, "-", e.message);
    process.exit(2);
  }
  const md = buildMarkdownComment(report);
  if (args.output) {
    writeFileSync(args.output, md);
    console.log("Wrote", args.output);
  } else {
    process.stdout.write(md);
  }
}

// Only run CLI when invoked directly (not when imported by tests or sibling scripts).
import { fileURLToPath as _fileURLToPath } from "node:url";
import { resolve as _resolve } from "node:path";
const _isDirect = (() => {
  try {
    if (!process.argv[1]) return false;
    return _fileURLToPath(import.meta.url) === _resolve(process.argv[1]);
  } catch {
    return false;
  }
})();
if (_isDirect) main();
