#!/usr/bin/env node
/**
 * Discover all *.test.js files under tests/ (recursive) and run node --test.
 * Avoids shell glob differences between Windows, macOS, and Linux CI.
 *
 * Usage: node scripts/run-tests.mjs [--ci] [-- ...extra node --test flags]
 * --ci  → adds --test-timeout=300000 (matches GitHub Actions budget)
 */
import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

async function collectTestFiles(dir) {
  const out = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const ent of entries) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...(await collectTestFiles(p)));
    } else if (ent.name.endsWith(".test.js")) {
      out.push(p);
    }
  }
  return out;
}

const raw = process.argv.slice(2);
const ci = raw.includes("--ci");
const rest = raw.filter((a) => a !== "--ci");
const sep = rest.indexOf("--");
const extraBeforeFiles = sep === -1 ? rest : rest.slice(0, sep);
const extraAfterSep = sep === -1 ? [] : rest.slice(sep + 1);

const testsDir = join(root, "tests");
let files;
try {
  files = (await collectTestFiles(testsDir)).sort();
} catch (e) {
  console.error("run-tests: cannot read tests/: ", e.message);
  process.exit(1);
}

if (files.length === 0) {
  console.error("run-tests: no *.test.js files under tests/");
  process.exit(1);
}

const relFiles = files.map((f) => relative(root, f).split("\\").join("/"));

const nodeArgs = ["--test"];
if (ci) nodeArgs.push("--test-timeout=300000");
nodeArgs.push(...extraBeforeFiles);
nodeArgs.push(...relFiles);
nodeArgs.push(...extraAfterSep);

const r = spawnSync(process.execPath, nodeArgs, {
  stdio: "inherit",
  cwd: root,
  env: process.env,
});
process.exit(r.status === null ? 1 : r.status);
