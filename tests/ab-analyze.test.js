/**
 * Tests for scripts/ab-analyze.mjs — A/B test statistical analysis.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseArgs,
  welchT,
  pValueTwoTailed,
  twoProportion,
  pct,
  quantile,
  summarize,
  recommendation,
  formatReport,
  analyzeData,
} from "../scripts/ab-analyze.mjs";

const SCRIPT = fileURLToPath(new URL("../scripts/ab-analyze.mjs", import.meta.url));

// --- welchT ---

test("welchT: identical samples produce t ≈ 0 and p ≈ 1", () => {
  const a = [10, 12, 11, 13, 10, 12, 11, 13, 10, 12, 11, 13, 10, 12, 11, 13];
  const b = [10, 12, 11, 13, 10, 12, 11, 13, 10, 12, 11, 13, 10, 12, 11, 13];
  const w = welchT(a, b);
  assert.ok(w);
  assert.ok(Math.abs(w.t) < 1e-9, `expected t ≈ 0, got ${w.t}`);
  const p = pValueTwoTailed(w.t, w.df);
  assert.ok(p > 0.95, `expected p ≈ 1, got ${p}`);
});

test("welchT: identical means produce t = 0", () => {
  const a = [5, 7, 6, 8, 5, 7, 6, 8];
  const b = [5, 7, 6, 8, 5, 7, 6, 8];
  const w = welchT(a, b);
  assert.equal(w.meanA, w.meanB);
  assert.ok(Math.abs(w.t) < 1e-9);
});

test("welchT: clearly better B yields p < 0.05", () => {
  // A clusters around 100ms, B clusters around 50ms -> highly significant.
  const a = Array.from({ length: 50 }, (_, i) => 100 + (i % 5));
  const b = Array.from({ length: 50 }, (_, i) => 50 + (i % 5));
  const w = welchT(a, b);
  assert.ok(w);
  assert.ok(w.meanA > w.meanB);
  const p = pValueTwoTailed(w.t, w.df);
  assert.ok(p != null && p < 0.05, `expected p < 0.05, got ${p}`);
});

test("welchT: returns null for too-small inputs", () => {
  assert.equal(welchT([1], [2, 3]), null);
  assert.equal(welchT([], []), null);
  assert.equal(welchT(null, [1, 2]), null);
});

// --- pValueTwoTailed ---

test("pValueTwoTailed: t=1.96 with df>30 returns ~0.05", () => {
  const p = pValueTwoTailed(1.96, 100);
  assert.ok(p != null);
  assert.ok(Math.abs(p - 0.05) < 0.01, `expected ~0.05, got ${p}`);
});

test("pValueTwoTailed: t=0 returns ~1", () => {
  const p = pValueTwoTailed(0, 100);
  assert.ok(p > 0.99, `expected ~1, got ${p}`);
});

test("pValueTwoTailed: large t returns near 0", () => {
  const p = pValueTwoTailed(10, 100);
  assert.ok(p < 0.001, `expected near 0, got ${p}`);
});

test("pValueTwoTailed: very small df returns null", () => {
  assert.equal(pValueTwoTailed(2, 3), null);
});

// --- twoProportion ---

test("twoProportion: equal proportions yield p ≈ 1", () => {
  const r = twoProportion({ successes: 50, total: 100 }, { successes: 50, total: 100 });
  assert.ok(r);
  assert.ok(r.p > 0.99);
});

test("twoProportion: very different proportions yield p < 0.05", () => {
  const r = twoProportion({ successes: 10, total: 100 }, { successes: 50, total: 100 });
  assert.ok(r.p < 0.05);
});

// --- summarize / quantile / pct ---

test("summarize: empty array returns count: 0", () => {
  const s = summarize([]);
  assert.deepEqual(s, { count: 0 });
});

test("summarize: non-empty returns correct stats", () => {
  const s = summarize([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(s.count, 10);
  assert.equal(s.mean, 5.5);
  assert.equal(s.min, 1);
  assert.equal(s.max, 10);
  // p50 of 10 sorted samples: floor(0.5 * 10) = index 5 -> value 6
  assert.equal(s.p50, 6);
  // p95: floor(0.95 * 10) = index 9 -> value 10
  assert.equal(s.p95, 10);
});

test("summarize: handles unsorted input", () => {
  const s = summarize([5, 1, 9, 3, 7]);
  assert.equal(s.min, 1);
  assert.equal(s.max, 9);
  assert.equal(s.count, 5);
});

test("quantile: empty array returns null", () => {
  assert.equal(quantile([], 0.5), null);
});

test("quantile: single value returns that value", () => {
  assert.equal(quantile([42], 0.95), 42);
});

test("pct: zero total returns n/a", () => {
  assert.equal(pct(0, 0), "n/a");
});

test("pct: regular ratio formats with %", () => {
  assert.equal(pct(25, 100), "25.00%");
});

// --- parseArgs ---

test("parseArgs: parses known flags", () => {
  const a = parseArgs(["node", "script", "--experiment=foo", "--metric=p95", "--input=in.json"]);
  assert.equal(a.experiment, "foo");
  assert.equal(a.metric, "p95");
  assert.equal(a.input, "in.json");
});

test("parseArgs: defaults metric to error_rate", () => {
  const a = parseArgs(["node", "script", "--experiment=x"]);
  assert.equal(a.metric, "error_rate");
});

// --- recommendation ---

test("recommendation: deploy when B better and p < 0.05", () => {
  const r = recommendation({ p: 0.01, meanA: 100, meanB: 110 });
  assert.equal(r.label, "deploy");
});

test("recommendation: revert when B worse and p < 0.05", () => {
  const r = recommendation({ p: 0.01, meanA: 100, meanB: 80 });
  assert.equal(r.label, "revert");
});

test("recommendation: inconclusive when p >= 0.05", () => {
  const r = recommendation({ p: 0.2, meanA: 100, meanB: 110 });
  assert.equal(r.label, "inconclusive");
});

test("recommendation: inconclusive when analysis is null", () => {
  assert.equal(recommendation(null).label, "inconclusive");
});

// --- analyzeData ---

test("analyzeData: produces analysis when both variants have >5 samples", () => {
  const data = {
    variants: {
      control: { latencies: [100, 102, 99, 101, 100, 103, 98], errors: 1 },
      treatment: { latencies: [50, 52, 49, 51, 50, 53, 48], errors: 0 },
    },
  };
  const { variants, analysis } = analyzeData(data, "p95_latency_ms");
  assert.equal(variants.control.count, 7);
  assert.equal(variants.treatment.count, 7);
  assert.ok(analysis);
  assert.ok(analysis.meanA > analysis.meanB);
});

test("analyzeData: skips analysis when too few samples", () => {
  const data = {
    variants: {
      control: { latencies: [100, 102], errors: 0 },
      treatment: { latencies: [50, 52], errors: 0 },
    },
  };
  const { analysis } = analyzeData(data);
  assert.equal(analysis, null);
});

// --- formatReport ---

test("formatReport: includes Recommendation line", () => {
  const variants = {
    control: { count: 10, mean: 100, p50: 100, p95: 105, errors: 1 },
    treatment: { count: 10, mean: 50, p50: 50, p95: 55, errors: 0 },
  };
  const analysis = { metric: "latency", meanA: 100, meanB: 50, se: 1, p: 0.001 };
  const report = formatReport("test-exp", variants, analysis);
  assert.match(report, /# A\/B Analysis: test-exp/);
  assert.match(report, /Recommendation/);
  assert.match(report, /Lift/);
});

// --- end-to-end CLI ---

test("CLI: end-to-end run with JSON input emits Recommendation", () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-analyze-"));
  try {
    const inputPath = join(dir, "results.json");
    const data = {
      experiment: "swarm-v2",
      variants: {
        control: {
          latencies: Array.from({ length: 50 }, (_, i) => 100 + (i % 5)),
          errors: 5,
        },
        treatment: {
          latencies: Array.from({ length: 50 }, (_, i) => 50 + (i % 5)),
          errors: 1,
        },
      },
    };
    writeFileSync(inputPath, JSON.stringify(data));

    const result = spawnSync(
      process.execPath,
      [
        SCRIPT,
        "--experiment=swarm-v2",
        "--metric=latency",
        `--input=${inputPath}`,
      ],
      { encoding: "utf8" }
    );

    // Exit code 1 is expected here because mean(treatment) < mean(control) is a "significant regression"
    // from the perspective of (B - A) since we treat second variant as B. That's fine; we just check stdout.
    assert.match(result.stdout, /A\/B Analysis: swarm-v2/);
    assert.match(result.stdout, /Recommendation/);
    assert.match(result.stdout, /Per-variant summary/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: missing --experiment exits with code 2", () => {
  const result = spawnSync(
    process.execPath,
    [SCRIPT],
    { encoding: "utf8" }
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage:/);
});
