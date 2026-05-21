#!/usr/bin/env node
/**
 * Seed safety SLA classifiers from eval-history safety samples.
 *
 * Usage:
 *   node scripts/seed-safety-sla-from-traces.mjs --workspace default
 *   node scripts/seed-safety-sla-from-traces.mjs --workspace default --classifier eval-safety-mini
 */
import { parseArgs } from "node:util";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { values } = parseArgs({
  options: {
    workspace: { type: "string", short: "w" },
    classifier: { type: "string", short: "c", default: "eval-safety" },
    since: { type: "string" },
    limit: { type: "string", default: "500" },
    "pass-threshold": { type: "string", default: "0.8" },
    "actual-threshold": { type: "string", default: "0.5" },
    "storage-path": { type: "string" },
  },
});

if (!values.workspace) {
  console.error("Usage: seed-safety-sla-from-traces.mjs --workspace <id> [--classifier id]");
  process.exit(2);
}

if (!process.env.STORAGE_PATH) {
  process.env.STORAGE_PATH = values["storage-path"] || mkdtempSync(join(tmpdir(), "siskel-seed-sla-"));
}

const { seedFromEvalHistory } = await import("../lib/safety-sla.js");

const out = await seedFromEvalHistory({
  workspaceId: values.workspace,
  classifierId: values.classifier,
  sinceTs: values.since ? Number(values.since) : undefined,
  limit: Number(values.limit),
  passThreshold: Number(values["pass-threshold"]),
  actualThreshold: Number(values["actual-threshold"]),
});

console.log(JSON.stringify(out, null, 2));
