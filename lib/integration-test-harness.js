/**
 * Phase 61.3: Integration test harness — recipe-level test runner.
 *
 * Loads a recipe (provided inline or by name via an injectable loader) and
 * executes each step in dry-run mode, asserting expected outputs. Dry-run
 * execution is handled by an injectable step runner — by default the harness
 * uses a pure echo runner that returns deterministic synthetic output so tests
 * and CI scripts can exercise pipelines without hitting real backends.
 *
 * Storage layout (via json-path-store):
 *   data/integration-tests/{runId}.json   — individual run records
 *   data/integration-tests/_index.json    — run id index
 */
import { join } from "path";
import { randomUUID } from "crypto";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

// ─── Paths ─────────────────────────────────────────────────────────────────

function runPath(id) {
  return join(getDataDir(), "integration-tests", `${sanitize(id)}.json`);
}

function indexPath() {
  return join(getDataDir(), "integration-tests", "_index.json");
}

function sanitize(v) {
  return String(v || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || "default";
}

// ─── Default step runner (dry-run echo) ────────────────────────────────────

/**
 * Default dry-run runner. Produces a deterministic output so step assertions
 * are reproducible across environments. Real recipe execution is explicitly
 * out of scope — callers supply their own runner when needed.
 *
 * @param {object} step
 * @param {object} ctx  rolling context (previous step outputs, variables, etc.)
 */
export async function defaultStepRunner(step, ctx) {
  const kind = String(step?.kind || step?.type || "noop");
  const name = step?.name || step?.id || kind;
  const template = step?.output;
  const output = template !== undefined
    ? template
    : { dryRun: true, kind, name, input: step?.input ?? null, prev: ctx?.lastOutput ?? null };
  return { output, durationMs: 1 };
}

// ─── Assertions ────────────────────────────────────────────────────────────

function deepEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return a === b;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!deepEqual(a[k], b[k])) return false;
  return true;
}

function applyAssertion(expected, actual) {
  if (expected === undefined) return { passed: true };
  if (expected && typeof expected === "object" && !Array.isArray(expected)) {
    // Allow { contains: ..., equals: ..., matches: regex-string, type: "object" }
    if ("equals" in expected) {
      return deepEqual(expected.equals, actual)
        ? { passed: true }
        : { passed: false, reason: `expected equals ${JSON.stringify(expected.equals)}, got ${JSON.stringify(actual)}` };
    }
    if ("contains" in expected) {
      const hay = typeof actual === "string" ? actual : JSON.stringify(actual);
      return hay.includes(expected.contains)
        ? { passed: true }
        : { passed: false, reason: `missing substring: ${expected.contains}` };
    }
    if ("matches" in expected) {
      let re;
      try { re = new RegExp(expected.matches); } catch { return { passed: false, reason: `invalid regex: ${expected.matches}` }; }
      const hay = typeof actual === "string" ? actual : JSON.stringify(actual);
      return re.test(hay)
        ? { passed: true }
        : { passed: false, reason: `regex ${re} did not match` };
    }
    if ("type" in expected) {
      const t = Array.isArray(actual) ? "array" : typeof actual;
      return t === expected.type
        ? { passed: true }
        : { passed: false, reason: `expected type ${expected.type}, got ${t}` };
    }
    // Fall through to deep-equality if none of the structured keys match.
    return deepEqual(expected, actual)
      ? { passed: true }
      : { passed: false, reason: `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}` };
  }
  return deepEqual(expected, actual)
    ? { passed: true }
    : { passed: false, reason: `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}` };
}

// ─── Index helpers ─────────────────────────────────────────────────────────

async function appendIndex(entry) {
  await withPathLock(indexPath(), async () => {
    const idx = await readJsonPath(indexPath(), { runs: [] });
    const list = Array.isArray(idx.runs) ? idx.runs : [];
    list.unshift(entry);
    if (list.length > 500) list.length = 500;
    await writeJsonPath(indexPath(), { runs: list });
  });
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Run a recipe as an integration test in dry-run mode.
 *
 * @param {object} recipe  { name, steps: [{name, kind, expect?, output?}] }
 * @param {{
 *   runner?: (step: object, ctx: object) => Promise<{output: any}>,
 *   loader?: (name: string) => Promise<object>,
 *   name?: string,
 * }} [opts]
 */
export async function runRecipeTest(recipe, opts = {}) {
  const runner = opts.runner || defaultStepRunner;
  let target = recipe;
  if (typeof recipe === "string") {
    if (typeof opts.loader !== "function") {
      throw new Error("loader is required when recipe is a string");
    }
    target = await opts.loader(recipe);
    if (!target) {
      const err = new Error(`recipe ${recipe} not found`);
      err.code = "NOT_FOUND";
      throw err;
    }
  }
  if (!target || typeof target !== "object") throw new Error("recipe is required");
  const steps = Array.isArray(target.steps) ? target.steps : [];
  const runId = randomUUID();
  const startedAt = new Date().toISOString();

  const ctx = { lastOutput: null, outputs: {} };
  const stepResults = [];
  let passedCount = 0;
  let failedCount = 0;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i] || {};
    const stepName = step.name || step.id || `step-${i + 1}`;
    let runnerResult;
    let error = null;
    try {
      runnerResult = await runner(step, ctx);
    } catch (e) {
      error = e.message || String(e);
      runnerResult = { output: null };
    }
    const output = runnerResult?.output;
    ctx.lastOutput = output;
    ctx.outputs[stepName] = output;

    const assertion = error
      ? { passed: false, reason: `runner error: ${error}` }
      : applyAssertion(step.expect, output);

    if (assertion.passed) passedCount += 1; else failedCount += 1;

    stepResults.push({
      index: i,
      name: stepName,
      kind: step.kind || step.type || "noop",
      output,
      expected: step.expect ?? null,
      passed: assertion.passed,
      reason: assertion.reason || null,
      durationMs: runnerResult?.durationMs ?? 0,
      error,
    });

    if (!assertion.passed && step.stopOnFail !== false) {
      // Default: stop on first failure so the report is easier to triage.
      break;
    }
  }

  const record = {
    id: runId,
    name: opts.name || target.name || "unnamed-recipe",
    recipe: { name: target.name || null, stepCount: steps.length },
    status: failedCount === 0 ? "passed" : "failed",
    startedAt,
    finishedAt: new Date().toISOString(),
    steps: stepResults,
    summary: {
      total: steps.length,
      executed: stepResults.length,
      passed: passedCount,
      failed: failedCount,
      skipped: steps.length - stepResults.length,
    },
  };
  await writeJsonPath(runPath(runId), record);
  await appendIndex({ id: runId, name: record.name, status: record.status, startedAt });
  return record;
}

export async function getTestRun(id) {
  if (!id) return null;
  const rec = await readJsonPath(runPath(id), null);
  if (!rec || !rec.id) return null;
  return rec;
}

export async function listTestRuns(opts = {}) {
  const limit = Math.max(1, Math.min(500, Number(opts.limit) || 50));
  const idx = await readJsonPath(indexPath(), { runs: [] });
  const list = Array.isArray(idx.runs) ? idx.runs : [];
  let filtered = list;
  if (opts.status) filtered = filtered.filter((r) => r.status === opts.status);
  if (opts.name) filtered = filtered.filter((r) => r.name === opts.name);
  return filtered.slice(0, limit);
}

export const _internals = {
  runPath,
  indexPath,
  applyAssertion,
  deepEqual,
};
