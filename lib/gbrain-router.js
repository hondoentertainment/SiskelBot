/**
 * GBrain routing engine.
 *
 * Decision layer of the GBrain agent system. Given a task analysis, pick the
 * best execution strategy and dispatch to the appropriate subsystem
 * (agent-loop, swarm, hierarchy, consensus, long-running mission, reflection,
 * or plain direct response).
 *
 * Strategies are scored against a task analysis by combining:
 *   - baseline per-strategy reliability
 *   - heuristic "match score" for how well the strategy fits the task's
 *     complexity, stakes, and required capabilities
 *   - penalties for cost and latency that exceed the caller's budget
 *
 * Dispatchers are kept thin: each one performs a dynamic import of the
 * concrete subsystem so test code can stub strategies via `setSubsystem` /
 * `resetSubsystems` without loading heavy dependencies.
 *
 * Outcomes (success/failure/cost/latency) are recorded to a durable JSON
 * store so the router can learn which strategies perform best on which task
 * shapes over time (`getAdaptiveStrategy`).
 *
 * @module gbrain-router
 */
import { join } from "path";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";
import {
  summarizeHeuristics,
  assessComplexity,
  matchesSimpleQuestion,
  matchesToolRequired,
  matchesHighStakes,
  matchesLongRunning,
} from "./gbrain-heuristics.js";

export const STRATEGIES = {
  direct: {
    name: "Direct Response",
    bestFor: ["simple questions", "conversational", "trivial tasks"],
    costMultiplier: 1,
    latencyMs: 500,
    reliability: 0.85,
  },
  agent_loop: {
    name: "Agent Tool Loop",
    bestFor: ["tasks requiring tools", "multi-step reasoning"],
    costMultiplier: 2,
    latencyMs: 3000,
    reliability: 0.9,
  },
  swarm: {
    name: "Multi-Agent Swarm",
    bestFor: ["complex research", "multi-perspective analysis"],
    costMultiplier: 4,
    latencyMs: 5000,
    reliability: 0.92,
  },
  hierarchy: {
    name: "Hierarchical Delegation",
    bestFor: ["large projects", "task decomposition"],
    costMultiplier: 6,
    latencyMs: 8000,
    reliability: 0.88,
  },
  consensus: {
    name: "Consensus Voting",
    bestFor: ["high-stakes decisions", "fact-checking"],
    costMultiplier: 3,
    latencyMs: 4000,
    reliability: 0.95,
  },
  mission: {
    name: "Long-Running Mission",
    bestFor: ["extended autonomous work", "research projects"],
    costMultiplier: 10,
    latencyMs: 60_000,
    reliability: 0.85,
  },
  reflection: {
    name: "Reflect & Revise",
    bestFor: ["critical outputs", "code generation"],
    costMultiplier: 1.5,
    latencyMs: 2000,
    reliability: 0.93,
  },
};

const STRATEGY_IDS = Object.keys(STRATEGIES);

// Normalisation constants: the router penalises cost and latency relative to
// the most expensive / slowest strategy so the penalties always live in a
// bounded range (0..costWeight, 0..latencyWeight).
const MAX_COST_MULTIPLIER = 10; // "mission"
const MAX_LATENCY_MS = 60_000; // "mission"

const DEFAULT_BUDGET = {
  maxCost: Infinity,
  maxLatencyMs: Infinity,
  costWeight: 0.1,
  latencyWeight: 0.1,
};

function storePath() {
  return join(getDataDir(), "gbrain-router.json");
}

function normalizeStore(raw) {
  const base = raw && typeof raw === "object" ? raw : {};
  const outcomes =
    base.outcomes && typeof base.outcomes === "object" && !Array.isArray(base.outcomes)
      ? base.outcomes
      : {};
  return { version: 1, outcomes };
}

function ensureOutcomeBuckets(store, strategyId, taskType) {
  if (!store.outcomes[strategyId]) {
    store.outcomes[strategyId] = {
      uses: 0,
      successes: 0,
      failures: 0,
      totalCost: 0,
      totalLatencyMs: 0,
      byTaskType: {},
    };
  }
  const bucket = store.outcomes[strategyId];
  if (!bucket.byTaskType[taskType]) {
    bucket.byTaskType[taskType] = {
      uses: 0,
      successes: 0,
      failures: 0,
      totalCost: 0,
      totalLatencyMs: 0,
    };
  }
  return bucket;
}

