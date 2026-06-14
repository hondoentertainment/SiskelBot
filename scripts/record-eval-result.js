#!/usr/bin/env node
/**
 * Record an evaluation result into the eval history store.
 *
 * Examples:
 *   node scripts/record-eval-result.js \
 *     --workspace default \
 *     --kind benchmark \
 *     --suite mini \
 *     --metrics '{"passRate":0.9,"total":10}'
 *
 *   node scripts/record-eval-result.js \
 *     --workspace default \
 *     --kind benchmark \
 *     --suite mini \
 *     --input report.json \
 *     --commit abc123
 *
 * When --input PATH is supplied, the JSON is parsed and its `aggregate` field
 * (benchmark-harness) or its own numeric keys (safety-eval-suite overall) are
 * used to build the `metrics` object. --metrics overrides inferred ones.
 *
 * Writes directly to lib/eval-history-store.js (no HTTP round-trip).
 */

import { readFileSync } from "fs";
import { recordSample } from "../lib/eval-history-store.js";

function log(...args) {
  const ts = new Date().toISOString();
  process.stderr.write(`[${ts}] [record-eval-result] ${args.join(" ")}\n`);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function metricsFromReport(report) {
  if (!report || typeof report !== "object") return {};
  const out = {};
  const src =
    (report.aggregate && typeof report.aggregate === "object" && report.aggregate) ||
    (report.overall && typeof report.overall === "object" && report.overall) ||
    report;
  // Flatten one level: keep numeric leaves only.
  for (const [k, v] of Object.entries(src)) {
    if (Number.isFinite(v)) out[k] = Number(v);
  }
  // Safety-eval-suite exposes overall.{total,passed,passRate,durationMs}
  if (report.overall && typeof report.overall === "object") {
    for (const [k, v] of Object.entries(report.overall)) {
      if (Number.isFinite(v)) out[k] = Number(v);
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const workspace = typeof args.workspace === "string" ? args.workspace : "default";
  const kind = typeof args.kind === "string" ? args.kind : null;
  if (!kind) {
    log("ERROR: --kind is required (benchmark|safety|feedback|genealogy|custom)");
    process.exit(2);
  }
  const suite = typeof args.suite === "string" ? args.suite : undefined;
  const commit = typeof args.commit === "string" ? args.commit : undefined;

  /** @type {Record<string, number>} */
  let metrics = {};

  if (typeof args.input === "string") {
    try {
      const raw = readFileSync(args.input, "utf8");
      const parsed = JSON.parse(raw);
      metrics = metricsFromReport(parsed);
      log(`read ${Object.keys(metrics).length} metrics from ${args.input}`);
    } catch (err) {
      log("ERROR: failed to read --input", args.input, String(err?.message || err));
      process.exit(2);
    }
  }

  if (typeof args.metrics === "string") {
    try {
      const parsed = JSON.parse(args.metrics);
      if (!parsed || typeof parsed !== "object") throw new Error("must be a JSON object");
      metrics = { ...metrics, ...parsed };
    } catch (err) {
      log("ERROR: --metrics must be a JSON object", String(err?.message || err));
      process.exit(2);
    }
  }

  if (!metrics || Object.keys(metrics).length === 0) {
    log("ERROR: no metrics collected (supply --metrics and/or --input)");
    process.exit(2);
  }

  let tags;
  if (typeof args.tags === "string") {
    try {
      const parsed = JSON.parse(args.tags);
      if (parsed && typeof parsed === "object") tags = parsed;
    } catch (err) {
      log("WARN: ignoring malformed --tags:", String(err?.message || err));
    }
  }

  const sample = {
    ts: Date.now(),
    kind,
    suite,
    metrics,
    commit,
    tags,
  };

  try {
    const saved = await recordSample(workspace, sample);
    log(`recorded sample ${saved.id} (kind=${saved.kind} suite=${saved.suite || "-"}) for workspace=${workspace}`);
    process.stdout.write(JSON.stringify(saved, null, 2) + "\n");
  } catch (err) {
    log("ERROR: recordSample failed:", String(err?.message || err));
    process.exit(1);
  }
}

main().catch((err) => {
  log("FATAL:", String(err?.stack || err));
  process.exit(1);
});
