// @ts-check
/**
 * Phase 58.4: Model distillation.
 *
 * Teacher-student distillation pipeline. This module manages the
 * data collection side of distillation: create a job against a
 * (teacher, student) model pair, record traces of the teacher's
 * outputs as training examples, and export the dataset in a
 * JSONL-friendly shape for offline fine-tuning.
 *
 * Actual student-model training is out of scope — this just owns
 * the persisted job metadata and trace catalog so the rest of the
 * system can accumulate training data while routing traffic.
 *
 * The module exposes:
 *   - `createDistillationJob(spec)`
 *   - `recordTeacherTrace(jobId, trace)`
 *   - `exportTrainingSet(jobId, opts)`
 *   - `jobStatus(jobId)`
 *   - `listJobs()`
 *
 * @module distillation
 */
import { join } from "path";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;

const VALID_STATUSES = new Set([
  "pending",
  "collecting",
  "ready",
  "exported",
  "failed",
  "archived",
]);

function jobsPath() {
  return join(getDataDir(), "distillation-jobs.json");
}

function tracesPath(jobId) {
  const safe = String(jobId).replace(/[^a-zA-Z0-9_.-]+/g, "_");
  return join(getDataDir(), `distillation-traces-${safe}.json`);
}

/* -------------------------------------------------------------------------- */
/* Persistence                                                                */
/* -------------------------------------------------------------------------- */

async function loadJobs() {
  const data = await readJsonPath(jobsPath(), { version: STORE_VERSION, jobs: {} });
  if (!data.jobs || typeof data.jobs !== "object") data.jobs = {};
  return data;
}

async function saveJobs(data) {
  await writeJsonPath(jobsPath(), {
    version: STORE_VERSION,
    jobs: data.jobs || {},
    updatedAt: new Date().toISOString(),
  });
}

async function loadTraces(jobId) {
  const data = await readJsonPath(tracesPath(jobId), {
    version: STORE_VERSION,
    jobId,
    traces: [],
  });
  if (!Array.isArray(data.traces)) data.traces = [];
  return data;
}

async function saveTraces(jobId, data) {
  await writeJsonPath(tracesPath(jobId), {
    version: STORE_VERSION,
    jobId,
    traces: data.traces || [],
    updatedAt: new Date().toISOString(),
  });
}

/* -------------------------------------------------------------------------- */
/* Job creation                                                               */
/* -------------------------------------------------------------------------- */

let _jobCounter = 0;
function generateJobId(clock) {
  _jobCounter += 1;
  const ts = typeof clock === "function" ? clock() : Date.now();
  return `distill-${ts.toString(36)}-${_jobCounter}`;
}

/**
 * @typedef {Object} DistillationJob
 * @property {number} version
 * @property {string} id
 * @property {string} teacher
 * @property {string} student
 * @property {string} status
 * @property {string} [taskType]
 * @property {number} traceCount
 * @property {number} [targetTraces]
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {string} [exportedAt]
 */

/**
 * Create a new distillation job.
 *
 * @param {{ teacher: string, student: string, taskType?: string, targetTraces?: number, clock?: () => number }} spec
 * @returns {Promise<DistillationJob>}
 */
export async function createDistillationJob(spec) {
  if (!spec || typeof spec !== "object") throw new Error("spec is required");
  if (!spec.teacher || typeof spec.teacher !== "string") throw new Error("teacher is required");
  if (!spec.student || typeof spec.student !== "string") throw new Error("student is required");
  const path = jobsPath();
  return withPathLock(path, async () => {
    const data = await loadJobs();
    const id = generateJobId(spec.clock);
    const now = new Date().toISOString();
    const job = {
      version: STORE_VERSION,
      id,
      teacher: spec.teacher,
      student: spec.student,
      status: "pending",
      taskType: spec.taskType || "general",
      traceCount: 0,
      targetTraces: Number.isFinite(spec.targetTraces) && spec.targetTraces > 0
        ? Math.floor(spec.targetTraces)
        : 1000,
      createdAt: now,
      updatedAt: now,
    };
    data.jobs[id] = job;
    await saveJobs(data);
    // Initialize an empty trace store file so subsequent reads don't race.
    await saveTraces(id, { traces: [] });
    return job;
  });
}

/* -------------------------------------------------------------------------- */
/* Trace recording                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Record a single teacher trace against a job. A trace is an
 * `(input, output)` pair plus optional metadata (latency, tokens,
 * score).
 *
 * @param {string} jobId
 * @param {{ input: any, output: any, metadata?: object }} trace
 * @returns {Promise<DistillationJob>}
 */