/**
 * Compute how well a strategy matches a task analysis based on heuristics and
 * the strategy's declared "bestFor" tags. Returns a number in [0, 1].
 *
 * @param {string} strategyId
 * @param {object} analysis
 */
function computeDomainMatch(strategyId, analysis) {
  const heur = analysis?._heuristics || summarizeHeuristics(analysis?.task ?? analysis);
  const complexity = analysis?.complexity || heur.complexity;
  const toolsRequired =
    typeof analysis?.toolsRequired === "boolean"
      ? analysis.toolsRequired
      : heur.toolRequired;
  const highStakes =
    typeof analysis?.highStakes === "boolean" ? analysis.highStakes : heur.highStakes;
  const longRunning =
    typeof analysis?.longRunning === "boolean" ? analysis.longRunning : heur.longRunning;
  const simpleQuestion =
    typeof analysis?.simpleQuestion === "boolean"
      ? analysis.simpleQuestion
      : heur.simpleQuestion;

  let score = 0.3; // baseline so nothing is ever 0

  switch (strategyId) {
    case "direct":
      if (simpleQuestion) score += 0.6;
      if (complexity === "trivial") score += 0.1;
      if (complexity === "simple") score += 0.05;
      if (toolsRequired) score -= 0.4;
      if (highStakes) score -= 0.25;
      if (longRunning) score -= 0.4;
      if (complexity === "complex" || complexity === "mission") score -= 0.3;
      break;
    case "agent_loop":
      if (toolsRequired) score += 0.55;
      if (complexity === "moderate") score += 0.15;
      if (complexity === "complex") score += 0.1;
      if (simpleQuestion) score -= 0.2;
      if (longRunning) score -= 0.15;
      break;
    case "swarm":
      if (complexity === "complex") score += 0.4;
      if (analysis?.multiPerspective) score += 0.25;
      if (toolsRequired) score += 0.1;
      if (simpleQuestion) score -= 0.35;
      if (complexity === "trivial") score -= 0.3;
      break;
    case "hierarchy":
      if (complexity === "complex") score += 0.35;
      if (complexity === "mission") score += 0.2;
      if (analysis?.decomposable) score += 0.25;
      if (simpleQuestion) score -= 0.4;
      if (complexity === "trivial" || complexity === "simple") score -= 0.3;
      break;
    case "consensus":
      if (highStakes) score += 0.55;
      if (analysis?.factCheck) score += 0.2;
      if (simpleQuestion && !highStakes) score -= 0.2;
      if (longRunning) score -= 0.2;
      break;
    case "mission":
      if (longRunning) score += 0.6;
      if (complexity === "mission") score += 0.3;
      if (simpleQuestion) score -= 0.5;
      if (complexity === "trivial" || complexity === "simple") score -= 0.4;
      break;
    case "reflection":
      if (analysis?.critical) score += 0.35;
      if (analysis?.codeGeneration) score += 0.3;
      if (complexity === "moderate" || complexity === "complex") score += 0.1;
      if (simpleQuestion) score -= 0.2;
      if (longRunning) score -= 0.2;
      break;
    default:
      break;
  }

  if (score < 0) score = 0;
  if (score > 1) score = 1;
  return score;
}

/**
 * Compute a total score for a strategy given an analysis and (optional)
 * budget constraints. Score shape:
 *
 *   score = (0.5 * reliability + 0.5 * domain_match)
 *           - cost_penalty
 *           - latency_penalty
 *
 * @param {string} strategyId
 * @param {object} analysis
 * @param {object} [budgetConstraints]
 * @returns {number} A number in [0, 1] after clamping.
 */
