/**
 * Benchmark scorer for SWE-bench-shaped tasks.
 *
 * Executes agent-generated JavaScript code in an isolated Node subprocess
 * (never in-process: no eval, no Function, no require of user code).
 * Scores pass/fail against a list of test cases by:
 *   1. Writing generatedCode to a tmp module file under os.tmpdir().
 *   2. Spawning `node --input-type=module --eval <runner>` with env={}.
 *   3. Sending JSON-encoded test cases over stdin.
 *   4. Reading JSON-encoded results from stdout.
 *   5. Enforcing a hard timeout via spawn timeout + kill.
 *   6. Cleaning up the tmp directory.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_TIMEOUT_MS = 30000;
const MIN_TIMEOUT_MS = 100;

/**
 * The runner snippet executed inside the child subprocess. It imports the
 * user's module (file:// URL passed via process.argv[2]), reads JSON test
 * cases from stdin, invokes either the named export or the first exported
 * function with the input args, and writes JSON results to stdout.
 */
const RUNNER_SOURCE = `
const moduleUrl = process.argv[1];
const entryName = process.argv[2] || "";
let chunks = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { chunks += c; });
process.stdin.on("end", async () => {
  let testCases;
  try { testCases = JSON.parse(chunks); }
  catch (e) {
    process.stdout.write(JSON.stringify({ fatal: "bad-stdin: " + e.message }));
    return;
  }
  let mod;
  try { mod = await import(moduleUrl); }
  catch (e) {
    process.stdout.write(JSON.stringify({ fatal: "import-failed: " + (e && e.stack || e.message || String(e)) }));
    return;
  }
  let fn = null;
  if (entryName && typeof mod[entryName] === "function") fn = mod[entryName];
  if (!fn && mod.default && typeof mod.default === "function") fn = mod.default;
  if (!fn) {
    for (const k of Object.keys(mod)) {
      if (typeof mod[k] === "function") { fn = mod[k]; break; }
    }
  }
  if (!fn) {
    process.stdout.write(JSON.stringify({ fatal: "no-exported-function" }));
    return;
  }
  const results = [];
  for (const tc of testCases) {
    const args = Array.isArray(tc.input) ? tc.input : [tc.input];
    try {
      const out = await fn(...args);
      results.push({ ok: true, actual: out === undefined ? null : out });
    } catch (e) {
      results.push({ ok: false, error: (e && e.message) ? e.message : String(e) });
    }
  }
  process.stdout.write(JSON.stringify({ results }));
});
`;

/**
 * Deep structural equality for JSON-compatible values.
 */
function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) if (!deepEqual(a[k], b[k])) return false;
  return true;
}

function clampTimeout(ms) {
  const n = Number.isFinite(ms) ? Math.floor(ms) : DEFAULT_TIMEOUT_MS;
  if (n < MIN_TIMEOUT_MS) return MIN_TIMEOUT_MS;
  if (n > MAX_TIMEOUT_MS) return MAX_TIMEOUT_MS;
  return n;
}

/**
 * Score generated code against a set of test cases.
 *
 * @param {{id: string, language: string, timeoutMs?: number, entry?: string}} task
 * @param {string} generatedCode - JavaScript module source defining the target function.
 * @param {Array<{input: any, expected: any}>} testCases
 * @returns {Promise<{passed: boolean, passedTests: number, totalTests: number, details: Array, error?: string}>}
 */
