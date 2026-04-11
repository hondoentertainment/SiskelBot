/**
 * Continuous learning system.
 * Automatically captures good interactions for future fine-tuning.
 * Based on Karpathy's "Software 2.0" philosophy: models improve from data.
 *
 * Storage layout:
 *   data/continuous-learning/{workspaceId}/interactions.json
 *   data/continuous-learning/{workspaceId}/signals.json     — per-interaction signal events
 *   data/continuous-learning/{workspaceId}/state.json       — curation state (lastRun, lastTrained)
 */
import { randomUUID } from "crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";

const MAX_INTERACTIONS = Number(process.env.CL_MAX_INTERACTIONS) || 10_000;
const DRIFT_WINDOW = Number(process.env.CL_DRIFT_WINDOW) || 50;
const DRIFT_THRESHOLD = Number(process.env.CL_DRIFT_THRESHOLD) || 0.1;
const TRAIN_MIN_CANDIDATES = Number(process.env.CL_TRAIN_MIN_CANDIDATES) || 100;
const TRAIN_MIN_SCORE = Number(process.env.CL_TRAIN_MIN_SCORE) || 0.6;

// Karpathy's "ladder of reliability"
export const QUALITY_RUNGS = {
  R0: { name: "No signal", weight: 0 },
  R1: { name: "Accepted", weight: 0.3 }, // User continued
  R2: { name: "Rated positive", weight: 0.6 }, // Explicit thumbs up
  R3: { name: "Copied/used", weight: 0.8 }, // User copied or acted on
  R4: { name: "Shared", weight: 1.0 }, // User shared the response
};

function getDataDir() {
  return process.env.STORAGE_PATH || join(process.cwd(), "data");
}

function sanitize(val, fallback) {
  if (typeof val !== "string" || !val.trim()) return fallback;
  return val.trim().replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || fallback;
}

function workspacePath(workspaceId, name) {
  const ws = sanitize(workspaceId, "default");
  return join(getDataDir(), "continuous-learning", ws, name);
}

