#!/usr/bin/env node
/**
 * Dead-module audit.
 *
 * Reports lib/*.js modules with no detectable reference in the rest of
 * the tree. A module counts as referenced when any other source file in
 * lib/, routes/, server.js, scripts/, bin/, or tests/ contains a quoted
 * string literal ending in `<basename>.js` — this catches static
 * imports, dynamic `import()`, and constructed paths such as
 * `join(ROOT, "lib", "<basename>.js")` or `resolve(__dirname,
 * "<basename>.js")`.
 *
 * Exits 0 by default (report-only). With DEAD_MODULE_STRICT=1 exits
 * non-zero when any orphans are found, suitable for CI gating after the
 * first cleanup pass lands.
 *
 * Notes:
 *   - The check is conservative — string-based references and re-exports
 *     are caught.
 *   - Modules whose name is a substring of another (e.g. agent.js inside
 *     agent-loop.js) are treated as ambiguous and EXCLUDED from the
 *     orphan list to avoid false positives.
 */
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

async function listJsFiles(dir, { recurse = false, exclude = [] } = {}) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    if (exclude.includes(ent.name)) continue;
    const p = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (recurse) out.push(...(await listJsFiles(p, { recurse, exclude })));
    } else if (ent.name.endsWith(".js") || ent.name.endsWith(".mjs")) {
      out.push(p);
    }
  }
  return out;
}

const libDir = join(root, "lib");
const libFilesTop = await listJsFiles(libDir);
const libFilesAll = await listJsFiles(libDir, { recurse: true });
const libBasenames = libFilesTop.map((f) =>
  f.slice(libDir.length + 1).replace(/\.js$/, "")
);

const corpusFiles = [
  ...libFilesAll,
  ...(await listJsFiles(join(root, "routes"), { recurse: true })),
  ...(await listJsFiles(join(root, "scripts"))),
  ...(await listJsFiles(join(root, "bin"))),
  ...(await listJsFiles(join(root, "tests"), { recurse: true })),
  join(root, "server.js"),
];

const corpus = (
  await Promise.all(
    corpusFiles.map(async (f) => {
      try {
        return [f, await readFile(f, "utf8")];
      } catch {
        return [f, ""];
      }
    })
  )
).filter(([, s]) => s);

function ambiguousBasenames(basenames) {
  const ambiguous = new Set();
  const sorted = [...basenames].sort((a, b) => a.length - b.length);
  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) {
      if (sorted[j].includes(sorted[i]) && sorted[j] !== sorted[i]) {
        ambiguous.add(sorted[i]);
      }
    }
  }
  return ambiguous;
}

const ambiguous = ambiguousBasenames(libBasenames);
const orphans = [];
const ambiguousReport = [];

for (const file of libFilesTop) {
  const base = file.slice(libDir.length + 1).replace(/\.js$/, "");
  const rel = relative(root, file);
  if (ambiguous.has(base)) {
    ambiguousReport.push(rel);
    continue;
  }
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const refPattern = new RegExp(`["'][^"']*${escaped}\\.js["']`);
  let referencedSomewhere = false;
  for (const [otherFile, content] of corpus) {
    if (otherFile === file) continue;
    if (refPattern.test(content)) {
      referencedSomewhere = true;
      break;
    }
  }
  if (!referencedSomewhere) orphans.push(rel);
}

console.log(`Dead-module audit: ${libFilesTop.length} top-level lib modules scanned`);
if (ambiguousReport.length) {
  console.log(
    `\nSkipped ${ambiguousReport.length} module(s) with ambiguous basenames (substring of another module)`
  );
}
if (orphans.length === 0) {
  console.log("\nNo orphan modules detected.");
  process.exit(0);
}
console.log(`\nORPHANS (${orphans.length}):`);
for (const o of orphans) console.log(`  - ${o}`);

if (process.env.DEAD_MODULE_STRICT === "1") {
  console.error("\nFAIL: DEAD_MODULE_STRICT=1 and orphans present");
  process.exit(1);
}
process.exit(0);
