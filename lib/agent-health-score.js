/**
 * Composite agent health-budget score.
 *
 * Ops staff shouldn't need to watch five dashboards to answer "is the agent
 * system healthy right now?". This module blends four quality signals and
 * two penalty signals into a single 0-1 number with clear thresholds and
 * human-readable alerts.
 *
 * Composition:
 *   health = w_bench       * benchmarkPassRate
 *          + w_safety      * safetyPassRate
 *          + w_feedback    * feedbackUpRate
 *          + w_reliability * avgToolReliability
 *          - w_chronic     * min(1, chronicToolCount / 10)
 *          - w_conflict    * min(1, conflictsLast24h / 10)
 *   clamped to [0, 1].
 *
 * Missing data rule: when a positive-component input is null we treat that
 * component's contribution as 0. A partial set of signals therefore yields a
 * partial score rather than a hard failure, which matters for brand-new
 * workspaces that may not yet have a benchmark run or safety suite result.
 *
 * Status thresholds:
 *   healthy  >= 0.75
 *   warning  >= 0.50
 *   critical <  0.50
 *
 * @module agent-health-score
 */

import { join } from "path";
import { readJsonPath, writeJsonPath, getDataDir } from "./json-path-store.js";
import { latest } from "./eval-history-store.js";
import { aggregateFeedback } from "./agent-feedback-store.js";
import { loadToolOutcomes, rankByReliability } from "./agent-genealogy.js";
import { rankChronicFailures } from "./agent-failure-store.js";
import { listConflicts } from "./swarm-conflict-store.js";
import { setAgentHealthScore } from "./metrics.js";

export const DEFAULT_WEIGHTS = Object.freeze({
  bench: 0.25,
  safety: 0.25,
  feedback: 0.20,
  reliability: 0.15,
  chronic: 0.10,
  conflict: 0.05,
});

const HEALTHY_THRESHOLD = 0.75;
const WARNING_THRESHOLD = 0.50;

// Component-level alert thresholds (below → emit human-readable line).
const SAFETY_ALERT_THRESHOLD = 0.90;
const BENCHMARK_ALERT_THRESHOLD = 0.70;
const FEEDBACK_ALERT_THRESHOLD = 0.60;
const RELIABILITY_ALERT_THRESHOLD = 0.70;
const CHRONIC_ALERT_MIN = 3;
const CONFLICT_ALERT_MIN = 3;

const RELIABILITY_TOP_N = 10;
const RELIABILITY_MIN_SAMPLES = 3;
const CHRONIC_SCORE_THRESHOLD = 8;
const MS_DAY = 86_400_000;

// Delta detection: a > 0.15 drop since last recorded sample triggers an alert.
const DELTA_DROP_ALERT = 0.15;

/**
 * @typedef {object} HealthComponents
 * @property {number | null} benchmarkPassRate
 * @property {number | null} safetyPassRate
 * @property {number | null} feedbackUpRate
 * @property {number | null} avgToolReliability
 * @property {number} chronicToolCount
 * @property {number} conflictsLast24h
 */

/**
 * @typedef {object} HealthScore
 * @property {number} score
 * @property {number} ts
 * @property {string} workspace
 * @property {HealthComponents} components
 * @property {Record<string, number>} weights
 * @property {"healthy" | "warning" | "critical"} status
 * @property {string[]} alerts
 */

function sanitizeSegment(s) {
  if (typeof s !== "string" || s.length === 0) return "default";
  return s.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80);
}