export async function scoreTaskResult(task, generatedCode, testCases) {
  if (!task || typeof task !== "object") {
    return { passed: false, passedTests: 0, totalTests: 0, details: [], error: "invalid-task" };
  }
  if (task.language !== "javascript") {
    return {
      passed: false,
      passedTests: 0,
      totalTests: Array.isArray(testCases) ? testCases.length : 0,
      details: [],
      error: `unsupported-language:${task.language}`,
    };
  }
  if (typeof generatedCode !== "string" || generatedCode.length === 0) {
    return {
      passed: false,
      passedTests: 0,
      totalTests: Array.isArray(testCases) ? testCases.length : 0,
      details: [],
      error: "empty-generated-code",
    };
  }
  const cases = Array.isArray(testCases) ? testCases : [];
  const total = cases.length;
  const timeoutMs = clampTimeout(task.timeoutMs);

  // Create isolated tmp dir (mkdtempSync under os.tmpdir()).
  const tmp = mkdtempSync(join(tmpdir(), "bench-"));
  const modulePath = join(tmp, `m-${randomBytes(6).toString("hex")}.mjs`);
  try {
    writeFileSync(modulePath, generatedCode, { encoding: "utf8" });
    const moduleUrl = "file://" + modulePath;

    const execResult = await runSubprocess(moduleUrl, task.entry || "", cases, timeoutMs);
    if (execResult.error) {
      return {
        passed: false,
        passedTests: 0,
        totalTests: total,
        details: [],
        error: execResult.error,
      };
    }

    const payload = execResult.payload;
    if (payload && payload.fatal) {
      return {
        passed: false,
        passedTests: 0,
        totalTests: total,
        details: [],
        error: payload.fatal,
      };
    }
    const results = (payload && Array.isArray(payload.results)) ? payload.results : [];
    const details = [];
    let passedTests = 0;
    for (let i = 0; i < cases.length; i++) {
      const tc = cases[i];
      const r = results[i];
      if (!r) {
        details.push({ index: i, passed: false, error: "no-result" });
        continue;
      }
      if (!r.ok) {
        details.push({ index: i, passed: false, error: r.error });
        continue;
      }
      const ok = deepEqual(r.actual, tc.expected);
      if (ok) passedTests++;
      details.push({
        index: i,
        passed: ok,
        actual: r.actual,
        expected: tc.expected,
      });
    }
    return {
      passed: passedTests === total && total > 0,
      passedTests,
      totalTests: total,
      details,
    };
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function runSubprocess(moduleUrl, entryName, testCases, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const child = spawn(
      process.execPath,
      ["--input-type=module", "--eval", RUNNER_SOURCE, "--", moduleUrl, entryName],
      {
        stdio: ["pipe", "pipe", "pipe"],
        // Strict env isolation: no inherited env (no PATH, no network creds, no HOME).
        env: { NODE_NO_WARNINGS: "1" },
        cwd: tmpdir(),
        windowsHide: true,
      }
    );

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }, timeoutMs);

    child.stdout.on("data", (d) => { stdout += d.toString("utf8"); });
    child.stderr.on("data", (d) => { stderr += d.toString("utf8"); });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ error: "spawn-error: " + (err && err.message ? err.message : String(err)) });
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) {
        resolve({ error: `timeout after ${timeoutMs}ms` });
        return;
      }
      if (code !== 0 && !stdout) {
        resolve({
          error: `subprocess-exit ${code} signal=${signal} stderr=${stderr.slice(0, 500)}`,
        });
        return;
      }
      try {
        const payload = JSON.parse(stdout);
        resolve({ payload });
      } catch (e) {
        resolve({ error: `bad-stdout: ${e.message} raw=${stdout.slice(0, 200)}` });
      }
    });

    try {
      child.stdin.write(JSON.stringify(testCases));
      child.stdin.end();
    } catch (e) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      resolve({ error: "stdin-write-failed: " + (e && e.message ? e.message : String(e)) });
    }
  });
}

/**
 * Aggregate per-task results into suite-level stats.
 *
 * @param {Array<{passed: boolean, durationMs: number, iterations?: number}>} taskResults
 */
export function aggregateResults(taskResults) {
  const results = Array.isArray(taskResults) ? taskResults : [];
  const total = results.length;
  const passed = results.filter((r) => r && r.passed).length;
  const durations = results
    .map((r) => (r && Number.isFinite(r.durationMs) ? r.durationMs : 0))
    .sort((a, b) => a - b);
  const iterations = results.map((r) => (r && Number.isFinite(r.iterations) ? r.iterations : 0));

  function percentile(sorted, p) {
    if (sorted.length === 0) return 0;
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[idx];
  }
  const avg = (arr) => (arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length);

  return {
    passed,
    total,
    passRate: total === 0 ? 0 : passed / total,
    avgDurationMs: Math.round(avg(durations)),
    avgIterations: Number((avg(iterations)).toFixed(2)),
    p50Duration: percentile(durations, 50),
    p95Duration: percentile(durations, 95),
  };
}