export function scoreStrategy(strategyId, analysis, budgetConstraints = {}) {
  const strategy = STRATEGIES[strategyId];
  if (!strategy) return 0;
  const budget = { ...DEFAULT_BUDGET, ...budgetConstraints };

  const domain = computeDomainMatch(strategyId, analysis);
  const base = 0.5 * strategy.reliability + 0.5 * domain;

  const cost = strategy.costMultiplier;
  const latency = strategy.latencyMs;

  // Normalise cost and latency to [0, 1] against the most expensive /
  // slowest strategies so the penalties stay bounded regardless of absolute
  // units.
  const normCost = Math.min(1, Math.max(0, cost) / MAX_COST_MULTIPLIER);
  const normLatency = Math.min(1, Math.max(0, latency) / MAX_LATENCY_MS);

  let costPenalty = normCost * Math.max(0, budget.costWeight);
  let latencyPenalty = normLatency * Math.max(0, budget.latencyWeight);

  // Hard budget busts: if a strategy exceeds the caller's ceilings, apply a
  // large penalty so it falls to the bottom of the ranking but does not go
  // strictly negative (so it can still be the fallback if nothing fits).
  if (Number.isFinite(budget.maxCost) && cost > budget.maxCost) {
    costPenalty += 1;
  }
  if (Number.isFinite(budget.maxLatencyMs) && latency > budget.maxLatencyMs) {
    latencyPenalty += 1;
  }

  let total = base - costPenalty - latencyPenalty;
  if (total < 0) total = 0;
  if (total > 1) total = 1;
  return total;
}

/**
 * Rank all strategies against an analysis, and return the best-fitting one
 * that satisfies the given budget ceilings. Falls back to the highest-ranked
 * strategy overall if nothing fits.
 *
 * @param {object} analysis
 * @param {object} [budget]
 * @returns {{ strategy: string, score: number, ranking: Array<{ strategy: string, score: number, fitsBudget: boolean }> }}
 */
export function selectBestStrategy(analysis, budget = {}) {
  const merged = { ...DEFAULT_BUDGET, ...budget };
  const ranking = STRATEGY_IDS.map((id) => {
    const strategy = STRATEGIES[id];
    const fitsBudget =
      strategy.costMultiplier <= (merged.maxCost ?? Infinity) &&
      strategy.latencyMs <= (merged.maxLatencyMs ?? Infinity);
    return {
      strategy: id,
      score: scoreStrategy(id, analysis, merged),
      fitsBudget,
    };
  }).sort((a, b) => b.score - a.score);

  const withinBudget = ranking.find((entry) => entry.fitsBudget);
  const chosen = withinBudget || ranking[0];
  return { strategy: chosen.strategy, score: chosen.score, ranking };
}

// ---------------------------------------------------------------------------
// Subsystem dispatch
// ---------------------------------------------------------------------------

/**
 * Map of subsystem implementations. Kept as a mutable object so tests can
 * substitute fake implementations via `setSubsystem` without loading the real
 * (heavy) modules.
 *
 * @type {Record<string, (task: any, context: any) => Promise<any>>}
 */
const subsystems = {
  direct: defaultDirect,
  agent_loop: defaultAgentLoop,
  swarm: defaultSwarm,
  hierarchy: defaultHierarchy,
  consensus: defaultConsensus,
  mission: defaultMission,
  reflection: defaultReflection,
};

/**
 * Override the dispatcher for a given strategy. Primarily intended for tests.
 * @param {string} strategy
 * @param {(task: any, context: any) => Promise<any>} impl
 */
export function setSubsystem(strategy, impl) {
  if (!STRATEGIES[strategy]) {
    throw new Error(`Unknown strategy: ${strategy}`);
  }
  if (typeof impl !== "function") {
    throw new Error("Subsystem implementation must be a function");
  }
  subsystems[strategy] = impl;
}

/**
 * Reset subsystem dispatchers to their defaults (for test teardown).
 */
export function resetSubsystems() {
  subsystems.direct = defaultDirect;
  subsystems.agent_loop = defaultAgentLoop;
  subsystems.swarm = defaultSwarm;
  subsystems.hierarchy = defaultHierarchy;
  subsystems.consensus = defaultConsensus;
  subsystems.mission = defaultMission;
  subsystems.reflection = defaultReflection;
}

/**
 * Dispatch a task to the concrete implementation for a given strategy.
 *
 * @param {string} strategy
 * @param {any} task
 * @param {any} context
 */
export async function routeToSubsystem(strategy, task, context = {}) {
  const impl = subsystems[strategy];
  if (!impl) throw new Error(`Unknown strategy: ${strategy}`);
  return impl(task, context);
}

async function defaultDirect(task, context) {
  // Default "direct" path simply echoes the task text back through the
  // caller-supplied model function, if any. Callers normally replace this
  // with a real model call.
  const text = typeof task === "string" ? task : task?.task || task?.prompt || "";
  if (typeof context?.model === "function") {
    return context.model(text, { strategy: "direct" });
  }
  return { strategy: "direct", text };
}

