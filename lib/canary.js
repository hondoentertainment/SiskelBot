/**
 * Phase 59.4: Canary deployments + traffic shifting.
 *
 * Gradually shifts traffic from version A to version B across named phases
 * (initial → expansion → majority → dominant → complete). Each phase has a
 * target percentage and a minimum duration. Health samples drive automatic
 * promotion or abort via `checkHealthGate` + `autoAdvanceOrAbort`.
 *
 * Storage layout (via json-path-store):
 *   data/canary/{id}.json   — deployment record (phases, health, history)
 *   data/canary/_index.json — registry of known deployment ids
 */
import { randomUUID, createHash } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

// ─── Phase definitions ──────────────────────────────────────────────────────

export const CANARY_PHASES = [
  { name: "initial", percentage: 1, minDurationMs: 5 * 60 * 1000 },
  { name: "expansion", percentage: 5, minDurationMs: 15 * 60 * 1000 },
  { name: "majority", percentage: 25, minDurationMs: 30 * 60 * 1000 },
  { name: "dominant", percentage: 75, minDurationMs: 30 * 60 * 1000 },
  { name: "complete", percentage: 100, minDurationMs: 0 },
];

export const DEFAULT_HEALTH_CHECKS = {
  maxErrorRate: 0.05,       // 5% error rate triggers abort
  maxLatencyP95Ms: 5000,    // 5s p95 latency
  minSamples: 10,           // need at least 10 samples before gating
  maxErrorRateDelta: 0.02,  // B cannot be >2% worse than A
};

// ─── Status constants ───────────────────────────────────────────────────────

export const STATUS_CREATED = "created";
export const STATUS_RUNNING = "running";
export const STATUS_PAUSED = "paused";
export const STATUS_COMPLETED = "completed";
export const STATUS_ABORTED = "aborted";
export const STATUS_ROLLED_BACK = "rolled_back";

// ─── Path helpers ───────────────────────────────────────────────────────────

