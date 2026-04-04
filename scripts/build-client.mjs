#!/usr/bin/env node
/**
 * Client bundling script — bundles client JS modules for production.
 *
 * Usage: node scripts/build-client.mjs [--watch] [--minify]
 *
 * Outputs:
 *   client/dist/modules.js   — all client JS modules bundled together
 *   client/dist/manifest.json — file hashes for cache busting
 *
 * Falls back to copying files if esbuild is not installed.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename, resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');

const CLIENT_DIR = join(ROOT, 'client');
const JS_DIR = join(CLIENT_DIR, 'js');
const DIST_DIR = join(CLIENT_DIR, 'dist');

const args = process.argv.slice(2);
const watchMode = args.includes('--watch');
const minifyFlag = args.includes('--minify');
// Default to minify unless --no-minify is passed
const shouldMinify = minifyFlag || !args.includes('--no-minify');

/** Collect all bundleable JS files from client/js/ and client/*.js (excluding sw.js). */
function getEntryFiles() {
  const files = [];

  // client/js/*.js
  if (existsSync(JS_DIR)) {
    for (const f of readdirSync(JS_DIR)) {
      if (f.endsWith('.js')) files.push(join(JS_DIR, f));
    }
  }

  // client/*.js (exclude sw.js — service worker must stay standalone)
  for (const f of readdirSync(CLIENT_DIR)) {
    if (f.endsWith('.js') && f !== 'sw.js') {
      const full = join(CLIENT_DIR, f);
      if (statSync(full).isFile()) files.push(full);
    }
  }

  return files;
}

/** Compute SHA-256 hash of a file, returning first 12 hex chars. */
function fileHash(filePath) {
  const contents = readFileSync(filePath);
  return createHash('sha256').update(contents).digest('hex').slice(0, 12);
}

/** Generate manifest.json mapping file names to their content hashes. */
function generateManifest() {
  const manifest = {};
  for (const f of readdirSync(DIST_DIR)) {
    if (f === 'manifest.json') continue;
    const full = join(DIST_DIR, f);
    if (statSync(full).isFile()) {
      manifest[f] = fileHash(full);
    }
  }
  writeFileSync(join(DIST_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

/** Fallback: copy JS files to dist/ without bundling. */
function fallbackCopy() {
  console.log('[build-client] esbuild not available — copying files to dist/');
  mkdirSync(DIST_DIR, { recursive: true });
  const files = getEntryFiles();
  const copied = [];
  for (const f of files) {
    const dest = join(DIST_DIR, basename(f));
    copyFileSync(f, dest);
    copied.push(basename(f));
  }
  // Create a simple concatenated modules.js
  let combined = '';
  for (const f of files) {
    combined += readFileSync(f, 'utf8') + '\n';
  }
  writeFileSync(join(DIST_DIR, 'modules.js'), combined);

  const manifest = generateManifest();
  console.log(`[build-client] Copied ${copied.length} files to client/dist/`);
  console.log('[build-client] Manifest:', JSON.stringify(manifest, null, 2));
}

/** Build with esbuild. */
async function buildWithEsbuild() {
  let esbuild;
  try {
    esbuild = await import('esbuild');
  } catch {
    fallbackCopy();
    return;
  }

  mkdirSync(DIST_DIR, { recursive: true });

  const entryFiles = getEntryFiles();
  if (entryFiles.length === 0) {
    console.log('[build-client] No client JS files found to bundle.');
    return;
  }

  // Create a virtual entry that imports all modules
  const entryContents = entryFiles
    .map((f) => `import ${JSON.stringify(f)};`)
    .join('\n');

  const entryPath = join(DIST_DIR, '_entry.js');
  writeFileSync(entryPath, entryContents);

  const start = Date.now();

  const buildOptions = {
    entryPoints: [entryPath],
    bundle: true,
    outfile: join(DIST_DIR, 'modules.js'),
    format: 'iife',
    platform: 'browser',
    target: ['es2020'],
    minify: shouldMinify,
    sourcemap: false,
    logLevel: 'warning',
  };

  if (watchMode) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    console.log('[build-client] Watching for changes...');
    // First build
    await ctx.rebuild();
    const elapsed = Date.now() - start;
    printStats(elapsed);
  } else {
    await esbuild.build(buildOptions);
    const elapsed = Date.now() - start;
    printStats(elapsed);
  }

  // Clean up temp entry
  try {
    const { unlinkSync } = await import('node:fs');
    unlinkSync(entryPath);
  } catch { /* ignore */ }

  generateManifest();
}

function printStats(elapsed) {
  console.log(`[build-client] Build completed in ${elapsed}ms`);
  if (existsSync(DIST_DIR)) {
    for (const f of readdirSync(DIST_DIR)) {
      if (f.startsWith('_')) continue;
      const full = join(DIST_DIR, f);
      if (statSync(full).isFile()) {
        const size = statSync(full).size;
        const kb = (size / 1024).toFixed(1);
        console.log(`  ${f}: ${kb} KB`);
      }
    }
  }
}

buildWithEsbuild().catch((err) => {
  console.error('[build-client] Build failed:', err.message);
  process.exit(1);
});
