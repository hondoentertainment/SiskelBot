/**
 * Phase 56.2: Benchmark runner.
 *
 * Framework for running standard LLM benchmarks (MMLU, HumanEval, SWE-bench,
 * GSM8K, custom) without bundling any datasets. Users supply JSONL datasets
 * via file path or inline text, register a `target` function, pick a scorer,
 * and receive per-case results plus aggregate scores.
 *
 * Storage layout (under STORAGE_PATH):
 *   data/benchmarks/<name>.json   -- saved benchmark definition
 *   data/benchmark-runs.json      -- recorded run history (append-only list)
 */
import { randomUUID } from "crypto";
import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

// ─── Type definitions ─────────────────────────────────────────────────────────

/**
 * @typedef {Object} BenchmarkTypeSpec
 * @property {string} label
 * @property {string} description
 * @property {string} defaultScorer
 * @property {string[]} expectedInputFields
 */

/** @type {Record<string, BenchmarkTypeSpec>} */
export const BENCHMARK_TYPES = {
  multiple_choice: {
    label: "Multiple choice",
    description: "MMLU-style: a question with choices A–D. Expected is the letter.",
    defaultScorer: "multiple_choice_letter",
    expectedInputFields: ["question", "choices"],
  },
  code_completion: {
    label: "Code completion",
    description: "HumanEval-style: prompt + canonical test. Expected is test code.",
    defaultScorer: "contains",
    expectedInputFields: ["prompt", "tests"],
  },
  math_word: {
    label: "Math word problem",
    description: "GSM8K-style: natural-language question with a single numeric answer.",
    defaultScorer: "numeric",
    expectedInputFields: ["question"],
  },
  issue_resolution: {
    label: "Issue resolution",
    description: "SWE-bench-style: issue text + reference patch. Expected is a diff/patch.",
    defaultScorer: "contains",
    expectedInputFields: ["issue", "repo"],
  },
  custom: {
    label: "Custom",
    description: "User-defined; no input schema enforced.",
    defaultScorer: "exact_match",
    expectedInputFields: [],
  },
};

// ─── Scorers ──────────────────────────────────────────────────────────────────

function extractChoiceLetter(text) {
  if (typeof text !== "string") return null;
  const match = text.match(/\b([A-D])\b/);
  return match ? match[1].toUpperCase() : null;
}

function tryParseJson(s) {
  if (typeof s !== "string") return s;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== "object") return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqual(a[k], b[k])) return false;
  }
  return true;
}

/** @type {Record<string, (output: string, expected: any) => boolean>} */
export const SCORERS = {
  exact_match: (out, exp) => String(out ?? "").trim() === String(exp ?? "").trim(),
  regex: (out, exp) => {
    try {
      return new RegExp(String(exp)).test(String(out ?? ""));
    } catch {
      return false;
    }
  },
  multiple_choice_letter: (out, exp) => {
    const pred = extractChoiceLetter(String(out ?? ""));
    const gold = extractChoiceLetter(String(exp ?? "")) || String(exp ?? "").trim().toUpperCase();
    if (!pred || !gold) return false;
    return pred === gold;
  },
  numeric: (out, exp) => {
    const o = parseFloat(String(out ?? "").replace(/,/g, "").match(/-?\d+(\.\d+)?/)?.[0] ?? "");
    const e = parseFloat(String(exp ?? "").replace(/,/g, ""));
    if (!Number.isFinite(o) || !Number.isFinite(e)) return false;
    return Math.abs(o - e) < 1e-6;
  },
  contains: (out, exp) => {
    const o = String(out ?? "");
    const e = String(exp ?? "");
    if (!e) return false;
    return o.includes(e);
  },
  jsonEqual: (out, exp) => {
    const o = tryParseJson(out);
    const e = typeof exp === "string" ? tryParseJson(exp) ?? exp : exp;
    if (o === undefined) return false;
    return deepEqual(o, e);
  },
};

const customScorers = new Map();

/**
 * Register a custom scorer. Scorer receives (output, expected) and returns boolean.
 * @param {string} name
 * @param {(output: string, expected: any) => boolean} fn
 */
export function registerScorer(name, fn) {
  if (!name || typeof name !== "string") throw new Error("scorer name required");
  if (typeof fn !== "function") throw new Error("scorer must be a function");
  customScorers.set(name, fn);
}

function resolveScorer(name) {
  if (!name) return null;
  if (Object.prototype.hasOwnProperty.call(SCORERS, name)) return SCORERS[name];
  if (customScorers.has(name)) return customScorers.get(name);
  return null;
}

/**
 * Score a single test case.
 * @param {{ expected: any }} testCase
 * @param {string} output
 * @param {string} scorerName
 */
