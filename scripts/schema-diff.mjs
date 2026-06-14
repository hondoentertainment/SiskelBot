#!/usr/bin/env node
/**
 * Phase 61.5: Schema diff CLI.
 *
 * Usage:
 *   node scripts/schema-diff.mjs before.json after.json
 *
 * Prints a human-readable diff and exits 1 if any breaking changes are found,
 * suitable for PR-time gating in CI.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { diffSchemas } from "../lib/schema-registry.js";

async function loadJson(file) {
  const abs = resolve(process.cwd(), file);
  const raw = await readFile(abs, "utf8");
  return JSON.parse(raw);
}

function severityTag(sev) {
  if (sev === "breaking") return "BREAK";
  if (sev === "additive") return "ADD  ";
  return "INFO ";
}

async function main() {
  const [before, after] = process.argv.slice(2);
  if (!before || !after) {
    console.error("usage: scripts/schema-diff.mjs <before.json> <after.json>");
    process.exit(2);
  }
  const [a, b] = await Promise.all([loadJson(before), loadJson(after)]);
  const diff = diffSchemas(a, b);
  if (diff.changes.length === 0) {
    console.log("No changes.");
    process.exit(0);
  }
  for (const c of diff.changes) {
    console.log(`[${severityTag(c.severity)}] ${c.type} @ ${c.path || "/"}`);
    if (c.before !== undefined) console.log(`    before: ${JSON.stringify(c.before)}`);
    if (c.after !== undefined) console.log(`    after:  ${JSON.stringify(c.after)}`);
    if (c.added !== undefined) console.log(`    added:  ${c.added}`);
    if (c.removed !== undefined) console.log(`    removed: ${c.removed}`);
  }
  console.log(`\n${diff.changes.length} change(s), ${diff.breakingCount} breaking.`);
  process.exit(diff.breaking ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