function sanitize(value) {
  return String(value || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || "default";
}

function deploymentPath(id) {
  return join(getDataDir(), "canary", `${sanitize(id)}.json`);
}

function indexPath() {
  return join(getDataDir(), "canary", "_index.json");
}

// ─── Index helpers ──────────────────────────────────────────────────────────

async function updateIndex(id, remove = false, entry = null) {
  return withPathLock(indexPath(), async () => {
    const idx = await readJsonPath(indexPath(), { deployments: [] });
    const list = Array.isArray(idx.deployments) ? idx.deployments : [];
    const filtered = list.filter((e) => e.id !== id);
    if (!remove && entry) filtered.push(entry);
    await writeJsonPath(indexPath(), { deployments: filtered });
  });
}

// ─── CRUD ───────────────────────────────────────────────────────────────────

/**
 * Create a new canary deployment record. Defaults to the standard 5-phase
 * schedule unless `phases` is supplied.
 */
export async function createDeployment({ name, versionA, versionB, phases, healthChecks } = {}) {
  if (!name || typeof name !== "string") {
    throw new Error("name is required");
  }
  if (!versionA || typeof versionA !== "string") {
    throw new Error("versionA is required");
  }
  if (!versionB || typeof versionB !== "string") {
    throw new Error("versionB is required");
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  const phaseList = Array.isArray(phases) && phases.length > 0
    ? phases.map((p) => ({
        name: String(p.name),
        percentage: Number(p.percentage),
        minDurationMs: Number(p.minDurationMs) || 0,
      }))
    : CANARY_PHASES.map((p) => ({ ...p }));
  const gates = { ...DEFAULT_HEALTH_CHECKS, ...(healthChecks || {}) };
  const record = {
    id,
    name,
    versionA,
    versionB,
    phases: phaseList,
    healthChecks: gates,
    status: STATUS_CREATED,
    currentPhaseIndex: -1,
    currentPercentage: 0,
    createdAt: now,
    updatedAt: now,
    phaseStartedAt: null,
    startedAt: null,
    completedAt: null,
    abortedAt: null,
    abortReason: null,
    health: { A: [], B: [] },
    history: [
      { at: now, type: "created", data: { name, versionA, versionB } },
    ],
  };
  await writeJsonPath(deploymentPath(id), record);
  await updateIndex(id, false, { id, name, createdAt: now });
  return record;
}

export async function getDeployment(id) {
  if (!id) return null;
  const data = await readJsonPath(deploymentPath(id), null);
  if (!data || !data.id || data._deleted) return null;
  return data;
}

/**
 * List deployments. Supports optional filtering by status or name.
 */
export async function listDeployments(filter = {}) {
  const idx = await readJsonPath(indexPath(), { deployments: [] });
  const entries = Array.isArray(idx.deployments) ? idx.deployments : [];
  const records = [];
  for (const entry of entries) {
    const rec = await getDeployment(entry.id);
    if (!rec) continue;
    if (filter.status && rec.status !== filter.status) continue;
    if (filter.name && rec.name !== filter.name) continue;
    records.push(rec);
  }
  return records;
}

export async function deleteDeployment(id) {
  const rec = await getDeployment(id);
  if (!rec) return { ok: false, code: "NOT_FOUND" };
  await writeJsonPath(deploymentPath(id), { _deleted: true });
  await updateIndex(id, true);
  return { ok: true };
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────

async function mutateDeployment(id, mutator) {
  return withPathLock(deploymentPath(id), async () => {
    const rec = await readJsonPath(deploymentPath(id), null);
    if (!rec || !rec.id || rec._deleted) {
      const err = new Error(`deployment ${id} not found`);
      err.code = "NOT_FOUND";
      throw err;
    }
    const updated = await mutator(rec);
    if (updated) {
      updated.updatedAt = new Date().toISOString();
      await writeJsonPath(deploymentPath(id), updated);
      return updated;
    }
    return rec;
  });
}

export async function startDeployment(deploymentId) {
  return mutateDeployment(deploymentId, (rec) => {
    if (rec.status === STATUS_RUNNING) return rec;
    if (rec.status === STATUS_COMPLETED || rec.status === STATUS_ABORTED ||
        rec.status === STATUS_ROLLED_BACK) {
      const err = new Error(`cannot start deployment in status ${rec.status}`);
      err.code = "INVALID_STATE";
      throw err;
    }
    const now = new Date().toISOString();
    rec.status = STATUS_RUNNING;
    rec.startedAt = rec.startedAt || now;
    rec.currentPhaseIndex = 0;
    rec.currentPercentage = rec.phases[0]?.percentage ?? 0;
    rec.phaseStartedAt = now;
    rec.history.push({
      at: now,
      type: "started",
      data: { phase: rec.phases[0]?.name, percentage: rec.currentPercentage },
    });
    return rec;
  });
}

export async function pauseDeployment(deploymentId) {
  return mutateDeployment(deploymentId, (rec) => {
    if (rec.status !== STATUS_RUNNING) {
      const err = new Error(`cannot pause deployment in status ${rec.status}`);
      err.code = "INVALID_STATE";
      throw err;
    }
    const now = new Date().toISOString();
    rec.status = STATUS_PAUSED;
    rec.history.push({ at: now, type: "paused", data: {} });
    return rec;
  });
}

export async function resumeDeployment(deploymentId) {
  return mutateDeployment(deploymentId, (rec) => {
    if (rec.status !== STATUS_PAUSED) {
      const err = new Error(`cannot resume deployment in status ${rec.status}`);
      err.code = "INVALID_STATE";
      throw err;
    }
    const now = new Date().toISOString();
    rec.status = STATUS_RUNNING;
    rec.history.push({ at: now, type: "resumed", data: {} });
    return rec;
  });
}

export async function abortDeployment(deploymentId, reason) {
  return mutateDeployment(deploymentId, (rec) => {
    if (rec.status === STATUS_ABORTED || rec.status === STATUS_COMPLETED ||
        rec.status === STATUS_ROLLED_BACK) {
      return rec;
    }
    const now = new Date().toISOString();
    rec.status = STATUS_ABORTED;
    rec.abortedAt = now;
    rec.abortReason = reason || "aborted";
    rec.currentPercentage = 0;
    rec.history.push({ at: now, type: "aborted", data: { reason: rec.abortReason } });
    return rec;
  });
}

/**
 * Advance to the next phase regardless of duration gate. For manual promotion.
 */
export async function advancePhase(deploymentId) {
  return mutateDeployment(deploymentId, (rec) => {
    if (rec.status !== STATUS_RUNNING) {
      const err = new Error(`cannot advance deployment in status ${rec.status}`);
      err.code = "INVALID_STATE";
      throw err;
    }
    const nextIndex = rec.currentPhaseIndex + 1;
    if (nextIndex >= rec.phases.length) {
      // Already at the final phase — mark complete.
      const now = new Date().toISOString();
      rec.status = STATUS_COMPLETED;
      rec.completedAt = now;
      rec.currentPercentage = 100;
      rec.history.push({ at: now, type: "completed", data: {} });
      return rec;
    }
    const phase = rec.phases[nextIndex];
    const now = new Date().toISOString();
    rec.currentPhaseIndex = nextIndex;
    rec.currentPercentage = phase.percentage;
    rec.phaseStartedAt = now;
    rec.history.push({
      at: now,
      type: "phase_advanced",
      data: { phase: phase.name, percentage: phase.percentage },
    });
    if (phase.percentage >= 100) {
      rec.status = STATUS_COMPLETED;
      rec.completedAt = now;
      rec.history.push({ at: now, type: "completed", data: {} });
    }
    return rec;
  });
}

// ─── Hash-based routing ────────────────────────────────────────────────────

/**
 * Map an arbitrary string to an integer percentile 0..99.
 * Deterministic SHA-256-backed hash ensures cross-process stability.
 */
export function hashToPercentile(key) {
  const hash = createHash("sha256").update(String(key ?? "")).digest();
  // Take the first 4 bytes as an unsigned int.
  const n = hash.readUInt32BE(0);
  return n % 100;
}

/**
 * Returns true if the key should route to the "B" bucket given a percentage.
 * `percentage` is 0..100; percentiles 0..percentage-1 go to B.
 */
export function routeByPercentage(key, percentage) {
  const pct = Math.max(0, Math.min(100, Number(percentage) || 0));
  if (pct <= 0) return false;
  if (pct >= 100) return true;
  return hashToPercentile(key) < pct;
}

/**
 * Synchronous traffic routing helper. Expects the deployment record (or
 * percentage) to already be loaded. The deployment passed here is cached by
 * the caller — we avoid IO for hot paths.
 */
export function routeTraffic(deployment, requestKey) {
  // Support passing a raw percentage for convenience.
  let pct = 0;
  let status = STATUS_RUNNING;
  if (typeof deployment === "number") {
    pct = deployment;
  } else if (deployment && typeof deployment === "object") {
    pct = deployment.currentPercentage ?? 0;
    status = deployment.status;
  }
  if (status !== STATUS_RUNNING && status !== STATUS_COMPLETED) {
    return "A";
  }
  return routeByPercentage(requestKey, pct) ? "B" : "A";
}

// ─── Health samples ────────────────────────────────────────────────────────

/**
 * Record a health sample for a given version ("A" or "B"). Stored inline on
 * the deployment record (bounded to last 1000 per version).
 *
 * sample shape: { ok, latencyMs, status, errorKind, at }
 */
export async function recordHealthSample(deploymentId, version, metric = {}) {
  if (version !== "A" && version !== "B") {
    throw new Error("version must be 'A' or 'B'");
  }
  return mutateDeployment(deploymentId, (rec) => {
    const at = metric.at || new Date().toISOString();
    const sample = {
      at,
      ok: metric.ok !== false && (metric.error == null),
      latencyMs: typeof metric.latencyMs === "number" ? metric.latencyMs : null,
      ...(metric.status != null ? { status: metric.status } : {}),
      ...(metric.errorKind ? { errorKind: String(metric.errorKind) } : {}),
      ...(metric.error ? { error: String(metric.error) } : {}),
      ...(typeof metric.satisfaction === "number" ? { satisfaction: metric.satisfaction } : {}),
    };
    if (!rec.health) rec.health = { A: [], B: [] };
    if (!Array.isArray(rec.health[version])) rec.health[version] = [];
    rec.health[version].push(sample);
    // Bound memory: keep last 1000 per version.
    if (rec.health[version].length > 1000) {
      rec.health[version] = rec.health[version].slice(-1000);
    }
    return rec;
  });
}

function summarizeVersion(samples) {
  const arr = Array.isArray(samples) ? samples : [];
  const count = arr.length;
  if (count === 0) {
    return {
      samples: 0,
      errorRate: 0,
      successRate: 0,
      avgLatencyMs: 0,
      p50LatencyMs: 0,
      p95LatencyMs: 0,
      p99LatencyMs: 0,
      satisfaction: null,
    };
  }
  const errors = arr.filter((s) => s.ok === false).length;
  const latencies = arr
    .map((s) => s.latencyMs)
    .filter((v) => typeof v === "number" && Number.isFinite(v))
    .sort((a, b) => a - b);
  const sum = latencies.reduce((a, b) => a + b, 0);
  const pick = (q) => (latencies.length === 0 ? 0 : latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))]);
  const satisfactionVals = arr
    .map((s) => s.satisfaction)
    .filter((v) => typeof v === "number" && Number.isFinite(v));
  const satisfaction = satisfactionVals.length
    ? satisfactionVals.reduce((a, b) => a + b, 0) / satisfactionVals.length
    : null;
  return {
    samples: count,
    errorRate: errors / count,
    successRate: (count - errors) / count,
    avgLatencyMs: latencies.length ? sum / latencies.length : 0,
    p50LatencyMs: pick(0.5),
    p95LatencyMs: pick(0.95),
    p99LatencyMs: pick(0.99),
    satisfaction,
  };
}

