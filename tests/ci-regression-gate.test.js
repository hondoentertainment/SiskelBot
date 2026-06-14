import { test } from "node:test";
import assert from "node:assert/strict";

import {
  evaluateThresholds,
  buildReport,
  parseTapSummary,
  formatHumanSummary,
} from "../scripts/ci-regression-gate.js";
import { buildMarkdownComment } from "../scripts/ci-pr-comment.js";

const THRESHOLDS = { benchmark: 0.9, safety: 0.9, eval: 0.8 };

function benchInput(passRate, passed = 10, total = 10) {
  return {
    suite: "mini",
    aggregate: { passRate, passed, total, avgDurationMs: 50 },
  };
}

function safetyInput(passRate, passed = 27, total = 30) {
  return {
    category: "all",
    overall: { passRate, passed, total, durationMs: 5 },
  };
}

test("evaluateThresholds: all above -> status pass", () => {
  const result = evaluateThresholds(
    {
      benchmark: benchInput(1.0, 10, 10),
      safety: safetyInput(0.9666, 29, 30),
      eval: { total: 6, passed: 6 },
    },
    THRESHOLDS,
  );
  assert.equal(result.status, "pass");
  assert.equal(result.gates.benchmark.status, "pass");
  assert.equal(result.gates.safety.status, "pass");
  assert.equal(result.gates.eval.status, "pass");
});

test("evaluateThresholds: benchmark below -> fail & that gate fails", () => {
  const result = evaluateThresholds(
    {
      benchmark: benchInput(0.5, 5, 10),
      safety: safetyInput(0.95, 28, 30),
      eval: { total: 6, passed: 6 },
    },
    THRESHOLDS,
  );
  assert.equal(result.status, "fail");
  assert.equal(result.gates.benchmark.status, "fail");
  assert.match(result.gates.benchmark.reason, /below threshold/);
  assert.equal(result.gates.safety.status, "pass");
  assert.equal(result.gates.eval.status, "pass");
});

test("evaluateThresholds: safety below -> fail", () => {
  const result = evaluateThresholds(
    {
      benchmark: benchInput(1.0),
      safety: safetyInput(0.5, 15, 30),
      eval: { total: 6, passed: 6 },
    },
    THRESHOLDS,
  );
  assert.equal(result.status, "fail");
  assert.equal(result.gates.safety.status, "fail");
});

test("evaluateThresholds: eval below -> fail", () => {
  const result = evaluateThresholds(
    {
      benchmark: benchInput(1.0),
      safety: safetyInput(1.0, 30, 30),
      eval: { total: 10, passed: 5 },
    },
    THRESHOLDS,
  );
  assert.equal(result.status, "fail");
  assert.equal(result.gates.eval.status, "fail");
  assert.match(result.gates.eval.reason, /below threshold/);
});

test("evaluateThresholds: exactly-at-threshold counts as pass (>=)", () => {
  const result = evaluateThresholds(
    {
      benchmark: benchInput(0.9, 9, 10),
      safety: safetyInput(0.9, 27, 30),
      eval: { total: 10, passed: 8 }, // exactly 0.8
    },
    THRESHOLDS,
  );
  assert.equal(result.status, "pass");
  assert.equal(result.gates.benchmark.status, "pass");
  assert.equal(result.gates.safety.status, "pass");
  assert.equal(result.gates.eval.status, "pass");
});

test("evaluateThresholds: missing eval -> status fail with reason 'missing input'", () => {
  const result = evaluateThresholds(
    {
      benchmark: benchInput(1.0),
      safety: safetyInput(1.0, 30, 30),
      eval: undefined,
    },
    THRESHOLDS,
  );
  assert.equal(result.status, "fail");
  assert.equal(result.gates.eval.status, "fail");
  assert.equal(result.gates.eval.reason, "missing input");
});

test("evaluateThresholds: missing benchmark -> fail with reason 'missing input'", () => {
  const result = evaluateThresholds(
    { benchmark: null, safety: safetyInput(1.0), eval: { total: 6, passed: 6 } },
    THRESHOLDS,
  );
  assert.equal(result.status, "fail");
  assert.equal(result.gates.benchmark.reason, "missing input");
});

test("evaluateThresholds: malformed benchmark -> 'unparseable output'", () => {
  const result = evaluateThresholds(
    { benchmark: { aggregate: { foo: "bar" } }, safety: safetyInput(1.0), eval: { total: 6, passed: 6 } },
    THRESHOLDS,
  );
  assert.equal(result.gates.benchmark.status, "fail");
  assert.equal(result.gates.benchmark.reason, "unparseable output");
});

