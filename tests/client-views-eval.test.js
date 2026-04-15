/**
 * Unit tests for the pure helpers exported from
 * client/src/views/eval-view.js. No JSDOM required.
 */

import test from "node:test";
import assert from "node:assert/strict";

if (typeof globalThis.document === "undefined") {
  globalThis.document = {
    querySelector: () => null,
    createElement: () => ({
      appendChild: () => {},
      addEventListener: () => {},
      setAttribute: () => {},
      dataset: {},
    }),
    head: { appendChild: () => {} },
  };
}

const { formatEvalStatus, summarizeRun, sortEvalSets } = await import(
  "../client/src/views/eval-view.js"
);

test("formatEvalStatus maps pass / fail / skipped / unknown", () => {
  const pass = formatEvalStatus({ pass: true });
  assert.equal(pass.label, "pass");
  assert.ok(pass.cls.includes("eval-badge-ok"));
  assert.equal(pass.symbol, "\u2713");

  const fail = formatEvalStatus({ pass: false });
  assert.equal(fail.label, "fail");
  assert.ok(fail.cls.includes("eval-badge-bad"));
  assert.equal(fail.symbol, "\u2717");

  const skipped = formatEvalStatus({ skipped: true, pass: true });
  assert.equal(skipped.label, "skipped");
  assert.ok(skipped.cls.includes("eval-badge-muted"));

  const unknown = formatEvalStatus(null);
  assert.equal(unknown.label, "unknown");
  const empty = formatEvalStatus({});
  assert.equal(empty.label, "unknown");
});

test("summarizeRun derives totals when counts absent", () => {
  const run = {
    results: [
      { pass: true },
      { pass: false },
      { pass: false, error: "boom" },
      { skipped: true },
    ],
  };
  const s = summarizeRun(run);
  assert.equal(s.total, 4);
  assert.equal(s.passed, 1);
  assert.equal(s.failed, 2);
  assert.equal(s.skipped, 1);
  assert.equal(s.durationMs, 0);
});

test("summarizeRun honors explicit counts and never goes negative", () => {
  const s = summarizeRun({
    total: 10,
    passed: 7,
    skipped: 1,
    durationMs: 4321,
    results: [],
  });
  assert.equal(s.total, 10);
  assert.equal(s.passed, 7);
  assert.equal(s.skipped, 1);
  assert.equal(s.failed, 2);
  assert.equal(s.durationMs, 4321);

  // Malformed counts clamp.
  const weird = summarizeRun({ total: -1, passed: -4, skipped: "x", results: null, durationMs: "bad" });
  assert.equal(weird.total, 0);
  assert.equal(weird.passed, 0);
  assert.equal(weird.skipped, 0);
  assert.equal(weird.failed, 0);
  assert.equal(weird.durationMs, 0);
});

test("summarizeRun handles null/undefined input gracefully", () => {
  const empty = summarizeRun(null);
  assert.deepEqual(empty, { total: 0, passed: 0, failed: 0, skipped: 0, durationMs: 0 });
  const also = summarizeRun(undefined);
  assert.deepEqual(also, { total: 0, passed: 0, failed: 0, skipped: 0, durationMs: 0 });
});

test("sortEvalSets sorts by name asc, stable and non-mutating", () => {
  const input = [
    { id: "zebra", name: "Zebra" },
    { id: "apple", name: "apple" },
    { id: "mango", name: "Mango" },
    { id: "apple-2", name: "apple" }, // tie on name, id-asc breaks
  ];
  const copy = JSON.parse(JSON.stringify(input));
  const out = sortEvalSets(input);
  assert.deepEqual(input, copy, "input not mutated");
  assert.deepEqual(out.map((s) => s.id), ["apple", "apple-2", "mango", "zebra"]);
});

test("sortEvalSets returns [] for non-array input", () => {
  assert.deepEqual(sortEvalSets(null), []);
  assert.deepEqual(sortEvalSets(undefined), []);
  assert.deepEqual(sortEvalSets("oops"), []);
  assert.deepEqual(sortEvalSets({ length: 2, 0: { id: "a" }, 1: { id: "b" } }), []);
});
