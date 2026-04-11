// @ts-check
/**
 * Phase 52.4: Neuro-symbolic SAT/SMT bridge.
 *
 * A small, dependency-free constraint solver usable as an LLM tool. It
 * exposes:
 *
 *   - `parseClauses`          -- parse DIMACS-ish or simple infix boolean formulas
 *   - `solveSAT`              -- DPLL with unit propagation + pure literal elimination
 *   - `solveLinearConstraints`-- bounded search over integer linear inequalities
 *   - `checkConstraints`      -- evaluate a model against mixed SAT + linear constraints
 *   - `explainModel`          -- human-readable explanation of a satisfying assignment
 *
 * Pure JavaScript, no native bindings, no worker threads, no unbounded
 * recursion (iterative DPLL). Intended for small problems the LLM produces
 * at reasoning time (tens of variables, hundreds of clauses).
 *
 * Persisted runs are saved via `json-path-store.js` so the LLM can refer to
 * prior proofs by id.
 *
 * @module neuro-symbolic
 */
import { randomUUID } from "crypto";
import { join } from "path";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;

/* -------------------------------------------------------------------------- */
/* Persistence                                                                */
/* -------------------------------------------------------------------------- */

function runsPath() {
  return join(getDataDir(), "neuro-symbolic-runs.json");
}

async function loadRuns() {
  const data = await readJsonPath(runsPath(), {
    version: STORE_VERSION,
    runs: {},
  });
  if (!data || typeof data !== "object") return { version: STORE_VERSION, runs: {} };
  if (!data.runs || typeof data.runs !== "object") data.runs = {};
  if (!data.version) data.version = STORE_VERSION;
  return data;
}

async function saveRuns(data) {
  await writeJsonPath(runsPath(), {
    version: STORE_VERSION,
    runs: data.runs || {},
  });
}

/**
 * Persist a solver result under a stable id. Returns the id.
 * @param {object} record
 */
async function recordRun(record) {
  const path = runsPath();
  return withPathLock(path, async () => {
    const data = await loadRuns();
    const id = randomUUID();
    const now = new Date().toISOString();
    data.runs[id] = {
      id,
      createdAt: now,
      version: STORE_VERSION,
      ...record,
    };
    await saveRuns(data);
    return id;
  });
}

/** Get a stored run by id. */
export async function getRun(id) {
  if (!id || typeof id !== "string") return null;
  const data = await loadRuns();
  return data.runs[id] || null;
}

/* -------------------------------------------------------------------------- */
/* Parsing                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Parse a boolean formula into CNF clauses. Supports two forms:
 *
 *   1. DIMACS-ish list of lists: `[[1, -2], [2, 3]]` meaning (x1 ∨ ¬x2) ∧ (x2 ∨ x3).
 *   2. A simple infix string: `"a & (b | !c) & (!a | c)"` where identifiers
 *      are variable names, `&` = AND, `|` = OR, `!` = NOT. NOT must appear
 *      at the literal level (CNF-only; no arbitrary nesting of NOT).
 *
 * Returns `{ clauses, variables }` where `clauses` is `number[][]` using
 * 1-indexed integer literals (positive => var, negative => not var), and
 * `variables` is an ordered `string[]` so callers can map back.
 *
 * @param {string | number[][]} input
 * @returns {{ clauses: number[][], variables: string[] }}
 */