test("evaluateThresholds: malformed eval -> 'unparseable output'", () => {
  const result = evaluateThresholds(
    { benchmark: benchInput(1.0), safety: safetyInput(1.0), eval: { foo: 1 } },
    THRESHOLDS,
  );
  assert.equal(result.gates.eval.status, "fail");
  assert.equal(result.gates.eval.reason, "unparseable output");
});

test("parseTapSummary: extracts counts from TAP tail", () => {
  const tap = [
    "ok 1 - foo",
    "ok 2 - bar",
    "1..2",
    "# tests 2",
    "# suites 0",
    "# pass 2",
    "# fail 0",
    "# cancelled 0",
    "# duration_ms 1.0",
  ].join("\n");
  const summary = parseTapSummary(tap);
  assert.deepEqual(summary, { total: 2, passed: 2, failed: 0 });
});

test("parseTapSummary: returns null on garbage input", () => {
  assert.equal(parseTapSummary("no tap here"), null);
  assert.equal(parseTapSummary(""), null);
  assert.equal(parseTapSummary(null), null);
});

test("buildReport: wraps evaluation with metadata", () => {
  const evaluation = evaluateThresholds(
    {
      benchmark: benchInput(1.0),
      safety: safetyInput(1.0, 30, 30),
      eval: { total: 6, passed: 6 },
    },
    THRESHOLDS,
  );
  const report = buildReport(evaluation, {
    runtimeSec: 4.2,
    commit: "abc1234567",
    timestamp: "2026-04-18T00:00:00.000Z",
  });
  assert.equal(report.status, "pass");
  assert.equal(report.runtimeSec, 4.2);
  assert.equal(report.commit, "abc1234567");
  assert.equal(report.timestamp, "2026-04-18T00:00:00.000Z");
  assert.ok(report.gates.benchmark);
});

test("buildMarkdownComment: pass report contains expected table rows", () => {
  const evaluation = evaluateThresholds(
    {
      benchmark: benchInput(1.0, 10, 10),
      safety: safetyInput(0.9666666, 29, 30),
      eval: { total: 18, passed: 18 },
    },
    THRESHOLDS,
  );
  const report = buildReport(evaluation, { runtimeSec: 4.2, commit: "abc1234" });
  const md = buildMarkdownComment(report);
  assert.match(md, /## Agent regression gate/);
  assert.match(md, /PASS/);
  assert.match(md, /\| Gate \| Value \| Threshold \| Status \|/);
  assert.match(md, /Benchmark \(mini\)/);
  assert.match(md, /100\.0% \(10\/10\)/);
  assert.match(md, /Safety \(all\)/);
  assert.match(md, /96\.7% \(29\/30\)/);
  assert.match(md, /Internal evals/);
  assert.match(md, /18\/18 pass/);
  assert.match(md, /≥ 90\.0%/);
  assert.match(md, /≥ 80\.0%/);
  assert.match(md, /abc1234/);
  assert.match(md, /4\.2s/);
});

test("buildMarkdownComment: fail report starts with FAIL and lists failed gates", () => {
  const evaluation = evaluateThresholds(
    {
      benchmark: benchInput(0.5, 5, 10),
      safety: safetyInput(1.0, 30, 30),
      eval: { total: 10, passed: 5 },
    },
    THRESHOLDS,
  );
  const report = buildReport(evaluation, { runtimeSec: 3.1, commit: "deadbee" });
  const md = buildMarkdownComment(report);
  assert.match(md, /## Agent regression gate .* FAIL/);
  assert.match(md, /### Failed gates/);
  assert.match(md, /Benchmark.*below threshold/);
  assert.match(md, /Internal evals.*below threshold/);
});

test("buildMarkdownComment: handles missing input gracefully", () => {
  const evaluation = evaluateThresholds(
    { benchmark: benchInput(1.0), safety: null, eval: { total: 6, passed: 6 } },
    THRESHOLDS,
  );
  const report = buildReport(evaluation, { runtimeSec: 1.0 });
  const md = buildMarkdownComment(report);
  assert.match(md, /FAIL/);
  assert.match(md, /Safety.*missing input/);
});

test("formatHumanSummary: contains per-gate lines with PASS/FAIL tags", () => {
  const evaluation = evaluateThresholds(
    {
      benchmark: benchInput(1.0),
      safety: safetyInput(0.95, 28, 30),
      eval: { total: 6, passed: 6 },
    },
    THRESHOLDS,
  );
  const report = buildReport(evaluation, { runtimeSec: 2.5 });
  const text = formatHumanSummary(report);
  assert.match(text, /\[PASS\]/);
  assert.match(text, /benchmark:/);
  assert.match(text, /safety:/);
  assert.match(text, /eval:/);
});
