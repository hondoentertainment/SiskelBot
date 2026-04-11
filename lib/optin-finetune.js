// @ts-check
/**
 * Phase 69.5: Opt-in fine-tune job management.
 *
 * Models a light-weight queue for personal fine-tune jobs. Users must
 * explicitly record consent before a job can be started; consent can
 * be revoked at any time. Jobs are purely metadata (no model training
 * happens here) — the module is storage + state machine.
 *
 * Lifecycle: queued -> running -> completed | failed | cancelled
 *
 * Exports:
 *   - recordConsent
 *   - startFineTuneJob
 *   - getJobStatus
 *   - listJobs
 *   - revokeConsent
 *
 * @module optin-finetune
 */
import { join } from "path";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;

function consentPath() {
  return join(getDataDir(), "optin-finetune-consent.json");
}

function jobsPath() {
  return join(getDataDir(), "optin-finetune-jobs.json");
}

async function loadConsent() {
  const data = await readJsonPath(consentPath(), { version: STORE_VERSION, consents: {} });
  if (!data.consents || typeof data.consents !== "object") data.consents = {};
  return data;
}

async function saveConsent(data) {
  await writeJsonPath(consentPath(), { version: STORE_VERSION, consents: data.consents || {} });
}

async function loadJobs() {
  const data = await readJsonPath(jobsPath(), { version: STORE_VERSION, jobs: {} });
  if (!data.jobs || typeof data.jobs !== "object") data.jobs = {};
  return data;
}

async function saveJobs(data) {
  await writeJsonPath(jobsPath(), { version: STORE_VERSION, jobs: data.jobs || {} });
}

/**
 * Record that a user has consented to personalized fine-tuning with
 * specific terms. Returns the stored consent record.
 *
 * @param {string} userId
 * @param {{ terms: string, scope?: string[] }} spec
 * @returns {Promise<object>}
 */
export async function recordConsent(userId, spec) {
  if (!userId || typeof userId !== "string") throw new Error("userId is required");
  if (!spec || typeof spec !== "object") throw new Error("spec is required");
  if (!spec.terms || typeof spec.terms !== "string") throw new Error("terms is required");
  const path = consentPath();
  return withPathLock(path, async () => {
    const data = await loadConsent();
    const now = new Date().toISOString();
    const record = {
      userId,
      terms: spec.terms,
      scope: Array.isArray(spec.scope) ? spec.scope.slice() : [],
      granted: true,
      grantedAt: now,
      revokedAt: null,
    };
    data.consents[userId] = record;
    await saveConsent(data);
    return record;
  });
}

/**
 * Revoke previously-granted consent. Any queued or running jobs for
 * the user are marked cancelled.
 *
 * @param {string} userId
 * @returns {Promise<{ userId: string, granted: false, cancelled: number }>}
 */
export async function revokeConsent(userId) {
  if (!userId || typeof userId !== "string") throw new Error("userId is required");
  const now = new Date().toISOString();
  await withPathLock(consentPath(), async () => {
    const data = await loadConsent();
    if (!data.consents[userId]) {
      data.consents[userId] = { userId, terms: "", scope: [], granted: false };
    }
    data.consents[userId].granted = false;
    data.consents[userId].revokedAt = now;
    await saveConsent(data);
  });
  let cancelled = 0;
  await withPathLock(jobsPath(), async () => {
    const data = await loadJobs();
    for (const job of Object.values(data.jobs || {})) {
      if (job.userId !== userId) continue;
      if (job.status === "queued" || job.status === "running") {
        job.status = "cancelled";
        job.cancelledAt = now;
        data.jobs[job.id] = job;
        cancelled += 1;
      }
    }
    await saveJobs(data);
  });
  return { userId, granted: false, cancelled };
}

function consentValid(consent) {
  return Boolean(consent && consent.granted === true);
}

/**
 * Queue a new fine-tune job for a user (pending active consent).
 *
 * @param {string} userId
 * @param {{ baseModel: string, datasetId: string, hyperparams?: object }} spec
 * @returns {Promise<object>}
 */
export async function startFineTuneJob(userId, spec) {
  if (!userId || typeof userId !== "string") throw new Error("userId is required");
  if (!spec || typeof spec !== "object") throw new Error("spec is required");
  if (!spec.baseModel || typeof spec.baseModel !== "string") throw new Error("baseModel is required");
  if (!spec.datasetId || typeof spec.datasetId !== "string") throw new Error("datasetId is required");
  const consents = await loadConsent();
  if (!consentValid(consents.consents[userId])) {
    throw new Error("consent not granted");
  }
  const path = jobsPath();
  return withPathLock(path, async () => {
    const data = await loadJobs();
    const now = new Date().toISOString();
    const id = `ft_${userId}_${Date.now()}`;
    const job = {
      id,
      userId,
      baseModel: spec.baseModel,
      datasetId: spec.datasetId,
      hyperparams: spec.hyperparams && typeof spec.hyperparams === "object" ? spec.hyperparams : {},
      status: "queued",
      createdAt: now,
      updatedAt: now,
      progress: 0,
    };
    data.jobs[id] = job;
    await saveJobs(data);
    return job;
  });
}

/**
 * Fetch the current status of a job by id.
 * @param {string} jobId
 * @returns {Promise<object | null>}
 */
export async function getJobStatus(jobId) {
  if (!jobId || typeof jobId !== "string") return null;
  const data = await loadJobs();
  return data.jobs[jobId] || null;
}

/**
 * List jobs, optionally filtered by user.
 *
 * @param {{ userId?: string, status?: string }} [opts]
 * @returns {Promise<object[]>}
 */
export async function listJobs(opts = {}) {
  const data = await loadJobs();
  let out = Object.values(data.jobs || {});
  if (opts.userId) out = out.filter((j) => j.userId === opts.userId);
  if (opts.status) out = out.filter((j) => j.status === opts.status);
  out.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  return out;
}

/**
 * Advance a job to a new status. Intended to be called by a background
 * worker; exported to keep lifecycle logic centralized.
 *
 * @param {string} jobId
 * @param {"running" | "completed" | "failed" | "cancelled"} status
 * @param {{ progress?: number, error?: string }} [opts]
 * @returns {Promise<object>}
 */
export async function advanceJob(jobId, status, opts = {}) {
  if (!jobId || typeof jobId !== "string") throw new Error("jobId is required");
  const valid = new Set(["running", "completed", "failed", "cancelled"]);
  if (!valid.has(status)) throw new Error("invalid status");
  const path = jobsPath();
  return withPathLock(path, async () => {
    const data = await loadJobs();
    const job = data.jobs[jobId];
    if (!job) throw new Error(`unknown job: ${jobId}`);
    job.status = status;
    job.updatedAt = new Date().toISOString();
    if (Number.isFinite(opts.progress)) job.progress = Math.max(0, Math.min(1, opts.progress));
    if (status === "failed" && opts.error) job.error = opts.error;
    data.jobs[jobId] = job;
    await saveJobs(data);
    return job;
  });
}
