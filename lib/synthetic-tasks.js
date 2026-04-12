// @ts-check
/**
 * Phase 56.3: Synthetic task generator.
 *
 * Template-based synthesis of evaluation/training tasks with difficulty
 * grading. Each task has a shape:
 *   { id, template, difficulty, input, expected, metadata }
 *
 * Tasks are produced deterministically from a seed so the same (template,
 * difficulty, seed) triple always produces the same task. The difficulty
 * scale is 1 (easy) to 5 (very hard) and controls digit count, operation
 * count, and decomposition depth per template.
 *
 * Storage: JSON-backed via json-path-store so saved task sets persist across
 * restarts. No external dependencies.
 *
 * @module synthetic-tasks
 */

import { randomUUID } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const STORE_VERSION = 1;
const DIFFICULTIES = [1, 2, 3, 4, 5];

// ---------------------------------------------------------------------------
// Deterministic random (mulberry32)
// ---------------------------------------------------------------------------

/**
 * Create a seeded PRNG. Returns a function with helpers .int(), .pick(), .bool().
 * @param {number|string} seed
 */
export function seededRandom(seed) {
  let s;
  if (typeof seed === "string") {
    // FNV-1a-ish hash
    s = 2166136261 >>> 0;
    for (let i = 0; i < seed.length; i++) {
      s ^= seed.charCodeAt(i);
      s = Math.imul(s, 16777619) >>> 0;
    }
  } else if (Number.isFinite(seed)) {
    s = Math.floor(Number(seed)) >>> 0;
  } else {
    s = (Date.now() & 0xffffffff) >>> 0;
  }
  if (s === 0) s = 1;

  function next() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  const rng = next;
  rng.int = (min, max) => {
    const lo = Math.ceil(min);
    const hi = Math.floor(max);
    return Math.floor(next() * (hi - lo + 1)) + lo;
  };
  rng.pick = (arr) => arr[Math.floor(next() * arr.length)];
  rng.bool = () => next() < 0.5;
  rng.shuffle = (arr) => {
    const out = [...arr];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };
  return rng;
}

// ---------------------------------------------------------------------------
// Built-in templates
// ---------------------------------------------------------------------------

function clampDifficulty(d) {
  const n = Number(d);
  if (!Number.isFinite(n)) return 3;
  return Math.max(1, Math.min(5, Math.round(n)));
}

function digitsForDifficulty(d) {
  // Difficulty 1 -> 1 digit, 5 -> 5 digits
  return clampDifficulty(d);
}

const arithmeticTemplate = {
  name: "arithmetic",
  difficulties: DIFFICULTIES,
  generate(difficulty, rng) {
    const d = clampDifficulty(difficulty);
    const digits = digitsForDifficulty(d);
    const maxVal = Math.pow(10, digits) - 1;
    const minVal = d === 1 ? 0 : Math.pow(10, digits - 1);
    const opsPool = d <= 2 ? ["+", "-"] : d <= 3 ? ["+", "-", "*"] : ["+", "-", "*", "/"];
    const termCount = Math.min(2 + Math.floor((d - 1) / 2), 5); // 2..4

    const terms = [];
    const ops = [];
    for (let i = 0; i < termCount; i++) {
      terms.push(rng.int(minVal, maxVal));
      if (i < termCount - 1) ops.push(rng.pick(opsPool));
    }

    // Division: pick a divisor that divides the running value cleanly.
    const expr = [String(terms[0])];
    let value = terms[0];
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      let t = terms[i + 1];
      if (op === "/") {
        // Choose divisor in 2..9 that divides the running value.
        const candidates = [];
        for (let k = 2; k <= 9; k++) if (value % k === 0) candidates.push(k);
        t = candidates.length ? rng.pick(candidates) : 1;
        terms[i + 1] = t;
      }
      expr.push(op);
      expr.push(String(t));
      switch (op) {
        case "+": value = value + t; break;
        case "-": value = value - t; break;
        case "*": value = value * t; break;
        case "/": value = Math.trunc(value / t); break;
      }
    }
    const input = expr.join(" ");
    return {
      input: `Compute: ${input}`,
      expected: String(value),
      metadata: { operations: ops, termCount, digits },
    };
  },
};

