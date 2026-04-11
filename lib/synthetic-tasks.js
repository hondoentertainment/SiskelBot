// @ts-check
/**
 * Phase 56.3: Synthetic tasks.
 *
 * Generates task sets of varying difficulty suitable for training and
 * evaluation. The module ships with deterministic built-in generators
 * (arithmetic, string manipulation, logic puzzles) so tests pass
 * without a live LLM. A custom generator can be injected for LLM-backed
 * task synthesis.
 *
 * Difficulty is a discrete scale 1..5 with configurable difficulty
 * sampling distributions; each task carries a numeric `difficulty`
 * score used by `sampleDifficulty()` to model the task curve.
 *
 * Exports:
 *   - generateTaskSet(opts)
 *   - gradeTask(taskId, response)
 *   - listTaskSets()
 *   - getTaskSet(id)
 *   - sampleDifficulty(opts)
 *   - setGenerator(fn)
 *
 * @module synthetic-tasks
 */
import { join } from "path";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;
const MIN_DIFFICULTY = 1;
const MAX_DIFFICULTY = 5;

function storePath() {
  return join(getDataDir(), "synthetic-tasks.json");
}

function now() {
  return new Date().toISOString();
}

function randomId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/* -------------------------------------------------------------------------- */
/* Seeded RNG                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Deterministic LCG so task generation is reproducible from a seed.
 * @param {number} seed
 */
