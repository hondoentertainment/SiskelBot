/**
 * Phase 58.2: Speculative decoding orchestration.
 *
 * Speculative decoding speeds up autoregressive generation by using a cheap
 * "draft" model to propose γ (gamma) candidate tokens in a single pass, then
 * verifying them with a larger "target" model. Accepted tokens are committed;
 * on the first rejection the draft is truncated and a single token is sampled
 * from the target's corrected distribution.
 *
 * This module implements the orchestration layer only — model inference is
 * delegated to pluggable implementations registered by name. Mock draft/target
 * models are provided for testing and estimation.
 *
 * Storage: data/speculative-decoding/runs.json via json-path-store.
 */
import { randomUUID } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

// ─── Pluggable model registry ────────────────────────────────────────────────

const draftModels = new Map();
const targetModels = new Map();

/**
 * Register a draft-model implementation.
 * implFn signature: async (prompt, k, context?) -> Array<{ token, prob }>
 */
export function registerDraftModel(name, implFn) {
  if (typeof name !== "string" || !name.trim()) {
    throw new Error("draft model name is required");
  }
  if (typeof implFn !== "function") {
    throw new Error("draft model implFn must be a function");
  }
  draftModels.set(name, implFn);
  return true;
}

/**
 * Register a target-model implementation.
 * implFn signature: async (prompt, candidateTokens, context?) ->
 *   { acceptance: number[], targetProbs: number[], fallbackToken: { token, prob } }
 */
export function registerTargetModel(name, implFn) {
  if (typeof name !== "string" || !name.trim()) {
    throw new Error("target model name is required");
  }
  if (typeof implFn !== "function") {
    throw new Error("target model implFn must be a function");
  }
  targetModels.set(name, implFn);
  return true;
}

export function getDraftModel(name) {
  return draftModels.get(name) || null;
}

export function getTargetModel(name) {
  return targetModels.get(name) || null;
}

export function listRegisteredModels() {
  return {
    draft: Array.from(draftModels.keys()),
    target: Array.from(targetModels.keys()),
  };
}

// ─── Mock implementations (for tests and estimation) ─────────────────────────

/**
 * Mock draft model: generates k pseudo-tokens by deterministic hashing of the prompt.
 * Each returned token has a draft probability used for verification sampling.
 */
export const mockDraftModel = async (prompt, k = 4) => {
  const count = Math.max(1, Math.floor(k));
  const out = [];
  let seed = hashString(String(prompt || ""));
  for (let i = 0; i < count; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const token = `t${seed % 10000}`;
    // draft probabilities skewed high (draft model is usually confident)
    const prob = 0.4 + ((seed % 60) / 100);
    out.push({ token, prob: clamp(prob, 0.01, 0.99) });
  }
  return out;
};

/**
 * Mock target model: verifies a list of candidate tokens.
 * Accepts each candidate with probability proportional to targetProb/draftProb.
 * Returns an acceptance mask (1 = accept, 0 = reject) plus a fallback token
 * to use after the first rejection.
 */
export const mockTargetModel = async (prompt, candidateTokens) => {
  if (!Array.isArray(candidateTokens) || candidateTokens.length === 0) {
    return { acceptance: [], targetProbs: [], fallbackToken: { token: "<eos>", prob: 1 } };
  }
  const acceptance = [];
  const targetProbs = [];
  let seed = hashString(String(prompt || "")) ^ 0xdeadbeef;
  for (const cand of candidateTokens) {
    seed = (seed * 22695477 + 1) & 0x7fffffff;
    // Target probability: tends to agree with draft but with some deviation.
    const draftProb = typeof cand?.prob === "number" ? cand.prob : 0.5;
    const noise = ((seed % 100) - 50) / 200; // +/- 0.25
    const tProb = clamp(draftProb + noise, 0.05, 0.99);
    targetProbs.push(tProb);
    // Deterministic accept/reject via rejection sampling
    const r = ((seed >>> 4) % 1000) / 1000;
    const ratio = tProb / Math.max(draftProb, 1e-6);
    acceptance.push(r < ratio ? 1 : 0);
  }
  // If the first reject appears, everything after must be 0 (speculative rules)
  let sawReject = false;
  for (let i = 0; i < acceptance.length; i++) {
    if (sawReject) acceptance[i] = 0;
    if (acceptance[i] === 0) sawReject = true;
  }
  const fallbackSeed = (seed * 16807) & 0x7fffffff;
  return {
    acceptance,
    targetProbs,
    fallbackToken: {
      token: `f${fallbackSeed % 10000}`,
      prob: 0.5 + ((fallbackSeed % 40) / 100),
    },
  };
};