const wordProblemTemplate = {
  name: "word_problem",
  difficulties: DIFFICULTIES,
  generate(difficulty, rng) {
    const d = clampDifficulty(difficulty);
    const items = ["apples", "oranges", "books", "pencils", "coins", "tokens"];
    const names = ["Alice", "Bob", "Carol", "Dan", "Eve", "Frank"];
    const steps = Math.min(1 + d, 5); // 2..5 ops
    const item = rng.pick(items);
    const owner = rng.pick(names);
    let total = rng.int(d * 3, d * 10);
    const narrative = [`${owner} has ${total} ${item}.`];
    for (let i = 0; i < steps; i++) {
      const op = rng.pick(d <= 2 ? ["gives", "buys"] : ["gives", "buys", "loses", "doubles"]);
      if (op === "doubles") {
        narrative.push(`Then ${owner} doubles their ${item}.`);
        total = total * 2;
      } else if (op === "gives") {
        const n = rng.int(1, Math.max(2, Math.floor(total / 2)));
        narrative.push(`Then ${owner} gives away ${n} ${item}.`);
        total = total - n;
      } else if (op === "buys") {
        const n = rng.int(1, d * 5);
        narrative.push(`Then ${owner} buys ${n} more ${item}.`);
        total = total + n;
      } else if (op === "loses") {
        const n = rng.int(1, Math.max(2, Math.floor(total / 3)));
        narrative.push(`Then ${owner} loses ${n} ${item}.`);
        total = total - n;
      }
    }
    narrative.push(`How many ${item} does ${owner} have now?`);
    return {
      input: narrative.join(" "),
      expected: String(total),
      metadata: { steps, item, owner },
    };
  },
};

const sequenceTemplate = {
  name: "sequence_completion",
  difficulties: DIFFICULTIES,
  generate(difficulty, rng) {
    const d = clampDifficulty(difficulty);
    const len = 4 + d; // 5..9
    const kinds = d <= 2 ? ["arithmetic"] : d <= 3 ? ["arithmetic", "geometric"] : ["arithmetic", "geometric", "fibonacci"];
    const kind = rng.pick(kinds);
    const seq = [];
    let next;
    if (kind === "arithmetic") {
      const start = rng.int(1, 9);
      const step = rng.int(1, d + 1);
      for (let i = 0; i < len; i++) seq.push(start + i * step);
      next = start + len * step;
    } else if (kind === "geometric") {
      const start = rng.int(1, 4);
      const ratio = rng.int(2, 3);
      let v = start;
      for (let i = 0; i < len; i++) {
        seq.push(v);
        v = v * ratio;
      }
      next = v;
    } else {
      let a = 1;
      let b = 1;
      seq.push(a, b);
      for (let i = 2; i < len; i++) {
        const c = a + b;
        seq.push(c);
        a = b;
        b = c;
      }
      next = a + b;
    }
    return {
      input: `Complete the sequence: ${seq.join(", ")}, ?`,
      expected: String(next),
      metadata: { kind, length: len },
    };
  },
};

const orderingTemplate = {
  name: "ordering",
  difficulties: DIFFICULTIES,
  generate(difficulty, rng) {
    const d = clampDifficulty(difficulty);
    const count = 3 + d * 2; // 5..13
    const maxVal = Math.pow(10, d);
    const nums = [];
    for (let i = 0; i < count; i++) nums.push(rng.int(0, maxVal));
    const direction = rng.bool() ? "ascending" : "descending";
    const sorted = [...nums].sort((a, b) => (direction === "ascending" ? a - b : b - a));
    return {
      input: `Sort in ${direction} order: ${nums.join(", ")}`,
      expected: sorted.join(", "),
      metadata: { count, direction },
    };
  },
};

const setOpsTemplate = {
  name: "set_operations",
  difficulties: DIFFICULTIES,
  generate(difficulty, rng) {
    const d = clampDifficulty(difficulty);
    const size = 2 + d; // 3..7
    const pool = [];
    for (let i = 1; i <= 20; i++) pool.push(i);
    const a = rng.shuffle(pool).slice(0, size);
    const b = rng.shuffle(pool).slice(0, size);
    const ops = d <= 2 ? ["union", "intersection"] : ["union", "intersection", "difference"];
    const op = rng.pick(ops);
    let result;
    const setA = new Set(a);
    const setB = new Set(b);
    if (op === "union") {
      result = [...new Set([...a, ...b])].sort((x, y) => x - y);
    } else if (op === "intersection") {
      result = a.filter((x) => setB.has(x)).sort((x, y) => x - y);
      result = [...new Set(result)];
    } else {
      result = a.filter((x) => !setB.has(x)).sort((x, y) => x - y);
      result = [...new Set(result)];
    }
    return {
      input: `Compute A ${op} B where A = {${a.join(", ")}}, B = {${b.join(", ")}}`,
      expected: `{${result.join(", ")}}`,
      metadata: { op, sizeA: a.length, sizeB: b.length },
    };
  },
};