export async function getHealthSummary(deploymentId) {
  const rec = await getDeployment(deploymentId);
  if (!rec) {
    const err = new Error(`deployment ${deploymentId} not found`);
    err.code = "NOT_FOUND";
    throw err;
  }
  return {
    A: summarizeVersion(rec.health?.A),
    B: summarizeVersion(rec.health?.B),
  };
}

/**
 * Evaluate whether a deployment's B-version is healthy enough to continue.
 * Returns { passed: bool, reason?, metrics }.
 *
 * Rules:
 *  - If fewer than `minSamples` B samples → passed=true, reason="not_enough_samples".
 *  - If B errorRate > maxErrorRate → fail.
 *  - If B p95 latency > maxLatencyP95Ms → fail.
 *  - If B errorRate - A errorRate > maxErrorRateDelta → fail (B is noticeably worse).
 */
export async function checkHealthGate(deploymentId) {
  const rec = await getDeployment(deploymentId);
  if (!rec) {
    const err = new Error(`deployment ${deploymentId} not found`);
    err.code = "NOT_FOUND";
    throw err;
  }
  const gates = { ...DEFAULT_HEALTH_CHECKS, ...(rec.healthChecks || {}) };
  const metrics = {
    A: summarizeVersion(rec.health?.A),
    B: summarizeVersion(rec.health?.B),
  };
  if (metrics.B.samples < (gates.minSamples || 1)) {
    return { passed: true, reason: "not_enough_samples", metrics, gates };
  }
  if (metrics.B.errorRate > gates.maxErrorRate) {
    return {
      passed: false,
      reason: `B error rate ${(metrics.B.errorRate * 100).toFixed(2)}% exceeds ${(gates.maxErrorRate * 100).toFixed(2)}%`,
      metrics,
      gates,
    };
  }
  if (gates.maxLatencyP95Ms > 0 && metrics.B.p95LatencyMs > gates.maxLatencyP95Ms) {
    return {
      passed: false,
      reason: `B p95 latency ${metrics.B.p95LatencyMs}ms exceeds ${gates.maxLatencyP95Ms}ms`,
      metrics,
      gates,
    };
  }
  const delta = metrics.B.errorRate - metrics.A.errorRate;
  if (metrics.A.samples >= (gates.minSamples || 1) && delta > gates.maxErrorRateDelta) {
    return {
      passed: false,
      reason: `B error rate is ${(delta * 100).toFixed(2)}% worse than A`,
      metrics,
      gates,
    };
  }
  return { passed: true, metrics, gates };
}