function makeRng(seed) {
  let state = Math.abs(Math.floor(seed)) || 1;
  return function next() {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

function pickInt(rng, lo, hi) {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

/* -------------------------------------------------------------------------- */
/* Built-in task generators                                                   */
/* -------------------------------------------------------------------------- */

function genArithmetic(difficulty, rng) {
  const range = [10, 50, 200, 1000, 10000][difficulty - 1] || 10;
  const terms = Math.min(5, 1 + difficulty);
  const nums = [];
  for (let i = 0; i < terms; i++) nums.push(pickInt(rng, 1, range));
  const op = difficulty <= 2 ? "+" : difficulty === 3 ? (rng() > 0.5 ? "+" : "-") : "*";
  let expected;
  let expr;
  if (op === "+") {
    expected = nums.reduce((a, b) => a + b, 0);
    expr = nums.join(" + ");
  } else if (op === "-") {
    expected = nums.reduce((a, b) => a - b);
    expr = nums.join(" - ");
  } else {
    expected = nums.reduce((a, b) => a * b, 1);
    expr = nums.join(" * ");
  }
  return {
    prompt: `Compute: ${expr}`,
    expected: String(expected),
    grader: "numeric",
    skill: "arithmetic",
  };
}

function genString(difficulty, rng) {
  const words = ["alpha", "beta", "gamma", "delta", "omega", "sigma"];
  const count = Math.min(words.length, 1 + difficulty);
  const picks = [];
  for (let i = 0; i < count; i++) picks.push(words[pickInt(rng, 0, words.length - 1)]);
  if (difficulty <= 2) {
    return { prompt: `Reverse the word: ${picks[0]}`, expected: picks[0].split("").reverse().join(""), grader: "exact", skill: "string" };
  }
  if (difficulty === 3) {
    return { prompt: `Uppercase: ${picks.join(" ")}`, expected: picks.join(" ").toUpperCase(), grader: "exact", skill: "string" };
  }
  // 4-5: sort
  const sorted = picks.slice().sort();
  return { prompt: `Sort alphabetically: ${picks.join(", ")}`, expected: sorted.join(", "), grader: "exact", skill: "string" };
}

function genLogic(difficulty, rng) {
  // Simple parity / comparison puzzles.
  const a = pickInt(rng, 1, 100);
  const b = pickInt(rng, 1, 100);
  if (difficulty <= 2) {
    return { prompt: `Is ${a} even? Answer yes or no.`, expected: a % 2 === 0 ? "yes" : "no", grader: "exact", skill: "logic" };
  }
  if (difficulty === 3) {
    return { prompt: `Which is larger, ${a} or ${b}? Answer with the number.`, expected: String(Math.max(a, b)), grader: "exact", skill: "logic" };
  }
  // 4-5: composite
  const c = pickInt(rng, 1, 50);
  return { prompt: `Is (${a} + ${b}) greater than ${c * 5}? Answer yes or no.`, expected: (a + b) > (c * 5) ? "yes" : "no", grader: "exact", skill: "logic" };
}

const BUILTIN_GENERATORS = {
  arithmetic: genArithmetic,
  string: genString,
  logic: genLogic,
};

/** @type {((opts: any) => any) | null} */
let _customGenerator = null;

/**
 * Install an external generator (e.g., LLM-backed). Receives opts
 * `{difficulty, skill, rng}` and returns `{prompt, expected, grader, skill}`.
 * @param {((opts: any) => any) | null} fn
 */
export function setGenerator(fn) {
  if (fn === null) {
    _customGenerator = null;
    return;
  }
  if (typeof fn !== "function") throw new Error("generator must be a function");
  _customGenerator = fn;
}

/* -------------------------------------------------------------------------- */
/* Difficulty sampling                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Sample a difficulty from 1..5 given an optional target mean.
 * The target mean directly sets the expected value of the sample
 * using a small additive-noise model:   d ≈ target + N(0, 0.6)
 * rounded and clamped. A uniform draw outside the [-0.5, 0.5] range
 * gives the desired spread around the mean.
 * @param {object} [opts]
 */
export function sampleDifficulty(opts = {}) {
  const target = Number.isFinite(opts?.targetMean)
    ? Math.max(MIN_DIFFICULTY, Math.min(MAX_DIFFICULTY, opts.targetMean))
    : 3;
  const rng = typeof opts?.rng === "function" ? opts.rng : Math.random;
  // Sum of two uniforms for a triangular distribution centered at target.
  const u = rng();
  const v = rng();
  const noise = (u + v - 1); // mean 0, range [-1, 1]
  const raw = target + noise * 1.5;
  const d = Math.round(raw);
  return Math.max(MIN_DIFFICULTY, Math.min(MAX_DIFFICULTY, d));
}

/* -------------------------------------------------------------------------- */
/* Store                                                                      */
/* -------------------------------------------------------------------------- */

async function loadStore() {
  const raw = await readJsonPath(storePath(), { version: STORE_VERSION, taskSets: {} });
  if (!raw || typeof raw !== "object") return { version: STORE_VERSION, taskSets: {} };
  if (!raw.taskSets || typeof raw.taskSets !== "object") raw.taskSets = {};
  raw.version = STORE_VERSION;
  return raw;
}

async function saveStore(store) {
  await writeJsonPath(storePath(), { version: STORE_VERSION, taskSets: store.taskSets || {} });
}

/* -------------------------------------------------------------------------- */
/* Generation                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Generate and persist a task set.
 * @param {object} [opts]
 */
export async function generateTaskSet(opts = {}) {
  const count = Number.isFinite(opts?.count) && opts.count > 0 ? Math.min(500, Math.floor(opts.count)) : 10;
  const seed = Number.isFinite(opts?.seed) ? opts.seed : Date.now() & 0x7fffffff;
  const skills = Array.isArray(opts?.skills) && opts.skills.length > 0 ? opts.skills : ["arithmetic", "string", "logic"];
  const name = typeof opts?.name === "string" && opts.name.trim() ? opts.name.trim() : `set-${seed}`;
  const targetMean = Number.isFinite(opts?.targetDifficulty) ? opts.targetDifficulty : 3;
  const rng = makeRng(seed);

  const tasks = [];
  for (let i = 0; i < count; i++) {
    const skill = skills[pickInt(rng, 0, skills.length - 1)];
    const difficulty = sampleDifficulty({ targetMean, rng });
    let item;
    if (_customGenerator) {
      try {
        item = await _customGenerator({ difficulty, skill, rng });
      } catch (err) {
        item = null;
      }
    }
    if (!item) {
      const gen = BUILTIN_GENERATORS[skill] || genArithmetic;
      item = gen(difficulty, rng);
    }
    tasks.push({
      id: randomId("task"),
      prompt: String(item.prompt || ""),
      expected: String(item.expected || ""),
      grader: item.grader || "exact",
      skill: item.skill || skill,
      difficulty,
    });
  }

  const avgDifficulty = tasks.length > 0
    ? Math.round((tasks.reduce((a, b) => a + b.difficulty, 0) / tasks.length) * 100) / 100
    : 0;
  const record = {
    id: randomId("tset"),
    name,
    seed,
    count: tasks.length,
    avgDifficulty,
    tasks,
    createdAt: now(),
    version: 1,
  };

  await withPathLock(storePath(), async () => {
    const store = await loadStore();
    store.taskSets[record.id] = record;
    await saveStore(store);
  });

  return record;
}

/**
 * Grade a single task by id (set scan).
 * @param {string} taskId
 * @param {string} response
 */
export async function gradeTask(taskId, response) {
  if (!taskId || typeof taskId !== "string") throw new Error("taskId is required");
  const store = await loadStore();
  /** @type {any} */
  let task = null;
  /** @type {any} */
  let set = null;
  for (const s of Object.values(store.taskSets || {})) {
    const hit = (s && Array.isArray(s.tasks)) ? s.tasks.find((t) => t.id === taskId) : null;
    if (hit) {
      task = hit;
      set = s;
      break;
    }
  }
  if (!task) throw new Error(`task "${taskId}" not found`);
  const resp = String(response || "");
  const grader = task.grader || "exact";
  let correct = false;
  if (grader === "numeric") {
    const n = parseFloat(resp.replace(/[^0-9.\-]/g, ""));
    const want = parseFloat(task.expected);
    correct = Number.isFinite(n) && Number.isFinite(want) && Math.abs(n - want) < 1e-6;
  } else if (grader === "contains") {
    correct = resp.toLowerCase().includes(String(task.expected).toLowerCase());
  } else {
    correct = resp.trim().toLowerCase() === String(task.expected).trim().toLowerCase();
  }
  return {
    taskId,
    taskSetId: set?.id || null,
    difficulty: task.difficulty,
    skill: task.skill,
    correct,
    expected: task.expected,
    response: resp,
  };
}

/** List all persisted task sets (metadata, not tasks). */
export async function listTaskSets() {
  const store = await loadStore();
  return Object.values(store.taskSets || {}).map((s) => ({
    id: s.id,
    name: s.name,
    count: s.count,
    avgDifficulty: s.avgDifficulty,
    seed: s.seed,
    createdAt: s.createdAt,
  }));
}

/** Fetch a single task set (with tasks). */
export async function getTaskSet(id) {
  if (!id || typeof id !== "string") return null;
  const store = await loadStore();
  return store.taskSets[id] || null;
}