const logicPuzzleTemplate = {
  name: "logic_puzzle",
  difficulties: DIFFICULTIES,
  generate(difficulty, rng) {
    const d = clampDifficulty(difficulty);
    const varCount = 1 + d; // 2..6
    const vars = ["x", "y", "z", "w", "v", "u"].slice(0, varCount);
    const values = vars.map(() => rng.int(1, 9));
    const clues = vars.map((v, i) => `${v} = ${values[i]}`);
    // Add some constraint clues for higher difficulty.
    for (let i = 1; i < Math.min(d, vars.length); i++) {
      const sum = values[0] + values[i];
      clues.push(`${vars[0]} + ${vars[i]} = ${sum}`);
    }
    const ask = rng.pick(vars);
    const askIdx = vars.indexOf(ask);
    return {
      input: `Given: ${rng.shuffle(clues).join("; ")}. What is ${ask}?`,
      expected: String(values[askIdx]),
      metadata: { variables: varCount, ask },
    };
  },
};

const stringManipulationTemplate = {
  name: "string_manipulation",
  difficulties: DIFFICULTIES,
  generate(difficulty, rng) {
    const d = clampDifficulty(difficulty);
    const words = ["cat", "dog", "fish", "bird", "tree", "stone", "river", "mountain"];
    const len = Math.min(1 + Math.floor(d / 2), 3);
    const src = [];
    for (let i = 0; i < len; i++) src.push(rng.pick(words));
    const text = src.join(" ");
    const ops = d <= 1 ? ["reverse"] : d <= 2 ? ["reverse", "upper"] : d <= 3 ? ["reverse", "upper", "replace"] : ["reverse", "upper", "replace", "concat"];
    const op = rng.pick(ops);
    let expected;
    let prompt;
    if (op === "reverse") {
      expected = text.split("").reverse().join("");
      prompt = `Reverse the string "${text}"`;
    } else if (op === "upper") {
      expected = text.toUpperCase();
      prompt = `Convert "${text}" to uppercase`;
    } else if (op === "replace") {
      const ch = text.includes("o") ? "o" : text[0];
      expected = text.split(ch).join("*");
      prompt = `Replace all "${ch}" with "*" in "${text}"`;
    } else {
      const other = rng.pick(words);
      expected = text + other;
      prompt = `Concatenate "${text}" and "${other}"`;
    }
    return {
      input: prompt,
      expected,
      metadata: { op, length: text.length },
    };
  },
};

const patternMatchingTemplate = {
  name: "pattern_matching",
  difficulties: DIFFICULTIES,
  generate(difficulty, rng) {
    const d = clampDifficulty(difficulty);
    const corpus = ["apple", "banana", "cherry", "date", "elder", "fig", "grape", "honey", "ivy"];
    const count = 3 + d;
    const list = [];
    for (let i = 0; i < count; i++) list.push(rng.pick(corpus));
    // Pick a letter present in at least one word
    const letters = list.flatMap((w) => w.split(""));
    const letter = letters.length ? rng.pick(letters) : "a";
    const matches = list.filter((w) => w.includes(letter));
    const expected = matches.join(", ");
    return {
      input: `From [${list.join(", ")}], list words containing "${letter}".`,
      expected,
      metadata: { letter, matchCount: matches.length, listSize: list.length },
    };
  },
};

/**
 * Built-in templates table.
 * @type {Record<string, {name: string, difficulties: number[], generate: (d:number, rng:any) => {input:string, expected:string, metadata?:object}}>}
 */
export const TASK_TEMPLATES = {
  arithmetic: arithmeticTemplate,
  word_problem: wordProblemTemplate,
  sequence_completion: sequenceTemplate,
  ordering: orderingTemplate,
  set_operations: setOpsTemplate,
  logic_puzzle: logicPuzzleTemplate,
  string_manipulation: stringManipulationTemplate,
  pattern_matching: patternMatchingTemplate,
};

// ---------------------------------------------------------------------------
// Registration / listing
// ---------------------------------------------------------------------------

/**
 * Register a custom template. Overwrites an existing name.
 * @param {string} name
 * @param {{ difficulties?: number[], generate: Function }} template
 */