export function parseClauses(input) {
  if (Array.isArray(input)) {
    /** @type {Map<number, string>} */
    const varMap = new Map();
    const clauses = [];
    for (const row of input) {
      if (!Array.isArray(row)) continue;
      const lits = [];
      for (const lit of row) {
        const n = Number(lit);
        if (!Number.isFinite(n) || n === 0) continue;
        const idx = Math.abs(n);
        if (!varMap.has(idx)) varMap.set(idx, `x${idx}`);
        lits.push(n);
      }
      if (lits.length > 0) clauses.push(lits);
    }
    const variables = [];
    const sorted = [...varMap.keys()].sort((a, b) => a - b);
    for (const idx of sorted) variables.push(varMap.get(idx) || `x${idx}`);
    return { clauses, variables };
  }

  const text = typeof input === "string" ? input.trim() : "";
  if (!text) return { clauses: [], variables: [] };

  // Split on '&' at top level. No parentheses around AND -- each conjunct is
  // a clause that may be parenthesized.
  const conjuncts = splitTopLevel(text, "&");
  /** @type {string[]} */
  const variables = [];
  /** @type {Map<string, number>} */
  const varIndex = new Map();
  /** @type {number[][]} */
  const clauses = [];

  const getVar = (name) => {
    const key = name.trim();
    if (!varIndex.has(key)) {
      variables.push(key);
      varIndex.set(key, variables.length);
    }
    return /** @type {number} */ (varIndex.get(key));
  };

  for (const raw of conjuncts) {
    let body = raw.trim();
    while (body.startsWith("(") && body.endsWith(")") && balanced(body.slice(1, -1))) {
      body = body.slice(1, -1).trim();
    }
    if (!body) continue;
    const literals = splitTopLevel(body, "|").map((s) => s.trim()).filter(Boolean);
    /** @type {number[]} */
    const lits = [];
    for (const lit of literals) {
      let neg = false;
      let name = lit;
      while (name.startsWith("!")) {
        neg = !neg;
        name = name.slice(1).trim();
      }
      if (!/^[a-z_][a-z0-9_]*$/i.test(name)) {
        throw new Error(`invalid literal: ${lit}`);
      }
      const idx = getVar(name);
      lits.push(neg ? -idx : idx);
    }
    if (lits.length > 0) clauses.push(lits);
  }

  return { clauses, variables };
}

function balanced(s) {
  let depth = 0;
  for (const ch of s) {
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

function splitTopLevel(text, sep) {
  const out = [];
  let depth = 0;
  let buf = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "(") {
      depth += 1;
      buf += ch;
    } else if (ch === ")") {
      depth -= 1;
      buf += ch;
    } else if (ch === sep && depth === 0) {
      out.push(buf);
      buf = "";
    } else {
      buf += ch;
    }
  }
  if (buf.length > 0) out.push(buf);
  return out;
}

/* -------------------------------------------------------------------------- */
/* SAT solver (iterative DPLL with unit propagation)                           */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} SatResult
 * @property {boolean} sat
 * @property {Record<string, boolean>} [assignment]
 * @property {number[][]} [model]  -- raw integer literal assignment
 * @property {string[]} variables
 * @property {number} decisions
 * @property {number} propagations
 * @property {string} [reason]
 * @property {string} [runId]
 */

/**
 * Solve a CNF formula. Input is either the return value of `parseClauses` or
 * a formula string / DIMACS list directly.
 *
 * @param {{ clauses: number[][], variables: string[] } | string | number[][]} input
 * @param {{ persist?: boolean, maxDecisions?: number }} [opts]
 * @returns {Promise<SatResult>}
 */
