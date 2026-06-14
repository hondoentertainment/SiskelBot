/**
 * Phase 58.4: Model distillation scaffold.
 *
 * Teacher → student pipeline scaffold. Workflow:
 *   1. `startDistillation(config)` — open a run keyed to a teacher + student.
 *   2. `recordPair(runId, pair)`   — append a teacher input/output pair to
 *      the run's training dataset.
 *   3. `finalizeDataset(runId, evalReport)` — close the dataset and, if eval
 *      passes the configured thresholds, emit a "promotion" event that
 *      external training infra (or a human) can pick up.
 *   4. `listRuns()` / `getRun(runId)` — observability.
 *
 * This module does NOT run training itself; it's a coordination layer.
 *
 * Storage:
 *   data/distillation/runs/{runId}.json      — run metadata + state
 *   data/distillation/datasets/{runId}.json  — appended training pairs
 *   data/distillation/_index.json            — known runs
 */
import { randomUUID } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

export const RUN_STATUS = Object.freeze({
  COLLECTING: "collecting",
  FINALIZING: "finalizing",
  READY_TO_PROMOTE: "ready_to_promote",
  PROMOTED: "promoted",
  REJECTED: "rejected",
  CANCELED: "canceled",
});

function sanitize(v) {
  return String(v || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || "default";
}

function runPath(id) {
  return join(getDataDir(), "distillation", "runs", `${sanitize(id)}.json`);
}

function datasetPath(id) {
  return join(getDataDir(), "distillation", "datasets", `${sanitize(id)}.json`);
}

function indexPath() {
  return join(getDataDir(), "distillation", "_index.json");
}

async function touchIndex(entry) {
  return withPathLock(indexPath(), async () => {
    const idx = await readJsonPath(indexPath(), { runs: [] });
    const list = Array.isArray(idx.runs) ? idx.runs : [];
    const filtered = list.filter((r) => r.runId !== entry.runId);
    filtered.push(entry);
    await writeJsonPath(indexPath(), { runs: filtered });
  });
}

/**
 * Start a distillation run.
 *
 * @param {{ teacherModel: string, studentModel: string, name?: string, evalThresholds?: object }} config
 */
export async function startDistillation(config = {}) {
  if (!config.teacherModel) throw new Error("teacherModel is required");
  if (!config.studentModel) throw new Error("studentModel is required");
  const runId = config.runId || randomUUID();
  const record = {
    runId,
    name: config.name ? String(config.name) : `${config.teacherModel}→${config.studentModel}`,
    teacherModel: String(config.teacherModel),
    studentModel: String(config.studentModel),
    evalThresholds: {
      minAccuracy: Number(config.evalThresholds?.minAccuracy) || 0,
      maxRegression: Number(config.evalThresholds?.maxRegression) || 0,
      ...(config.evalThresholds || {}),
    },
    status: RUN_STATUS.COLLECTING,
    pairCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    finalizedAt: null,
    promotedAt: null,
    rejectedAt: null,
    evalReport: null,
    history: [{ at: new Date().toISOString(), type: "started", data: {} }],
  };
  await writeJsonPath(runPath(runId), record);
  await writeJsonPath(datasetPath(runId), { runId, pairs: [] });
  await touchIndex({ runId, name: record.name, createdAt: record.createdAt });
  return record;
}

/**
 * Record a teacher input/output pair for the training dataset.
 *
 * @param {string} runId
 * @param {{ input: string | object, teacherOutput: string | object, metadata?: object, at?: number }} pair
 */
export async function recordPair(runId, pair) {
  if (!pair || !("input" in pair) || !("teacherOutput" in pair)) {
    throw new Error("pair requires input and teacherOutput");
  }
  const rfile = runPath(runId);
  const dfile = datasetPath(runId);
  let updated;
  await withPathLock(rfile, async () => {
    const run = await readJsonPath(rfile, null);
    if (!run || !run.runId) throw new Error(`run ${runId} not found`);
    if (run.status !== RUN_STATUS.COLLECTING) {
      throw new Error(`cannot record pair when run status is ${run.status}`);
    }
    run.pairCount += 1;
    run.updatedAt = new Date().toISOString();
    await writeJsonPath(rfile, run);
    updated = run;
  });
  await withPathLock(dfile, async () => {
    const store = await readJsonPath(dfile, { runId, pairs: [] });
    const pairs = Array.isArray(store.pairs) ? store.pairs : [];
    pairs.push({
      input: pair.input,
      teacherOutput: pair.teacherOutput,
      metadata: pair.metadata && typeof pair.metadata === "object" ? pair.metadata : {},
      at: typeof pair.at === "number" ? pair.at : Date.now(),
    });
    const maxPairs = Number(process.env.DISTILLATION_MAX_PAIRS) || 200_000;
    const trimmed = pairs.length > maxPairs ? pairs.slice(-maxPairs) : pairs;
    await writeJsonPath(dfile, { runId, pairs: trimmed });
  });
  return { runId, pairCount: updated.pairCount };
}

/**
 * Close the dataset for this run. If an evalReport is supplied, gate
 * promotion on its thresholds.
 *
 * @param {string} runId
 * @param {{ accuracy?: number, regression?: number, extra?: object }} [evalReport]
 * @returns {Promise<object>} updated run record
 */
export async function finalizeDataset(runId, evalReport = null) {
  const rfile = runPath(runId);
  return withPathLock(rfile, async () => {
    const run = await readJsonPath(rfile, null);
    if (!run || !run.runId) throw new Error(`run ${runId} not found`);
    if (run.status === RUN_STATUS.PROMOTED || run.status === RUN_STATUS.REJECTED) {
      return run;
    }
    run.status = RUN_STATUS.FINALIZING;
    run.finalizedAt = new Date().toISOString();
    run.evalReport = evalReport || null;
    const thresholds = run.evalThresholds || {};
    let passed = true;
    const reasons = [];
    if (evalReport) {
      if (typeof evalReport.accuracy === "number" && typeof thresholds.minAccuracy === "number") {
        if (evalReport.accuracy < thresholds.minAccuracy) {
          passed = false;
          reasons.push(`accuracy ${evalReport.accuracy} < ${thresholds.minAccuracy}`);
        }
      }
      if (typeof evalReport.regression === "number" && typeof thresholds.maxRegression === "number") {
        if (evalReport.regression > thresholds.maxRegression) {
          passed = false;
          reasons.push(`regression ${evalReport.regression} > ${thresholds.maxRegression}`);
        }
      }
    }
    if (passed && evalReport) {
      run.status = RUN_STATUS.READY_TO_PROMOTE;
      run.history.push({
        at: new Date().toISOString(),
        type: "promotion_event",
        data: { teacherModel: run.teacherModel, studentModel: run.studentModel, evalReport },
      });
    } else if (!passed) {
      run.status = RUN_STATUS.REJECTED;
      run.rejectedAt = new Date().toISOString();
      run.history.push({
        at: new Date().toISOString(),
        type: "rejected",
        data: { reasons },
      });
    } else {
      // No eval report — stay in FINALIZING so caller can attach one later.
      run.status = RUN_STATUS.FINALIZING;
    }
    run.updatedAt = new Date().toISOString();
    await writeJsonPath(rfile, run);
    return run;
  });
}

/**
 * Mark the student as promoted into production. Typically called by the
 * deployment pipeline after eval pass.
 */
export async function promoteStudent(runId) {
  const rfile = runPath(runId);
  return withPathLock(rfile, async () => {
    const run = await readJsonPath(rfile, null);
    if (!run || !run.runId) throw new Error(`run ${runId} not found`);
    if (run.status !== RUN_STATUS.READY_TO_PROMOTE) {
      throw new Error(`cannot promote from status ${run.status}`);
    }
    run.status = RUN_STATUS.PROMOTED;
    run.promotedAt = new Date().toISOString();
    run.history.push({ at: run.promotedAt, type: "promoted", data: {} });
    await writeJsonPath(rfile, run);
    return run;
  });
}

export async function cancelRun(runId) {
  const rfile = runPath(runId);
  return withPathLock(rfile, async () => {
    const run = await readJsonPath(rfile, null);
    if (!run || !run.runId) throw new Error(`run ${runId} not found`);
    if (run.status === RUN_STATUS.PROMOTED) throw new Error("cannot cancel a promoted run");
    run.status = RUN_STATUS.CANCELED;
    run.updatedAt = new Date().toISOString();
    run.history.push({ at: run.updatedAt, type: "canceled", data: {} });
    await writeJsonPath(rfile, run);
    return run;
  });
}

export async function getRun(runId) {
  const rec = await readJsonPath(runPath(runId), null);
  return rec && rec.runId ? rec : null;
}

export async function getDataset(runId) {
  const rec = await readJsonPath(datasetPath(runId), null);
  return rec || { runId, pairs: [] };
}

export async function listRuns() {
  const idx = await readJsonPath(indexPath(), { runs: [] });
  const list = Array.isArray(idx.runs) ? idx.runs : [];
  const out = [];
  for (const entry of list) {
    const rec = await getRun(entry.runId);
    if (rec) out.push(rec);
  }
  return out;
}

/**
 * Test helper.
 */
export async function _reset() {
  const idx = await readJsonPath(indexPath(), { runs: [] });
  const list = Array.isArray(idx.runs) ? idx.runs : [];
  for (const entry of list) {
    await writeJsonPath(runPath(entry.runId), { _deleted: true });
    await writeJsonPath(datasetPath(entry.runId), { runId: entry.runId, pairs: [] });
  }
  await writeJsonPath(indexPath(), { runs: [] });
}

export const _internals = { runPath, datasetPath, indexPath };