async function defaultAgentLoop(task, context) {
  const mod = await import("./agent-loop.js");
  const runAgentLoop = mod.runAgentLoop || mod.default;
  if (typeof runAgentLoop !== "function") {
    throw new Error("agent-loop.js does not export runAgentLoop");
  }
  return runAgentLoop(task, context);
}

async function defaultSwarm(task, context) {
  const mod = await import("./swarm.js");
  const runSwarm = mod.runSwarm || mod.default;
  if (typeof runSwarm !== "function") {
    throw new Error("swarm.js does not export runSwarm");
  }
  return runSwarm(task, context);
}

async function defaultHierarchy(task, context) {
  const mod = await import("./agent-hierarchy.js");
  const runHierarchy =
    mod.runHierarchy || mod.runManager || mod.executeHierarchy || mod.default;
  if (typeof runHierarchy !== "function") {
    throw new Error("agent-hierarchy.js does not export a hierarchy runner");
  }
  return runHierarchy(task, context);
}

async function defaultConsensus(task, context) {
  const mod = await import("./agent-consensus.js");
  const runConsensus =
    mod.runConsensus || mod.executeConsensus || mod.default;
  if (typeof runConsensus !== "function") {
    throw new Error("agent-consensus.js does not export a consensus runner");
  }
  return runConsensus(task, context);
}

async function defaultMission(task, context) {
  const mod = await import("./long-running-missions.js");
  const runMission =
    mod.runMission || mod.startMission || mod.createMission || mod.default;
  if (typeof runMission !== "function") {
    throw new Error("long-running-missions.js does not export a mission runner");
  }
  return runMission(task, context);
}

async function defaultReflection(task, context) {
  const mod = await import("./agent-reflection.js");
  const runReflection =
    mod.runReflection || mod.reflectAndRevise || mod.default;
  if (typeof runReflection !== "function") {
    throw new Error("agent-reflection.js does not export a reflection runner");
  }
  return runReflection(task, context);
}

// ---------------------------------------------------------------------------
// Outcome tracking
// ---------------------------------------------------------------------------

function classifyTaskType(task, analysis) {
  const provided = analysis?.taskType || analysis?.type;
  if (typeof provided === "string" && provided.trim()) return provided.trim();
  // Fall back to complexity bucket.
  const complexity = analysis?.complexity || assessComplexity(task);
  return `complexity:${complexity}`;
}

/**
 * Record the outcome of a strategy run so the router can learn from history.
 *
 * @param {string} strategy
 * @param {string} taskType
 * @param {object} outcome  { success: boolean, cost?: number, latencyMs?: number }
 */
export async function recordStrategyOutcome(strategy, taskType, outcome) {
  if (!STRATEGIES[strategy]) {
    throw new Error(`Unknown strategy: ${strategy}`);
  }
  const type =
    typeof taskType === "string" && taskType.trim() ? taskType.trim() : "unknown";
  const success = Boolean(outcome?.success);
  const cost = Number.isFinite(outcome?.cost) ? Number(outcome.cost) : 0;
  const latencyMs = Number.isFinite(outcome?.latencyMs)
    ? Number(outcome.latencyMs)
    : 0;

  const path = storePath();
  return withPathLock(path, async () => {
    const raw = await readJsonPath(path, { version: 1, outcomes: {} });
    const store = normalizeStore(raw);
    const bucket = ensureOutcomeBuckets(store, strategy, type);
    bucket.uses += 1;
    bucket.totalCost += cost;
    bucket.totalLatencyMs += latencyMs;
    if (success) bucket.successes += 1;
    else bucket.failures += 1;

    const typeBucket = bucket.byTaskType[type];
    typeBucket.uses += 1;
    typeBucket.totalCost += cost;
    typeBucket.totalLatencyMs += latencyMs;
    if (success) typeBucket.successes += 1;
    else typeBucket.failures += 1;

    await writeJsonPath(path, store);
    return { strategy, taskType: type, uses: bucket.uses };
  });
}

/**
 * Retrieve aggregate stats for a strategy.
 *
 * @param {string} strategyId
 * @returns {Promise<{ uses: number, successRate: number, avgCost: number, avgLatency: number, byTaskType: Record<string, { uses: number, successRate: number, avgCost: number, avgLatency: number }> }>}
 */
