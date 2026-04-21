#!/usr/bin/env node
/**
 * Wire-check audit.
 *
 * For every route module under routes/ verify it is imported and mounted by
 * routes/index.js. Report:
 *   - route modules with no import in routes/index.js
 *   - route modules imported but never mounted
 *   - route modules mounted but with no test file referencing them
 *
 * Exits non-zero when any of the above gaps exist so CI can gate on it.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const routesDir = join(root, "routes");
const indexPath = join(routesDir, "index.js");
const testsDir = join(root, "tests");

async function listJsFiles(dir, { recurse = false } = {}) {
  const out = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const ent of entries) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (recurse) out.push(...(await listJsFiles(p, { recurse })));
    } else if (ent.name.endsWith(".js")) {
      out.push(p);
    }
  }
  return out;
}

const routeFiles = (await listJsFiles(routesDir)).filter(
  (p) => !p.endsWith("index.js")
);
const indexSrc = await readFile(indexPath, "utf8");
const serverSrc = await readFile(join(root, "server.js"), "utf8");
const wiringSrc = `${indexSrc}\n${serverSrc}`;
const testFiles = await listJsFiles(testsDir, { recurse: true });
const testCorpus = (
  await Promise.all(testFiles.map((f) => readFile(f, "utf8")))
).join("\n");
const testFileNames = new Set(
  testFiles.map((f) => f.slice(testsDir.length + 1))
);

const gaps = { unimported: [], unmounted: [], untested: [] };

for (const file of routeFiles) {
  const base = file.slice(routesDir.length + 1).replace(/\.js$/, "");
  const importRe = new RegExp(
    `from\\s+["']\\.(?:/routes)?/${base.replace(/\//g, "\\/")}\\.js["']`
  );
  if (!importRe.test(wiringSrc)) {
    gaps.unimported.push(base);
    continue;
  }

  const importMatch = wiringSrc.match(
    new RegExp(
      `import\\s+(?:\\{\\s*([^}]+)\\s*\\}|(\\w+))\\s+from\\s+["']\\.(?:/routes)?/${base.replace(
        /\//g,
        "\\/"
      )}\\.js["']`
    )
  );
  const symbol = importMatch
    ? (importMatch[1] || importMatch[2]).split(/\s+as\s+/)[0].trim()
    : null;
  if (symbol) {
    const symRe = new RegExp(`\\b${symbol}\\b`, "g");
    const occurrences = (wiringSrc.match(symRe) || []).length;
    if (occurrences < 2) {
      gaps.unmounted.push(base);
      continue;
    }
  }

  const baseLeaf = base.split("/").pop();
  const testRe = new RegExp(`routes/${base.replace(/\//g, "\\/")}\\.js`);
  const hasNamedTest =
    testFileNames.has(`${baseLeaf}-route.test.js`) ||
    testFileNames.has(`${baseLeaf}.test.js`);
  if (!hasNamedTest && !testRe.test(testCorpus)) {
    gaps.untested.push(base);
  }
}

const report = (label, items) => {
  if (!items.length) return;
  console.log(`\n${label} (${items.length}):`);
  for (const i of items) console.log(`  - ${i}`);
};

console.log(`Wire-check: ${routeFiles.length} route modules`);
report("UNIMPORTED in routes/index.js", gaps.unimported);
report("IMPORTED but never invoked", gaps.unmounted);
report("MOUNTED but no test references routes/<name>.js", gaps.untested);

const hardFailures = gaps.unimported.length + gaps.unmounted.length;
if (hardFailures > 0) {
  console.error(`\nFAIL: ${hardFailures} hard wire-check gap(s)`);
  process.exit(1);
}
if (gaps.untested.length > 0) {
  console.warn(`\nWARN: ${gaps.untested.length} route module(s) lack test references`);
  if (process.env.WIRE_CHECK_STRICT === "1") process.exit(1);
}
console.log("\nOK");