export async function recordTeacherTrace(jobId, trace) {
  if (!jobId || typeof jobId !== "string") throw new Error("jobId is required");
  if (!trace || typeof trace !== "object") throw new Error("trace is required");
  if (trace.input === undefined) throw new Error("trace.input is required");
  if (trace.output === undefined) throw new Error("trace.output is required");

  const jPath = jobsPath();
  return withPathLock(jPath, async () => {
    const data = await loadJobs();
    const job = data.jobs[jobId];
    if (!job) throw new Error(`unknown job: ${jobId}`);
    if (job.status === "archived") throw new Error("job is archived");

    const tData = await loadTraces(jobId);
    const record = {
      input: trace.input,
      output: trace.output,
      metadata: trace.metadata && typeof trace.metadata === "object" ? trace.metadata : {},
      recordedAt: new Date().toISOString(),
    };
    tData.traces.push(record);
    await saveTraces(jobId, tData);

    job.traceCount = tData.traces.length;
    job.updatedAt = new Date().toISOString();
    if (job.status === "pending") job.status = "collecting";
    if (job.traceCount >= (job.targetTraces || Infinity)) {
      job.status = "ready";
    }
    data.jobs[jobId] = job;
    await saveJobs(data);
    return job;
  });
}

/* -------------------------------------------------------------------------- */
/* Export                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Export the recorded traces as an array of training examples.
 * The default format is `[ { prompt, completion, meta } ]` compatible
 * with most instruction-tuning pipelines.
 *
 * @param {string} jobId
 * @param {{ format?: "jsonl" | "messages", markExported?: boolean }} [opts]
 * @returns {Promise<{ jobId: string, format: string, count: number, examples: any[] }>}
 */
export async function exportTrainingSet(jobId, opts = {}) {
  if (!jobId || typeof jobId !== "string") throw new Error("jobId is required");
  const data = await loadJobs();
  const job = data.jobs[jobId];
  if (!job) throw new Error(`unknown job: ${jobId}`);

  const tData = await loadTraces(jobId);
  const format = opts.format === "messages" ? "messages" : "jsonl";

  const examples = tData.traces.map((t) => {
    if (format === "messages") {
      return {
        messages: [
          { role: "user", content: typeof t.input === "string" ? t.input : JSON.stringify(t.input) },
          { role: "assistant", content: typeof t.output === "string" ? t.output : JSON.stringify(t.output) },
        ],
        meta: t.metadata || {},
      };
    }
    return {
      prompt: typeof t.input === "string" ? t.input : JSON.stringify(t.input),
      completion: typeof t.output === "string" ? t.output : JSON.stringify(t.output),
      meta: t.metadata || {},
    };
  });

  if (opts.markExported) {
    await withPathLock(jobsPath(), async () => {
      const d2 = await loadJobs();
      const j2 = d2.jobs[jobId];
      if (j2) {
        j2.status = "exported";
        j2.exportedAt = new Date().toISOString();
        j2.updatedAt = j2.exportedAt;
        d2.jobs[jobId] = j2;
        await saveJobs(d2);
      }
    });
  }

  return {
    jobId,
    format,
    count: examples.length,
    examples,
  };
}

/* -------------------------------------------------------------------------- */
/* Status / listing                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Return the current state of a single job.
 *
 * @param {string} jobId
 * @returns {Promise<DistillationJob | null>}
 */
export async function jobStatus(jobId) {
  if (!jobId || typeof jobId !== "string") return null;
  const data = await loadJobs();
  return data.jobs[jobId] || null;
}

/**
 * List every distillation job.
 *
 * @returns {Promise<DistillationJob[]>}
 */
export async function listJobs() {
  const data = await loadJobs();
  return Object.values(data.jobs || {});
}

/**
 * Update the status of a job. Useful for archival and manual
 * intervention. Rejects unknown statuses.
 *
 * @param {string} jobId
 * @param {string} status
 */
export async function setJobStatus(jobId, status) {
  if (!VALID_STATUSES.has(status)) {
    throw new Error(`invalid status: ${status}`);
  }
  const path = jobsPath();
  return withPathLock(path, async () => {
    const data = await loadJobs();
    const job = data.jobs[jobId];
    if (!job) throw new Error(`unknown job: ${jobId}`);
    job.status = status;
    job.updatedAt = new Date().toISOString();
    data.jobs[jobId] = job;
    await saveJobs(data);
    return job;
  });
}
