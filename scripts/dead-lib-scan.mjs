#!/usr/bin/env node
/**
 * Heuristic dead-lib scan (docs/NEXT_STEPS.md P0): walks lib/ recursively and lists
 * modules whose basename never appears as an obvious static import path elsewhere.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWLIST_PATH = join(ROOT, "lib", ".dead-lib-allowlist");

function loadAllowlist() {
  try {
    return readFileSync(ALLOWLIST_PATH, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => (l.startsWith("lib/") ? l : `lib/${l}`));
  } catch {
    return [];
  }
}

const SKIP_DIRS = new Set([
  "node_modules",
  "coverage",
  ".git",
  "client",
  "electron",
  "plugins",
  "data",
  ".claude",
  "release",
  ".vercel",
  "vscode-extension",
  "sdk",
]);

function walkJs(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      walkJs(p, acc);
    } else if (ent.isFile() && ent.name.endsWith(".js")) acc.push(p);
  }
  return acc;
}

function containsImportHint(src, base) {
  return (
    src.includes("/" + base + '"') ||
    src.includes("/" + base + "'") ||
    src.includes("./" + base + '"') ||
    src.includes("./" + base + "'") ||
    src.includes("\\" + base + '"')
  );
}

const allJs = walkJs(ROOT);
const libJs = allJs.filter((p) => relative(ROOT, p).replace(/\\/g, "/").startsWith("lib/"));

const suspects = [];
for (const libPath of libJs) {
  const base = libPath.split(/[/\\]/).pop();
  let refs = 0;
  for (const abs of allJs) {
    if (abs === libPath) continue;
    try {
      if (containsImportHint(readFileSync(abs, "utf8"), base)) refs++;
    } catch {
      /* skip */
    }
  }
  if (refs === 0) suspects.push(relative(ROOT, libPath).split("\\").join("/"));
}

console.log(`[dead-lib-scan] suspects (${suspects.length}) — verify before deleting:`);
for (const s of suspects.sort()) console.log(`  - ${s}`);
console.log("[dead-lib-scan] dynamic imports and aliases cause false positives.");

const allowed = new Set(loadAllowlist());
const unlisted = suspects.filter((s) => !allowed.has(s));
if (unlisted.length) {
  console.error(`[dead-lib-scan] ${unlisted.length} unlisted suspect(s) — add to lib/.dead-lib-allowlist or wire the module:`);
  for (const s of unlisted) console.error(`  ! ${s}`);
  process.exit(1);
}
console.log("[dead-lib-scan] ok (all suspects allowlisted)");
