#!/usr/bin/env node
/**
 * Prune files that are unnecessary for the desktop build.
 * Run before electron-builder to reduce installer size.
 *
 * This removes:
 * - Test files in node_modules
 * - TypeScript source maps
 * - README/CHANGELOG/LICENSE files in dependencies
 * - Documentation folders in dependencies
 */
import { rmSync, readdirSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const nmDir = join(root, "node_modules");

const REMOVE_PATTERNS = [
  /^\..*/, // dotfiles
  /^tsconfig.*\.json$/,
  /\.map$/,
  /^CHANGELOG/i,
  /^HISTORY/i,
  /^CHANGES/i,
  /^README/i,
  /^AUTHORS/i,
  /^CONTRIBUTORS/i,
  /^PATENTS/i,
  /^SECURITY\.md$/i,
  /^FUNDING\.yml$/i,
  /^\.editorconfig$/,
  /^\.eslintrc/,
  /^\.prettierrc/,
  /^\.travis\.yml$/,
  /^appveyor\.yml$/,
  /^Makefile$/,
  /^Gruntfile/,
  /^Gulpfile/,
  /^\.zuul\.yml$/,
  /^\.jscs\.json$/,
];

const REMOVE_DIRS = new Set([
  "test",
  "tests",
  "__tests__",
  "testing",
  "example",
  "examples",
  "doc",
  "docs",
  ".github",
  ".vscode",
  "coverage",
  ".nyc_output",
  "benchmark",
  "benchmarks",
  "fixtures",
]);

let removedCount = 0;
let removedBytes = 0;

function getSize(p) {
  try {
    const stat = statSync(p);
    if (stat.isFile()) return stat.size;
    if (stat.isDirectory()) {
      let size = 0;
      for (const f of readdirSync(p)) {
        size += getSize(join(p, f));
      }
      return size;
    }
  } catch { /* ignore */ }
  return 0;
}

function pruneDir(dir, depth = 0) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      if (REMOVE_DIRS.has(entry) && depth > 0) {
        const size = getSize(full);
        rmSync(full, { recursive: true, force: true });
        removedCount++;
        removedBytes += size;
        continue;
      }
      // Recurse into package subdirectories
      if (depth === 0 || entry === "node_modules") {
        pruneDir(full, depth + 1);
      }
    } else if (stat.isFile() && depth > 0) {
      if (REMOVE_PATTERNS.some((re) => re.test(entry))) {
        const size = stat.size;
        rmSync(full, { force: true });
        removedCount++;
        removedBytes += size;
      }
    }
  }
}

console.log("Pruning node_modules for desktop build...");
pruneDir(nmDir);
const mb = (removedBytes / (1024 * 1024)).toFixed(1);
console.log(`Removed ${removedCount} files/dirs (${mb} MB saved)`);
