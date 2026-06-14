#!/usr/bin/env node
/**
 * Phase 61.3: Run recipe integration tests (dry-run).
 *
 * Usage:
 *   node scripts/test-recipes.mjs path/to/recipe.json [...more]
 *
 * Each JSON file must describe a recipe with a `steps` array. Each step
 * may include an `expect` block (equals / contains / matches / type) that is
 * evaluated against the step's dry-run output. Exits non-zero if any
 * expectation fails. Uses the default echo runner so tests do not need a
 * live backend.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runRecipeTest } from "../lib/integration-test-harness.js";

async function loadRecipe(file) {
  const abs = resolve(process.cwd(), file);
  const raw = await readFile(abs, "utf8");
  return JSON.parse(raw);
}

function report(run) {
  const { name, status, summary, steps } = run;
  const sym = status === "passed" ? "PASS" : "FAIL";
  console.log(`[${sym}] ${name} — ${summary.passed}/${summary.total} steps passed`);
  for (const step of steps) {
    const tag = step.passed ? "  ok " : "  x  ";
    console.log(`${tag}${step.name}${step.reason ? ` — ${step.reason}` : ""}`);
  }
}

async function main() {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error("usage: scripts/test-recipes.mjs <recipe.json> [...]");
    process.exit(2);
  }
  let failures = 0;
  for (const file of files) {
    try {
      const recipe = await loadRecipe(file);
      const run = await runRecipeTest(recipe, { name: recipe.name || file });
      report(run);
      if (run.status !== "passed") failures += 1;
    } catch (err) {
      console.error(`[ERR ] ${file}: ${err.message}`);
      failures += 1;
    }
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
