import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreTaskResult, aggregateResults } from "../lib/benchmark-scorer.js";

const sumTask = {
  id: "t-sum",
  language: "javascript",
  entry: "sum",
  timeoutMs: 5000,
};

const sumTestCases = [
  { input: [1, 2], expected: 3 },
  { input: [0, 0], expected: 0 },
  { input: [-1, 1], expected: 0 },
];

test("scoreTaskResult: passing code passes all test cases", async () => {
  const code = "export function sum(a, b) { return a + b; }";
  const res = await scoreTaskResult(sumTask, code, sumTestCases);
  assert.equal(res.passed, true);
  assert.equal(res.passedTests, 3);
  assert.equal(res.totalTests, 3);
  assert.equal(res.details.length, 3);
  assert.ok(res.details.every((d) => d.passed));
});

test("scoreTaskResult: wrong-logic code fails all cases", async () => {
  const code = "export function sum(a, b) { return a - b; }";
  const res = await scoreTaskResult(sumTask, code, sumTestCases);
  assert.equal(res.passed, false);
  // -1-1 = 0 passes by coincidence; (1-2)=-1 fails, (0-0)=0 passes
  assert.ok(res.passedTests < 3);
  assert.equal(res.totalTests, 3);
});

test("scoreTaskResult: code that throws returns 0 passed + per-case errors", async () => {
  const code = "export function sum() { throw new Error('boom'); }";
  const res = await scoreTaskResult(sumTask, code, sumTestCases);
  assert.equal(res.passed, false);
  assert.equal(res.passedTests, 0);
  assert.equal(res.totalTests, 3);
  assert.ok(res.details.every((d) => d.passed === false));
  assert.ok(res.details.some((d) => typeof d.error === "string" && d.error.includes("boom")));
});

test("scoreTaskResult: timeout is reported as an error containing 'timeout'", async () => {
  const code = "export function sum() { while (true) {} }";
  const res = await scoreTaskResult({ ...sumTask, timeoutMs: 300 }, code, sumTestCases);
  assert.equal(res.passed, false);
  assert.equal(res.passedTests, 0);
  assert.ok(res.error, "expected an error");
  assert.ok(/timeout/i.test(res.error), `expected 'timeout' in error, got: ${res.error}`);
});

test("scoreTaskResult: rejects non-javascript language", async () => {
  const task = { id: "py", language: "python", entry: "f" };
  const res = await scoreTaskResult(task, "def f(): return 1", [{ input: [], expected: 1 }]);
  assert.equal(res.passed, false);
  assert.equal(res.passedTests, 0);
  assert.ok(res.error && res.error.includes("unsupported-language:python"));
});

test("scoreTaskResult: rejects empty generated code", async () => {
  const res = await scoreTaskResult(sumTask, "", sumTestCases);
  assert.equal(res.passed, false);
  assert.equal(res.error, "empty-generated-code");
});

test("scoreTaskResult: handles syntactically invalid code as import-failed", async () => {
  const res = await scoreTaskResult(sumTask, "export function sum( { ", sumTestCases);
  assert.equal(res.passed, false);
  assert.equal(res.passedTests, 0);
  assert.ok(res.error);
});

test("scoreTaskResult: deep-equality for object/array expected values", async () => {
  const code = "export function f(x) { return { a: x, b: [x, x] }; }";
  const task = { id: "obj", language: "javascript", entry: "f" };
  const cases = [
    { input: [1], expected: { a: 1, b: [1, 1] } },
    { input: [2], expected: { a: 2, b: [2, 2] } },
  ];
  const res = await scoreTaskResult(task, code, cases);
  assert.equal(res.passed, true);
  assert.equal(res.passedTests, 2);
});

test("aggregateResults: computes p50/p95 correctly", () => {
  const results = [
    { passed: true, durationMs: 10, iterations: 1 },
    { passed: true, durationMs: 20, iterations: 1 },
    { passed: false, durationMs: 30, iterations: 2 },
    { passed: true, durationMs: 40, iterations: 1 },
    { passed: false, durationMs: 50, iterations: 3 },
    { passed: true, durationMs: 60, iterations: 1 },
    { passed: true, durationMs: 70, iterations: 1 },
    { passed: true, durationMs: 80, iterations: 1 },
    { passed: true, durationMs: 90, iterations: 1 },
    { passed: true, durationMs: 100, iterations: 1 },
  ];
  const agg = aggregateResults(results);
  assert.equal(agg.passed, 8);
  assert.equal(agg.total, 10);
  assert.equal(agg.passRate, 0.8);
  // sorted durations: 10,20,30,40,50,60,70,80,90,100
  // p50: floor(0.5 * 10) = 5 -> index 5 -> 60
  // p95: floor(0.95 * 10) = 9 -> index 9 -> 100
  assert.equal(agg.p50Duration, 60);
  assert.equal(agg.p95Duration, 100);
  assert.equal(agg.avgDurationMs, 55);
  assert.ok(agg.avgIterations > 1 && agg.avgIterations < 2);
});

test("aggregateResults: empty input returns zeros", () => {
  const agg = aggregateResults([]);
  assert.equal(agg.passed, 0);
  assert.equal(agg.total, 0);
  assert.equal(agg.passRate, 0);
  assert.equal(agg.p50Duration, 0);
  assert.equal(agg.p95Duration, 0);
});
