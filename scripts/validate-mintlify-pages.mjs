#!/usr/bin/env node
/**
 * Validate Mintlify navigation pages from mint.json.
 * Internal engineering markdown under docs/ may contain bare "%" (percentages,
 * shell formats, Windows env vars) that break `mintlify broken-links` when it
 * scans the whole tree — so we only assert that navigable pages exist.
 */
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const cfg = JSON.parse(readFileSync("mint.json", "utf8"));
const missing = [];
const pages = [];

function visit(group) {
  for (const p of group.pages || []) {
    if (typeof p === "string") pages.push(p);
    else if (p?.pages) visit(p);
  }
}
for (const nav of cfg.navigation || []) visit(nav);

for (const p of pages) {
  const candidates = [`${p}.md`, `${p}.mdx`].map((c) => resolve(process.cwd(), c));
  if (!candidates.some((c) => existsSync(c))) missing.push(p);
}

if (missing.length) {
  console.error("Missing Mintlify pages:");
  for (const m of missing) console.error("  " + m);
  process.exit(1);
}
console.log(`OK: ${pages.length} Mintlify navigation pages exist.`);
