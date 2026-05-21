#!/usr/bin/env node
/**
 * P0 dead-route report: routes on disk vs mounted (wire-check haystack) vs ignored.
 * Read-only companion to scripts/wire-check.mjs — prints inventory, does not fail CI by default.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROUTES_DIR = join(ROOT, "routes");

function readUtf8(rel) {
  return readFileSync(join(ROOT, rel), "utf8");
}

function listJs(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".js"))
    .map((e) => e.name)
    .sort();
}

function loadIgnores() {
  try {
    return readFileSync(join(ROUTES_DIR, ".wire-check-ignore"), "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
  } catch {
    return [];
  }
}

function haystack() {
  return [
    readUtf8(join("routes", "index.js")),
    readUtf8(join("lib", "server-configured-app.js")),
    readUtf8("server.js"),
    readUtf8(join("lib", "server-production-listener.js")),
  ].join("\n");
}

function isMounted(name, hay) {
  return (
    hay.includes(`./${name}`) ||
    hay.includes(`/routes/${name}`) ||
    hay.includes(`\\routes\\${name}`)
  );
}

function main() {
  const hay = haystack();
  const ignores = new Set(loadIgnores());
  const mounted = [];
  const ignored = [];
  const orphan = [];

  for (const name of listJs(ROUTES_DIR)) {
    if (name === "index.js") continue;
    if (ignores.has(name)) {
      ignored.push(name);
      continue;
    }
    if (isMounted(name, hay)) mounted.push(name);
    else orphan.push(name);
  }

  console.log("[dead-route-scan] route inventory");
  console.log(`  mounted: ${mounted.length}`);
  console.log(`  ignored (wire-check): ${ignored.length}`);
  console.log(`  orphan (needs wire or ignore): ${orphan.length}`);

  if (orphan.length) {
    console.log("\nOrphan routes:");
    for (const name of orphan) console.log(`  - routes/${name}`);
    process.exitCode = 1;
  }
}

main();
