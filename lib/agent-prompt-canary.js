/**
 * Canary A/B rollout for prompt patches.
 *
 * Replaces apply-all-or-nothing with a staged rollout: a fraction of agent
 * runs are routed to the candidate patch, the rest to the baseline (the
 * previously-applied patch). Outcome metrics are collected per arm and
 * compared; the canary either promotes (wins), rolls back (regresses), or
 * continues (still collecting).
 *
 * Routing is deterministic per runId so the same run always sees the same
 * arm (critical for correctly attributing outcomes to a single arm).
 *
 * Storage: data/prompt-canary/<ws>/canaries.json with shape
 *   { version: 1, updatedAt, active: CanaryDeployment | null, history: [...] }
 *
 * @module agent-prompt-canary
 */

import { join } from "path";
import { createHash } from "crypto";
import { readJsonPath, writeJsonPath, getDataDir } from "./json-path-store.js";
import { listPatches, getActivePatch } from "./agent-prompt-tuner.js";

const MAX_HISTORY = 50;
const DEFAULT_TRAFFIC_SPLIT = 0.1;
const DEFAULT_DURATION_HOURS = 24;
const DEFAULT_MIN_SAMPLES_PER_ARM = 20;
const DEFAULT_METRICS = ["feedbackUpRate", "benchmarkPassRate"];
const DEFAULT_PASS_DELTA = 0.02;
const DEFAULT_FAIL_DELTA = 0.05;

/**
 * @typedef {object} CanaryDeployment
 * @property {string} workspace
 * @property {string} candidateVersion
 * @property {string | null} baselineVersion
 * @property {number} trafficSplit
 * @property {number} startedAt
 * @property {number} endsAt
 * @property {number} minSamplesPerArm
 * @property {"active"|"promoted"|"rolled_back"|"expired"} status
 * @property {string[]} metrics
 * @property {{passDelta: number, failDelta: number}} thresholds
 * @property {Record<string, {candidateN: number, baselineN: number, candidateValue: number, baselineValue: number}>} results
 * @property {string} [decisionReason]
 * @property {number} [decidedAt]
 */

function sanitizeSegment(s) {
  if (typeof s !== "string" || s.length === 0) return "default";
  return s.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80);
}

function storePath(workspace) {
  return join(getDataDir(), "prompt-canary", sanitizeSegment(workspace), "canaries.json");
}

function emptyStore() {
  return { version: 1, updatedAt: 0, active: null, history: [] };
}

async function loadStore(workspace) {
  const raw = await readJsonPath(storePath(workspace), emptyStore());
  if (!raw || typeof raw !== "object") return emptyStore();
  if (!Array.isArray(raw.history)) raw.history = [];
  if (raw.active === undefined) raw.active = null;
  if (typeof raw.version !== "number") raw.version = 1;
  return raw;
}

async function saveStore(workspace, store) {
  store.updatedAt = Date.now();
  await writeJsonPath(storePath(workspace), store);
}

function emptyResults(metrics) {
  const r = {};
  for (const m of metrics) {
    r[m] = { candidateN: 0, baselineN: 0, candidateValue: 0, baselineValue: 0 };
  }
  return r;
}

/**
 * Is the canary system enabled?
 * @returns {boolean}
 */
export function canaryEnabled() {
  return process.env.PROMPT_CANARY_ENABLED !== "0";
}

/**
 * Start a canary deployment for a candidate patch version.
 *
 * @param {string} workspace
 * @param {object} params
 * @param {string} params.candidateVersion
 * @param {number} [params.trafficSplit]
 * @param {number} [params.durationHours]
 * @param {number} [params.minSamplesPerArm]
 * @param {string[]} [params.metrics]
 * @param {{passDelta?: number, failDelta?: number}} [params.thresholds]
 * @returns {Promise<CanaryDeployment>}
 */