// Register the mocks by default so tests and estimation endpoints work out of the box.
draftModels.set("mock", mockDraftModel);
targetModels.set("mock", mockTargetModel);

// ─── Core speculative generation loop ────────────────────────────────────────

const DEFAULT_OPTIONS = {
  draftModel: "mock",
  targetModel: "mock",
  maxTokens: 64,
  gamma: 4,
  stopTokens: [],
};

/**
 * Run speculative decoding on a prompt.
 * @returns {Promise<{text, tokens, stats}>}
 */
export async function speculativeGenerate(prompt, options = {}) {
  if (typeof prompt !== "string") {
    throw new Error("prompt must be a string");
  }
  const opts = { ...DEFAULT_OPTIONS, ...(options || {}) };
  const draftImpl = resolveImpl(opts.draftModel, draftModels, "draft");
  const targetImpl = resolveImpl(opts.targetModel, targetModels, "target");
  const maxTokens = Math.max(1, Math.floor(opts.maxTokens || DEFAULT_OPTIONS.maxTokens));
  const gamma = Math.max(1, Math.floor(opts.gamma || DEFAULT_OPTIONS.gamma));
  const stopSet = new Set(Array.isArray(opts.stopTokens) ? opts.stopTokens : []);

  const tokens = [];
  const stats = {
    accepted: 0,
    rejected: 0,
    iterations: 0,
    fallbackTokens: 0,
    gamma,
    draftCalls: 0,
    targetCalls: 0,
    startedAt: Date.now(),
    finishedAt: null,
    stopReason: "max_tokens",
  };

  let contextPrompt = prompt;

  outer: while (tokens.length < maxTokens) {
    stats.iterations += 1;

    // Step 1: draft model generates γ candidate tokens
    const remaining = maxTokens - tokens.length;
    const k = Math.min(gamma, remaining);
    const draftTokens = await draftImpl(contextPrompt, k);
    stats.draftCalls += 1;
    if (!Array.isArray(draftTokens) || draftTokens.length === 0) {
      stats.stopReason = "draft_empty";
      break;
    }

    // Step 2: target model verifies the candidates in one shot
    const verification = await targetImpl(contextPrompt, draftTokens);
    stats.targetCalls += 1;
    const mask = Array.isArray(verification?.acceptance) ? verification.acceptance : [];

    // Step 3: commit accepted prefix, stop at first reject
    let firstReject = -1;
    for (let i = 0; i < draftTokens.length; i++) {
      if (mask[i] === 1) {
        const cand = draftTokens[i];
        tokens.push(cand.token);
        stats.accepted += 1;
        contextPrompt += cand.token;
        if (stopSet.has(cand.token)) {
          stats.stopReason = "stop_token";
          break outer;
        }
        if (tokens.length >= maxTokens) {
          stats.stopReason = "max_tokens";
          break outer;
        }
      } else {
        firstReject = i;
        break;
      }
    }

    if (firstReject !== -1) {
      // count rejections after the first
      stats.rejected += 1;
      // Step 4: sample one correction token from target
      const fb = verification?.fallbackToken;
      if (fb && typeof fb.token === "string") {
        tokens.push(fb.token);
        stats.fallbackTokens += 1;
        contextPrompt += fb.token;
        if (stopSet.has(fb.token)) {
          stats.stopReason = "stop_token";
          break;
        }
        if (tokens.length >= maxTokens) {
          stats.stopReason = "max_tokens";
          break;
        }
      } else {
        stats.stopReason = "no_fallback";
        break;
      }
    } else {
      // All γ candidates accepted — continue for another draft round.
      if (tokens.length >= maxTokens) {
        stats.stopReason = "max_tokens";
        break;
      }
    }
  }

  stats.finishedAt = Date.now();
  stats.durationMs = stats.finishedAt - stats.startedAt;
  stats.acceptanceRate = computeAcceptanceRate(stats);
  stats.expectedTokensPerIteration = computeExpectedTokensPerIteration(stats.acceptanceRate, gamma);
  stats.speedupEstimate = stats.iterations > 0
    ? tokens.length / stats.iterations
    : 0;

  return {
    text: tokens.join(""),
    tokens,
    stats,
  };
}

