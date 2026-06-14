#!/usr/bin/env node
/**
 * Analyze A/B test results.
 *
 * Usage:
 *   node scripts/ab-analyze.mjs --experiment=experiment_name [--metric=p95_latency_ms]
 *
 * Reads from the storage backend (or accepts --input=results.json) and emits:
 *   - per-variant counts, mean, p50/p95/p99, error rate
 *   - lift % vs control
 *   - 95% confidence interval (z-test for binary, Welch's t for continuous)
 *   - p-value
 *   - "deploy" / "revert" / "inconclusive" recommendation
 *
 * Input JSON shape:
 *   {
 *     "experiment": "name",
 *     "variants": {
 *       "control":   { "latencies": [12, 15, ...], "errors": 3 },
 *       "treatment": { "latencies": [10, 11, ...], "errors": 1 }
 *     }
 *   }
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Math.erfc polyfill (Abramowitz & Stegun 7.1.26)
if (!Math.erfc) {
  Math.erfc = function erfc(x) {
    const t = 1 / (1 + 0.3275911 * Math.abs(x));
    const y =
      1 -
      (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
        0.254829592) *
        t *
        Math.exp(-x * x));
    return x >= 0 ? 1 - y : 1 + y;
  };
}

export function parseArgs(argv) {
  const args = { experiment: null, metric: "error_rate", input: null, output: null };
  for (const a of argv.slice(2)) {
    const [k, v] = a.replace(/^--/, "").split("=");
    if (k === "experiment") args.experiment = v;
    if (k === "metric") args.metric = v;
    if (k === "input") args.input = v;
    if (k === "output") args.output = v;
  }
  return args;
}

// Welch's t-test for unequal variances
export function welchT(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length < 2 || b.length < 2) {
    return null;
  }
  const meanA = a.reduce((s, x) => s + x, 0) / a.length;
  const meanB = b.reduce((s, x) => s + x, 0) / b.length;
  const varA = a.reduce((s, x) => s + (x - meanA) ** 2, 0) / (a.length - 1);
  const varB = b.reduce((s, x) => s + (x - meanB) ** 2, 0) / (b.length - 1);
  const se = Math.sqrt(varA / a.length + varB / b.length);
  const t = se === 0 ? 0 : (meanB - meanA) / se;
  // Welch–Satterthwaite df
  const num = (varA / a.length + varB / b.length) ** 2;
  const den =
    (varA / a.length) ** 2 / (a.length - 1) + (varB / b.length) ** 2 / (b.length - 1);
  const df = den === 0 ? a.length + b.length - 2 : num / den;
  return { t, df, meanA, meanB, varA, varB, se };
}

// Two-tailed p-value for t with df (rough approximation using normal for df > 30)
export function pValueTwoTailed(t, df) {
  if (!Number.isFinite(t)) return null;
  if (df > 30) {
    const z = Math.abs(t);
    const sf = 0.5 * Math.erfc(z / Math.sqrt(2));
    return Math.min(1, 2 * sf);
  }
  if (df > 5) {
    return Math.min(1, 0.5 * Math.erfc(Math.abs(t) / Math.sqrt(2)) * 2);
  }
  return null;
}

// Two-proportion z-test for binary outcomes (e.g. error_rate)
export function twoProportion(a, b) {
  if (!a || !b || !a.total || !b.total) return null;
  const pA = a.successes / a.total;
  const pB = b.successes / b.total;
  const pPool = (a.successes + b.successes) / (a.total + b.total);
  const se = Math.sqrt(pPool * (1 - pPool) * (1 / a.total + 1 / b.total));
  const z = se === 0 ? 0 : (pB - pA) / se;
  const p = Math.min(1, 2 * 0.5 * Math.erfc(Math.abs(z) / Math.sqrt(2)));
  return { pA, pB, z, p, se };
}

export function pct(n, total) {
  return total > 0 ? ((n / total) * 100).toFixed(2) + "%" : "n/a";
}

export function quantile(sorted, q) {
  if (!sorted || sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[idx];
}

export function summarize(samples) {
  if (!samples || samples.length === 0) return { count: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = samples.reduce((s, x) => s + x, 0);
  return {
    count: samples.length,
    mean: sum / samples.length,
    p50: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    p99: quantile(sorted, 0.99),
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

export async function loadResults(args) {
  if (args.input) {
    return JSON.parse(readFileSync(args.input, "utf8"));
  }
  // Storage path: not yet implemented. Tell the user to export to JSON first.
  throw new Error(
    "--input=<file> is required (storage adapter not implemented yet — export raw data to JSON)"
  );
}

export function recommendation(analysis) {
  if (!analysis || analysis.p == null) {
    return { label: "inconclusive", reason: "insufficient data or undefined p-value" };
  }
  if (analysis.p < 0.05 && analysis.meanB > analysis.meanA) {
    return { label: "deploy", reason: "significant improvement" };
  }
  if (analysis.p < 0.05 && analysis.meanB < analysis.meanA) {
    return { label: "revert", reason: "significant regression" };
  }
  return { label: "inconclusive", reason: "p >= 0.05; run longer or accept null hypothesis" };
}

export function formatReport(experiment, variants, analysis) {
  const lines = [];
  lines.push(`# A/B Analysis: ${experiment}\n`);
  lines.push("## Per-variant summary\n");
  lines.push("| Variant | Count | Mean | p50 | p95 | Error rate |");
  lines.push("|---|---|---|---|---|---|");
  for (const [name, v] of Object.entries(variants)) {
    const mean = v.mean != null ? v.mean.toFixed(2) : "n/a";
    const p50 = v.p50 != null ? v.p50.toFixed(2) : "n/a";
    const p95 = v.p95 != null ? v.p95.toFixed(2) : "n/a";
    lines.push(
      `| ${name} | ${v.count} | ${mean} | ${p50} | ${p95} | ${pct(v.errors, v.count)} |`
    );
  }
  lines.push("\n## Statistical analysis\n");
  if (analysis) {
    const lift =
      analysis.meanA !== 0
        ? (((analysis.meanB - analysis.meanA) / analysis.meanA) * 100).toFixed(2)
        : "n/a";
    const pStr = analysis.p != null ? analysis.p.toFixed(4) : "n/a";
    const ciLow = (analysis.meanB - 1.96 * analysis.se).toFixed(2);
    const ciHigh = (analysis.meanB + 1.96 * analysis.se).toFixed(2);
    lines.push(`- **Lift**: ${lift}% (${analysis.metric})`);
    lines.push(`- **p-value**: ${pStr}`);
    lines.push(`- **95% CI**: [${ciLow}, ${ciHigh}]`);
    const rec = recommendation(analysis);
    if (rec.label === "deploy") {
      lines.push(`- **Recommendation**: Deploy variant B (${rec.reason})`);
    } else if (rec.label === "revert") {
      lines.push(`- **Recommendation**: Revert variant B (${rec.reason})`);
    } else {
      lines.push(`- **Recommendation**: Inconclusive (${rec.reason})`);
    }
  } else {
    lines.push("- Insufficient data for statistical analysis (need >5 samples per variant).");
  }
  return lines.join("\n");
}

export function analyzeData(data, metric = "error_rate") {
  const variants = {};
  for (const [name, samples] of Object.entries(data.variants || {})) {
    variants[name] = {
      ...summarize(samples.latencies || []),
      errors: samples.errors || 0,
    };
  }

  let analysis = null;
  const variantNames = Object.keys(variants);
  if (variantNames.length === 2) {
    const [aName, bName] = variantNames;
    const aSamples = data.variants[aName].latencies || [];
    const bSamples = data.variants[bName].latencies || [];
    if (aSamples.length > 5 && bSamples.length > 5) {
      const w = welchT(aSamples, bSamples);
      if (w) {
        analysis = {
          metric,
          meanA: w.meanA,
          meanB: w.meanB,
          se: w.se,
          t: w.t,
          df: w.df,
          p: pValueTwoTailed(w.t, w.df),
        };
      }
    }
  }

  return { variants, analysis };
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.experiment) {
    console.error(
      "Usage: ab-analyze.mjs --experiment=<name> [--metric=<name>] [--input=<file>] [--output=<file>]"
    );
    process.exit(2);
  }

  const data = await loadResults(args);
  const { variants, analysis } = analyzeData(data, args.metric);
  const report = formatReport(args.experiment, variants, analysis);

  if (args.output) {
    writeFileSync(args.output, report);
    console.log(`Wrote report to ${args.output}`);
  } else {
    console.log(report);
  }

  if (analysis && analysis.p != null && analysis.p < 0.05 && analysis.meanB < analysis.meanA) {
    process.exit(1); // significant regression
  }
}

// Run only when invoked directly (not when imported by tests)
const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(2);
  });
}