// ─── Automatic progression ─────────────────────────────────────────────────

/**
 * Poll target — inspects health + phase duration and either advances, aborts,
 * or leaves the deployment alone.
 */
export async function autoAdvanceOrAbort(deploymentId, nowMs = Date.now()) {
  const rec = await getDeployment(deploymentId);
  if (!rec) {
    const err = new Error(`deployment ${deploymentId} not found`);
    err.code = "NOT_FOUND";
    throw err;
  }
  if (rec.status !== STATUS_RUNNING) {
    return { action: "noop", reason: `status=${rec.status}`, deployment: rec };
  }
  const gate = await checkHealthGate(deploymentId);
  if (!gate.passed) {
    const aborted = await abortDeployment(deploymentId, gate.reason);
    return { action: "aborted", reason: gate.reason, deployment: aborted, gate };
  }
  const phase = rec.phases[rec.currentPhaseIndex];
  if (!phase) return { action: "noop", reason: "no_current_phase", deployment: rec };
  const startedAtMs = rec.phaseStartedAt ? Date.parse(rec.phaseStartedAt) : nowMs;
  const elapsedMs = nowMs - startedAtMs;
  if (elapsedMs < (phase.minDurationMs || 0)) {
    return {
      action: "waiting",
      reason: `phase ${phase.name} needs ${phase.minDurationMs - elapsedMs}ms more`,
      deployment: rec,
      gate,
    };
  }
  if (rec.currentPhaseIndex >= rec.phases.length - 1) {
    // already on final phase — just complete.
    const completed = await mutateDeployment(deploymentId, (r) => {
      if (r.status !== STATUS_RUNNING) return r;
      const now = new Date().toISOString();
      r.status = STATUS_COMPLETED;
      r.completedAt = now;
      r.currentPercentage = r.phases[r.phases.length - 1].percentage;
      r.history.push({ at: now, type: "completed", data: {} });
      return r;
    });
    return { action: "completed", deployment: completed, gate };
  }
  const advanced = await advancePhase(deploymentId);
  return { action: "advanced", deployment: advanced, gate };
}