// ─── Statistics helpers ──────────────────────────────────────────────────────

/**
 * Acceptance rate = accepted / (accepted + rejected).
 * Fallback tokens are not draft tokens, so they do not count toward the rate.
 */
export function computeAcceptanceRate(stats) {
  if (!stats || typeof stats !== "object") return 0;
  const a = Number(stats.accepted) || 0;
  const r = Number(stats.rejected) || 0;
  const total = a + r;
  if (total <= 0) return 0;
  return a / total;
}

/**
 * Analytical expected tokens per iteration for speculative decoding.
 *   E[tokens] = (1 - α^(γ+1)) / (1 - α)   when α != 1
 *             = γ + 1                      when α == 1
 * where α is the per-token acceptance rate and γ is the draft length.
 */
export function computeExpectedTokensPerIteration(acceptanceRate, gamma) {
  const alpha = clamp(Number(acceptanceRate) || 0, 0, 1);
  const g = Math.max(1, Math.floor(Number(gamma) || 1));
  if (alpha >= 1 - 1e-9) return g + 1;
  const num = 1 - Math.pow(alpha, g + 1);
  const den = 1 - alpha;
  return num / den;
}

/**
 * Estimate speedup vs. vanilla autoregressive decoding.
 *   speedup = expectedTokensPerIter * targetLatency /
 *             (targetLatency + gamma * draftLatency)
 * Uses observed acceptance rate when stats provided, otherwise defaults to 0.
 */
export function computeSpeedup(stats, targetLatencyMs, draftLatencyMs) {
  const t = Math.max(0, Number(targetLatencyMs) || 0);
  const d = Math.max(0, Number(draftLatencyMs) || 0);
  const alpha = computeAcceptanceRate(stats);
  const gamma = Math.max(1, Math.floor((stats && stats.gamma) || 4));
  const expected = computeExpectedTokensPerIteration(alpha, gamma);
  const iterCost = t + gamma * d;
  if (iterCost <= 0) return 0;
  return (expected * t) / iterCost;
}

// ─── Batched speculative ─────────────────────────────────────────────────────

/**
 * Run speculative decoding on several prompts concurrently. Returns one result
 * per prompt in the same order. Errors are captured per entry.
 */
export async function batchedSpeculativeGenerate(prompts, options = {}) {
  if (!Array.isArray(prompts)) {
    throw new Error("prompts must be an array");
  }
  const runs = await Promise.all(
    prompts.map(async (p) => {
      try {
        const r = await speculativeGenerate(p, options);
        return { ok: true, ...r };
      } catch (err) {
        return { ok: false, error: err?.message || String(err) };
      }
    }),
  );
  // aggregate stats
  const agg = {
    totalAccepted: 0,
    totalRejected: 0,
    totalIterations: 0,
    totalTokens: 0,
    successes: 0,
    failures: 0,
  };
  for (const r of runs) {
    if (r.ok && r.stats) {
      agg.totalAccepted += r.stats.accepted || 0;
      agg.totalRejected += r.stats.rejected || 0;
      agg.totalIterations += r.stats.iterations || 0;
      agg.totalTokens += (r.tokens && r.tokens.length) || 0;
      agg.successes += 1;
    } else {
      agg.failures += 1;
    }
  }
  agg.acceptanceRate = computeAcceptanceRate({
    accepted: agg.totalAccepted,
    rejected: agg.totalRejected,
  });
  return { runs, aggregate: agg };
}

