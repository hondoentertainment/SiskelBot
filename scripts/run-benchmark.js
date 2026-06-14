#!/usr/bin/env node
/**
 * CLI entry point for the benchmark harness.
 *
 * Usage:
 *   node scripts/run-benchmark.js --suite mini
 *   node scripts/run-benchmark.js --suite mini --output report.json --concurrency 2
 *   node scripts/run-benchmark.js --suite mini --url http://localhost:3000 --key KEY --model gpt-4
 *
 * When --url is not given, a built-in mock agent returns hardcoded reference
 * solutions for each mini task. This keeps the script runnable in CI.
 *
 * When --url is given, the agent issues a single /v1/chat/completions request
 * per task and extracts the code from the assistant message.
 */
import { writeFileSync } from "node:fs";
import { runBenchmarkSuite } from "../lib/benchmark-harness.js";
import { getSuite } from "../lib/benchmark-suites/mini-tasks.js";

function parseArgs(argv) {
  const out = { suite: "mini", output: null, concurrency: 1, url: null, key: null, model: "gpt-4" };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    switch (a) {
      case "--suite": out.suite = next; i++; break;
      case "--output": out.output = next; i++; break;
      case "--concurrency": out.concurrency = Math.max(1, parseInt(next, 10) || 1); i++; break;
      case "--url": out.url = next; i++; break;
      case "--key": out.key = next; i++; break;
      case "--model": out.model = next; i++; break;
      case "--help":
      case "-h":
        console.log("Usage: node scripts/run-benchmark.js [--suite mini] [--output FILE.json] [--concurrency N] [--url URL --key KEY --model NAME]");
        process.exit(0);
        break;
      default:
        if (a.startsWith("--")) console.error("Unknown flag:", a);
    }
  }
  return out;
}

/**
 * Reference solutions for the mini suite. Used by the built-in mock agent so
 * the harness can be exercised end-to-end without a live server. The keys are
 * task ids; values are full ES module source strings.
 */
const MOCK_SOLUTIONS = {
  "mini-001": "export function sumEvens(arr) { return arr.reduce((s, n) => n % 2 === 0 ? s + n : s, 0); }",
  "mini-002": "export function fizzbuzz(n) { if (n % 15 === 0) return 'FizzBuzz'; if (n % 3 === 0) return 'Fizz'; if (n % 5 === 0) return 'Buzz'; return String(n); }",
  "mini-003": "export function reverseString(s) { return s.split('').reverse().join(''); }",
  "mini-004": "export function isPalindrome(s) { const cleaned = s.toLowerCase().replace(/[^a-z0-9]/g, ''); const rev = cleaned.split('').reverse().join(''); return cleaned === rev; }",
  "mini-005": "export function twoSum(nums, target) { const seen = new Map(); for (let i = 0; i < nums.length; i++) { const need = target - nums[i]; if (seen.has(need)) return [seen.get(need), i]; seen.set(nums[i], i); } return [-1, -1]; }",
  "mini-006": "export function mergeSorted(a, b) { const out = []; let i = 0, j = 0; while (i < a.length && j < b.length) { if (a[i] <= b[j]) out.push(a[i++]); else out.push(b[j++]); } while (i < a.length) out.push(a[i++]); while (j < b.length) out.push(b[j++]); return out; }",
  "mini-007": "export function deepClone(v) { if (v === null || typeof v !== 'object') return v; if (Array.isArray(v)) return v.map(deepClone); const o = {}; for (const k of Object.keys(v)) o[k] = deepClone(v[k]); return o; }",
  "mini-008": "export function binarySearch(arr, target) { let lo = 0, hi = arr.length - 1; while (lo <= hi) { const mid = (lo + hi) >> 1; if (arr[mid] === target) return mid; if (arr[mid] < target) lo = mid + 1; else hi = mid - 1; } return -1; }",
  "mini-009": "export function countVowels(s) { let c = 0; for (const ch of s.toLowerCase()) if ('aeiou'.includes(ch)) c++; return c; }",
  "mini-010": "export function flattenOnce(arr) { const out = []; for (const x of arr) { if (Array.isArray(x)) out.push(...x); else out.push(x); } return out; }",
};

function makeMockAgent() {
  return async function mockAgent(prompt, { task } = {}) {
    const id = task && task.id;
    const code = MOCK_SOLUTIONS[id];
    if (!code) return "```javascript\n// no mock solution available\nexport default function() { return null; }\n```";
    return "```javascript\n" + code + "\n```";
  };
}

function makeHttpAgent(url, key, model) {
  return async function httpAgent(prompt) {
    const headers = { "content-type": "application/json" };
    if (key) headers["authorization"] = "Bearer " + key;
    const body = {
      model,
      stream: false,
      messages: [
        { role: "system", content: "You are a code generation assistant. Return ONLY the requested JavaScript ES module inside a ```javascript fence." },
        { role: "user", content: prompt },
      ],
    };
    const res = await fetch(url.replace(/\/$/, "") + "/v1/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => "")}`);
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    return typeof content === "string" ? content : "";
  };
}

function formatTable(results) {
  const rows = [["TASK", "PASS", "TESTS", "DUR(ms)", "ERROR"]];
  for (const r of results) {
    rows.push([
      r.taskId,
      r.passed ? "ok" : "fail",
      `${r.passedTests}/${r.totalTests}`,
      String(r.durationMs),
      r.error ? r.error.slice(0, 40) : "",
    ]);
  }
  const widths = rows[0].map((_, i) => Math.max(...rows.map((row) => String(row[i]).length)));
  return rows
    .map((row) => row.map((c, i) => String(c).padEnd(widths[i])).join("  "))
    .join("\n");
}

async function main() {
  const args = parseArgs(process.argv);
  let suite;
  try {
    suite = getSuite(args.suite);
  } catch (e) {
    console.error("Error:", e.message);
    process.exit(2);
  }

  const agent = args.url
    ? makeHttpAgent(args.url, args.key, args.model)
    : makeMockAgent();

  console.log(`Running suite "${args.suite}" (${suite.length} tasks) — agent=${args.url ? "http:" + args.url : "mock"}  concurrency=${args.concurrency}`);

  const started = Date.now();
  const { taskResults, aggregate } = await runBenchmarkSuite(suite, agent, {
    concurrency: args.concurrency,
  });
  const wallMs = Date.now() - started;

  console.log("");
  console.log(formatTable(taskResults));
  console.log("");
  console.log(
    `Aggregate: passed=${aggregate.passed}/${aggregate.total} ` +
    `(${(aggregate.passRate * 100).toFixed(1)}%) ` +
    `avg=${aggregate.avgDurationMs}ms p50=${aggregate.p50Duration}ms p95=${aggregate.p95Duration}ms ` +
    `wall=${wallMs}ms`
  );

  const report = {
    suite: args.suite,
    agent: args.url ? { kind: "http", url: args.url, model: args.model } : { kind: "mock" },
    concurrency: args.concurrency,
    startedAt: new Date(started).toISOString(),
    wallMs,
    aggregate,
    taskResults,
  };
  if (args.output) {
    writeFileSync(args.output, JSON.stringify(report, null, 2));
    console.log("Wrote", args.output);
  }

  process.exit(aggregate.passed === aggregate.total ? 0 : 1);
}

main().catch((e) => {
  console.error("Fatal:", e && e.stack ? e.stack : e);
  process.exit(2);
});
