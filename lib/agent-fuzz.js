/**
 * Phase 73.1: Agent fuzz harness — perturb prompts/tool args; detect crash / stagnation loops.
 * Classifier-safe: only mutates structure (whitespace, casing, punctuation, duplicates).
 */
import { randomUUID } from "crypto";
import { detectStagnation } from "./agent-stagnation.js";

const MUTATORS = [
  (s) => `  ${s}  `,
  (s) => s.toUpperCase(),
  (s) => s.toLowerCase(),
  (s) => `${s}\n\nPlease continue.`,
  (s) => s.replace(/\s+/g, " "),
  (s) => `${s} ${s.split(/\s+/).slice(0, 3).join(" ")}`,
  (s) => s.split("").reverse().join(""),
  (s) => s.replace(/[.!?]/g, ""),
];

/**
 * @param {string} prompt
 * @param {{ count?: number, seed?: number }} [opts]
 * @returns {string[]}
 */
export function generatePromptPerturbations(prompt, opts = {}) {
  const base = String(prompt || "").trim() || "Hello";
  const count = Math.min(32, Math.max(1, Number(opts.count) || 8));
  const seed = Number(opts.seed) || 1;
  const out = [];
  for (let i = 0; i < count; i++) {
    const mut = MUTATORS[(seed + i) % MUTATORS.length];
    out.push(mut(base));
  }
  return out;
}

/**
 * Score a synthetic tool-call log for crash/loop signals.
 * @param {{ toolCallsLog?: Array<{ name?: string, args?: object }>, threw?: boolean, error?: string, iterations?: number, maxIterations?: number }} run
 */
export function scoreFuzzRun(run = {}) {
  const log = Array.isArray(run.toolCallsLog) ? run.toolCallsLog : [];
  const stagnant = Boolean(
    detectStagnation(
      log.map((t, i) => ({
        name: t.name || "unknown",
        args: t.args || {},
        iteration: typeof t.iteration === "number" ? t.iteration : i + 1,
      })),
      { windowSize: Math.min(8, Math.max(3, log.length)) }
    )
  );
  const hitMax =
    Number(run.iterations) > 0 &&
    Number(run.maxIterations) > 0 &&
    Number(run.iterations) >= Number(run.maxIterations);
  return {
    ok: !run.threw && !stagnant && !hitMax,
    threw: Boolean(run.threw),
    error: run.error || null,
    stagnant: Boolean(stagnant),
    hitMaxIterations: hitMax,
    toolCalls: log.length,
  };
}

/**
 * Run an offline fuzz batch against a provided executor.
 * @param {{ prompt: string, count?: number, seed?: number, execute: (prompt: string) => Promise<object> }} opts
 */
export async function runAgentFuzz(opts) {
  const id = randomUUID();
  const prompts = generatePromptPerturbations(opts.prompt, opts);
  const results = [];
  for (const p of prompts) {
    try {
      const run = await opts.execute(p);
      results.push({ prompt: p.slice(0, 200), ...scoreFuzzRun(run) });
    } catch (e) {
      results.push({
        prompt: p.slice(0, 200),
        ...scoreFuzzRun({ threw: true, error: String(e?.message || e), toolCallsLog: [] }),
      });
    }
  }
  const failures = results.filter((r) => !r.ok);
  return {
    id,
    total: results.length,
    failures: failures.length,
    passRate: results.length ? (results.length - failures.length) / results.length : 0,
    results,
  };
}
