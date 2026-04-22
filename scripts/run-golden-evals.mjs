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
import { recordEvalRun, detectRegression } from "../lib/eval-run-history.js";

const cwd = process.cwd();
const goldenPath = join(cwd, "data", "eval-sets", "golden.json");
const startedAt = Date.now();

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
const perCaseResults = [];

for (const c of cases) {
  if (c.target !== "trace") { skip++; continue; }
  if (!Array.isArray(c.trace) || !Array.isArray(c.expectedToolSequence)) {
    failures.push({ id: c.id, reason: "missing trace or expectedToolSequence" });
    perCaseResults.push({ id: c.id, pass: false, reason: "missing trace or expectedToolSequence" });
    fail++;
    continue;
  }
  const actual = c.trace.map((t) => t?.name || "");
  const expected = c.expectedToolSequence;
  const match = actual.length === expected.length && actual.every((n, i) => n === expected[i]);
  if (match) {
    pass++;
    perCaseResults.push({ id: c.id, pass: true });
  } else {
    fail++;
    failures.push({ id: c.id, actual, expected });
    perCaseResults.push({ id: c.id, pass: false, reason: `expected ${expected.join("→")} got ${actual.join("→")}` });
  }
}

const total = cases.length;
const traceTotal = pass + fail;
console.log(`[golden-evals] ${pass}/${traceTotal} trace cases passed (${skip} non-trace skipped, ${total} total)`);
if (fail > 0) {
  console.log("[golden-evals] failures:");
  for (const f of failures) console.log(`  - ${f.id}: ${JSON.stringify(f)}`);
}

// Wave-2: persist run to history for regression tracking.
try {
  await recordEvalRun({
    suiteId: set.id || "golden",
    passed: pass,
    total: traceTotal,
    skipped: skip,
    durationMs: Date.now() - startedAt,
    results: perCaseResults,
    meta: { source: "run-golden-evals.mjs" },
  });
  const regression = await detectRegression(set.id || "golden");
  if (regression) {
    console.log(
      `[golden-evals] regression detected: pass rate ${(regression.previous * 100).toFixed(1)}% → ${(regression.current * 100).toFixed(1)}% (Δ ${(regression.delta * 100).toFixed(1)}pp)`,
    );
  }
} catch (e) {
  console.warn(`[golden-evals] history persistence failed: ${e?.message || e}`);
}

process.exit(fail > 0 ? 1 : 0);
