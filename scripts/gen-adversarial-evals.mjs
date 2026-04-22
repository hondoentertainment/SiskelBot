#!/usr/bin/env node
/**
 * Generate the adversarial eval set and write it to
 * data/eval-sets/adversarial.json. Uses the static templates by default; pass
 * --expand to also call an LLM for additional variations.
 *
 * Usage:
 *   node scripts/gen-adversarial-evals.mjs            # static only
 *   node scripts/gen-adversarial-evals.mjs --expand   # add LLM variations
 *   node scripts/gen-adversarial-evals.mjs --run      # also execute the
 *                                                     # static suite against
 *                                                     # the safety gate
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { buildStaticAdversarialEvalSet, expandAdversarialWithLlm, runAdversarialSuite } from "../lib/adversarial-eval-gen.js";

function parseArgs(argv) {
  const out = { expand: false, run: false };
  for (const a of argv.slice(2)) {
    if (a === "--expand") out.expand = true;
    else if (a === "--run") out.run = true;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  const set = buildStaticAdversarialEvalSet();

  if (args.expand) {
    const backendFetch = globalThis.fetch;
    const url = process.env.ADVERSARIAL_GEN_URL || process.env.OLLAMA_URL || "http://localhost:11434/v1/chat/completions";
    const model = process.env.ADVERSARIAL_GEN_MODEL || "gpt-4o-mini";
    const key = process.env.OPENAI_API_KEY || "";
    const headers = { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) };
    const expanded = await expandAdversarialWithLlm({ backendFetch, url, model, headers, perTemplate: 3 });
    // Append the expanded (non-template) entries as cases
    const existingIds = new Set(set.cases.map((c) => c.id));
    for (const t of expanded) {
      if (existingIds.has(t.id)) continue;
      set.cases.push({
        id: t.id,
        target: "safety_probe",
        category: t.category,
        prompt: t.prompt,
        workspace: "default",
        expectSafetyBlock: true,
      });
    }
    set.name = "Adversarial Safety Eval (static + llm expansion)";
  }

  const outDir = join(process.cwd(), "data", "eval-sets");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "adversarial.json");
  writeFileSync(outPath, JSON.stringify(set, null, 2) + "\n", "utf8");
  console.log(`[adversarial] wrote ${set.cases.length} cases → ${outPath}`);

  if (args.run) {
    if (process.env.SAFETY_PROBE_GATE !== "1") {
      console.error("[adversarial] --run requires SAFETY_PROBE_GATE=1");
      process.exit(2);
    }
    const report = await runAdversarialSuite();
    console.log("[adversarial] suite report:", JSON.stringify(report, null, 2));
    if (!report.skipped && report.missed.length > 0) {
      console.error(`[adversarial] ${report.missed.length} prompt-injection attack(s) missed by safety gate`);
      process.exit(1);
    }
  }
}

main().catch((e) => {
  console.error("[adversarial] failed:", e?.message || e);
  process.exit(1);
});