export async function getStrategyStats(strategyId) {
  if (!STRATEGIES[strategyId]) {
    throw new Error(`Unknown strategy: ${strategyId}`);
  }
  const raw = await readJsonPath(storePath(), { version: 1, outcomes: {} });
  const store = normalizeStore(raw);
  const bucket = store.outcomes[strategyId];
  if (!bucket || !bucket.uses) {
    return {
      uses: 0,
      successRate: 0,
      avgCost: 0,
      avgLatency: 0,
      byTaskType: {},
    };
  }
  const byTaskType = {};
  for (const [type, t] of Object.entries(bucket.byTaskType || {})) {
    byTaskType[type] = {
      uses: t.uses,
      successRate: t.uses ? t.successes / t.uses : 0,
      avgCost: t.uses ? t.totalCost / t.uses : 0,
      avgLatency: t.uses ? t.totalLatencyMs / t.uses : 0,
    };
  }
  return {
    uses: bucket.uses,
    successRate: bucket.uses ? bucket.successes / bucket.uses : 0,
    avgCost: bucket.uses ? bucket.totalCost / bucket.uses : 0,
    avgLatency: bucket.uses ? bucket.totalLatencyMs / bucket.uses : 0,
    byTaskType,
  };
}

/**
 * Adaptive routing: pick the strategy that has historically performed best on
 * tasks of the same shape. Falls back to `selectBestStrategy` when there is
 * insufficient history.
 *
 * @param {object} analysis
 * @param {{ minSamples?: number, budget?: object, history?: Array<{ strategy: string, taskType: string, success: boolean }> } | Array<any>} [options]
 */
export async function getAdaptiveStrategy(analysis, options = {}) {
  // Permit `options` to be a bare history array for convenience.
  const opts = Array.isArray(options) ? { history: options } : options || {};
  const minSamples = Math.max(1, Number(opts.minSamples) || 3);
  const budget = opts.budget || {};
  const taskType = classifyTaskType(analysis?.task ?? analysis, analysis);

  // Gather historical success rates. Prefer an in-memory history (tests),
  // otherwise read from the durable store.
  const tally = {};
  for (const id of STRATEGY_IDS) {
    tally[id] = { uses: 0, successes: 0 };
  }

  if (Array.isArray(opts.history)) {
    // Explicit history array (even if empty) means: use only this; do not
    // fall back to the durable store.
    for (const entry of opts.history) {
      if (!entry || entry.taskType !== taskType) continue;
      if (!tally[entry.strategy]) continue;
      tally[entry.strategy].uses += 1;
      if (entry.success) tally[entry.strategy].successes += 1;
    }
  } else {
    const raw = await readJsonPath(storePath(), { version: 1, outcomes: {} });
    const store = normalizeStore(raw);
    for (const id of STRATEGY_IDS) {
      const bucket = store.outcomes[id];
      const byType = bucket?.byTaskType?.[taskType];
      if (byType) {
        tally[id].uses = byType.uses || 0;
        tally[id].successes = byType.successes || 0;
      }
    }
  }

  // Build candidate list of strategies with enough samples, ranked by
  // historical success rate. Tie-break with the static scoring model so we
  // still prefer strategies whose heuristics match the task.
  const candidates = STRATEGY_IDS.map((id) => {
    const t = tally[id];
    const successRate = t.uses >= minSamples ? t.successes / t.uses : null;
    const staticScore = scoreStrategy(id, analysis, budget);
    return { strategy: id, successRate, samples: t.uses, staticScore };
  });

  const eligible = candidates.filter((c) => c.successRate != null);
  if (!eligible.length) {
    const fallback = selectBestStrategy(analysis, budget);
    return {
      strategy: fallback.strategy,
      source: "static",
      reason: "insufficient-history",
      taskType,
    };
  }

  eligible.sort((a, b) => {
    if (b.successRate !== a.successRate) return b.successRate - a.successRate;
    return b.staticScore - a.staticScore;
  });
  const best = eligible[0];
  return {
    strategy: best.strategy,
    source: "adaptive",
    successRate: best.successRate,
    samples: best.samples,
    taskType,
  };
}

// Re-export heuristics for convenience so downstream callers only need to
// import the router module.
export {
  matchesSimpleQuestion,
  matchesToolRequired,
  matchesHighStakes,
  matchesLongRunning,
  assessComplexity,
};