export function scoreCase(testCase, output, scorerName) {
  const scorer = resolveScorer(scorerName);
  if (!scorer) throw new Error(`unknown scorer: ${scorerName}`);
  const expected = testCase?.expected;
  let pass = false;
  try {
    pass = !!scorer(output, expected);
  } catch {
    pass = false;
  }
  return { pass, scorer: scorerName };
}

// ─── Storage paths ────────────────────────────────────────────────────────────

function benchmarkPath(name) {
  const safe = String(name || "").trim().replace(/[^a-zA-Z0-9_.-]/g, "_");
  if (!safe) throw new Error("benchmark name required");
  return join(getDataDir(), "benchmarks", `${safe}.json`);
}

function runsPath() {
  return join(getDataDir(), "benchmark-runs.json");
}

function benchmarksDir() {
  return join(getDataDir(), "benchmarks");
}

// ─── Dataset parsing ──────────────────────────────────────────────────────────

function parseJsonlText(text) {
  if (typeof text !== "string") throw new Error("dataset must be a string");
  const lines = text.split(/\r?\n/);
  const cases = [];
  let idx = 0;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (e) {
      throw new Error(`invalid JSONL at line ${idx + 1}: ${e.message}`, { cause: e });
    }
    idx++;
    const id = parsed.id != null ? String(parsed.id) : `case-${idx}`;
    const input = parsed.input != null ? parsed.input : parsed;
    const expected = parsed.expected != null
      ? parsed.expected
      : parsed.answer != null
      ? parsed.answer
      : parsed.output != null
      ? parsed.output
      : null;
    const metadata = parsed.metadata && typeof parsed.metadata === "object" ? parsed.metadata : {};
    cases.push({ id, input, expected, metadata });
  }
  return cases;
}

/**
 * Load a benchmark. If `datasetPath` is provided, reads JSONL from that file and
 * returns a fresh benchmark object. If `datasetPath` is inline JSONL text (looks
 * like JSONL, not an existing path), it is parsed directly. Otherwise, loads a
 * previously-saved benchmark from storage.
 *
 * @param {string} name
 * @param {string|null} [datasetPath] - file path OR inline JSONL text (for tests)
 * @param {{ type?: string, inline?: boolean }} [options]
 * @returns {Promise<{ name: string, type: string, cases: Array<object> }>}
 */
export async function loadBenchmark(name, datasetPath = null, options = {}) {
  if (!name || typeof name !== "string") throw new Error("benchmark name required");

  if (datasetPath) {
    let rawText;
    if (options.inline === true) {
      rawText = datasetPath;
    } else if (existsSync(datasetPath)) {
      rawText = readFileSync(datasetPath, "utf8");
    } else if (datasetPath.includes("\n") || datasetPath.trim().startsWith("{")) {
      // Treat as inline JSONL text when it clearly isn't a path
      rawText = datasetPath;
    } else {
      throw new Error(`dataset not found: ${datasetPath}`);
    }
    const cases = parseJsonlText(rawText);
    const type = options.type && BENCHMARK_TYPES[options.type] ? options.type : "custom";
    return { name, type, cases };
  }

  const path = benchmarkPath(name);
  const stored = await readJsonPath(path, null);
  if (!stored || typeof stored !== "object" || stored._deleted || !Array.isArray(stored.cases)) {
    return null;
  }
  return {
    name: stored.name || name,
    type: stored.type || "custom",
    cases: stored.cases,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
  };
}

/**
 * Persist a benchmark definition.
 * @param {string} name
 * @param {{ type?: string, cases: Array<object> }} benchmark
 */
export async function saveBenchmark(name, benchmark) {
  if (!name || typeof name !== "string") throw new Error("benchmark name required");
  if (!benchmark || !Array.isArray(benchmark.cases)) {
    throw new Error("benchmark.cases must be an array");
  }
  const type = benchmark.type && BENCHMARK_TYPES[benchmark.type] ? benchmark.type : "custom";
  const now = new Date().toISOString();
  const path = benchmarkPath(name);
  const record = {
    name,
    type,
    cases: benchmark.cases.map((c, i) => ({
      id: c.id != null ? String(c.id) : `case-${i + 1}`,
      input: c.input != null ? c.input : null,
      expected: c.expected != null ? c.expected : null,
      metadata: c.metadata && typeof c.metadata === "object" ? c.metadata : {},
    })),
    createdAt: now,
    updatedAt: now,
  };
  await withPathLock(path, async () => {
    const existing = await readJsonPath(path, null);
    if (existing && existing.createdAt) record.createdAt = existing.createdAt;
    await writeJsonPath(path, record);
  });
  return record;
}

/**
 * Delete a saved benchmark.
 * @param {string} name
 * @returns {Promise<{ deleted: boolean }>}
 */
