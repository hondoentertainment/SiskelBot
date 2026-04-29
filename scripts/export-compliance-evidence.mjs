#!/usr/bin/env node
/**
 * Wave 19A: Export compliance evidence snapshots for auditors.
 *
 * Usage:
 *   node scripts/export-compliance-evidence.mjs [--output <file.json>] [--days 90]
 *
 * Prints a summary table to stdout and writes a JSON file if --output is given.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);

function getArg(flag, defaultVal) {
  const idx = args.indexOf(flag);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return defaultVal;
}

const outputFile = getArg("--output", null);
const days = parseInt(getArg("--days", "90"), 10) || 90;

const { listEvidenceSnapshots, collectEvidence } = await import("../lib/compliance-evidence.js");

const limit = Math.min(days, 365);
const snapshots = await listEvidenceSnapshots({ limit });

if (snapshots.length === 0) {
  console.log("No compliance evidence snapshots found.");
  console.log("Run: curl -X POST -H 'x-admin-api-key: <key>' http://localhost:3000/api/v1/admin/compliance/evidence/collect");
  process.exit(0);
}

const colDate = 12;
const colWs = 12;
const colAuth = 40;
const colSsl = 8;

function pad(s, n) {
  return String(s).padEnd(n).slice(0, n);
}

const header =
  "| " + pad("Date", colDate) +
  " | " + pad("Workspaces", colWs) +
  " | " + pad("Auth Methods", colAuth) +
  " | " + pad("DB SSL", colSsl) + " |";
const divider = "|-" + "-".repeat(colDate) + "-|-" + "-".repeat(colWs) + "-|-" + "-".repeat(colAuth) + "-|-" + "-".repeat(colSsl) + "-|";

console.log(divider);
console.log(header);
console.log(divider);

for (const snap of snapshots) {
  const date = (snap.collectedAt || "").slice(0, 10) || "unknown";
  const ws = String(snap.summary?.workspaceCount ?? "?");
  const methods = Object.entries(snap.summary?.authMethods || {})
    .filter(([, v]) => v)
    .map(([k]) => k)
    .join(", ") || "none";
  const ssl = snap.summary?.databaseSsl ? "yes" : "no";
  console.log(
    "| " + pad(date, colDate) +
    " | " + pad(ws, colWs) +
    " | " + pad(methods, colAuth) +
    " | " + pad(ssl, colSsl) + " |"
  );
}
console.log(divider);
console.log(`\nTotal snapshots: ${snapshots.length} (last ${days} days requested)`);

if (outputFile) {
  const out = {
    exportedAt: new Date().toISOString(),
    days,
    snapshotCount: snapshots.length,
    snapshots,
  };
  const resolved = outputFile.startsWith("/") ? outputFile : join(process.cwd(), outputFile);
  writeFileSync(resolved, JSON.stringify(out, null, 2), "utf8");
  console.log(`\nExported to: ${resolved}`);
}
