import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBenchmarkTask, runBenchmarkSuite, extractCode } from "../lib/benchmark-harness.js";
import { MINI_TASKS, getSuite } from "../lib/benchmark-suites/mini-tasks.js";

// Tmpdir handshake: verify we can create an isolated tmp path without polluting cwd.
const _sandbox = mkdtempSync(join(tmpdir(), "bh-test-"));
process.on("exit", () => {
  try { rmSync(_sandbox, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ─── extractCode ──────────────────────────────────────────────────────────────

test("extractCode: returns contents of a ```javascript fence", () => {
  const raw = "Sure!\n```javascript\nexport const x = 1;\n```\nDone.";
  assert.equal(extractCode(raw), "export const x = 1;");
});

test("extractCode: returns longest fence when multiple present", () => {
  const raw = "```js\nconst a = 1;\n```\n```javascript\nexport function f() { return 42; }\nexport function g() { return 1; }\n```";
  const out = extractCode(raw);
  assert.ok(out.includes("function f()"));
  assert.ok(out.includes("function g()"));
});

test("extractCode: returns raw if no fence", () => {
  const raw = "export function f() { return 1; }";
  assert.equal(extractCode(raw), raw);
});

test("extractCode: returns empty string on bad input", () => {
  assert.equal(extractCode(""), "");
  assert.equal(extractCode(null), "");
  assert.equal(extractCode(undefined), "");
});

// ─── runBenchmarkTask ────────────────────────────────────────────────────────

const sumEvensTask = MINI_TASKS.find((t) => t.id === "mini-001");

test("runBenchmarkTask: known-good agent passes all test cases", async () => {
  const agent = async () => "```javascript\nexport function sumEvens(a) { return a.reduce((s, n) => n % 2 === 0 ? s + n : s, 0); }\n```";
  const res = await runBenchmarkTask(sumEvensTask, agent);
  assert.equal(res.taskId, "mini-001");
  assert.equal(res.passed, true);
  assert.equal(res.passedTests, sumEvensTask.testCases.length);
  assert.equal(res.totalTests, sumEvensTask.testCases.length);
  assert.ok(res.durationMs >= 0);
  assert.equal(typeof res.generatedCode, "string");
  assert.ok(res.generatedCode.includes("sumEvens"));
});

test("runBenchmarkTask: bogus agent output fails", async () => {
  const agent = async () => "```javascript\nexport function sumEvens() { return 999; }\n```";
  const res = await runBenchmarkTask(sumEvensTask, agent);
  assert.equal(res.passed, false);
  assert.ok(res.passedTests < sumEvensTask.testCases.length);
});

test("runBenchmarkTask: agent throwing is captured, not propagated", async () => {
  const agent = async () => { throw new Error("network-down"); };
  const res = await runBenchmarkTask(sumEvensTask, agent);
  assert.equal(res.passed, false);
  assert.ok(res.error && res.error.includes("agent-error"));
  assert.ok(res.error.includes("network-down"));
});

test("runBenchmarkTask: empty/no-code response reports no-code-extracted", async () => {
  const agent = async () => "";
  const res = await runBenchmarkTask(sumEvensTask, agent);
  assert.equal(res.passed, false);
  assert.equal(res.error, "no-code-extracted");
});

test("runBenchmarkTask: rejects non-javascript task", async () => {
  const task = { id: "py", language: "python", prompt: "x", testCases: [{ input: [], expected: 1 }] };
  const res = await runBenchmarkTask(task, async () => "code");
  assert.equal(res.passed, false);
  assert.ok(res.error && res.error.includes("unsupported-language"));
});

test("runBenchmarkTask: rejects missing testCases", async () => {
  const task = { id: "x", language: "javascript", prompt: "hi", testCases: [] };
  const res = await runBenchmarkTask(task, async () => "code");
  assert.equal(res.passed, false);
  assert.equal(res.error, "no-test-cases");
});

test("runBenchmarkTask: onProgress callback fires with the result", async () => {
  const agent = async () => "```javascript\nexport function sumEvens(a) { return a.reduce((s, n) => n % 2 === 0 ? s + n : s, 0); }\n```";
  let captured = null;
  await runBenchmarkTask(sumEvensTask, agent, {
    onProgress: (r) => { captured = r; },
  });
  assert.ok(captured);
  assert.equal(captured.taskId, "mini-001");
  assert.equal(captured.passed, true);
});

// ─── runBenchmarkSuite ───────────────────────────────────────────────────────

const MOCK_SOLUTIONS = {
  "mini-001": "export function sumEvens(arr) { return arr.reduce((s, n) => n % 2 === 0 ? s + n : s, 0); }",
  "mini-002": "export function fizzbuzz(n) { if (n % 15 === 0) return 'FizzBuzz'; if (n % 3 === 0) return 'Fizz'; if (n % 5 === 0) return 'Buzz'; return String(n); }",
  "mini-003": "export function reverseString(s) { return s.split('').reverse().join(''); }",
  "mini-004": "export function isPalindrome(s) { const c = s.toLowerCase().replace(/[^a-z0-9]/g, ''); return c === c.split('').reverse().join(''); }",
  "mini-005": "export function twoSum(nums, target) { const m = new Map(); for (let i = 0; i < nums.length; i++) { const n = target - nums[i]; if (m.has(n)) return [m.get(n), i]; m.set(nums[i], i); } return [-1, -1]; }",
  "mini-006": "export function mergeSorted(a, b) { const o = []; let i = 0, j = 0; while (i < a.length && j < b.length) o.push(a[i] <= b[j] ? a[i++] : b[j++]); while (i < a.length) o.push(a[i++]); while (j < b.length) o.push(b[j++]); return o; }",
  "mini-007": "export function deepClone(v) { if (v === null || typeof v !== 'object') return v; if (Array.isArray(v)) return v.map(deepClone); const o = {}; for (const k of Object.keys(v)) o[k] = deepClone(v[k]); return o; }",
  "mini-008": "export function binarySearch(arr, target) { let lo = 0, hi = arr.length - 1; while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m] === target) return m; if (arr[m] < target) lo = m + 1; else hi = m - 1; } return -1; }",
  "mini-009": "export function countVowels(s) { let c = 0; for (const ch of s.toLowerCase()) if ('aeiou'.includes(ch)) c++; return c; }",
  "mini-010": "export function flattenOnce(arr) { const o = []; for (const x of arr) { if (Array.isArray(x)) o.push(...x); else o.push(x); } return o; }",
};

function makeMockAgent() {
  return async (prompt, { task } = {}) => {
    const id = task && task.id;
    const code = MOCK_SOLUTIONS[id];
    if (!code) return "";
    return "```javascript\n" + code + "\n```";
  };
}

test("runBenchmarkSuite: MINI_TASKS with reference solutions passes all", async () => {
  const suite = getSuite("mini");
  assert.ok(suite.length >= 5 && suite.length <= 15, `mini suite should be 5-10-ish tasks, got ${suite.length}`);

  const { taskResults, aggregate } = await runBenchmarkSuite(suite, makeMockAgent(), { concurrency: 2 });
  assert.equal(taskResults.length, suite.length);
  for (const r of taskResults) {
    assert.equal(r.passed, true, `task ${r.taskId} failed: ${r.error || "wrong answer"}`);
  }
  assert.equal(aggregate.passed, suite.length);
  assert.equal(aggregate.total, suite.length);
  assert.equal(aggregate.passRate, 1);
  assert.ok(aggregate.p50Duration >= 0);
  assert.ok(aggregate.p95Duration >= aggregate.p50Duration);
});

test("runBenchmarkSuite: concurrency preserves result order by task index", async () => {
  const suite = getSuite("mini");
  const { taskResults } = await runBenchmarkSuite(suite, makeMockAgent(), { concurrency: 4 });
  for (let i = 0; i < suite.length; i++) {
    assert.equal(taskResults[i].taskId, suite[i].id);
  }
});

test("runBenchmarkSuite: bogus agent yields failing aggregate", async () => {
  const suite = getSuite("mini");
  const agent = async () => "```javascript\nexport default function() { return null; }\n```";
  const { aggregate } = await runBenchmarkSuite(suite, agent, { concurrency: 2 });
  assert.ok(aggregate.passed < aggregate.total);
  assert.ok(aggregate.passRate < 1);
});

test("getSuite: unknown suite throws", () => {
  assert.throws(() => getSuite("nope"), /unknown suite/);
});
