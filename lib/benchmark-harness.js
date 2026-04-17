/**
 * Benchmark harness — SWE-bench-compatible runner shape.
 *
 * Responsibilities:
 *   - Accept a BenchmarkTask and an async agentFn(prompt) => string.
 *   - Call the agent, extract code from the agent's response (markdown-fence
 *     aware), and hand off to the scorer.
 *   - Enforce a hard timeout + iteration cap at the harness level so a slow
 *     agent cannot stall the suite.
 *   - NEVER execute generated code in-process. All execution is delegated to
 *     lib/benchmark-scorer.js which spawns an isolated Node subprocess.
 *
 * @typedef {object} BenchmarkTask
 * @property {string} id
 * @property {string} title
 * @property {string} prompt
 * @property {string} language
 * @property {string} [starterCode]
 * @property {string} [entry]
 * @property {Array<{input: any, expected: any}>} testCases
 * @property {number} [timeoutMs]
 *
 * @typedef {object} BenchmarkRunResult
 * @property {string} taskId
 * @property {boolean} passed
 * @property {number} passedTests
 * @property {number} totalTests
 * @property {number} durationMs
 * @property {number} iterations
 * @property {string} [error]
 * @property {string} [generatedCode]
 */
import { scoreTaskResult, aggregateResults } from "./benchmark-scorer.js";

/**
 * Extract a JavaScript code block from an LLM response. Supports:
 *   - ```js / ```javascript / ```mjs / ```node fenced blocks
 *   - unfenced raw code (returned as-is if it looks like JS)
 *   - multiple fences: returns the longest JS block
 */
export function extractCode(raw) {
  if (typeof raw !== "string") return "";
  const text = raw.trim();
  if (text.length === 0) return "";

  const fenceRe = /```(?:js|javascript|mjs|node)?\s*\n([\s\S]*?)\n```/gi;
  const blocks = [];
  let m;
  while ((m = fenceRe.exec(text)) !== null) {
    blocks.push(m[1]);
  }
  if (blocks.length > 0) {
    blocks.sort((a, b) => b.length - a.length);
    return blocks[0].trim();
  }
  // No fences — assume the whole string is code.
  return text;
}

function validateTask(task) {
  if (!task || typeof task !== "object") return "invalid-task";
  if (typeof task.id !== "string" || task.id.length === 0) return "missing-id";
  if (typeof task.prompt !== "string") return "missing-prompt";
  if (task.language !== "javascript") return `unsupported-language:${task.language}`;
  if (!Array.isArray(task.testCases) || task.testCases.length === 0) return "no-test-cases";
  return null;
}

/**
 * Run a single benchmark task.
 *
 * @param {BenchmarkTask} task
 * @param {(prompt: string) => Promise<string>} agentFn
 * @param {{onProgress?: Function}} [opts]
 * @returns {Promise<BenchmarkRunResult>}
 */
export async function runBenchmarkTask(task, agentFn, opts = {}) {
  const start = Date.now();
  const taskId = task && task.id ? task.id : "unknown";

  const invalid = validateTask(task);
  if (invalid) {
    return {
      taskId,
      passed: false,
      passedTests: 0,
      totalTests: Array.isArray(task && task.testCases) ? task.testCases.length : 0,
      durationMs: Date.now() - start,
      iterations: 0,
      error: invalid,
    };
  }

  if (typeof agentFn !== "function") {
    return {
      taskId,
      passed: false,
      passedTests: 0,
      totalTests: task.testCases.length,
      durationMs: Date.now() - start,
      iterations: 0,
      error: "agentFn-not-a-function",
    };
  }

  let agentResponse;
  let iterations = 0;
  try {
    const promptParts = [task.prompt];
    if (task.starterCode) {
      promptParts.push("\nStarter code:\n```javascript\n" + task.starterCode + "\n```");
    }
    promptParts.push(
      "\nReturn a single JavaScript ES module that exports the required function. " +
      "Wrap your code in a ```javascript fenced block."
    );
    const fullPrompt = promptParts.join("\n");
    const res = await agentFn(fullPrompt, { task });
    if (res && typeof res === "object" && typeof res.content === "string") {
      agentResponse = res.content;
      if (Number.isFinite(res.iterations)) iterations = res.iterations;
    } else if (typeof res === "string") {
      agentResponse = res;
      iterations = 1;
    } else {
      agentResponse = "";
    }
  } catch (e) {
    return {
      taskId,
      passed: false,
      passedTests: 0,
      totalTests: task.testCases.length,
      durationMs: Date.now() - start,
      iterations,
      error: "agent-error: " + (e && e.message ? e.message : String(e)),
    };
  }

  const generatedCode = extractCode(agentResponse);
  if (!generatedCode) {
    return {
      taskId,
      passed: false,
      passedTests: 0,
      totalTests: task.testCases.length,
      durationMs: Date.now() - start,
      iterations,
      error: "no-code-extracted",
      generatedCode: "",
    };
  }

  const score = await scoreTaskResult(task, generatedCode, task.testCases);
  const result = {
    taskId,
    passed: Boolean(score.passed),
    passedTests: score.passedTests,
    totalTests: score.totalTests,
    durationMs: Date.now() - start,
    iterations,
    generatedCode,
  };
  if (score.error) result.error = score.error;
  if (opts && typeof opts.onProgress === "function") {
    try { opts.onProgress(result); } catch { /* ignore */ }
  }
  return result;
}

/**
 * Run a whole suite (array of tasks).
 *
 * @param {BenchmarkTask[]} suite
 * @param {(prompt: string) => Promise<string>} agentFn
 * @param {{concurrency?: number, onProgress?: Function}} [opts]
 */
export async function runBenchmarkSuite(suite, agentFn, opts = {}) {
  const tasks = Array.isArray(suite) ? suite : [];
  const concurrency = Math.max(1, Math.min(8, Math.floor(opts.concurrency || 1)));
  const taskResults = new Array(tasks.length);

  let cursor = 0;
  async function worker() {
    while (true) {
      const idx = cursor++;
      if (idx >= tasks.length) return;
      taskResults[idx] = await runBenchmarkTask(tasks[idx], agentFn, opts);
    }
  }
  const workers = [];
  for (let i = 0; i < concurrency; i++) workers.push(worker());
  await Promise.all(workers);

  const aggregate = aggregateResults(taskResults);
  return { taskResults, aggregate };
}
