// @ts-check
/**
 * Phase 61.3: Integration test harness.
 *
 * Recipe-level test runner with setup / teardown hooks. A harness is a
 * named collection of steps, each representing a single recipe
 * invocation (or any arbitrary test case). Runs are executed via an
 * injectable executor so the harness can be exercised in tests without
 * a live system.
 *
 * Export surface:
 *   - createHarness(config)
 *   - runHarness(id, opts?)
 *   - listHarnesses()
 *   - recordOutcome(runId, outcome)
 *   - clearHarnessRuns(id?)
 *
 * @module integration-harness
 */
import { join } from "path";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;
const MAX_RUNS = 500;

function storePath() {
  return join(getDataDir(), "integration-harness.json");
}

let _counter = 0;
function genId(prefix) {
  _counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${_counter}`;
}

/* -------------------------------------------------------------------------- */
/* Persistence                                                                */
/* -------------------------------------------------------------------------- */

async function loadStore() {
  const data = await readJsonPath(storePath(), {
    version: STORE_VERSION,
    harnesses: {},
    runs: [],
  });
  if (!data.harnesses || typeof data.harnesses !== "object") data.harnesses = {};
  if (!Array.isArray(data.runs)) data.runs = [];
  return data;
}

async function saveStore(data) {
  await writeJsonPath(storePath(), {
    version: STORE_VERSION,
    harnesses: data.harnesses || {},
    runs: Array.isArray(data.runs) ? data.runs.slice(-MAX_RUNS) : [],
  });
}

/* -------------------------------------------------------------------------- */
/* Harness definitions                                                        */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} HarnessStep
 * @property {string} name
 * @property {string} [recipe]
 * @property {object} [input]
 * @property {object} [expect]
 */

/**
 * @typedef {Object} HarnessConfig
 * @property {string} name
 * @property {string} [description]
 * @property {HarnessStep[]} steps
 * @property {HarnessStep[]} [setup]
 * @property {HarnessStep[]} [teardown]
 */

/**
 * Create or replace a harness definition.
 *
 * @param {HarnessConfig} config
 */
export async function createHarness(config) {
  if (!config || typeof config !== "object") {
    throw new Error("harness config is required");
  }
  if (!config.name || typeof config.name !== "string") {
    throw new Error("harness name is required");
  }
  if (!Array.isArray(config.steps) || config.steps.length === 0) {
    throw new Error("harness must have at least one step");
  }
  for (const step of config.steps) {
    if (!step || typeof step !== "object" || !step.name) {
      throw new Error("each step must be an object with a name");
    }
  }
  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    const now = new Date().toISOString();
    const existing = data.harnesses[config.name];
    const record = {
      id: existing?.id || genId("h"),
      name: config.name,
      description: typeof config.description === "string" ? config.description : "",
      steps: config.steps.map((s) => ({ ...s })),
      setup: Array.isArray(config.setup) ? config.setup.map((s) => ({ ...s })) : [],
      teardown: Array.isArray(config.teardown) ? config.teardown.map((s) => ({ ...s })) : [],
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    data.harnesses[config.name] = record;
    await saveStore(data);
    return record;
  });
}

/**
 * List every defined harness.
 */
export async function listHarnesses() {
  const data = await loadStore();
  return Object.values(data.harnesses || {});
}

/* -------------------------------------------------------------------------- */
/* Execution                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Execute a harness. Setup, steps, and teardown are run through the
 * injected `executor(step, context)`. A step is considered passing
 * when the executor returns `{ ok: true, ... }` or throws nothing.
 *
 * @param {string} harnessName
 * @param {{ executor?: (step: any, context: any) => Promise<any>, context?: object, stopOnFailure?: boolean }} [opts]
 */
export async function runHarness(harnessName, opts = {}) {
  if (!harnessName || typeof harnessName !== "string") {
    throw new Error("harnessName is required");
  }
  const data = await loadStore();
  const harness = data.harnesses[harnessName];
  if (!harness) throw new Error(`harness ${harnessName} not found`);

  const executor = typeof opts.executor === "function" ? opts.executor : defaultExecutor;
  const ctx = { ...(opts.context || {}), harness: harnessName };
  const stopOnFailure = opts.stopOnFailure !== false;

  const runId = genId("run");
  const startedAt = new Date().toISOString();
  /** @type {Array<{ name: string, phase: string, ok: boolean, result?: any, error?: string, durationMs: number }>} */
  const steps = [];
  let passed = 0;
  let failed = 0;

  const runPhase = async (phase, phaseSteps) => {
    for (const step of phaseSteps || []) {
      const start = Date.now();
      let result = null;
      let ok = true;
      let error = null;
      try {
        const out = await executor(step, { ...ctx, phase });
        if (out && typeof out === "object" && out.ok === false) {
          ok = false;
          error = typeof out.error === "string" ? out.error : "step returned ok=false";
        }
        result = out;
      } catch (err) {
        ok = false;
        error = err?.message || String(err);
      }
      const durationMs = Date.now() - start;
      steps.push({ name: step.name, phase, ok, result, error, durationMs });
      if (ok) passed += 1;
      else failed += 1;
      if (!ok && stopOnFailure && phase === "steps") break;
    }
  };

  await runPhase("setup", harness.setup);
  await runPhase("steps", harness.steps);
  await runPhase("teardown", harness.teardown);

  const finishedAt = new Date().toISOString();
  const record = {
    id: runId,
    harnessName,
    startedAt,
    finishedAt,
    durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
    steps,
    passed,
    failed,
    status: failed === 0 ? "passed" : "failed",
  };

  const path = storePath();
  await withPathLock(path, async () => {
    const store = await loadStore();
    store.runs.push(record);
    if (store.runs.length > MAX_RUNS) {
      store.runs = store.runs.slice(-MAX_RUNS);
    }
    await saveStore(store);
  });
  return record;
}

/**
 * Default executor used when none is injected. Simply echoes the step.
 */
async function defaultExecutor(step, _context) {
  return { ok: true, echoed: step };
}

/**
 * Record an outcome for an existing run (e.g., a manual pass/fail
 * annotation after a reviewer checks results).
 *
 * @param {string} runId
 * @param {{ status?: string, note?: string }} outcome
 */
export async function recordOutcome(runId, outcome) {
  if (!runId || typeof runId !== "string") {
    throw new Error("runId is required");
  }
  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    const run = data.runs.find((r) => r.id === runId);
    if (!run) throw new Error(`run ${runId} not found`);
    run.outcome = {
      status: typeof outcome?.status === "string" ? outcome.status : run.status,
      note: typeof outcome?.note === "string" ? outcome.note : "",
      recordedAt: new Date().toISOString(),
    };
    await saveStore(data);
    return run;
  });
}

/**
 * Remove a harness's runs (or every run when id/name omitted).
 *
 * @param {string} [harnessName]
 */
export async function clearHarnessRuns(harnessName) {
  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    if (!harnessName) {
      const count = data.runs.length;
      data.runs = [];
      await saveStore(data);
      return { cleared: count };
    }
    const before = data.runs.length;
    data.runs = data.runs.filter((r) => r.harnessName !== harnessName);
    await saveStore(data);
    return { cleared: before - data.runs.length };
  });
}

/**
 * List recent runs, optionally filtered by harness name.
 *
 * @param {string} [harnessName]
 */
export async function listRuns(harnessName) {
  const data = await loadStore();
  let out = data.runs.slice();
  if (harnessName) out = out.filter((r) => r.harnessName === harnessName);
  return out.sort((a, b) => (Date.parse(b.startedAt) || 0) - (Date.parse(a.startedAt) || 0));
}