export async function deleteBenchmark(name) {
  if (!name || typeof name !== "string") throw new Error("benchmark name required");
  const path = benchmarkPath(name);
  const existing = await readJsonPath(path, null);
  const isRecord =
    existing && typeof existing === "object" && !existing._deleted
      && (Array.isArray(existing.cases) || existing.name);
  if (!isRecord) return { deleted: false };
  await writeJsonPath(path, { _deleted: true, name });
  // Best-effort remove underlying file when on the filesystem backend.
  try {
    const { unlinkSync, existsSync: exists } = await import("fs");
    if (exists(path)) unlinkSync(path);
  } catch {
    // ignore
  }
  return { deleted: true };
}

/**
 * List saved benchmarks (name + type + case count).
 */
export async function listBenchmarks() {
  const dir = benchmarksDir();
  if (!existsSync(dir)) return [];
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    const path = join(dir, f);
    try {
      const raw = readFileSync(path, "utf8");
      const data = JSON.parse(raw);
      if (data && !data._deleted && Array.isArray(data.cases)) {
        out.push({
          name: data.name || f.replace(/\.json$/, ""),
          type: data.type || "custom",
          cases: data.cases.length,
          createdAt: data.createdAt || null,
          updatedAt: data.updatedAt || null,
        });
      }
    } catch {
      // ignore bad files
    }
  }
  return out;
}

// ─── Runner ───────────────────────────────────────────────────────────────────

async function runWithConcurrency(items, concurrency, worker) {
  const limit = Math.max(1, Math.min(32, Number(concurrency) || 1));
  const results = new Array(items.length);
  let cursor = 0;
  async function lane() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  }
  const lanes = [];
  for (let i = 0; i < limit; i++) lanes.push(lane());
  await Promise.all(lanes);
  return results;
}

/**
 * Run a benchmark.
 *
 * @param {string} name
 * @param {(testCase: object) => (Promise<string>|string)} targetFn
 * @param {{ maxCases?: number, concurrency?: number, type?: string, scorer?: string, benchmark?: object }} [options]
 */
export async function runBenchmark(name, targetFn, options = {}) {
  if (typeof targetFn !== "function") throw new Error("targetFn must be a function");
  let benchmark = options.benchmark || null;
  if (!benchmark) {
    benchmark = await loadBenchmark(name);
  }
  if (!benchmark) throw new Error(`benchmark not found: ${name}`);

  const type = options.type || benchmark.type || "custom";
  const scorerName = options.scorer
    || BENCHMARK_TYPES[type]?.defaultScorer
    || "exact_match";
  if (!resolveScorer(scorerName)) {
    throw new Error(`unknown scorer: ${scorerName}`);
  }

  const cases = Array.isArray(benchmark.cases) ? benchmark.cases : [];
  const limit = Number.isFinite(options.maxCases) && options.maxCases > 0
    ? Math.min(cases.length, Math.floor(options.maxCases))
    : cases.length;
  const subset = cases.slice(0, limit);
  const concurrency = Math.max(1, Math.min(16, Number(options.concurrency) || 1));

  const startedAt = Date.now();
  const perCase = await runWithConcurrency(subset, concurrency, async (tc) => {
    const caseStart = Date.now();
    let output = "";
    let error = null;
    try {
      const r = await targetFn(tc);
      output = r == null ? "" : typeof r === "string" ? r : JSON.stringify(r);
    } catch (e) {
      error = e?.message || String(e);
    }
    const { pass } = error
      ? { pass: false }
      : scoreCase(tc, output, scorerName);
    return {
      id: tc.id,
      output,
      expected: tc.expected,
      pass: !!pass,
      error,
      latencyMs: Date.now() - caseStart,
    };
  });
  const durationMs = Date.now() - startedAt;
  const correct = perCase.reduce((n, c) => n + (c.pass ? 1 : 0), 0);
  const total = perCase.length;
  const score = total > 0 ? Math.round((correct / total) * 10000) / 10000 : 0;

  return {
    runId: randomUUID(),
    benchmarkName: name,
    type,
    scorer: scorerName,
    total,
    correct,
    score,
    concurrency,
    durationMs,
    startedAt: new Date(startedAt).toISOString(),
    perCase,
  };
}

// ─── Run history ──────────────────────────────────────────────────────────────

/**
 * Persist a run summary to history.
 * @param {object} result - return value of runBenchmark
 */
export async function recordRun(result) {
  if (!result || !result.benchmarkName) throw new Error("result.benchmarkName required");
  const path = runsPath();
  let saved = null;
  await withPathLock(path, async () => {
    const store = await readJsonPath(path, { _version: 1, runs: [] });
    const runs = Array.isArray(store.runs) ? store.runs : [];
    const record = {
      runId: result.runId || randomUUID(),
      benchmarkName: result.benchmarkName,
      type: result.type || null,
      scorer: result.scorer || null,
      total: result.total || 0,
      correct: result.correct || 0,
      score: result.score || 0,
      durationMs: result.durationMs || 0,
      startedAt: result.startedAt || new Date().toISOString(),
      recordedAt: new Date().toISOString(),
      perCase: Array.isArray(result.perCase) ? result.perCase : [],
    };
    runs.push(record);
    // Cap at 500 runs to bound disk growth.
    while (runs.length > 500) runs.shift();
    await writeJsonPath(path, { _version: 1, runs });
    saved = record;
  });
  return saved;
}