// ─── Comparison / rollback ─────────────────────────────────────────────────

/**
 * Build a side-by-side comparison of versions A and B for a deployment.
 * Pure sync helper: accepts either the deployment record or the summaries.
 */
export function compareVersions(deploymentOrSummary) {
  let metricsA, metricsB;
  let deploymentId = null;
  if (deploymentOrSummary && deploymentOrSummary.A && deploymentOrSummary.B &&
      typeof deploymentOrSummary.A === "object" && "samples" in deploymentOrSummary.A) {
    metricsA = deploymentOrSummary.A;
    metricsB = deploymentOrSummary.B;
  } else if (deploymentOrSummary && deploymentOrSummary.health) {
    metricsA = summarizeVersion(deploymentOrSummary.health.A);
    metricsB = summarizeVersion(deploymentOrSummary.health.B);
    deploymentId = deploymentOrSummary.id;
  } else {
    metricsA = summarizeVersion([]);
    metricsB = summarizeVersion([]);
  }
  const diff = {
    errorRateDelta: metricsB.errorRate - metricsA.errorRate,
    latencyP95Delta: metricsB.p95LatencyMs - metricsA.p95LatencyMs,
    avgLatencyDelta: metricsB.avgLatencyMs - metricsA.avgLatencyMs,
    satisfactionDelta:
      metricsA.satisfaction != null && metricsB.satisfaction != null
        ? metricsB.satisfaction - metricsA.satisfaction
        : null,
  };
  let winner = "tie";
  // B wins if errorRate not worse AND latency not meaningfully worse.
  const errorBetter = metricsB.errorRate < metricsA.errorRate - 0.001;
  const errorWorse = metricsB.errorRate > metricsA.errorRate + 0.001;
  const latencyBetter = metricsB.p95LatencyMs < metricsA.p95LatencyMs * 0.95;
  const latencyWorse = metricsB.p95LatencyMs > metricsA.p95LatencyMs * 1.05;
  if (!errorWorse && (errorBetter || latencyBetter) && !latencyWorse) {
    winner = "B";
  } else if (errorWorse || latencyWorse) {
    winner = "A";
  }
  return {
    deploymentId,
    A: metricsA,
    B: metricsB,
    diff,
    winner,
  };
}

/**
 * Immediately revert traffic back to 100% A. Records a "rolled_back" event.
 */
export async function rollbackDeployment(deploymentId) {
  return mutateDeployment(deploymentId, (rec) => {
    if (rec.status === STATUS_ROLLED_BACK) return rec;
    const now = new Date().toISOString();
    rec.status = STATUS_ROLLED_BACK;
    rec.currentPercentage = 0;
    rec.history.push({ at: now, type: "rolled_back", data: {} });
    return rec;
  });
}

// ─── History / events ─────────────────────────────────────────────────────

export async function recordDeploymentEvent(deploymentId, event) {
  if (!event || typeof event !== "object") {
    throw new Error("event is required");
  }
  const type = String(event.type || "note");
  const data = event.data ?? {};
  return mutateDeployment(deploymentId, (rec) => {
    rec.history.push({
      at: event.at || new Date().toISOString(),
      type,
      data,
    });
    return rec;
  });
}

export async function getDeploymentHistory(deploymentId) {
  const rec = await getDeployment(deploymentId);
  if (!rec) {
    const err = new Error(`deployment ${deploymentId} not found`);
    err.code = "NOT_FOUND";
    throw err;
  }
  return Array.isArray(rec.history) ? rec.history.slice() : [];
}

// ─── Test helpers ─────────────────────────────────────────────────────────

export const _internals = {
  summarizeVersion,
  deploymentPath,
  indexPath,
};