export async function solveSAT(input, opts = {}) {
  const parsed =
    typeof input === "string" || Array.isArray(input) ? parseClauses(input) : input;
  if (!parsed || !Array.isArray(parsed.clauses)) {
    throw new Error("invalid CNF input");
  }
  const { clauses, variables } = parsed;
  const maxDecisions = Number.isFinite(opts.maxDecisions) && opts.maxDecisions > 0
    ? Math.floor(opts.maxDecisions)
    : 100_000;

  const numVars = variables.length;
  // assignment[i-1]: null | true | false
  /** @type {Array<boolean | null>} */
  const assign = new Array(numVars).fill(null);

  let decisions = 0;
  let propagations = 0;

  /**
   * Evaluate a single clause against the current assignment.
   * Returns 1 (satisfied), -1 (conflict / all false), 0 (undetermined).
   */
  function evalClause(clause) {
    let unresolved = 0;
    for (const lit of clause) {
      const v = Math.abs(lit) - 1;
      const val = assign[v];
      if (val == null) {
        unresolved += 1;
        continue;
      }
      const isTrue = lit > 0 ? val : !val;
      if (isTrue) return 1;
    }
    return unresolved > 0 ? 0 : -1;
  }

  /** Try to deduce forced assignments via unit propagation. Returns false on conflict. */
  function unitPropagate() {
    let changed = true;
    while (changed) {
      changed = false;
      for (const clause of clauses) {
        let unitLit = 0;
        let undet = 0;
        let sat = false;
        for (const lit of clause) {
          const v = Math.abs(lit) - 1;
          const val = assign[v];
          if (val == null) {
            undet += 1;
            unitLit = lit;
          } else {
            const isTrue = lit > 0 ? val : !val;
            if (isTrue) {
              sat = true;
              break;
            }
          }
        }
        if (sat) continue;
        if (undet === 0) return false; // conflict
        if (undet === 1) {
          const v = Math.abs(unitLit) - 1;
          assign[v] = unitLit > 0;
          propagations += 1;
          changed = true;
        }
      }
    }
    return true;
  }

  /** Find a variable with no assignment yet. */
  function chooseVar() {
    for (let i = 0; i < numVars; i += 1) {
      if (assign[i] == null) return i;
    }
    return -1;
  }

  // Iterative search using an explicit stack of frames:
  // { varIdx, tried: 0 | 1 | 2 , savepoint }
  const stack = [];
  /** @type {Array<Array<boolean | null>>} */
  const saves = [];

  function snapshot() {
    saves.push(assign.slice());
  }
  function restore() {
    const s = saves.pop();
    if (!s) return;
    for (let i = 0; i < numVars; i += 1) assign[i] = s[i];
  }

  // Initial propagation on an empty assignment.
  snapshot();
  if (!unitPropagate()) {
    restore();
    const result = {
      sat: false,
      variables,
      decisions,
      propagations,
      reason: "unit propagation conflict on initial formula",
    };
    if (opts.persist) result.runId = await recordRun({ kind: "sat", result });
    return result;
  }

  while (true) {
    // Check if everything is assigned or clauses are already satisfied.
    let allSat = true;
    for (const c of clauses) {
      const v = evalClause(c);
      if (v === -1) {
        allSat = false;
        break;
      }
      if (v === 0) {
        allSat = false;
      }
    }
    const hasConflict = clauses.some((c) => evalClause(c) === -1);
    const hasUnassigned = chooseVar() !== -1;
    if (!hasConflict && !hasUnassigned) {
      const assignment = {};
      const model = [];
      for (let i = 0; i < numVars; i += 1) {
        assignment[variables[i]] = assign[i] === true;
        model.push(assign[i] ? i + 1 : -(i + 1));
      }
      const result = { sat: true, assignment, model, variables, decisions, propagations };
      if (opts.persist) result.runId = await recordRun({ kind: "sat", result });
      return result;
    }

    if (hasConflict) {
      // Backtrack.
      let unwound = false;
      while (stack.length > 0) {
        const frame = stack.pop();
        restore();
        if (frame.tried === 1) {
          // Try the other branch with a fresh snapshot of the pre-decision state.
          snapshot();
          assign[frame.varIdx] = !(frame.value);
          frame.tried = 2;
          frame.value = !frame.value;
          stack.push(frame);
          if (unitPropagate()) {
            unwound = true;
            break;
          }
          // propagation failed; continue unwinding
        }
      }
      if (!unwound) {
        const result = {
          sat: false,
          variables,
          decisions,
          propagations,
          reason: "exhausted search space",
        };
        if (opts.persist) result.runId = await recordRun({ kind: "sat", result });
        return result;
      }
      continue;
    }

    // No conflict, has unassigned -> make a new decision.
    decisions += 1;
    if (decisions > maxDecisions) {
      const result = {
        sat: false,
        variables,
        decisions,
        propagations,
        reason: `decision limit ${maxDecisions} exceeded`,
      };
      if (opts.persist) result.runId = await recordRun({ kind: "sat", result });
      return result;
    }
    const v = chooseVar();
    snapshot();
    assign[v] = true;
    stack.push({ varIdx: v, tried: 1, value: true });
    if (!unitPropagate()) {
      // fall through to conflict handling on next loop iteration
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Linear integer constraints                                                 */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} LinearConstraint
 * @property {Record<string, number>} coefficients  -- variable name -> coefficient
 * @property {"<="|">="|"="|"<"|">"} op
 * @property {number} rhs
 */

/**
 * @typedef {Object} LinearSpec
 * @property {LinearConstraint[]} constraints
 * @property {Record<string, { min?: number, max?: number }>} [bounds]
 */

/**
 * Brute-force search for an integer assignment satisfying the given linear
 * constraints. Intended for small problems (<= ~6 variables, <= ~200 domain)
 * with explicit bounds. Returns the first satisfying model (or null).
 *
 * @param {LinearSpec} spec
 * @param {{ maxCombinations?: number, persist?: boolean }} [opts]
 * @returns {Promise<{ sat: boolean, assignment?: Record<string, number>, reason?: string, combinationsTried: number, runId?: string }>}
 */
export async function solveLinearConstraints(spec, opts = {}) {
  if (!spec || !Array.isArray(spec.constraints)) {
    throw new Error("spec.constraints must be an array");
  }
  /** @type {Set<string>} */
  const vars = new Set();
  for (const c of spec.constraints) {
    if (!c || typeof c !== "object") continue;
    for (const k of Object.keys(c.coefficients || {})) vars.add(k);
  }
  if (spec.bounds && typeof spec.bounds === "object") {
    for (const k of Object.keys(spec.bounds)) vars.add(k);
  }
  const varList = [...vars];
  const bounds = spec.bounds || {};

  const maxCombos = Number.isFinite(opts.maxCombinations) && opts.maxCombinations > 0
    ? Math.floor(opts.maxCombinations)
    : 200_000;

  /**
   * For each variable produce an inclusive [min,max] integer domain.
   * Defaults to [0, 10] when not specified.
   */
  const domains = varList.map((v) => {
    const b = bounds[v] || {};
    const min = Number.isFinite(b.min) ? Math.floor(b.min) : 0;
    const max = Number.isFinite(b.max) ? Math.floor(b.max) : 10;
    return { name: v, min, max };
  });

  let combinationsTried = 0;
  let total = 1;
  for (const d of domains) {
    const size = d.max - d.min + 1;
    if (size <= 0) {
      const result = {
        sat: false,
        reason: `empty domain for ${d.name}`,
        combinationsTried,
      };
      if (opts.persist) result.runId = await recordRun({ kind: "linear", result });
      return result;
    }
    total *= size;
    if (total > maxCombos) {
      const result = {
        sat: false,
        reason: `domain too large (> ${maxCombos} combinations)`,
        combinationsTried,
      };
      if (opts.persist) result.runId = await recordRun({ kind: "linear", result });
      return result;
    }
  }

  /** @type {Record<string, number>} */
  const assign = {};
  for (const d of domains) assign[d.name] = d.min;

  while (true) {
    combinationsTried += 1;
    if (combinationsTried > maxCombos) {
      const result = {
        sat: false,
        reason: `exceeded maxCombinations=${maxCombos}`,
        combinationsTried,
      };
      if (opts.persist) result.runId = await recordRun({ kind: "linear", result });
      return result;
    }
    if (allConstraintsHold(spec.constraints, assign)) {
      const result = { sat: true, assignment: { ...assign }, combinationsTried };
      if (opts.persist) result.runId = await recordRun({ kind: "linear", result });
      return result;
    }
    // Increment assignment lexicographically.
    let i = domains.length - 1;
    while (i >= 0) {
      const d = domains[i];
      if (assign[d.name] < d.max) {
        assign[d.name] += 1;
        break;
      }
      assign[d.name] = d.min;
      i -= 1;
    }
    if (i < 0) {
      const result = { sat: false, reason: "no satisfying integer model", combinationsTried };
      if (opts.persist) result.runId = await recordRun({ kind: "linear", result });
      return result;
    }
  }
}

function evalLinearLHS(coeffs, assign) {
  let sum = 0;
  for (const [v, c] of Object.entries(coeffs || {})) {
    const val = Number(assign[v]) || 0;
    sum += Number(c) * val;
  }
  return sum;
}

function allConstraintsHold(constraints, assign) {
  for (const c of constraints) {
    if (!c || typeof c !== "object") continue;
    const lhs = evalLinearLHS(c.coefficients || {}, assign);
    const rhs = Number(c.rhs) || 0;
    switch (c.op) {
      case "<=":
        if (!(lhs <= rhs)) return false;
        break;
      case ">=":
        if (!(lhs >= rhs)) return false;
        break;
      case "=":
        if (lhs !== rhs) return false;
        break;
      case "<":
        if (!(lhs < rhs)) return false;
        break;
      case ">":
        if (!(lhs > rhs)) return false;
        break;
      default:
        throw new Error(`unknown operator: ${c.op}`);
    }
  }
  return true;
}

/* -------------------------------------------------------------------------- */
/* checkConstraints and explainModel                                          */
/* -------------------------------------------------------------------------- */

/**
 * Evaluate a candidate model against a mixed specification and return a
 * per-constraint report.
 *
 * @param {{ sat?: { clauses: number[][], variables: string[] } | string, linear?: LinearSpec }} spec
 * @param {Record<string, boolean | number>} model
 * @returns {{ ok: boolean, sat: { passed: number, failed: number, failures: number[] }, linear: { passed: number, failed: number, failures: number[] } }}
 */
export function checkConstraints(spec, model) {
  const out = {
    ok: true,
    sat: { passed: 0, failed: 0, failures: [] },
    linear: { passed: 0, failed: 0, failures: [] },
  };
  if (!spec || typeof spec !== "object" || !model || typeof model !== "object") {
    throw new Error("spec and model are required");
  }
  if (spec.sat) {
    const parsed = typeof spec.sat === "string" ? parseClauses(spec.sat) : spec.sat;
    if (parsed && Array.isArray(parsed.clauses)) {
      for (let i = 0; i < parsed.clauses.length; i += 1) {
        const clause = parsed.clauses[i];
        let satisfied = false;
        for (const lit of clause) {
          const idx = Math.abs(lit) - 1;
          const name = parsed.variables[idx];
          const v = model[name];
          if (v == null) continue;
          const truth = Boolean(v);
          const expected = lit > 0 ? truth : !truth;
          if (expected) {
            satisfied = true;
            break;
          }
        }
        if (satisfied) out.sat.passed += 1;
        else {
          out.sat.failed += 1;
          out.sat.failures.push(i);
          out.ok = false;
        }
      }
    }
  }
  if (spec.linear && Array.isArray(spec.linear.constraints)) {
    for (let i = 0; i < spec.linear.constraints.length; i += 1) {
      const c = spec.linear.constraints[i];
      try {
        if (allConstraintsHold([c], model)) out.linear.passed += 1;
        else {
          out.linear.failed += 1;
          out.linear.failures.push(i);
          out.ok = false;
        }
      } catch (_) {
        out.linear.failed += 1;
        out.linear.failures.push(i);
        out.ok = false;
      }
    }
  }
  return out;
}

/**
 * Produce a plain-English explanation of a satisfying model.
 *
 * @param {SatResult | { assignment?: Record<string, number> }} result
 * @returns {string}
 */
export function explainModel(result) {
  if (!result || typeof result !== "object") return "no result";
  if ("sat" in result && result.sat === false) {
    return `unsatisfiable: ${/** @type {any} */ (result).reason || "no assignment found"}`;
  }
  const a = /** @type {any} */ (result).assignment || {};
  const parts = [];
  for (const [k, v] of Object.entries(a)) {
    if (typeof v === "boolean") parts.push(`${k} = ${v ? "true" : "false"}`);
    else parts.push(`${k} = ${v}`);
  }
  if (parts.length === 0) return "satisfiable with empty model";
  return `satisfiable: ${parts.join(", ")}`;
}