function ensureDir(filePath) {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function loadJson(filePath, fallback) {
  try {
    if (existsSync(filePath)) {
      return JSON.parse(readFileSync(filePath, "utf8"));
    }
  } catch {
    // corrupted — start fresh
  }
  return fallback;
}

function saveJson(filePath, data) {
  ensureDir(filePath);
  writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function loadInteractions(workspaceId) {
  return loadJson(workspacePath(workspaceId, "interactions.json"), []);
}

function saveInteractions(workspaceId, items) {
  saveJson(workspacePath(workspaceId, "interactions.json"), items);
}

function loadSignals(workspaceId) {
  return loadJson(workspacePath(workspaceId, "signals.json"), {});
}

function saveSignals(workspaceId, signals) {
  saveJson(workspacePath(workspaceId, "signals.json"), signals);
}

function loadState(workspaceId) {
  return loadJson(workspacePath(workspaceId, "state.json"), {
    lastCuratedAt: null,
    lastTrainedAt: null,
    lastTrainingCandidateCount: 0,
    improvementSinceLast: 0,
    history: [],
  });
}

function saveState(workspaceId, state) {
  saveJson(workspacePath(workspaceId, "state.json"), state);
}

/**
 * Record an interaction as potential training data.
 * @param {object} interaction - { workspaceId, prompt, response, model, rating?, metadata? }
 * @returns {Promise<{ id: string, createdAt: string }>}
 */
export async function recordInteraction(interaction) {
  const workspaceId = interaction.workspaceId || "default";
  const prompt = typeof interaction.prompt === "string" ? interaction.prompt : "";
  const response = typeof interaction.response === "string" ? interaction.response : "";
  if (!prompt.trim() || !response.trim()) {
    throw new Error("prompt and response are required");
  }

  const interactions = loadInteractions(workspaceId);

  // FIFO trim if at capacity.
  if (interactions.length >= MAX_INTERACTIONS) {
    interactions.splice(0, interactions.length - MAX_INTERACTIONS + 1);
  }

  const now = new Date().toISOString();
  const entry = {
    id: randomUUID(),
    workspaceId,
    prompt,
    response,
    model: interaction.model || "unknown",
    rating: typeof interaction.rating === "number" ? interaction.rating : null,
    metadata: interaction.metadata && typeof interaction.metadata === "object" ? interaction.metadata : {},
    conversationId: interaction.conversationId || null,
    userId: interaction.userId || "anonymous",
    createdAt: now,
    score: null,
    rung: "R0",
    curated: false,
    rejected: false,
  };

  interactions.push(entry);
  saveInteractions(workspaceId, interactions);

  return { id: entry.id, createdAt: entry.createdAt };
}

/**
 * Record a user signal attached to an interaction (copy, share, thumbs up/down, regenerate, dwell).
 */
export async function recordSignal(workspaceId, interactionId, signal) {
  if (!interactionId) throw new Error("interactionId is required");
  const type = signal?.type;
  const valid = ["rating", "copy", "share", "regenerate", "accepted", "dwell"];
  if (!valid.includes(type)) {
    throw new Error(`signal.type must be one of: ${valid.join(", ")}`);
  }
  const signals = loadSignals(workspaceId);
  if (!signals[interactionId]) signals[interactionId] = [];
  signals[interactionId].push({
    type,
    value: signal.value != null ? signal.value : null,
    at: new Date().toISOString(),
  });
  saveSignals(workspaceId, signals);
  return { ok: true };
}

/**
 * Compute quality score from multiple signals.
 * @param {string} interactionId
 * @param {string} [workspaceId]
 * @returns {Promise<{ score: number, signals: object, rung: string }>}
 */
export async function scoreInteraction(interactionId, workspaceId = "default") {
  const interactions = loadInteractions(workspaceId);
  const interaction = interactions.find((i) => i.id === interactionId);
  if (!interaction) {
    return { score: 0, signals: {}, rung: "R0" };
  }
  const signalMap = loadSignals(workspaceId);
  const events = signalMap[interactionId] || [];
  return computeInteractionScore(interaction, events, interactions);
}

/**
 * Pure computation of a score given an interaction, its events, and the corpus (for regeneration detection).
 */
export function computeInteractionScore(interaction, events, corpus = []) {
  const signals = {
    explicitRating: null,
    copied: false,
    shared: false,
    regenerated: false,
    accepted: false,
    dwellMs: null,
    lengthFit: 0,
  };

  for (const e of events || []) {
    if (e.type === "rating") signals.explicitRating = Number(e.value);
    if (e.type === "copy") signals.copied = true;
    if (e.type === "share") signals.shared = true;
    if (e.type === "regenerate") signals.regenerated = true;
    if (e.type === "accepted") signals.accepted = true;
    if (e.type === "dwell") signals.dwellMs = Number(e.value) || 0;
  }

  // Inline rating set on the interaction itself counts too.
  if (signals.explicitRating == null && typeof interaction.rating === "number") {
    signals.explicitRating = interaction.rating;
  }

  // Auto-detect regeneration from corpus if not flagged.
  if (!signals.regenerated && corpus.length) {
    signals.regenerated = detectRegeneration(corpus, interaction);
  }
  // Auto-detect acceptance from conversation continuation.
  if (!signals.accepted && corpus.length) {
    signals.accepted = detectAcceptance(corpus, interaction);
  }

  // Length appropriateness: response length vs. prompt complexity.
  signals.lengthFit = lengthAppropriatenessScore(interaction);

  // Aggregate score.
  let score = 0.3; // baseline

  if (signals.explicitRating != null) {
    // Rating in [-1, 1] or [0, 1]. Normalize.
    const r = signals.explicitRating;
    const norm = r < 0 ? 0 : r > 1 ? 1 : r;
    score = 0.4 * norm + 0.6 * score;
    if (r > 0) score += 0.1;
    if (r < 0) score -= 0.2;
  }
  if (signals.copied) score += 0.2;
  if (signals.shared) score += 0.25;
  if (signals.accepted) score += 0.1;
  if (signals.regenerated) score -= 0.3;
  if (signals.dwellMs != null) {
    if (signals.dwellMs > 3000) score += 0.05;
    if (signals.dwellMs < 500) score -= 0.05;
  }
  score += 0.1 * signals.lengthFit;

  if (score < 0) score = 0;
  if (score > 1) score = 1;

  const rung = computeQualityRung(signals);
  return { score: Math.round(score * 1000) / 1000, signals, rung };
}

function lengthAppropriatenessScore(interaction) {
  const promptLen = (interaction.prompt || "").length;
  const respLen = (interaction.response || "").length;
  if (promptLen === 0 || respLen === 0) return 0;
  const ratio = respLen / Math.max(1, promptLen);
  // Sweet spot: responses 2x-20x the prompt length.
  if (ratio < 0.5) return 0.2; // too short
  if (ratio >= 0.5 && ratio <= 20) return 1;
  if (ratio <= 40) return 0.6;
  return 0.3; // way too long
}

/**
 * Compute the highest-reliability rung a set of signals achieved.
 * @param {object} signals
 * @returns {string} — R0..R4
 */
export function computeQualityRung(signals) {
  if (!signals) return "R0";
  if (signals.shared) return "R4";
  if (signals.copied) return "R3";
  if (typeof signals.explicitRating === "number" && signals.explicitRating > 0) return "R2";
  if (signals.accepted && !signals.regenerated) return "R1";
  return "R0";
}

/**
 * Detect regeneration: same (or near-same) prompt in short window after this one.
 */
export function detectRegeneration(interactions, target) {
  if (!target) return false;
  const tIndex = interactions.findIndex((i) => i.id === target.id);
  if (tIndex === -1) return false;
  const tTime = new Date(target.createdAt).getTime();
  const windowMs = 2 * 60 * 1000;
  const tPrompt = (target.prompt || "").trim().toLowerCase();
  for (let i = tIndex + 1; i < interactions.length; i++) {
    const other = interactions[i];
    if (other.conversationId && other.conversationId !== target.conversationId) continue;
    const oTime = new Date(other.createdAt).getTime();
    if (oTime - tTime > windowMs) break;
    const oPrompt = (other.prompt || "").trim().toLowerCase();
    if (oPrompt === tPrompt) return true;
  }
  return false;
}

/**
 * Detect acceptance: the user continued the conversation without regenerating.
 */
export function detectAcceptance(interactions, target) {
  if (!target || !target.conversationId) return false;
  const tIndex = interactions.findIndex((i) => i.id === target.id);
  if (tIndex === -1) return false;
  const tTime = new Date(target.createdAt).getTime();
  const windowMs = 30 * 60 * 1000;
  for (let i = tIndex + 1; i < interactions.length; i++) {
    const other = interactions[i];
    if (other.conversationId !== target.conversationId) continue;
    const oTime = new Date(other.createdAt).getTime();
    if (oTime - tTime > windowMs) return false;
    if ((other.prompt || "").trim().toLowerCase() !== (target.prompt || "").trim().toLowerCase()) {
      return true;
    }
  }
  return false;
}

/**
 * Client-reported copy event.
 */
export function detectCopy(interaction) {
  if (!interaction) return false;
  if (interaction.metadata && interaction.metadata.copied) return true;
  return false;
}

/**
 * Curate training data: select high-quality interactions.
 * @param {string} workspaceId
 * @param {object} [options] - { minScore, maxExamples, deduplicate, balance }
 * @returns {Promise<{ jsonl: string, count: number, rejected: number }>}
 */
export async function curateTrainingData(workspaceId, options = {}) {
  const minScore = options.minScore != null ? Number(options.minScore) : TRAIN_MIN_SCORE;
  const maxExamples = options.maxExamples != null ? Number(options.maxExamples) : 1000;
  const deduplicate = options.deduplicate !== false;
  const balance = !!options.balance;

  const interactions = loadInteractions(workspaceId);
  const signals = loadSignals(workspaceId);

  // Score everyone first.
  const scored = interactions.map((it) => {
    const s = computeInteractionScore(it, signals[it.id] || [], interactions);
    return { interaction: it, ...s };
  });

  const accepted = scored.filter((s) => s.score >= minScore);
  const rejected = scored.filter((s) => s.score < 0.25);

  // Deduplicate by prompt fingerprint.
  const seen = new Set();
  const curated = [];
  for (const s of accepted.sort((a, b) => b.score - a.score)) {
    const key = (s.interaction.prompt || "").trim().toLowerCase().slice(0, 200);
    if (deduplicate && seen.has(key)) continue;
    seen.add(key);
    curated.push(s);
    if (curated.length >= maxExamples) break;
  }

  // Balance across models if requested.
  let finalList = curated;
  if (balance) {
    const byModel = {};
    for (const s of curated) {
      const m = s.interaction.model || "unknown";
      if (!byModel[m]) byModel[m] = [];
      byModel[m].push(s);
    }
    const perBucket = Math.ceil(maxExamples / Math.max(1, Object.keys(byModel).length));
    finalList = Object.values(byModel).flatMap((arr) => arr.slice(0, perBucket));
  }

  const jsonl = finalList
    .map((s) =>
      JSON.stringify({
        messages: [
          { role: "user", content: s.interaction.prompt },
          { role: "assistant", content: s.interaction.response },
        ],
        meta: {
          id: s.interaction.id,
          model: s.interaction.model,
          score: s.score,
          rung: s.rung,
        },
      })
    )
    .join("\n");

  return {
    jsonl,
    count: finalList.length,
    rejected: rejected.length,
    candidates: finalList.map((s) => ({
      id: s.interaction.id,
      prompt: s.interaction.prompt.slice(0, 200),
      response: s.interaction.response.slice(0, 200),
      score: s.score,
      rung: s.rung,
      model: s.interaction.model,
    })),
    rejectedSamples: rejected.slice(0, 50).map((s) => ({
      id: s.interaction.id,
      prompt: s.interaction.prompt.slice(0, 200),
      score: s.score,
    })),
  };
}

/**
 * Detect quality drift over time via rolling averages.
 * @param {string} workspaceId
 * @returns {Promise<{ driftDetected: boolean, trend: string, recommendations: string[], recentAvg: number, previousAvg: number }>}
 */
export async function detectDrift(workspaceId) {
  const interactions = loadInteractions(workspaceId);
  const signals = loadSignals(workspaceId);

  if (interactions.length < DRIFT_WINDOW * 2) {
    return {
      driftDetected: false,
      trend: "insufficient_data",
      recommendations: ["Need at least " + (DRIFT_WINDOW * 2) + " interactions to detect drift"],
      recentAvg: 0,
      previousAvg: 0,
    };
  }

  const sorted = [...interactions].sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
  const recent = sorted.slice(-DRIFT_WINDOW);
  const previous = sorted.slice(-DRIFT_WINDOW * 2, -DRIFT_WINDOW);

  const avg = (list) => {
    if (list.length === 0) return 0;
    const sum = list.reduce((acc, it) => {
      const { score } = computeInteractionScore(it, signals[it.id] || [], sorted);
      return acc + score;
    }, 0);
    return sum / list.length;
  };

  const recentAvg = avg(recent);
  const previousAvg = avg(previous);
  const delta = recentAvg - previousAvg;

  let trend = "stable";
  if (delta > DRIFT_THRESHOLD) trend = "improving";
  else if (delta < -DRIFT_THRESHOLD) trend = "declining";

  const driftDetected = trend === "declining";
  const recommendations = [];
  if (driftDetected) {
    recommendations.push("Quality is declining — review recent prompts/responses for drift.");
    recommendations.push("Consider triggering a new curation cycle and fine-tune run.");
    recommendations.push("Inspect model changes or prompt-template updates in the window.");
  }
  if (trend === "improving") {
    recommendations.push("Quality is improving — continue collecting data.");
  }

  return {
    driftDetected,
    trend,
    recommendations,
    recentAvg: Math.round(recentAvg * 1000) / 1000,
    previousAvg: Math.round(previousAvg * 1000) / 1000,
    windowSize: DRIFT_WINDOW,
  };
}

/**
 * Propose a training run if enough high-quality data has accumulated.
 * @param {string} workspaceId
 * @returns {Promise<{ shouldTrain: boolean, dataCount: number, estimatedGain: number, reason: string }>}
 */
export async function proposeTrainingRun(workspaceId) {
  const interactions = loadInteractions(workspaceId);
  const signals = loadSignals(workspaceId);
  const state = loadState(workspaceId);

  const scored = interactions.map((it) => {
    const s = computeInteractionScore(it, signals[it.id] || [], interactions);
    return { interaction: it, ...s };
  });

  const highQuality = scored.filter((s) => s.score >= TRAIN_MIN_SCORE);
  const dataCount = highQuality.length;
  const newSinceLast = dataCount - (state.lastTrainingCandidateCount || 0);

  let shouldTrain = false;
  let reason;
  if (dataCount < TRAIN_MIN_CANDIDATES) {
    reason = `Only ${dataCount} high-quality candidates (need ${TRAIN_MIN_CANDIDATES}).`;
  } else if (newSinceLast < Math.floor(TRAIN_MIN_CANDIDATES / 2)) {
    reason = `Only ${newSinceLast} new candidates since last training. Wait for more data.`;
  } else {
    shouldTrain = true;
    reason = `${dataCount} high-quality candidates available (${newSinceLast} new).`;
  }

  // Rough estimated gain: proportional to new data ratio.
  const estimatedGain =
    dataCount === 0 ? 0 : Math.min(0.3, (newSinceLast / Math.max(1, dataCount)) * 0.3);

  return {
    shouldTrain,
    dataCount,
    newSinceLast,
    estimatedGain: Math.round(estimatedGain * 1000) / 1000,
    reason,
    minRequired: TRAIN_MIN_CANDIDATES,
  };
}

/**
 * Overall learning statistics for a workspace.
 * @param {string} workspaceId
 */
export async function getLearningStats(workspaceId) {
  const interactions = loadInteractions(workspaceId);
  const signals = loadSignals(workspaceId);
  const state = loadState(workspaceId);

  let qualitySum = 0;
  let qualityCount = 0;
  const rungCounts = { R0: 0, R1: 0, R2: 0, R3: 0, R4: 0 };
  let candidates = 0;

  for (const it of interactions) {
    const s = computeInteractionScore(it, signals[it.id] || [], interactions);
    qualitySum += s.score;
    qualityCount += 1;
    if (rungCounts[s.rung] != null) rungCounts[s.rung] += 1;
    if (s.score >= TRAIN_MIN_SCORE) candidates += 1;
  }

  const qualityAvg = qualityCount ? qualitySum / qualityCount : 0;
  const drift = await detectDrift(workspaceId);

  return {
    workspaceId,
    totalInteractions: interactions.length,
    qualityAvg: Math.round(qualityAvg * 1000) / 1000,
    qualityTrend: drift.trend,
    rungCounts,
    trainingCandidates: candidates,
    lastCuratedAt: state.lastCuratedAt,
    lastTrainedAt: state.lastTrainedAt,
    improvementSinceLast: state.improvementSinceLast || 0,
    driftDetected: drift.driftDetected,
    minScore: TRAIN_MIN_SCORE,
  };
}

/**
 * List training candidates with pagination.
 */
export async function listTrainingCandidates(workspaceId, options = {}) {
  const limit = Math.min(Math.max(1, Number(options.limit) || 50), 500);
  const interactions = loadInteractions(workspaceId);
  const signals = loadSignals(workspaceId);
  const scored = interactions.map((it) => {
    const s = computeInteractionScore(it, signals[it.id] || [], interactions);
    return { interaction: it, ...s };
  });
  const filtered = scored
    .filter((s) => s.score >= TRAIN_MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return {
    candidates: filtered.map((s) => ({
      id: s.interaction.id,
      prompt: s.interaction.prompt.slice(0, 500),
      response: s.interaction.response.slice(0, 500),
      score: s.score,
      rung: s.rung,
      model: s.interaction.model,
      createdAt: s.interaction.createdAt,
    })),
    total: filtered.length,
  };
}

/**
 * Internal: update curation state. Used by the worker.
 */
export async function updateCurationState(workspaceId, patch) {
  const state = loadState(workspaceId);
  const next = { ...state, ...patch };
  if (patch.lastCuratedAt) {
    next.history = [
      ...(state.history || []).slice(-99),
      { at: patch.lastCuratedAt, candidates: patch.lastTrainingCandidateCount || 0 },
    ];
  }
  saveState(workspaceId, next);
  return next;
}

export async function markInteractionsCurated(workspaceId, ids) {
  const interactions = loadInteractions(workspaceId);
  const set = new Set(ids);
  for (const it of interactions) {
    if (set.has(it.id)) {
      it.curated = true;
    }
  }
  saveInteractions(workspaceId, interactions);
}

export async function markInteractionsRejected(workspaceId, ids) {
  const interactions = loadInteractions(workspaceId);
  const set = new Set(ids);
  for (const it of interactions) {
    if (set.has(it.id)) {
      it.rejected = true;
    }
  }
  saveInteractions(workspaceId, interactions);
}

// Test helper: full workspace wipe.
export function __resetWorkspaceForTests(workspaceId) {
  saveInteractions(workspaceId, []);
  saveSignals(workspaceId, {});
  saveState(workspaceId, {
    lastCuratedAt: null,
    lastTrainedAt: null,
    lastTrainingCandidateCount: 0,
    improvementSinceLast: 0,
    history: [],
  });
}