/**
 * Fetch run history. If `name` is provided, filters by benchmark.
 * @param {string|null} [name]
 */
export async function getRunHistory(name = null) {
  const store = await readJsonPath(runsPath(), { _version: 1, runs: [] });
  const runs = Array.isArray(store.runs) ? store.runs : [];
  if (!name) return runs;
  return runs.filter((r) => r.benchmarkName === name);
}

/**
 * Fetch the most recent run for a benchmark name.
 */
export async function getLatestRun(name) {
  const runs = await getRunHistory(name);
  if (!runs.length) return null;
  return runs[runs.length - 1];
}

/**
 * Compare two runs and return the delta on common cases.
 */
export function compareRuns(run1, run2) {
  if (!run1 || !run2) throw new Error("two run objects are required");
  const scoreDelta = Math.round(((run2.score || 0) - (run1.score || 0)) * 10000) / 10000;
  const correctDelta = (run2.correct || 0) - (run1.correct || 0);
  const totalDelta = (run2.total || 0) - (run1.total || 0);
  const durationDelta = (run2.durationMs || 0) - (run1.durationMs || 0);

  const by1 = new Map((run1.perCase || []).map((c) => [c.id, c]));
  const by2 = new Map((run2.perCase || []).map((c) => [c.id, c]));
  const improved = [];
  const regressed = [];
  const unchanged = [];
  for (const [id, c2] of by2.entries()) {
    const c1 = by1.get(id);
    if (!c1) continue;
    if (c1.pass === c2.pass) {
      unchanged.push(id);
    } else if (!c1.pass && c2.pass) {
      improved.push(id);
    } else {
      regressed.push(id);
    }
  }

  return {
    run1: { runId: run1.runId, benchmarkName: run1.benchmarkName, score: run1.score, correct: run1.correct, total: run1.total },
    run2: { runId: run2.runId, benchmarkName: run2.benchmarkName, score: run2.score, correct: run2.correct, total: run2.total },
    scoreDelta,
    correctDelta,
    totalDelta,
    durationDelta,
    improved,
    regressed,
    unchanged,
  };
}

// ─── Reports ──────────────────────────────────────────────────────────────────

/**
 * Produce a human-readable or JSON report for a run.
 * @param {object} run
 * @param {"text"|"json"} [format]
 */
export function formatReport(run, format = "text") {
  if (!run) throw new Error("run is required");
  if (format === "json") {
    return JSON.stringify({
      benchmarkName: run.benchmarkName,
      type: run.type,
      scorer: run.scorer,
      total: run.total,
      correct: run.correct,
      score: run.score,
      durationMs: run.durationMs,
      startedAt: run.startedAt,
      failures: (run.perCase || []).filter((c) => !c.pass).map((c) => ({
        id: c.id,
        expected: c.expected,
        output: c.output,
        error: c.error || null,
      })),
    }, null, 2);
  }
  const pct = ((run.score || 0) * 100).toFixed(2);
  const lines = [];
  lines.push(`Benchmark: ${run.benchmarkName}`);
  if (run.type) lines.push(`Type:      ${run.type}`);
  if (run.scorer) lines.push(`Scorer:    ${run.scorer}`);
  lines.push(`Score:     ${run.correct}/${run.total} (${pct}%)`);
  if (run.durationMs != null) lines.push(`Duration:  ${run.durationMs}ms`);
  if (run.startedAt) lines.push(`Started:   ${run.startedAt}`);
  const failures = (run.perCase || []).filter((c) => !c.pass);
  if (failures.length) {
    lines.push("");
    lines.push(`Failures (${failures.length}):`);
    for (const f of failures.slice(0, 20)) {
      const snippet = String(f.output ?? "").slice(0, 80).replace(/\n/g, " ");
      const err = f.error ? ` [error: ${f.error}]` : "";
      lines.push(`  - ${f.id}: expected="${String(f.expected ?? "").slice(0, 40)}" got="${snippet}"${err}`);
    }
    if (failures.length > 20) lines.push(`  ... and ${failures.length - 20} more`);
  }
  return lines.join("\n");
}

export default {
  BENCHMARK_TYPES,
  SCORERS,
  registerScorer,
  scoreCase,
  loadBenchmark,
  saveBenchmark,
  deleteBenchmark,
  listBenchmarks,
  runBenchmark,
  recordRun,
  getRunHistory,
  getLatestRun,
  compareRuns,
  formatReport,
};