export function registerTemplate(name, template) {
  if (!name || typeof name !== "string") {
    throw new Error("template name is required");
  }
  if (!template || typeof template.generate !== "function") {
    throw new Error("template must have a generate() function");
  }
  TASK_TEMPLATES[name] = {
    name,
    difficulties: Array.isArray(template.difficulties) ? template.difficulties : DIFFICULTIES,
    generate: template.generate,
  };
  return TASK_TEMPLATES[name];
}

/**
 * List all registered template names with their supported difficulties.
 * @returns {Array<{ name: string, difficulties: number[] }>}
 */
export function listTemplates() {
  return Object.entries(TASK_TEMPLATES).map(([name, t]) => ({
    name,
    difficulties: Array.isArray(t.difficulties) ? [...t.difficulties] : DIFFICULTIES,
  }));
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/**
 * Generate a single task.
 * @param {string} templateName
 * @param {number} [difficulty=3]
 * @param {{ seed?: number|string }} [options]
 * @returns {Promise<{ id: string, template: string, difficulty: number, input: string, expected: string, metadata: object }>}
 */
export async function generateTask(templateName, difficulty = 3, options = {}) {
  const t = TASK_TEMPLATES[templateName];
  if (!t) throw new Error(`Unknown template: ${templateName}`);
  const d = clampDifficulty(difficulty);
  const seed = options && options.seed !== undefined ? options.seed : randomUUID();
  const rng = seededRandom(seed);
  const produced = t.generate(d, rng);
  if (!produced || typeof produced.input !== "string" || typeof produced.expected !== "string") {
    throw new Error(`Template '${templateName}' produced invalid output`);
  }
  return {
    id: typeof options.id === "string" && options.id ? options.id : randomUUID(),
    template: templateName,
    difficulty: d,
    input: produced.input,
    expected: produced.expected,
    metadata: {
      ...(produced.metadata || {}),
      seed: typeof seed === "number" || typeof seed === "string" ? seed : null,
      generatedAt: Date.now(),
    },
  };
}

/**
 * Generate a batch of tasks.
 * @param {number} count
 * @param {{ templates?: string[], minDifficulty?: number, maxDifficulty?: number, seed?: number|string }} [options]
 */
export async function generateBatch(count, options = {}) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  if (n === 0) return [];
  const pool = Array.isArray(options.templates) && options.templates.length
    ? options.templates.filter((name) => TASK_TEMPLATES[name])
    : Object.keys(TASK_TEMPLATES);
  if (!pool.length) throw new Error("No templates available for batch generation");
  const minD = clampDifficulty(options.minDifficulty ?? 1);
  const maxD = clampDifficulty(options.maxDifficulty ?? 5);
  const lo = Math.min(minD, maxD);
  const hi = Math.max(minD, maxD);
  const baseSeed = options.seed !== undefined ? options.seed : randomUUID();
  const rng = seededRandom(baseSeed);
  const tasks = [];
  for (let i = 0; i < n; i++) {
    const tpl = rng.pick(pool);
    const diff = rng.int(lo, hi);
    // Use the outer rng to derive a per-task seed so batches stay reproducible.
    const subSeed = rng.int(0, 0x7fffffff);
    const task = await generateTask(tpl, diff, { seed: subSeed });
    tasks.push(task);
  }
  return tasks;
}

// ---------------------------------------------------------------------------
// Difficulty estimation and grading
// ---------------------------------------------------------------------------

/**
 * Estimate difficulty 1..5 from a task's shape (heuristic).
 * @param {{ input?: string, expected?: string, metadata?: object }} task
 */
export function estimateDifficulty(task) {
  if (!task || typeof task !== "object") return 3;
  const input = typeof task.input === "string" ? task.input : "";
  const meta = task.metadata && typeof task.metadata === "object" ? task.metadata : {};
  let score = 0;
  // Input length bucket.
  if (input.length > 200) score += 2;
  else if (input.length > 80) score += 1;
  // Operation count.
  const ops = Array.isArray(meta.operations) ? meta.operations.length : 0;
  if (ops >= 4) score += 2;
  else if (ops >= 2) score += 1;
  // Step count for word problems.
  const steps = Number(meta.steps) || 0;
  if (steps >= 4) score += 2;
  else if (steps >= 2) score += 1;
  // Digit count.
  const digits = Number(meta.digits) || 0;
  if (digits >= 4) score += 1;
  // Set / list size.
  const size = Number(meta.count || meta.length || meta.listSize || 0);
  if (size >= 10) score += 1;
  // Decomposition: count clauses via sentence / semicolon count.
  const clauses = (input.match(/[.;]/g) || []).length;
  if (clauses >= 4) score += 1;
  const normalized = Math.min(5, Math.max(1, 1 + Math.round(score * 0.7)));
  return normalized;
}

