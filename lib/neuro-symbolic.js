/**
 * Phase 52.4: Neuro-symbolic bridge.
 *
 * Provides a pluggable interface for SAT/SMT solvers. Ships with a built-in
 * boolean-SAT DPLL solver (no external dependencies). Exposes a provider
 * registry so operators can later plug in Z3 / MiniSat / CVC5 backends.
 *
 * Inputs:
 *   SAT: clauses in CNF. A clause is an array of integer literals where
 *        positive = variable, negative = negated variable. Variables are
 *        positive integers, e.g. [[1, -2], [2, 3], [-1, -3]].
 *   SMT: a lightweight expression object (stub — real backends would compile
 *        this to SMT-LIB).
 */

// ─── Provider registry ────────────────────────────────────────────────────

const providers = new Map();

/**
 * Register a solver provider.
 * @param {string} name
 * @param {{ solveSat?: Function, solveSmt?: Function }} impl
 */
export function registerSolver(name, impl) {
  if (!name || typeof name !== "string") throw new Error("name is required");
  if (!impl || typeof impl !== "object") throw new Error("impl must be an object");
  if (impl.solveSat && typeof impl.solveSat !== "function") {
    throw new Error("impl.solveSat must be a function");
  }
  if (impl.solveSmt && typeof impl.solveSmt !== "function") {
    throw new Error("impl.solveSmt must be a function");
  }
  providers.set(name, impl);
}

export function listSolvers() {
  return Array.from(providers.keys());
}

export function getSolver(name = "builtin") {
  return providers.get(name) || null;
}

// ─── Built-in DPLL SAT solver ────────────────────────────────────────────

function normalizeClauses(clauses) {
  if (!Array.isArray(clauses)) throw new Error("clauses must be an array");
  const out = [];
  for (const c of clauses) {
    if (!Array.isArray(c)) throw new Error("each clause must be an array of literals");
    const lits = c
      .map((l) => Number(l))
      .filter((l) => Number.isInteger(l) && l !== 0);
    out.push(Array.from(new Set(lits)));
  }
  return out;
}

function allVariables(clauses) {
  const vars = new Set();
  for (const c of clauses) for (const l of c) vars.add(Math.abs(l));
  return Array.from(vars).sort((a, b) => a - b);
}

function simplify(clauses, literal) {
  const out = [];
  for (const c of clauses) {
    if (c.includes(literal)) continue; // satisfied
    const filtered = c.filter((l) => l !== -literal);
    out.push(filtered);
  }
  return out;
}

function findUnitClause(clauses) {
  for (const c of clauses) {
    if (c.length === 1) return c[0];
  }
  return null;
}

function findPureLiteral(clauses) {
  const seen = new Map();
  for (const c of clauses) {
    for (const l of c) {
      const prev = seen.get(Math.abs(l));
      if (prev === undefined) seen.set(Math.abs(l), l);
      else if (prev !== l) seen.set(Math.abs(l), 0);
    }
  }
  for (const [, lit] of seen) if (lit !== 0) return lit;
  return null;
}

/**
 * Classical DPLL: unit propagation, pure-literal elimination, branching.
 *
 * @param {number[][]} clauses
 * @param {object} assignment - literal -> boolean
 * @param {number} depth
 * @param {number} maxDepth
 * @returns {{ sat: boolean, assignment?: object, stats: object }}
 */
function dpll(clauses, assignment, stats, maxDepth = 10_000) {
  stats.steps += 1;
  if (stats.steps > maxDepth) {
    return { sat: false, stats, timeout: true };
  }
  // Unit propagation.
  let unit = findUnitClause(clauses);
  while (unit) {
    assignment[Math.abs(unit)] = unit > 0;
    clauses = simplify(clauses, unit);
    if (clauses.some((c) => c.length === 0)) {
      return { sat: false, stats };
    }
    unit = findUnitClause(clauses);
  }
  if (clauses.length === 0) return { sat: true, assignment, stats };
  // Pure-literal elimination.
  const pure = findPureLiteral(clauses);
  if (pure) {
    assignment[Math.abs(pure)] = pure > 0;
    return dpll(simplify(clauses, pure), assignment, stats, maxDepth);
  }
  // Branch on the most frequent variable.
  const freq = new Map();
  for (const c of clauses) for (const l of c) freq.set(l, (freq.get(l) || 0) + 1);
  const [literal] = [...freq.entries()].sort((a, b) => b[1] - a[1])[0] || [];
  if (literal == null) return clauses.length === 0 ? { sat: true, assignment, stats } : { sat: false, stats };
  stats.branches += 1;
  const tryTrue = dpll(
    simplify(clauses, literal),
    { ...assignment, [Math.abs(literal)]: literal > 0 },
    stats,
    maxDepth,
  );
  if (tryTrue.sat) return tryTrue;
  return dpll(
    simplify(clauses, -literal),
    { ...assignment, [Math.abs(literal)]: literal < 0 },
    stats,
    maxDepth,
  );
}

