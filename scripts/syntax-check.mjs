#!/usr/bin/env node
/**
 * Fast parse-only checks (node --check) on server and first-party JS.
 * Replaces a no-op lint in CI with something that catches syntax errors.
 */
import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

async function collectJsFiles(dir, { exts = [".js"] } = {}) {
  const out = [];
  if (!existsSync(dir)) return out;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const ent of entries) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...(await collectJsFiles(p, { exts })));
    } else if (exts.some((ext) => ent.name.endsWith(ext))) {
      out.push(p);
    }
  }
  return out;
}

const roots = [
  join(root, "server.js"),
  join(root, "lib"),
  join(root, "bin"),
  join(root, "scripts"),
];

const files = new Set();
for (const r of roots) {
  if (r.endsWith("server.js") && existsSync(r)) {
    files.add(r);
    continue;
  }
  const batch = await collectJsFiles(r, { exts: [".js", ".mjs", ".cjs"] });
  for (const f of batch) {
    if (f.split(/[/\\]/).includes("node_modules")) continue;
    files.add(f);
  }
}

const sorted = [...files].sort();
let failed = 0;
for (const abs of sorted) {
  const rel = relative(root, abs).split("\\").join("/");
  const r = spawnSync(process.execPath, ["--check", rel], { cwd: root, stdio: "pipe" });
  if (r.status !== 0) {
    console.error(`syntax-check: failed — ${rel}`);
    if (r.stderr?.length) process.stderr.write(r.stderr);
    failed++;
  }
}

if (failed) {
  console.error(`syntax-check: ${failed} file(s) failed node --check`);
  process.exit(1);
}
console.log(`syntax-check: ok (${sorted.length} files)`);