// ─── Persistent run history ──────────────────────────────────────────────────

function runsPath() {
  return join(getDataDir(), "speculative-decoding", "runs.json");
}

async function loadRuns() {
  const store = await readJsonPath(runsPath(), { _version: 1, runs: [] });
  return {
    _version: store._version || 1,
    runs: Array.isArray(store.runs) ? store.runs : [],
  };
}

async function saveRuns(store) {
  await writeJsonPath(runsPath(), {
    _version: 1,
    runs: Array.isArray(store.runs) ? store.runs : [],
  });
}

/**
 * Persist a run record. Returns the stored record (with id and recordedAt).
 */
export async function recordRun(runStats) {
  if (!runStats || typeof runStats !== "object") {
    throw new Error("runStats is required");
  }
  const id = runStats.id || randomUUID();
  const record = {
    id,
    recordedAt: new Date().toISOString(),
    workspaceId: runStats.workspaceId || "default",
    draftModel: runStats.draftModel || null,
    targetModel: runStats.targetModel || null,
    promptPreview: typeof runStats.promptPreview === "string"
      ? runStats.promptPreview.slice(0, 200)
      : null,
    tokens: Number(runStats.tokens) || 0,
    accepted: Number(runStats.accepted) || 0,
    rejected: Number(runStats.rejected) || 0,
    iterations: Number(runStats.iterations) || 0,
    gamma: Number(runStats.gamma) || 0,
    acceptanceRate: typeof runStats.acceptanceRate === "number"
      ? runStats.acceptanceRate
      : computeAcceptanceRate(runStats),
    speedupEstimate: Number(runStats.speedupEstimate) || 0,
    durationMs: Number(runStats.durationMs) || 0,
    stopReason: runStats.stopReason || null,
    metadata: runStats.metadata && typeof runStats.metadata === "object"
      ? runStats.metadata
      : {},
  };

  await withPathLock(runsPath(), async () => {
    const store = await loadRuns();
    store.runs.push(record);
    // cap history at 5000 entries
    if (store.runs.length > 5000) {
      store.runs = store.runs.slice(-5000);
    }
    await saveRuns(store);
  });

  return record;
}

/**
 * List run records with optional filter: { workspaceId, draftModel, targetModel, since, until, limit }
 */
export async function getRunHistory(filter = {}) {
  const store = await loadRuns();
  let runs = store.runs.slice();
  const f = filter || {};

  if (f.id) {
    runs = runs.filter((r) => r.id === f.id);
  }
  if (f.workspaceId) {
    runs = runs.filter((r) => r.workspaceId === f.workspaceId);
  }
  if (f.draftModel) {
    runs = runs.filter((r) => r.draftModel === f.draftModel);
  }
  if (f.targetModel) {
    runs = runs.filter((r) => r.targetModel === f.targetModel);
  }
  if (f.since) {
    const since = new Date(f.since).getTime();
    if (!Number.isNaN(since)) {
      runs = runs.filter((r) => new Date(r.recordedAt).getTime() >= since);
    }
  }
  if (f.until) {
    const until = new Date(f.until).getTime();
    if (!Number.isNaN(until)) {
      runs = runs.filter((r) => new Date(r.recordedAt).getTime() <= until);
    }
  }

  runs.sort((a, b) => new Date(b.recordedAt).getTime() - new Date(a.recordedAt).getTime());

  if (Number.isFinite(f.limit) && f.limit > 0) {
    runs = runs.slice(0, Math.floor(f.limit));
  }
  return runs;
}

/**
 * Aggregate statistics across a time window.
 *   timeRange = { since, until, workspaceId? }
 */