export async function startCanary(workspace, params) {
  const ws = typeof workspace === "string" && workspace.length > 0 ? workspace : "default";
  if (!params || typeof params !== "object") throw new Error("startCanary: params required");
  const { candidateVersion } = params;
  if (typeof candidateVersion !== "string" || candidateVersion.length === 0) {
    throw new Error("startCanary: candidateVersion required");
  }

  const store = await loadStore(ws);
  if (store.active && store.active.status === "active") {
    throw new Error(
      `startCanary: a canary is already active for workspace "${ws}" (candidate=${store.active.candidateVersion})`,
    );
  }

  // Validate candidate exists and is pending or freshly-applied.
  const patches = await listPatches(ws, { limit: 500 });
  const candidate = patches.find((p) => p.version === candidateVersion);
  if (!candidate) {
    throw new Error(`startCanary: candidate patch "${candidateVersion}" not found in workspace "${ws}"`);
  }
  if (candidate.status === "rejected") {
    throw new Error(`startCanary: candidate patch "${candidateVersion}" is rejected`);
  }

  // Baseline = currently-applied patch (excluding the candidate itself).
  const active = await getActivePatch(ws);
  const baselineVersion = active && active.version !== candidateVersion ? active.version : null;

  const trafficSplit = clamp01(
    typeof params.trafficSplit === "number" && Number.isFinite(params.trafficSplit)
      ? params.trafficSplit
      : DEFAULT_TRAFFIC_SPLIT,
  );
  const durationHours = Number.isFinite(params.durationHours) && params.durationHours > 0
    ? params.durationHours
    : DEFAULT_DURATION_HOURS;
  const minSamplesPerArm = Number.isFinite(params.minSamplesPerArm) && params.minSamplesPerArm > 0
    ? Math.floor(params.minSamplesPerArm)
    : DEFAULT_MIN_SAMPLES_PER_ARM;
  const metrics = Array.isArray(params.metrics) && params.metrics.length > 0
    ? params.metrics.map((m) => String(m)).filter((m) => m.length > 0)
    : DEFAULT_METRICS.slice();
  const thresholds = {
    passDelta: Number.isFinite(params?.thresholds?.passDelta)
      ? params.thresholds.passDelta
      : DEFAULT_PASS_DELTA,
    failDelta: Number.isFinite(params?.thresholds?.failDelta)
      ? params.thresholds.failDelta
      : DEFAULT_FAIL_DELTA,
  };

  const now = Date.now();
  /** @type {CanaryDeployment} */
  const deployment = {
    workspace: ws,
    candidateVersion,
    baselineVersion,
    trafficSplit,
    startedAt: now,
    endsAt: now + durationHours * 60 * 60 * 1000,
    minSamplesPerArm,
    status: "active",
    metrics,
    thresholds,
    results: emptyResults(metrics),
  };

  store.active = deployment;
  await saveStore(ws, store);
  return deployment;
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * @param {string} workspace
 * @returns {Promise<CanaryDeployment | null>}
 */
export async function getActiveCanary(workspace) {
  const ws = typeof workspace === "string" && workspace.length > 0 ? workspace : "default";
  const store = await loadStore(ws);
  if (store.active && store.active.status === "active") return store.active;
  return null;
}

/**
 * Deterministic hash: return uniform [0, 1) from SHA256(runId|workspace).
 */
function bucketFor(runId, workspace) {
  const h = createHash("sha256").update(`${runId}|${workspace}`).digest("hex").slice(0, 8);
  const n = parseInt(h, 16);
  return n / 0xffffffff;
}

/**
 * Should this runId see the candidate patch?
 *
 * Deterministic: same runId+workspace → same answer. Returns false if there
 * is no active canary or the canary has passed its deadline (callers should
 * also call evaluateCanary to trigger the terminal decision).
 *
 * @param {string} workspace
 * @param {string} runId
 * @returns {Promise<boolean>}
 */
export async function shouldUseCandidate(workspace, runId) {
  if (typeof runId !== "string" || runId.length === 0) return false;
  const active = await getActiveCanary(workspace);
  if (!active) return false;
  if (Date.now() > active.endsAt) return false;
  const b = bucketFor(runId, active.workspace);
  return b < active.trafficSplit;
}

/**
 * Record a single outcome sample for a metric on either arm.
 *
 * Running mean:
 *   newMean = (oldMean * oldN + value) / (oldN + 1)
 *
 * @param {string} workspace
 * @param {"candidate"|"baseline"} arm
 * @param {string} metricName
 * @param {number} value
 * @returns {Promise<void>}
 */
export async function recordOutcome(workspace, arm, metricName, value) {
  if (arm !== "candidate" && arm !== "baseline") {
    throw new Error(`recordOutcome: invalid arm "${arm}"`);
  }
  if (typeof metricName !== "string" || metricName.length === 0) {
    throw new Error("recordOutcome: metricName required");
  }
  const v = Number(value);
  if (!Number.isFinite(v)) throw new Error("recordOutcome: value must be finite number");

  const ws = typeof workspace === "string" && workspace.length > 0 ? workspace : "default";
  const store = await loadStore(ws);
  if (!store.active || store.active.status !== "active") return;

  const results = store.active.results || {};
  if (!results[metricName]) {
    results[metricName] = { candidateN: 0, baselineN: 0, candidateValue: 0, baselineValue: 0 };
  }
  const bucket = results[metricName];
  if (arm === "candidate") {
    const n = bucket.candidateN;
    bucket.candidateValue = (bucket.candidateValue * n + v) / (n + 1);
    bucket.candidateN = n + 1;
  } else {
    const n = bucket.baselineN;
    bucket.baselineValue = (bucket.baselineValue * n + v) / (n + 1);
    bucket.baselineN = n + 1;
  }
  store.active.results = results;
  await saveStore(ws, store);
}

/**
 * Evaluate the current canary and decide whether to promote, rollback, or
 * continue collecting. Does not mutate state — callers invoke promote/rollback
 * to finalize.
 *
 * @param {string} workspace
 * @returns {Promise<{decision: "promote"|"rollback"|"continue", reason: string}>}
 */
export async function evaluateCanary(workspace) {
  const ws = typeof workspace === "string" && workspace.length > 0 ? workspace : "default";
  const active = await getActiveCanary(ws);
  if (!active) return { decision: "continue", reason: "no active canary" };

  const now = Date.now();
  const expired = now > active.endsAt;
  const required = Array.isArray(active.metrics) ? active.metrics : DEFAULT_METRICS;
  const minN = active.minSamplesPerArm || DEFAULT_MIN_SAMPLES_PER_ARM;
  const results = active.results || {};
  const thresholds = active.thresholds || { passDelta: DEFAULT_PASS_DELTA, failDelta: DEFAULT_FAIL_DELTA };

  // Check regressions first: a failing metric with enough candidate samples
  // should trigger rollback regardless of deadline.
  for (const m of required) {
    const b = results[m];
    if (!b) continue;
    if (b.candidateN < minN) continue;
    const delta = b.candidateValue - b.baselineValue;
    if (delta < -thresholds.failDelta) {
      return { decision: "rollback", reason: `regression on ${m} (delta=${delta.toFixed(4)})` };
    }
  }

  // Under-sampled check: if any required metric on the candidate arm doesn't
  // have enough samples yet and we're not past the deadline, keep collecting.
  let underSampled = false;
  for (const m of required) {
    const b = results[m];
    if (!b || b.candidateN < minN || b.baselineN < minN) {
      underSampled = true;
      break;
    }
  }

  if (underSampled) {
    if (expired) {
      return { decision: "rollback", reason: "insufficient samples before deadline" };
    }
    return { decision: "continue", reason: "collecting samples" };
  }

  // All metrics have enough samples and none are regressing.
  let allPass = true;
  const deltas = [];
  for (const m of required) {
    const b = results[m];
    const delta = b.candidateValue - b.baselineValue;
    deltas.push(`${m}=${delta.toFixed(4)}`);
    if (delta < thresholds.passDelta) allPass = false;
  }

  if (allPass) {
    return { decision: "promote", reason: `all metrics pass (${deltas.join(", ")})` };
  }

  if (expired) {
    // Past deadline, no regression, but not clearly improving either: promote
    // since "no regression" with enough samples means candidate is at worst
    // on-par with baseline. This matches the spec: "Date.now() > endsAt with
    // no regression: promote".
    return { decision: "promote", reason: `deadline reached with no regression (${deltas.join(", ")})` };
  }

  return { decision: "continue", reason: `mixed signal, still collecting (${deltas.join(", ")})` };
}

function archiveActive(store) {
  if (!store.active) return;
  const d = store.active;
  d.decidedAt = Date.now();
  store.history = [d, ...(store.history || [])].slice(0, MAX_HISTORY);
  store.active = null;
}

/**
 * @param {string} workspace
 * @returns {Promise<CanaryDeployment>}
 */
export async function promoteCanary(workspace) {
  const ws = typeof workspace === "string" && workspace.length > 0 ? workspace : "default";
  const store = await loadStore(ws);
  if (!store.active || store.active.status !== "active") {
    throw new Error(`promoteCanary: no active canary for workspace "${ws}"`);
  }
  store.active.status = "promoted";
  store.active.decisionReason = store.active.decisionReason || "promoted";
  const snapshot = { ...store.active };
  archiveActive(store);
  await saveStore(ws, store);
  return snapshot;
}

/**
 * @param {string} workspace
 * @param {string} [reason]
 * @returns {Promise<CanaryDeployment>}
 */
export async function rollbackCanary(workspace, reason) {
  const ws = typeof workspace === "string" && workspace.length > 0 ? workspace : "default";
  const store = await loadStore(ws);
  if (!store.active || store.active.status !== "active") {
    throw new Error(`rollbackCanary: no active canary for workspace "${ws}"`);
  }
  const r = typeof reason === "string" && reason.length > 0 ? reason : "rolled back";
  store.active.status = "rolled_back";
  store.active.decisionReason = r;
  const snapshot = { ...store.active };
  archiveActive(store);
  await saveStore(ws, store);
  return snapshot;
}

/**
 * List historical + active canaries for a workspace, newest-first.
 * @param {string} workspace
 * @param {{limit?: number, status?: "active"|"promoted"|"rolled_back"|"expired"}} [opts]
 * @returns {Promise<CanaryDeployment[]>}
 */
export async function listCanaries(workspace, opts = {}) {
  const ws = typeof workspace === "string" && workspace.length > 0 ? workspace : "default";
  const store = await loadStore(ws);
  const all = [];
  if (store.active) all.push(store.active);
  for (const d of store.history || []) all.push(d);
  let filtered = all;
  if (opts && typeof opts.status === "string") {
    filtered = filtered.filter((d) => d.status === opts.status);
  }
  filtered.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  const limit = Number(opts?.limit);
  if (Number.isFinite(limit) && limit > 0) {
    filtered = filtered.slice(0, Math.floor(limit));
  }
  return filtered;
}

/**
 * Get a specific canary by candidate version (active or historical).
 * @param {string} workspace
 * @param {string} version
 * @returns {Promise<CanaryDeployment | null>}
 */
export async function getCanary(workspace, version) {
  const ws = typeof workspace === "string" && workspace.length > 0 ? workspace : "default";
  const store = await loadStore(ws);
  if (store.active && store.active.candidateVersion === version) return store.active;
  const match = (store.history || []).find((d) => d.candidateVersion === version);
  return match || null;
}