function lastScorePath(workspace) {
  return join(getDataDir(), "agent-health-score", sanitizeSegment(workspace), "last.json");
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function resolveWeights(overrides) {
  if (!overrides || typeof overrides !== "object") return { ...DEFAULT_WEIGHTS };
  const w = { ...DEFAULT_WEIGHTS };
  for (const k of Object.keys(DEFAULT_WEIGHTS)) {
    if (Number.isFinite(overrides[k])) w[k] = Number(overrides[k]);
  }
  return w;
}

function pct(v) {
  return `${Math.round(v * 100)}%`;
}

/**
 * Pure composition: given explicit component values and weights, compute the
 * final score and the list of alert reasons. Exported for unit tests.
 *
 * @param {HealthComponents} components
 * @param {Record<string, number>} [weights]
 * @returns {{ score: number, alerts: string[] }}
 */
export function scoreFromComponents(components, weights = DEFAULT_WEIGHTS) {
  const c = components || {};
  const w = resolveWeights(weights);
  const alerts = [];

  const benchmark = Number.isFinite(c.benchmarkPassRate) ? Number(c.benchmarkPassRate) : 0;
  const safety = Number.isFinite(c.safetyPassRate) ? Number(c.safetyPassRate) : 0;
  const feedback = Number.isFinite(c.feedbackUpRate) ? Number(c.feedbackUpRate) : 0;
  const reliability = Number.isFinite(c.avgToolReliability) ? Number(c.avgToolReliability) : 0;
  const chronic = Number.isFinite(c.chronicToolCount) ? Number(c.chronicToolCount) : 0;
  const conflicts = Number.isFinite(c.conflictsLast24h) ? Number(c.conflictsLast24h) : 0;

  const positive =
    w.bench * clamp01(benchmark) +
    w.safety * clamp01(safety) +
    w.feedback * clamp01(feedback) +
    w.reliability * clamp01(reliability);

  const chronicNorm = Math.min(1, Math.max(0, chronic) / 10);
  const conflictNorm = Math.min(1, Math.max(0, conflicts) / 10);
  const penalty = w.chronic * chronicNorm + w.conflict * conflictNorm;

  const raw = positive - penalty;
  const score = clamp01(raw);

  // Component-level alert lines.
  if (c.benchmarkPassRate === null || c.benchmarkPassRate === undefined) {
    alerts.push("benchmark pass rate unavailable (no recent samples)");
  } else if (benchmark < BENCHMARK_ALERT_THRESHOLD) {
    alerts.push(`benchmark pass rate ${pct(benchmark)} below ${BENCHMARK_ALERT_THRESHOLD.toFixed(2)} threshold`);
  }
  if (c.safetyPassRate === null || c.safetyPassRate === undefined) {
    alerts.push("safety pass rate unavailable (no recent samples)");
  } else if (safety < SAFETY_ALERT_THRESHOLD) {
    alerts.push(`safety pass rate ${pct(safety)} below ${SAFETY_ALERT_THRESHOLD.toFixed(2)} threshold`);
  }
  if (c.feedbackUpRate === null || c.feedbackUpRate === undefined) {
    alerts.push("feedback up rate unavailable (no user feedback yet)");
  } else if (feedback < FEEDBACK_ALERT_THRESHOLD) {
    alerts.push(`feedback up rate ${pct(feedback)} below ${FEEDBACK_ALERT_THRESHOLD.toFixed(2)} threshold`);
  }
  if (c.avgToolReliability === null || c.avgToolReliability === undefined) {
    alerts.push("tool reliability unavailable (no recorded outcomes)");
  } else if (reliability < RELIABILITY_ALERT_THRESHOLD) {
    alerts.push(`avg tool reliability ${pct(reliability)} below ${RELIABILITY_ALERT_THRESHOLD.toFixed(2)} threshold`);
  }
  if (chronic >= CHRONIC_ALERT_MIN) {
    alerts.push(`${chronic} chronic tool failures detected`);
  }
  if (conflicts >= CONFLICT_ALERT_MIN) {
    alerts.push(`${conflicts} swarm conflicts in last 24h`);
  }

  return { score, alerts };
}

function statusFor(score) {
  if (score >= HEALTHY_THRESHOLD) return "healthy";
  if (score >= WARNING_THRESHOLD) return "warning";
  return "critical";
}

async function readLastScore(workspace) {
  try {
    const blob = await readJsonPath(lastScorePath(workspace), null);
    if (blob && typeof blob === "object" && Number.isFinite(blob.score)) return blob;
  } catch (_) { /* best-effort */ }
  return null;
}

async function writeLastScore(workspace, hs) {
  try {
    await writeJsonPath(lastScorePath(workspace), {
      version: 1,
      score: hs.score,
      ts: hs.ts,
      status: hs.status,
    });
  } catch (_) { /* best-effort */ }
}

/**
 * Gather all component inputs from the durable stores. Missing data for a
 * component yields null for that field.
 * @param {string} workspace
 * @returns {Promise<HealthComponents>}
 */
async function collectComponents(workspace) {
  // Benchmark pass rate: latest benchmark sample's passRate metric.
  let benchmarkPassRate = null;
  try {
    const s = await latest(workspace, { kind: "benchmark" });
    if (s && s.metrics && Number.isFinite(s.metrics.passRate)) {
      benchmarkPassRate = Number(s.metrics.passRate);
    }
  } catch (_) { /* missing */ }

  let safetyPassRate = null;
  try {
    const s = await latest(workspace, { kind: "safety" });
    if (s && s.metrics && Number.isFinite(s.metrics.passRate)) {
      safetyPassRate = Number(s.metrics.passRate);
    }
  } catch (_) { /* missing */ }

  let feedbackUpRate = null;
  try {
    const agg = await aggregateFeedback(workspace);
    if (agg && agg.total > 0) {
      feedbackUpRate = Number(agg.upRate) || 0;
    }
  } catch (_) { /* missing */ }

  let avgToolReliability = null;
  try {
    const outcomes = await loadToolOutcomes(workspace);
    if (outcomes && outcomes.tools && Object.keys(outcomes.tools).length > 0) {
      const ranked = rankByReliability(outcomes, { minSamples: RELIABILITY_MIN_SAMPLES });
      if (ranked.length > 0) {
        const top = ranked.slice(0, RELIABILITY_TOP_N);
        const sum = top.reduce((acc, r) => acc + Number(r.successRate || 0), 0);
        avgToolReliability = sum / top.length;
      }
    }
  } catch (_) { /* missing */ }

  let chronicToolCount = 0;
  try {
    const chronic = await rankChronicFailures(workspace, 100);
    if (Array.isArray(chronic)) {
      chronicToolCount = chronic.filter((c) => Number(c.score) >= CHRONIC_SCORE_THRESHOLD).length;
    }
  } catch (_) { /* missing */ }

  let conflictsLast24h = 0;
  try {
    const all = await listConflicts(workspace, { limit: 500 });
    if (Array.isArray(all)) {
      const cutoff = Date.now() - MS_DAY;
      conflictsLast24h = all.filter((c) => Number(c.ts) >= cutoff).length;
    }
  } catch (_) { /* missing */ }

  return {
    benchmarkPassRate,
    safetyPassRate,
    feedbackUpRate,
    avgToolReliability,
    chronicToolCount,
    conflictsLast24h,
  };
}

/**
 * Compute a composite health score for the workspace.
 *
 * @param {string} workspace
 * @param {{weights?: Record<string, number>}} [opts]
 * @returns {Promise<HealthScore>}
 */
export async function computeHealthScore(workspace, opts = {}) {
  const ws = sanitizeSegment(workspace);
  const weights = resolveWeights(opts?.weights);
  const components = await collectComponents(ws);
  const { score, alerts } = scoreFromComponents(components, weights);
  const status = statusFor(score);
  return {
    score,
    ts: Date.now(),
    workspace: ws,
    components,
    weights,
    status,
    alerts,
  };
}

/**
 * Compute the score and publish it to the Prometheus gauge. Returns the
 * numeric score (or 0 if metrics are disabled).
 *
 * @param {string} workspace
 * @returns {Promise<number>}
 */
export async function emitHealthScoreMetric(workspace) {
  const hs = await computeHealthScore(workspace);
  setAgentHealthScore(hs.score, hs.workspace);
  await writeLastScore(hs.workspace, hs);
  return hs.score;
}

/**
 * If the current score is critical OR it dropped by more than
 * DELTA_DROP_ALERT since the last recorded sample, emit a
 * `health_score_alert` event on the webhook bus. Returns whether an event
 * was emitted (and the reason if not).
 *
 * @param {string} workspace
 * @returns {Promise<{emitted: boolean, reason?: string, score?: number, status?: string, delta?: number}>}
 */
export async function checkAndAlertHealthScore(workspace) {
  const ws = sanitizeSegment(workspace);
  const hs = await computeHealthScore(ws);
  const prev = await readLastScore(ws);
  const delta = prev && Number.isFinite(prev.score) ? hs.score - Number(prev.score) : null;
  const dropped = delta !== null && delta <= -DELTA_DROP_ALERT;
  const isCritical = hs.status === "critical";

  // Always persist the latest score so subsequent delta checks are meaningful.
  await writeLastScore(ws, hs);

  if (!isCritical && !dropped) {
    return { emitted: false, reason: "no_alert", score: hs.score, status: hs.status, delta };
  }

  const reasons = [];
  if (isCritical) reasons.push("critical");
  if (dropped) reasons.push("drop");

  let emitEvent;
  try {
    ({ emitEvent } = await import("./webhooks.js"));
  } catch (err) {
    return {
      emitted: false,
      reason: `webhooks_import_failed:${String(err?.message || err)}`,
      score: hs.score,
      status: hs.status,
      delta,
    };
  }

  try {
    await emitEvent(
      "health_score_alert",
      {
        workspace: hs.workspace,
        score: hs.score,
        status: hs.status,
        alerts: hs.alerts,
        components: hs.components,
        previousScore: prev ? Number(prev.score) : null,
        delta,
        reasons,
      },
      { workspaceId: hs.workspace },
    );
    return { emitted: true, score: hs.score, status: hs.status, delta, reason: reasons.join(",") };
  } catch (err) {
    return {
      emitted: false,
      reason: `emit_failed:${String(err?.message || err)}`,
      score: hs.score,
      status: hs.status,
      delta,
    };
  }
}

/**
 * Test-only helper: clear the last-score persistence for a workspace.
 * @param {string} workspace
 */
export async function __resetLastScoreForTests(workspace) {
  try {
    await writeJsonPath(lastScorePath(workspace), null);
  } catch (_) { /* best-effort */ }
}