export async function getAggregateStats(timeRange = {}) {
  const runs = await getRunHistory({
    since: timeRange?.since,
    until: timeRange?.until,
    workspaceId: timeRange?.workspaceId,
  });

  const totals = {
    runs: runs.length,
    tokens: 0,
    accepted: 0,
    rejected: 0,
    iterations: 0,
    fallbackTokens: 0,
    durationMs: 0,
    speedupEstimateSum: 0,
  };
  const byDraft = {};
  const byTarget = {};

  for (const r of runs) {
    totals.tokens += r.tokens || 0;
    totals.accepted += r.accepted || 0;
    totals.rejected += r.rejected || 0;
    totals.iterations += r.iterations || 0;
    totals.durationMs += r.durationMs || 0;
    totals.speedupEstimateSum += r.speedupEstimate || 0;
    if (r.draftModel) {
      byDraft[r.draftModel] = (byDraft[r.draftModel] || 0) + 1;
    }
    if (r.targetModel) {
      byTarget[r.targetModel] = (byTarget[r.targetModel] || 0) + 1;
    }
  }

  const acceptanceRate = computeAcceptanceRate({
    accepted: totals.accepted,
    rejected: totals.rejected,
  });
  const avgSpeedup = totals.runs > 0 ? totals.speedupEstimateSum / totals.runs : 0;
  const avgTokensPerRun = totals.runs > 0 ? totals.tokens / totals.runs : 0;
  const avgIterationsPerRun = totals.runs > 0 ? totals.iterations / totals.runs : 0;

  return {
    totals,
    acceptanceRate,
    avgSpeedup,
    avgTokensPerRun,
    avgIterationsPerRun,
    byDraftModel: byDraft,
    byTargetModel: byTarget,
  };
}

// ─── Token-level verification (rejection sampling) ───────────────────────────

/**
 * Accept a single draft token via the standard speculative-decoding criterion:
 *   accept if r < min(1, targetProb / draftProb)
 * @param {number} draftProb    probability assigned by draft model
 * @param {number} targetProb   probability assigned by target model
 * @param {() => number} [rngFn] random source in [0,1)
 */
export function acceptDraftToken(draftProb, targetProb, rngFn = Math.random) {
  const dp = Math.max(Number(draftProb) || 0, 1e-9);
  const tp = Math.max(Number(targetProb) || 0, 0);
  const ratio = Math.min(1, tp / dp);
  const r = typeof rngFn === "function" ? rngFn() : Math.random();
  return r < ratio;
}

/**
 * Verify a sequence of draft tokens against target probs, stopping at first reject.
 * @returns { accepted: [...], rejected: [...], position } where `position` is the
 *   index of the first rejected token (or tokens.length if all accepted).
 */
export function verifyDraftTokens(draftTokens, targetProbs, rngFn = Math.random) {
  if (!Array.isArray(draftTokens)) {
    throw new Error("draftTokens must be an array");
  }
  if (!Array.isArray(targetProbs)) {
    throw new Error("targetProbs must be an array");
  }
  const accepted = [];
  const rejected = [];
  let position = draftTokens.length;
  for (let i = 0; i < draftTokens.length; i++) {
    const cand = draftTokens[i];
    const dp = typeof cand?.prob === "number" ? cand.prob : 0.5;
    const tp = typeof targetProbs[i] === "number" ? targetProbs[i] : 0;
    if (acceptDraftToken(dp, tp, rngFn)) {
      accepted.push(cand);
    } else {
      rejected.push(cand);
      position = i;
      break;
    }
  }
  return { accepted, rejected, position };
}

// ─── Configuration presets ───────────────────────────────────────────────────

export const PRESETS = {
  conservative: { gamma: 2, acceptanceMinimum: 0.7 },
  balanced: { gamma: 4, acceptanceMinimum: 0.5 },
  aggressive: { gamma: 8, acceptanceMinimum: 0.3 },
};

export function getPreset(name) {
  const key = String(name || "").toLowerCase();
  return PRESETS[key] ? { ...PRESETS[key], name: key } : null;
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function clamp(n, lo, hi) {
  if (Number.isNaN(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 16777619) & 0x7fffffff;
  }
  return h || 1;
}

function resolveImpl(nameOrFn, registry, kind) {
  if (typeof nameOrFn === "function") return nameOrFn;
  const name = typeof nameOrFn === "string" && nameOrFn.trim() ? nameOrFn : "mock";
  const impl = registry.get(name);
  if (!impl) {
    throw new Error(`Unknown ${kind} model: ${name}`);
  }
  return impl;
}
