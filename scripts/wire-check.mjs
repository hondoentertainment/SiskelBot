#!/usr/bin/env node
/**
 * Route wiring consistency (docs/NEXT_STEPS.md P0 wire-check).
 *
 * - Every top-level routes/*.js (except index.js) must be imported from routes/index.js
 *   or wired from lib/server-configured-app.js (e.g. agent-sessions).
 *   Files listed in routes/.wire-check-ignore are skipped (intentionally unmounted DEFER/DELETE tiers).
 * - Every routes/v2/*.js (except index.js) must be imported from routes/v2/index.js.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROUTES_DIR = join(ROOT, "routes");
const V2_DIR = join(ROUTES_DIR, "v2");

function readUtf8(rel) {
  return readFileSync(join(ROOT, rel), "utf8");
}

function listJs(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".js"))
    .map((e) => e.name);
}

function wireHaystack() {
  return [
    readUtf8(join("routes", "index.js")),
    readUtf8(join("lib", "server-configured-app.js")),
    readUtf8("server.js"),
    readUtf8(join("lib", "server-production-listener.js")),
  ].join("\n");
}

function loadRouteWireIgnores() {
  try {
    return readFileSync(join(ROUTES_DIR, ".wire-check-ignore"), "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
  } catch {
    return [];
  }
}

function main() {
  const hay = wireHaystack();
  const ignoreRoutes = new Set(loadRouteWireIgnores());
  const missing = [];

  for (const name of listJs(ROUTES_DIR)) {
    if (name === "index.js") continue;
    if (ignoreRoutes.has(name)) continue;
    const ok =
      hay.includes(`./${name}`) ||
      hay.includes(`/routes/${name}`) ||
      hay.includes(`\\\\routes\\\\${name}`);
    if (!ok) {
      missing.push(`routes/${name} (expected ./${name} or /routes/${name} in wiring haystack)`);
    }
  }

  let v2Index = "";
  try {
    v2Index = readUtf8(join("routes", "v2", "index.js"));
  } catch {
    console.error("[wire-check] routes/v2/index.js missing");
    process.exit(1);
  }

  for (const name of listJs(V2_DIR)) {
    if (name === "index.js") continue;
    const needle = `./${name}`;
    if (!v2Index.includes(needle)) {
      missing.push(`routes/v2/${name} (expected "${needle}" in routes/v2/index.js)`);
    }
  }

  if (missing.length > 0) {
    console.error("[wire-check] Route modules not referenced by route indexes:\n");
    for (const m of missing) console.error(`  - ${m}`);
    console.error("\nFix: import and mount the module from routes/index.js or routes/v2/index.js,");
    console.error("reference it from lib/server-configured-app.js for sidecar mounts, or add the basename");
    console.error("to routes/.wire-check-ignore when the route is intentionally unmounted (DEFER/DELETE).");
    process.exit(1);
  }

  console.log("[wire-check] ok");
}

main();
