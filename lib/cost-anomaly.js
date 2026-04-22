/**
 * Wave-2: Cost anomaly detection. Computes per-user rolling daily token cost
 * mean and stddev from the existing usage-tracker records and flags the current
 * day when it exceeds mean + k*sigma (default k=3).
 *
 * Off by default. Enable via COST_ANOMALY_DETECT=1. Threshold multiplier
 * configurable via COST_ANOMALY_SIGMA (default 3). Minimum sample size via
 * COST_ANOMALY_MIN_SAMPLES (default 7 days).
 *
 * When an anomaly is detected and ANOMALY_WEBHOOK=1, an "anomaly.detected"
 * webhook event is emitted with full context (user, day, tokens, baseline).
 */
import { getRecordsForPeriod } from "./usage-tracker.js";

const DEFAULT_SIGMA = 3;
const DEFAULT_MIN_SAMPLES = 7;
const DEFAULT_WINDOW_DAYS = 30;

export function anomalyDetectionEnabled() {
  return process.env.COST_ANOMALY_DETECT === "1";
}

export function anomalyWebhookEnabled() {
  return process.env.ANOMALY_WEBHOOK === "1";
}

function getSigma() {
  const raw = Number(process.env.COST_ANOMALY_SIGMA);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SIGMA;
}

function getMinSamples() {
  const raw = Number(process.env.COST_ANOMALY_MIN_SAMPLES);
  return Number.isFinite(raw) && raw >= 2 ? Math.floor(raw) : DEFAULT_MIN_SAMPLES;
}

/**
 * Compute simple mean and sample stddev of a numeric array. Returns
 * { mean: 0, stddev: 0 } for arrays shorter than 2.
 */
export function computeStats(values) {
  if (!Array.isArray(values) || values.length < 2) {
    return { mean: values && values.length === 1 ? values[0] : 0, stddev: 0 };
  }
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  let ssum = 0;
  for (const v of values) {
    const d = v - mean;
    ssum += d * d;
  }
  const stddev = Math.sqrt(ssum / (n - 1));
  return { mean, stddev };
}

/**
 * Group usage records by YYYY-MM-DD, summing tokens.
 */
export function groupByDay(records) {
  const out = {};
  for (const r of records || []) {
    const day = typeof r.timestamp === "string" ? r.timestamp.slice(0, 10) : null;
    if (!day) continue;
    const tokens = (Number(r.inputTokens) || 0) + (Number(r.outputTokens) || 0);
    out[day] = (out[day] || 0) + tokens;
  }
  return out;
}

/**
 * Inspect today's spend vs. the baseline window. Returns:
 *   { anomalous: boolean, today, mean, stddev, threshold, samples, reason? }
 *
 * When the baseline has fewer than minSamples day-buckets, returns
 * { anomalous: false, reason: "insufficient_samples" }.
 */
export async function detectAnomaly({ userId, workspace, sigma, minSamples, windowDays } = {}) {
  const k = typeof sigma === "number" ? sigma : getSigma();
  const minN = typeof minSamples === "number" ? minSamples : getMinSamples();
  const window = Number.isFinite(Number(windowDays)) ? Number(windowDays) : DEFAULT_WINDOW_DAYS;

  try {
    const records = await getRecordsForPeriod(window, { userId, workspace });
    const byDay = groupByDay(records);
    const today = new Date().toISOString().slice(0, 10);
    const todayTokens = byDay[today] || 0;
    const baseline = Object.entries(byDay)
      .filter(([d]) => d !== today)
      .map(([, v]) => v);

    if (baseline.length < minN) {
      return {
        anomalous: false,
        today: todayTokens,
        mean: 0,
        stddev: 0,
        threshold: 0,
        samples: baseline.length,
        reason: "insufficient_samples",
      };
    }

    const { mean, stddev } = computeStats(baseline);
    const threshold = mean + k * stddev;
    return {
      anomalous: todayTokens > threshold && todayTokens > mean,
      today: todayTokens,
      mean,
      stddev,
      threshold,
      samples: baseline.length,
    };
  } catch {
    return { anomalous: false, today: 0, mean: 0, stddev: 0, threshold: 0, samples: 0, reason: "error" };
  }
}

/**
 * Inspect + optionally emit webhook. Safe to fire-and-forget from any request
 * path. Returns the detection result.
 */
export async function checkAndNotifyAnomaly({ userId, workspace }) {
  if (!anomalyDetectionEnabled()) return { anomalous: false, skipped: true };
  const result = await detectAnomaly({ userId, workspace });
  if (result.anomalous && anomalyWebhookEnabled()) {
    try {
      const { emitEvent } = await import("./webhooks.js");
      await emitEvent(
        "anomaly.detected",
        {
          kind: "cost",
          userId: userId || null,
          workspace: workspace || null,
          today: result.today,
          mean: result.mean,
          stddev: result.stddev,
          threshold: result.threshold,
          samples: result.samples,
          at: new Date().toISOString(),
        },
        { workspaceId: workspace, userId },
      );
    } catch { /* webhook is best-effort */ }
  }
  return result;
}
