#!/usr/bin/env node
/**
 * Client bundling pipeline for the client/src/ module tree.
 *
 * Bundles the SPA shell (client/src/app.js) and view entry points
 * (client/src/views/agent-run.js, client/src/views/replay.js) to
 * client/dist/ using esbuild with ES module output and code splitting,
 * then emits manifest.json mapping logical entry names to the hashed
 * output paths that can be referenced from client/app.html.
 *
 * Flags:
 *   --prod   Minify, drop comments, production-grade build.
 *   --watch  Keep the process alive and rebuild on change.
 *
 * Fallback:
 *   If esbuild is not installed the script performs a no-op copy of each
 *   entry point to client/dist/ (preserving the relative path) so that a
 *   naive "<script type=module src=/dist/app.js>" still loads something
 *   during local development without the bundler. To enable proper
 *   bundling install esbuild:
 *
 *     npm install --save-dev esbuild
 *
 *   and re-run `npm run build:client`.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  copyFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, "..");

const SRC_DIR = join(ROOT, "client", "src");
const DIST_DIR = join(ROOT, "client", "dist");

const args = process.argv.slice(2);
const watchMode = args.includes("--watch");
const prodMode = args.includes("--prod");

/** Entry points, relative to client/src/. */
const ENTRY_POINTS = [
  { name: "app", file: "app.js" },
  { name: "agent-run", file: "views/agent-run.js" },
  { name: "replay", file: "views/replay.js" },
];

function log(msg) {
  console.log(`[build-client] ${msg}`);
}

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function cleanDist() {
  if (existsSync(DIST_DIR)) {
    rmSync(DIST_DIR, { recursive: true, force: true });
  }
  ensureDir(DIST_DIR);
}

function resolveEntries() {
  const resolved = [];
  const missing = [];
  for (const { name, file } of ENTRY_POINTS) {
    const abs = join(SRC_DIR, file);
    if (existsSync(abs)) {
      resolved.push({ name, file, abs });
    } else {
      missing.push(file);
    }
  }
  return { resolved, missing };
}

/**
 * No-op fallback when esbuild is unavailable.
 * Copies each entry point (and its whole source tree) to client/dist/ so that
 * the app keeps loading during development without bundling. Downstream
 * imports must already be relative and browser-resolvable.
 */
function fallbackCopy(entries) {
  log("esbuild not installed — copy fallback (no bundling)");

  // Walk client/src/ and copy every .js/.css file under the same subpath.
  function walk(dir) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
      } else if (entry.endsWith(".js") || entry.endsWith(".css")) {
        const rel = relative(SRC_DIR, full);
        const dest = join(DIST_DIR, rel);
        ensureDir(dirname(dest));
        copyFileSync(full, dest);
      }
    }
  }

  if (existsSync(SRC_DIR)) walk(SRC_DIR);

  const manifest = {};
  for (const { name, file } of entries) {
    manifest[name] = `/dist/${file}`;
  }
  writeManifest(manifest, { bundler: "copy-fallback", prod: false });
  log(`Copied ${entries.length} entry points (fallback mode)`);
}

function writeManifest(entries, meta = {}) {
  const payload = {
    generatedAt: new Date().toISOString(),
    mode: meta.prod ? "production" : "development",
    bundler: meta.bundler || "esbuild",
    entries,
  };
  writeFileSync(
    join(DIST_DIR, "manifest.json"),
    JSON.stringify(payload, null, 2) + "\n",
  );
}

/**
 * Build metafile → manifest map. esbuild's metafile.outputs maps output
 * path → { entryPoint, ... }. We flip that into { entryName: outputPath }.
 */
function manifestFromMetafile(metafile, entries) {
  const byEntry = {};
  if (!metafile || !metafile.outputs) return byEntry;
  for (const [outPath, info] of Object.entries(metafile.outputs)) {
    if (!info.entryPoint) continue;
    const absEntry = resolve(ROOT, info.entryPoint);
    const match = entries.find((e) => resolve(e.abs) === absEntry);
    if (match) {
      // outPath is relative to cwd; normalise to /dist/...
      const rel = relative(DIST_DIR, resolve(ROOT, outPath));
      byEntry[match.name] = `/dist/${rel.split("\\").join("/")}`;
    }
  }
  return byEntry;
}

async function buildWithEsbuild(entries) {
  let esbuild;
  try {
    esbuild = await import("esbuild");
  } catch {
    fallbackCopy(entries);
    return;
  }

  const buildOptions = {
    entryPoints: entries.map((e) => ({ in: e.abs, out: e.name })),
    bundle: true,
    outdir: DIST_DIR,
    format: "esm",
    splitting: true,
    platform: "browser",
    target: ["es2020"],
    sourcemap: true,
    minify: prodMode,
    metafile: true,
    legalComments: prodMode ? "none" : "inline",
    logLevel: "info",
    // Hash entry filenames so client/app.html can be served with long-lived
    // Cache-Control and still cache-bust on new deploys. The manifest records
    // the final hashed path for each logical entry name.
    entryNames: "[name]-[hash]",
    chunkNames: "chunks/[name]-[hash]",
    assetNames: "assets/[name]-[hash]",
  };

  const start = Date.now();

  if (watchMode) {
    const ctx = await esbuild.context(buildOptions);
    const result = await ctx.rebuild();
    const manifest = manifestFromMetafile(result.metafile, entries);
    writeManifest(manifest, { bundler: "esbuild", prod: prodMode });
    printStats(Date.now() - start);
    await ctx.watch();
    log("Watching client/src/ for changes — press Ctrl+C to stop.");
    // Keep process alive; esbuild's watch owns the lifecycle.
    return;
  }

  const result = await esbuild.build(buildOptions);
  const manifest = manifestFromMetafile(result.metafile, entries);
  writeManifest(manifest, { bundler: "esbuild", prod: prodMode });
  printStats(Date.now() - start);
}

function printStats(elapsedMs) {
  log(`Build completed in ${elapsedMs}ms (${prodMode ? "prod" : "dev"})`);
  if (!existsSync(DIST_DIR)) return;
  const walk = (dir, depth = 0) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = statSync(full);
      const rel = relative(DIST_DIR, full);
      if (st.isDirectory()) {
        walk(full, depth + 1);
      } else {
        const kb = (st.size / 1024).toFixed(1);
        log(`  ${rel}: ${kb} KB`);
      }
    }
  };
  walk(DIST_DIR);
}

async function main() {
  if (!existsSync(SRC_DIR)) {
    log(`client/src/ not found — nothing to build (expected ${SRC_DIR})`);
    return;
  }

  const { resolved, missing } = resolveEntries();
  if (missing.length) {
    log(`warning: missing entry point(s): ${missing.join(", ")}`);
  }
  if (resolved.length === 0) {
    log("no resolvable entry points; skipping build");
    return;
  }

  cleanDist();
  await buildWithEsbuild(resolved);
}

main().catch((err) => {
  console.error("[build-client] Build failed:", err && err.stack ? err.stack : err);
  process.exit(1);
});
