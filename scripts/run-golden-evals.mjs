#!/usr/bin/env node
/**
 * Offline golden eval runner. Validates cases in data/eval-sets/golden.json
 * without a running server or live LLM.
 *
 * Supported targets (all offline):
 *   trace          — checks expectedToolSequence matches trace[].name
 *   tool_selection — checks all expectedTools appear in tool_calls[].function.name
 *   grounding      — checks all expectedKeywords appear in response
 *   refusal        — checks response contains a refusal pattern
 *
 * chat / task targets require a live model and are skipped here;
 * run them via `npm run eval:live`.
 *
 * Exit: 0 if all offline cases pass, 1 otherwise.
 */
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const REFUSAL_PATTERNS = [
  /i('m| am) (sorry|unable|not able)/i,
  /i (can't|cannot|won't|will not)/i,
  /i'm not (able|going)/i,
  /i (don't|do not) (provide|assist|support|help with)/i,
  /that('s| is) (not something|something i (can't|cannot))/i,
];

function isRefusal(text) {
  return REFUSAL_PATTERNS.some((re) => re.test(text));
}

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

const OFFLINE_TARGETS = new Set(["trace", "tool_selection", "grounding", "refusal"]);

let pass = 0, fail = 0, skip = 0;
const failures = [];
const categoryStats = {};

for (const c of cases) {
  if (!OFFLINE_TARGETS.has(c.target)) {
    skip++;
    continue;
  }

  if (!categoryStats[c.target]) {
    categoryStats[c.target] = { pass: 0, fail: 0 };
  }

  let ok = false;
  let reason = "";

  if (c.target === "trace") {
    if (!Array.isArray(c.trace) || !Array.isArray(c.expectedToolSequence)) {
      reason = "missing trace or expectedToolSequence";
    } else {
      const actual = c.trace.map((t) => t?.name || "");
      const expected = c.expectedToolSequence;
      ok = actual.length === expected.length && actual.every((n, i) => n === expected[i]);
      if (!ok) reason = `expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`;
    }
  } else if (c.target === "tool_selection") {
    if (!Array.isArray(c.tool_calls) || !Array.isArray(c.expectedTools)) {
      reason = "missing tool_calls or expectedTools";
    } else {
      const calledNames = c.tool_calls.map((tc) => tc?.function?.name || "");
      const missing = c.expectedTools.filter((t) => !calledNames.includes(t));
      ok = missing.length === 0;
      if (!ok) reason = `expected tools not called: ${JSON.stringify(missing)}`;
    }
  } else if (c.target === "grounding") {
    if (typeof c.response !== "string" || !Array.isArray(c.expectedKeywords)) {
      reason = "missing response or expectedKeywords";
    } else {
      const lower = c.response.toLowerCase();
      const missing = c.expectedKeywords.filter((kw) => !lower.includes(kw.toLowerCase()));
      ok = missing.length === 0;
      if (!ok) reason = `keywords not found in response: ${JSON.stringify(missing)}`;
    }
  } else if (c.target === "refusal") {
    if (typeof c.response !== "string") {
      reason = "missing response";
    } else {
      ok = isRefusal(c.response);
      if (!ok) reason = "response does not contain a refusal pattern";
    }
  }

  if (ok) {
    pass++;
    categoryStats[c.target].pass++;
  } else {
    fail++;
    categoryStats[c.target].fail++;
    failures.push({ id: c.id, reason });
  }
}

const total = cases.length;
const evaluated = pass + fail;
console.log(`[golden-evals] ${pass}/${evaluated} offline cases passed (${skip} skipped, ${total} total)`);

if (failures.length > 0) {
  console.log("[golden-evals] failures:");
  for (const f of failures) console.log(`  - ${f.id}: ${f.reason}`);
}

console.log("\n[golden-evals] category breakdown:");
for (const [cat, s] of Object.entries(categoryStats)) {
  const catTotal = s.pass + s.fail;
  const pct = catTotal > 0 ? ((s.pass / catTotal) * 100).toFixed(0) : "n/a";
  console.log(`  ${cat.padEnd(16)} ${s.pass}/${catTotal} (${pct}%)`);
}

if (fail > 0) process.exit(1);
process.exit(0);