/**
 * Solve a CNF formula.
 *
 * @param {number[][]} clauses - CNF clauses (array of literal arrays)
 * @param {{ provider?: string, maxSteps?: number }} [options]
 * @returns {Promise<{ sat: boolean, assignment?: object, stats: object, provider: string }>}
 */
export async function solveSat(clauses, options = {}) {
  const providerName = options.provider || "builtin";
  if (providerName !== "builtin" && providers.has(providerName)) {
    const prov = providers.get(providerName);
    if (prov && prov.solveSat) return prov.solveSat(clauses, options);
  }
  const normalized = normalizeClauses(clauses);
  // Handle trivial edge cases.
  if (normalized.length === 0) {
    return { sat: true, assignment: {}, stats: { steps: 0, branches: 0 }, provider: "builtin" };
  }
  if (normalized.some((c) => c.length === 0)) {
    return { sat: false, assignment: null, stats: { steps: 0, branches: 0 }, provider: "builtin" };
  }
  const stats = { steps: 0, branches: 0 };
  const result = dpll(normalized, {}, stats, Number(options.maxSteps) || 50_000);
  if (result.sat) {
    // Ensure every variable gets an assignment (unconstrained vars default to false).
    const vars = allVariables(normalized);
    const finalAssign = { ...result.assignment };
    for (const v of vars) if (!(v in finalAssign)) finalAssign[v] = false;
    return { sat: true, assignment: finalAssign, stats, provider: "builtin" };
  }
  return { sat: false, assignment: null, stats, provider: "builtin", timeout: result.timeout || false };
}

// ─── SMT stub ─────────────────────────────────────────────────────────────

/**
 * Stub SMT interface. Recognizes a very small subset of formulas:
 *   { op: "and"|"or"|"not"|"eq"|"lt"|"le"|"gt"|"ge"|"add"|"sub", args: [...] }
 *   | { var: "x" } | { const: number | boolean }
 *
 * Real backends (Z3) should register their own `solveSmt` via
 * `registerSolver`. This builtin performs light validation plus a
 * best-effort linear-inequality feasibility check over integer variables with
 * provided domains.
 */
export async function solveSmt(formula, options = {}) {
  const providerName = options.provider || "builtin";
  if (providerName !== "builtin" && providers.has(providerName)) {
    const prov = providers.get(providerName);
    if (prov && prov.solveSmt) return prov.solveSmt(formula, options);
  }
  validateSmt(formula);
  const domains = options.domains || {};
  const vars = collectSmtVars(formula);
  // Default domain is [-10..10] if not specified.
  const assign = {};
  const found = searchAssignment(formula, vars, domains, assign, 0);
  if (found) {
    return { sat: true, assignment: { ...found }, provider: "builtin", stub: true };
  }
  return { sat: false, assignment: null, provider: "builtin", stub: true };
}

function validateSmt(f) {
  if (!f || typeof f !== "object") throw new Error("formula must be an object");
  if ("const" in f) return;
  if ("var" in f) {
    if (typeof f.var !== "string") throw new Error("var must be a string");
    return;
  }
  if (!f.op || !Array.isArray(f.args)) {
    throw new Error("formula must be {op, args} or {var} or {const}");
  }
  for (const a of f.args) validateSmt(a);
}

function collectSmtVars(f, set = new Set()) {
  if (f == null) return set;
  if ("var" in f) set.add(f.var);
  else if (Array.isArray(f.args)) f.args.forEach((a) => collectSmtVars(a, set));
  return set;
}

function evalSmt(f, env) {
  if ("const" in f) return f.const;
  if ("var" in f) return env[f.var];
  const args = f.args.map((a) => evalSmt(a, env));
  switch (f.op) {
    case "and": return args.every(Boolean);
    case "or": return args.some(Boolean);
    case "not": return !args[0];
    case "eq": return args[0] === args[1];
    case "lt": return args[0] < args[1];
    case "le": return args[0] <= args[1];
    case "gt": return args[0] > args[1];
    case "ge": return args[0] >= args[1];
    case "add": return args.reduce((a, b) => a + b, 0);
    case "sub": return args.reduce((a, b, i) => (i === 0 ? b : a - b), 0);
    case "mul": return args.reduce((a, b) => a * b, 1);
    default: throw new Error(`unknown op: ${f.op}`);
  }
}

function searchAssignment(formula, vars, domains, assign, idx) {
  const arr = Array.from(vars);
  if (idx >= arr.length) {
    try {
      return evalSmt(formula, assign) ? { ...assign } : null;
    } catch (_) { return null; }
  }
  const v = arr[idx];
  const dom = domains[v] || { min: -10, max: 10 };
  for (let val = dom.min; val <= dom.max; val += 1) {
    assign[v] = val;
    const found = searchAssignment(formula, vars, domains, assign, idx + 1);
    if (found) return found;
  }
  delete assign[v];
  return null;
}

// Register builtin provider.
registerSolver("builtin", { solveSat, solveSmt });

export const _internals = { dpll, simplify, findUnitClause, findPureLiteral, normalizeClauses };
