/**
 * Phase 47.2: Agent reputation scoring.
 *
 * Computes a 0–100 reputation score from agent stats using a weighted formula:
 *   40% rating quality
 *   30% install volume (log-scaled)
 *   20% recency of activity
 *   10% verified publisher bonus
 *
 * Reports detract from the score by deducting up to 30 points.
 */

const INSTALLS_SATURATION = 5_000;
const RECENCY_FRESH_DAYS = 30;
const RECENCY_DECAY_DAYS = 365;

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function ratingComponent(stats) {
  const avg = Number(stats?.avgRating) || 0;
  const count = Number(stats?.ratingCount) || 0;
  if (count <= 0) return 0;
  // Bayesian-ish dampening: small rating counts pull toward a 3.0 prior.
  const prior = 3;
  const priorWeight = 5;
  const damped = (avg * count + prior * priorWeight) / (count + priorWeight);
  // Map 1–5 → 0–1.
  return clamp01((damped - 1) / 4);
}

function installsComponent(stats) {
  const installs = Number(stats?.installs) || 0;
  if (installs <= 0) return 0;
  // Log-scaled saturation so a few installs already register, but
  // huge install counts plateau near 1.0.
  const ratio = Math.log10(installs + 1) / Math.log10(INSTALLS_SATURATION + 1);
  return clamp01(ratio);
}

function recencyComponent(stats) {
  const ts = stats?.updatedAt || stats?.publishedAt;
  if (!ts) return 0;
  const t = new Date(ts).getTime();
  if (!Number.isFinite(t)) return 0;
  const ageDays = (Date.now() - t) / (24 * 3_600_000);
  if (ageDays <= RECENCY_FRESH_DAYS) return 1;
  if (ageDays >= RECENCY_DECAY_DAYS) return 0;
  // Linear decay between fresh and decay horizons.
  return clamp01(1 - (ageDays - RECENCY_FRESH_DAYS) / (RECENCY_DECAY_DAYS - RECENCY_FRESH_DAYS));
}

function verifiedComponent(stats) {
  return stats?.verifiedPublisher ? 1 : 0;
}

function reportPenalty(stats) {
  const reports = Number(stats?.reports) || 0;
  if (reports <= 0) return 0;
  // Each report subtracts ~3 points up to a 30 point cap.
  return Math.min(30, reports * 3);
}

/**
 * Calculate the reputation score for an agent on a 0–100 scale.
 * @param {object} agentStats - { installs, avgRating, ratingCount, publishedAt, updatedAt, verifiedPublisher, reports }
 * @returns {number}
 */
export function calculateReputationScore(agentStats) {
  if (!agentStats || typeof agentStats !== "object") return 0;
  const rating = ratingComponent(agentStats) * 40;
  const installs = installsComponent(agentStats) * 30;
  const recency = recencyComponent(agentStats) * 20;
  const verified = verifiedComponent(agentStats) * 10;
  const raw = rating + installs + recency + verified - reportPenalty(agentStats);
  if (raw < 0) return 0;
  if (raw > 100) return 100;
  return Math.round(raw);
}

/**
 * Map a reputation score to a textual badge tier.
 *   <30   → "new"
 *   30–60 → "emerging"
 *   60–80 → "trusted"
 *   80+   → "verified"
 * @param {number} score
 * @returns {"new"|"emerging"|"trusted"|"verified"}
 */
export function getReputationBadge(score) {
  const n = Number(score) || 0;
  if (n >= 80) return "verified";
  if (n >= 60) return "trusted";
  if (n >= 30) return "emerging";
  return "new";
}
