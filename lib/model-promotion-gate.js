/**
 * Phase 80.2: Golden-trace promotion gate for model deploy/status changes.
 * Enable with MODEL_PROMOTION_GATE=1. Uses offline golden cases when present.
 */
import { checkGoldenTrace } from "./eval-golden-trace.js";

/**
 * @param {{ modelId?: string, version?: string, skip?: boolean, sampleTrace?: object }} opts
 */
export async function assertPromotionGate(opts = {}) {
  if (opts.skip || process.env.MODEL_PROMOTION_GATE === "0") {
    return { ok: true, skipped: true };
  }
  if (process.env.MODEL_PROMOTION_GATE !== "1") {
    return { ok: true, skipped: true };
  }

  let cases = [];
  try {
    const { readFileSync, existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const p = join(process.cwd(), "data", "eval-sets", "golden.json");
    if (existsSync(p)) {
      const raw = JSON.parse(readFileSync(p, "utf8"));
      cases = Array.isArray(raw) ? raw : Array.isArray(raw?.cases) ? raw.cases : [];
    }
  } catch {
    cases = [];
  }

  if (cases.length === 0) {
    if (process.env.MODEL_PROMOTION_GATE_STRICT === "1") {
      const err = new Error("Promotion blocked: no golden cases available");
      err.code = "PROMOTION_GATE_FAILED";
      throw err;
    }
    return { ok: true, skipped: true, warning: "no_golden_cases" };
  }

  const sampleTrace = opts.sampleTrace || {
    stopReason: "complete",
    toolCalls: [],
    content: "ok",
  };
  let passed = 0;
  for (const c of cases.slice(0, 20)) {
    try {
      const r = checkGoldenTrace(c, sampleTrace);
      if (r?.ok || r?.pass || r === true) passed += 1;
    } catch {
      /* ignore malformed cases */
    }
  }
  const rate = passed / Math.min(20, cases.length);
  // Structural gate: when no live model output is provided, require cases to be loadable
  // and optionally a caller-supplied sampleTrace that passes checks.
  if (opts.sampleTrace && rate < 0.5) {
    const err = new Error("Promotion blocked: golden-trace eval gate failed");
    err.code = "PROMOTION_GATE_FAILED";
    err.details = { passRate: rate, passed, total: Math.min(20, cases.length) };
    throw err;
  }
  return { ok: true, cases: Math.min(20, cases.length), passRate: opts.sampleTrace ? rate : null };
}
