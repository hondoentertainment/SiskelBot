#!/usr/bin/env node
/**
 * Client code-splitting build script using esbuild.
 *
 * Extracts inline JS from HTML files into cacheable, content-hashed bundles.
 * Shared code is automatically split into common chunks by esbuild.
 *
 * Usage:
 *   node scripts/build-client.mjs           # development build
 *   NODE_ENV=production node scripts/build-client.mjs  # minified production build
 */

import * as esbuild from "esbuild";
import { writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const CLIENT = join(ROOT, "client");
const DIST = join(CLIENT, "dist");
const IS_PROD = process.env.NODE_ENV === "production";

async function build() {
  // Clean dist directory
  if (existsSync(DIST)) {
    const { rmSync } = await import("fs");
    rmSync(DIST, { recursive: true, force: true });
  }
  mkdirSync(DIST, { recursive: true });

  const entryPoints = [
    join(CLIENT, "src", "chat.js"),
    join(CLIENT, "src", "admin.js"),
    join(CLIENT, "src", "eval.js"),
    join(CLIENT, "src", "marketplace.js"),
  ];

  // Verify all entry points exist
  for (const ep of entryPoints) {
    if (!existsSync(ep)) {
      console.error(`[build-client] Missing entry point: ${ep}`);
      process.exit(1);
    }
  }

  const result = await esbuild.build({
    entryPoints,
    bundle: true,
    splitting: true,
    format: "esm",
    outdir: DIST,
    entryNames: "[name]-[hash]",
    chunkNames: "chunk-[hash]",
    minify: IS_PROD,
    sourcemap: true,
    target: ["es2020", "chrome80", "firefox78", "safari14"],
    metafile: true,
    logLevel: "info",
  });

  // Write a manifest so the server / HTML can resolve hashed filenames
  const manifest = {};
  for (const [outputPath, meta] of Object.entries(result.metafile.outputs)) {
    if (meta.entryPoint) {
      // e.g. "client/src/chat.js" -> "chat"
      const name = meta.entryPoint.replace(/^.*\/src\//, "").replace(/\.js$/, "");
      // outputPath is relative, e.g. "client/dist/chat-ABC123.js"
      const filename = outputPath.replace(/^.*\/dist\//, "");
      manifest[name] = filename;
    }
  }

  const manifestPath = join(DIST, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  console.log("[build-client] Manifest:", manifest);
  console.log(`[build-client] Build complete. ${IS_PROD ? "(production)" : "(development)"}`);
}

build().catch((err) => {
  console.error("[build-client] Build failed:", err);
  process.exit(1);
});
