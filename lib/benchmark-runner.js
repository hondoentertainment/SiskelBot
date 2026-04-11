// @ts-check
/**
 * Phase 56.2: Benchmark runner.
 *
 * Orchestrates runs of standard LLM eval suites (MMLU, HumanEval,
 * SWE-bench, GSM8K) with pluggable runner functions so the module
 * remains fully unit-testable without downloading real datasets.
 *
 * Each benchmark ships with a small built-in fixture (3–5 items) used
 * both for self-tests and for smoke runs. Callers may override with
 * registerBenchmark(name, fixture) or inject a custom grader.
 *
 * Exports:
 *   - listBenchmarks()
 *   - runBenchmark(name, opts)
 *   - getBenchmarkHistory(name)
 *   - compareRuns(runIdA, runIdB)
 *   - registerBenchmark(name, fixture)
 *   - setModelRunner(fn)
 *
 * @module benchmark-runner
 */
import { join } from "path";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;

function storePath() {
  return join(getDataDir(), "benchmark-runner.json");
}

function now() {
  return new Date().toISOString();
}

function randomId() {
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/* -------------------------------------------------------------------------- */
/* Built-in fixtures                                                          */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {{ id: string, prompt: string, expected: string, category?: string, grader?: "exact"|"contains"|"numeric"|"code" }} BenchItem
 * @typedef {{ name: string, description: string, items: BenchItem[] }} BenchmarkFixture
 */

/** @type {Record<string, BenchmarkFixture>} */
const BUILTIN_FIXTURES = {
  mmlu: {
    name: "mmlu",
    description: "Massive Multitask Language Understanding — tiny sample.",
    items: [
      { id: "mmlu-1", prompt: "What is the capital of France? A) Paris B) Lyon C) Nice", expected: "A", category: "geography", grader: "exact" },
      { id: "mmlu-2", prompt: "Which planet is closest to the Sun? A) Venus B) Mercury C) Earth", expected: "B", category: "science", grader: "exact" },
      { id: "mmlu-3", prompt: "Who wrote 'Hamlet'? A) Dickens B) Shakespeare C) Austen", expected: "B", category: "literature", grader: "exact" },
      { id: "mmlu-4", prompt: "Square root of 144? A) 10 B) 11 C) 12", expected: "C", category: "math", grader: "exact" },
    ],
  },
  humaneval: {
    name: "humaneval",
    description: "HumanEval-style code completion — tiny sample.",
    items: [
      { id: "he-1", prompt: "Write a function `add(a,b)` that returns a+b.", expected: "return a + b", grader: "contains" },
      { id: "he-2", prompt: "Write a function `max(a,b)` returning the greater.", expected: "a > b", grader: "contains" },
      { id: "he-3", prompt: "Write a function `is_even(n)` returning true if n is even.", expected: "% 2", grader: "contains" },
    ],
  },
  swebench: {
    name: "swebench",
    description: "SWE-bench-style bug-fix tasks — tiny sample.",
    items: [
      { id: "swe-1", prompt: "Fix bug in sum() where it returned -1 on empty list.", expected: "return 0", grader: "contains" },
      { id: "swe-2", prompt: "Fix off-by-one in find_index helper.", expected: "<= len", grader: "contains" },
      { id: "swe-3", prompt: "Handle null input in title_case().", expected: "is None", grader: "contains" },
    ],
  },
  gsm8k: {
    name: "gsm8k",
    description: "Grade-school math word problems — tiny sample.",
    items: [
      { id: "gsm-1", prompt: "Alice has 3 apples, Bob gives her 5 more. How many total?", expected: "8", grader: "numeric" },
      { id: "gsm-2", prompt: "A train travels 60 miles in 2 hours. Speed in mph?", expected: "30", grader: "numeric" },
      { id: "gsm-3", prompt: "Sum of 12+9+8?", expected: "29", grader: "numeric" },
      { id: "gsm-4", prompt: "Half of 100?", expected: "50", grader: "numeric" },
    ],
  },
};

/** @type {Record<string, BenchmarkFixture>} */
const _customFixtures = {};

/**
 * Register or override a benchmark fixture.
 * @param {string} name
 * @param {BenchmarkFixture} fixture
 */
export function registerBenchmark(name, fixture) {
  if (!name || typeof name !== "string") throw new Error("benchmark name is required");
  if (!fixture || typeof fixture !== "object" || !Array.isArray(fixture.items)) {
    throw new Error("fixture.items[] is required");
  }
  _customFixtures[name] = {
    name,
    description: String(fixture.description || ""),
    items: fixture.items.map((it) => ({
      id: String(it.id || ""),
      prompt: String(it.prompt || ""),
      expected: String(it.expected || ""),
      category: it.category ? String(it.category) : undefined,
      grader: it.grader || "exact",
    })),
  };
}

/**
 * Return the fixture for a benchmark (custom wins over built-in).
 * @param {string} name
 */
export function getFixture(name) {
  if (_customFixtures[name]) return _customFixtures[name];
  return BUILTIN_FIXTURES[name] || null;
}

/** List all benchmark names and metadata. */
export function listBenchmarks() {
  const names = new Set([...Object.keys(BUILTIN_FIXTURES), ...Object.keys(_customFixtures)]);
  return [...names].map((n) => {
    const f = getFixture(n);
    return {
      name: n,
      description: f?.description || "",
      itemCount: f ? f.items.length : 0,
      builtin: !!BUILTIN_FIXTURES[n],
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Graders                                                                    */
/* -------------------------------------------------------------------------- */

function normalize(s) {
  return String(s || "").trim().toLowerCase();
}

/**
 * Grade a single item's response.
 * @param {BenchItem} item
 * @param {string} response
 */
export function gradeItem(item, response) {
  const grader = item.grader || "exact";
  const resp = String(response || "");
  const exp = String(item.expected || "");
  if (grader === "exact") {
    return { correct: normalize(resp) === normalize(exp), grader };
  }
  if (grader === "contains") {
    return { correct: normalize(resp).includes(normalize(exp)), grader };
  }
  if (grader === "numeric") {
    const n = parseFloat(resp.replace(/[^0-9.\-]/g, ""));
    const want = parseFloat(exp);
    if (!Number.isFinite(n) || !Number.isFinite(want)) {
      return { correct: false, grader };
    }
    return { correct: Math.abs(n - want) < 1e-6, grader };
  }
  if (grader === "code") {
    // Loose: response must contain the expected snippet.
    return { correct: resp.includes(exp), grader };
  }
  return { correct: false, grader };
}

/* -------------------------------------------------------------------------- */
/* Model runner                                                               */
/* -------------------------------------------------------------------------- */

/** @type {(prompt: string, opts: object) => Promise<string>} */
let _modelRunner = async (prompt) => {
  // Default stub: echoes the last token of the prompt. Useless but safe.
  const toks = prompt.split(/\s+/).filter(Boolean);
  return toks[toks.length - 1] || "";
};

/**
 * Install a model runner. Tests inject a canned responder;
 * production wires the real LLM backend.
 * @param {((prompt: string, opts: object) => Promise<string>) | null} fn
 */
export function setModelRunner(fn) {
  if (fn === null) {
    _modelRunner = async (prompt) => {
      const toks = prompt.split(/\s+/).filter(Boolean);
      return toks[toks.length - 1] || "";
    };
    return;
  }
  if (typeof fn !== "function") throw new Error("runner must be a function");
  _modelRunner = fn;
}

/* -------------------------------------------------------------------------- */
/* Store                                                                      */
/* -------------------------------------------------------------------------- */

async function loadStore() {
  const raw = await readJsonPath(storePath(), { version: STORE_VERSION, runs: {} });
  if (!raw || typeof raw !== "object") return { version: STORE_VERSION, runs: {} };
  if (!raw.runs || typeof raw.runs !== "object") raw.runs = {};
  raw.version = STORE_VERSION;
  return raw;
}

async function saveStore(store) {
  await writeJsonPath(storePath(), { version: STORE_VERSION, runs: store.runs || {} });
}

/* -------------------------------------------------------------------------- */
/* Run                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Execute a benchmark end-to-end and persist the run.
 * @param {string} name
 * @param {object} [opts]
 */
export async function runBenchmark(name, opts = {}) {
  if (!name || typeof name !== "string") throw new Error("benchmark name is required");
  const fixture = getFixture(name);
  if (!fixture) throw new Error(`unknown benchmark "${name}"`);
  const model = opts && typeof opts.model === "string" ? opts.model : "stub";
  const limit = Number.isFinite(opts?.limit) && opts.limit > 0 ? Math.floor(opts.limit) : fixture.items.length;
  const items = fixture.items.slice(0, limit);
  const results = [];
  let correct = 0;
  const byCategory = /** @type {Record<string, {correct: number, total: number}>} */ ({});
  const start = Date.now();
  for (const it of items) {
    let response;
    try {
      response = await _modelRunner(it.prompt, { model, itemId: it.id });
    } catch (err) {
      response = `[runner error] ${err?.message || err}`;
    }
    const g = gradeItem(it, String(response || ""));
    if (g.correct) correct += 1;
    const cat = it.category || "default";
    byCategory[cat] = byCategory[cat] || { correct: 0, total: 0 };
    byCategory[cat].total += 1;
    if (g.correct) byCategory[cat].correct += 1;
    results.push({
      id: it.id,
      prompt: it.prompt,
      expected: it.expected,
      response: String(response || ""),
      correct: g.correct,
      grader: g.grader,
      category: it.category || null,
    });
  }
  const total = items.length;
  const score = total > 0 ? correct / total : 0;
  const run = {
    runId: randomId(),
    benchmark: name,
    model,
    score: Math.round(score * 10000) / 10000,
    correct,
    total,
    byCategory,
    durationMs: Date.now() - start,
    items: results,
    startedAt: new Date(start).toISOString(),
    finishedAt: now(),
    version: 1,
  };

  await withPathLock(storePath(), async () => {
    const store = await loadStore();
    store.runs[name] = Array.isArray(store.runs[name]) ? store.runs[name] : [];
    store.runs[name].push(run);
    if (store.runs[name].length > 500) store.runs[name] = store.runs[name].slice(-500);
    await saveStore(store);
  });

  return run;
}

/**
 * Fetch historical runs for a benchmark (newest last).
 * @param {string} name
 */
export async function getBenchmarkHistory(name) {
  const store = await loadStore();
  if (!name) {
    const out = {};
    for (const [k, v] of Object.entries(store.runs || {})) out[k] = v;
    return out;
  }
  return Array.isArray(store.runs[name]) ? store.runs[name].slice() : [];
}

/**
 * Compute a delta between two persisted runs.
 * @param {string} runIdA
 * @param {string} runIdB
 */
export async function compareRuns(runIdA, runIdB) {
  if (!runIdA || !runIdB) throw new Error("two run ids required");
  const store = await loadStore();
  let a = null;
  let b = null;
  for (const runs of Object.values(store.runs || {})) {
    if (!Array.isArray(runs)) continue;
    for (const r of runs) {
      if (r.runId === runIdA) a = r;
      if (r.runId === runIdB) b = r;
    }
  }
  if (!a) throw new Error(`run "${runIdA}" not found`);
  if (!b) throw new Error(`run "${runIdB}" not found`);
  const delta = {
    benchmarkA: a.benchmark,
    benchmarkB: b.benchmark,
    modelA: a.model,
    modelB: b.model,
    scoreA: a.score,
    scoreB: b.score,
    scoreDelta: Math.round((b.score - a.score) * 10000) / 10000,
    regressions: [],
    improvements: [],
    byCategory: /** @type {Record<string, {a: number|null, b: number|null, delta: number}>} */ ({}),
  };
  const byIdA = new Map(a.items.map((it) => [it.id, it]));
  const byIdB = new Map(b.items.map((it) => [it.id, it]));
  for (const [id, ia] of byIdA.entries()) {
    const ib = byIdB.get(id);
    if (!ib) continue;
    if (ia.correct && !ib.correct) delta.regressions.push(id);
    else if (!ia.correct && ib.correct) delta.improvements.push(id);
  }
  const allCats = new Set([...Object.keys(a.byCategory || {}), ...Object.keys(b.byCategory || {})]);
  for (const cat of allCats) {
    const ac = a.byCategory[cat];
    const bc = b.byCategory[cat];
    const sa = ac ? ac.correct / Math.max(1, ac.total) : null;
    const sb = bc ? bc.correct / Math.max(1, bc.total) : null;
    delta.byCategory[cat] = {
      a: sa != null ? Math.round(sa * 10000) / 10000 : null,
      b: sb != null ? Math.round(sb * 10000) / 10000 : null,
      delta: sa != null && sb != null ? Math.round((sb - sa) * 10000) / 10000 : 0,
    };
  }
  return delta;
}

/** Clear all persisted runs. Used in tests. */
export async function _clearRuns() {
  await withPathLock(storePath(), async () => {
    await saveStore({ runs: {} });
  });
}
