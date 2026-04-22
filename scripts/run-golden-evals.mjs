#!/usr/bin/env node
/**
 * Offline golden eval runner. Validates trace-target cases in
 * data/eval-sets/golden.json by checking that `expectedToolSequence`
 * matches `trace[].name`. Does NOT require a running server or LLM.
 *
 * Chat and task targets require a live model and are skipped in this
 * offline runner — run them via `npm run eval:live` against a server.
 *
 * Exit: 0 if all trace cases pass, 1 otherwise.
 */
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const cwd = process.cwd();
const goldenPath = join(cwd, "data", "eval-sets", "golden.json");

if (!existsSync(goldenPath)) {
  console.error(`[golden-evals] missing ${goldenPath}`);
  process.exit(1);
}

let set;
try {
  set = JSON.parse(readFileSync(goldenPath, "utf8"));
} catch (e) {
  console.error(`[golden-evals] cannot parse golden.json: ${e.message}`);
  process.exit(1);
}

const cases = Array.isArray(set.cases) ? set.cases : [];
let pass = 0, fail = 0, skip = 0;
const failures = [];

for (const c of cases) {
  if (c.target !== "trace") { skip++; continue; }
  if (!Array.isArray(c.trace) || !Array.isArray(c.expectedToolSequence)) {
    failures.push({ id: c.id, reason: "missing trace or expectedToolSequence" });
    fail++;
    continue;
  }
  const actual = c.trace.map((t) => t?.name || "");
  const expected = c.expectedToolSequence;
  const match = actual.length === expected.length && actual.every((n, i) => n === expected[i]);
  if (match) pass++;
  else {
    fail++;
    failures.push({ id: c.id, actual, expected });
  }
}

const total = cases.length;
const traceTotal = pass + fail;
console.log(`[golden-evals] ${pass}/${traceTotal} trace cases passed (${skip} non-trace skipped, ${total} total)`);
if (fail > 0) {
  console.log("[golden-evals] failures:");
  for (const f of failures) console.log(`  - ${f.id}: ${JSON.stringify(f)}`);
  process.exit(1);
}
process.exit(0);