/**
 * Grade a difficulty into an expected solve-time budget (ms).
 * @param {number} difficulty
 */
export function gradeByExpectedTime(difficulty) {
  const d = clampDifficulty(difficulty);
  // Roughly doubles per level: 500ms at d=1, up to ~8s at d=5.
  return 500 * Math.pow(2, d - 1);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate a task shape. Returns { ok, errors[] }.
 */
export function validateTask(task) {
  const errors = [];
  if (!task || typeof task !== "object") {
    return { ok: false, errors: ["task must be an object"] };
  }
  if (!task.id || typeof task.id !== "string") errors.push("id is required");
  if (!task.template || typeof task.template !== "string") errors.push("template is required");
  const d = Number(task.difficulty);
  if (!Number.isFinite(d) || d < 1 || d > 5) errors.push("difficulty must be 1..5");
  if (typeof task.input !== "string" || !task.input) errors.push("input must be non-empty string");
  if (typeof task.expected !== "string") errors.push("expected must be a string");
  if (task.metadata !== undefined && (task.metadata === null || typeof task.metadata !== "object" || Array.isArray(task.metadata))) {
    errors.push("metadata must be an object");
  }
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

/**
 * @param {Array} tasks
 * @param {number} [min]
 * @param {number} [max]
 */
export function filterByDifficulty(tasks, min, max) {
  if (!Array.isArray(tasks)) return [];
  const lo = clampDifficulty(min ?? 1);
  const hi = clampDifficulty(max ?? 5);
  const a = Math.min(lo, hi);
  const b = Math.max(lo, hi);
  return tasks.filter((t) => {
    const d = Number(t?.difficulty);
    return Number.isFinite(d) && d >= a && d <= b;
  });
}

/**
 * @param {Array} tasks
 * @param {string[]} templates
 */
export function filterByTemplate(tasks, templates) {
  if (!Array.isArray(tasks)) return [];
  if (!Array.isArray(templates) || templates.length === 0) return [...tasks];
  const allowed = new Set(templates);
  return tasks.filter((t) => allowed.has(t?.template));
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function storePath() {
  return join(getDataDir(), "synthetic-task-sets.json");
}

function normalizeStore(raw) {
  const base = raw && typeof raw === "object" ? raw : {};
  return {
    _version: STORE_VERSION,
    sets: base.sets && typeof base.sets === "object" ? base.sets : {},
  };
}

async function loadStore() {
  return normalizeStore(await readJsonPath(storePath(), { _version: STORE_VERSION, sets: {} }));
}

async function saveStore(store) {
  await writeJsonPath(storePath(), store);
}

/**
 * Persist a named task set.
 * @param {string} name
 * @param {Array} tasks
 * @param {{ workspaceId?: string, description?: string }} [meta]
 */
export async function saveTaskSet(name, tasks, meta = {}) {
  if (!name || typeof name !== "string") throw new Error("name is required");
  if (!Array.isArray(tasks)) throw new Error("tasks must be an array");
  for (const task of tasks) {
    const { ok, errors } = validateTask(task);
    if (!ok) throw new Error(`invalid task in set: ${errors.join("; ")}`);
  }
  return withPathLock(storePath(), async () => {
    const store = await loadStore();
    store.sets[name] = {
      name,
      workspaceId: meta.workspaceId || "default",
      description: typeof meta.description === "string" ? meta.description : "",
      tasks,
      savedAt: Date.now(),
    };
    await saveStore(store);
    return store.sets[name];
  });
}

/**
 * Retrieve a saved task set by name.
 * @param {string} name
 */
export async function getTaskSet(name) {
  if (!name || typeof name !== "string") return null;
  const store = await loadStore();
  return store.sets[name] || null;
}

/**
 * List all saved task sets (without the full tasks array in each summary).
 * @param {string|null} [workspaceId]
 */
export async function listTaskSets(workspaceId = null) {
  const store = await loadStore();
  const all = Object.values(store.sets);
  const filtered = workspaceId ? all.filter((s) => s.workspaceId === workspaceId) : all;
  return filtered.map((s) => ({
    name: s.name,
    workspaceId: s.workspaceId,
    description: s.description,
    savedAt: s.savedAt,
    taskCount: Array.isArray(s.tasks) ? s.tasks.length : 0,
  }));
}

export const _internals = {
  clampDifficulty,
  digitsForDifficulty,
  storePath,
};
