/**
 * GBrain: central intelligence cortex for SiskelBot.
 *
 * GBrain is the meta-cognitive coordinator that decides how to handle each
 * incoming task. Inspired by Google Brain's Pathways architecture ("one brain,
 * many specialized pathways"), it routes work through eight named cortices:
 *
 *   perception  — parse and classify the task
 *   memory      — recall relevant context from unified memory
 *   reasoning   — score strategies and pick the best pathway
 *   planning    — break the chosen strategy into concrete steps
 *   execution   — dispatch to the subsystem (agent-loop, swarm, etc.)
 *   reflection  — critique the output and decide whether to retry
 *   learning    — record outcomes for meta-learning
 *   emotion     — track affect/priority for the thought
 *
 * Each call to {@link think} produces a durable "thought" (a plan with a
 * traceable id). {@link execute} runs the chosen strategy. {@link learn}
 * pushes an outcome back into the meta-learning loop. The module is
 * deliberately thin: it orchestrates the existing GBrain subsystems
 * (`gbrain-router`, `gbrain-memory`, `gbrain-meta-learning`, `gbrain-heuristics`)
 * rather than reimplementing them.
 *
 * Thoughts persist via `json-path-store` so the HTTP routes can page through
 * recent plans and the dashboard can surface cortex activity.
 *
 * @module gbrain
 */

import crypto from "node:crypto";
import { join } from "node:path";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";
import {
  STRATEGIES,
  selectBestStrategy,
  routeToSubsystem,
  recordStrategyOutcome,
  getAdaptiveStrategy,
} from "./gbrain-router.js";
import {
  summarizeHeuristics,
  assessComplexity,
  taskText,
} from "./gbrain-heuristics.js";

// gbrain-memory and gbrain-meta-learning are imported lazily so a stubbed-out
// or missing dependency never blocks `think()`. In practice the dependencies
// are always present, but we want GBrain to remain usable even if a cortex is
// broken during bootstrap.
let memoryModulePromise = null;
async function loadMemory() {
  if (!memoryModulePromise) {
    memoryModulePromise = import("./gbrain-memory.js").catch(() => null);
  }
  return memoryModulePromise;
}

let metaLearningModulePromise = null;
async function loadMetaLearning() {
  if (!metaLearningModulePromise) {
    metaLearningModulePromise = import("./gbrain-meta-learning.js").catch(
      () => null,
    );
  }
  return metaLearningModulePromise;
}

// ---------------------------------------------------------------------------
// Cortices
// ---------------------------------------------------------------------------

/**
 * The eight cortices exposed via `GET /api/v1/gbrain/cortices`. Each cortex
 * has an id, a human-readable name, and a description of its role in the
 * think → execute → learn lifecycle.
 */
export const CORTICES = [
  {
    id: "perception",
    name: "Perception",
    description: "Parse the incoming task and classify its shape.",
  },
  {
    id: "memory",
    name: "Memory",
    description: "Recall related facts, past thoughts, and relevant knowledge.",
  },
  {
    id: "reasoning",
    name: "Reasoning",
    description: "Score strategies and pick the best execution pathway.",
  },
  {
    id: "planning",
    name: "Planning",
    description: "Decompose the chosen strategy into concrete steps.",
  },
  {
    id: "execution",
    name: "Execution",
    description: "Dispatch the plan to the selected subsystem.",
  },
  {
    id: "reflection",
    name: "Reflection",
    description: "Critique the output and decide whether to revise.",
  },
  {
    id: "learning",
    name: "Learning",
    description: "Record outcomes and adjust strategy weights.",
  },
  {
    id: "emotion",
    name: "Emotion",
    description: "Track affect and priority to bias routing decisions.",
  },
];

const CORTEX_IDS = CORTICES.map((c) => c.id);

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const MAX_THOUGHTS = 2000;

function storePath() {
  return join(getDataDir(), "gbrain.json");
}

function normalizeStore(raw) {
  const base = raw && typeof raw === "object" ? raw : {};
  return {
    version: 1,
    thoughts: Array.isArray(base.thoughts) ? base.thoughts : [],
    cortexActivity:
      base.cortexActivity && typeof base.cortexActivity === "object"
        ? base.cortexActivity
        : {},
    strategyDistribution:
      base.strategyDistribution && typeof base.strategyDistribution === "object"
        ? base.strategyDistribution
        : {},
    outcomes: {
      total: Number.isFinite(base?.outcomes?.total) ? base.outcomes.total : 0,
      successes: Number.isFinite(base?.outcomes?.successes)
        ? base.outcomes.successes
        : 0,
      failures: Number.isFinite(base?.outcomes?.failures)
        ? base.outcomes.failures
        : 0,
      confidenceSum: Number.isFinite(base?.outcomes?.confidenceSum)
        ? base.outcomes.confidenceSum
        : 0,
    },
  };
}

async function loadStore() {
  const raw = await readJsonPath(storePath());
  return normalizeStore(raw);
}

async function saveStore(store) {
  // Bound the thoughts log so the store never grows unboundedly.
  if (store.thoughts.length > MAX_THOUGHTS) {
    store.thoughts = store.thoughts.slice(-MAX_THOUGHTS);
  }
  await writeJsonPath(storePath(), store);
}

function newThoughtId() {
  return `th_${crypto.randomBytes(6).toString("hex")}`;
}

// ---------------------------------------------------------------------------
// Analysis — perception + memory + reasoning
// ---------------------------------------------------------------------------

/**
 * Classify a task and produce a structured analysis used by `selectBestStrategy`.
 *
 * @param {unknown} task
 * @param {object} [context]
 */
export async function analyzeTask(task, context = {}) {
  const text = taskText(task);
  const heuristics = summarizeHeuristics(task);
  const complexity = assessComplexity(task);

  let memoryContext = null;
  if (context?.skipMemory !== true) {
    const memoryMod = await loadMemory();
    if (memoryMod && typeof memoryMod.unifiedRecall === "function") {
      try {
        memoryContext = await memoryMod.unifiedRecall(text, context);
      } catch {
        memoryContext = null;
      }
    }
  }

  return {
    task,
    text,
    complexity,
    type: classifyType(text, heuristics),
    domain: context?.domain || null,
    riskLevel: heuristics.highStakes ? "high" : "low",
    confidence: 0.5 + (memoryContext?.confidence || 0) * 0.5,
    toolsRequired: heuristics.toolRequired,
    highStakes: heuristics.highStakes,
    longRunning: heuristics.longRunning,
    simpleQuestion: heuristics.simpleQuestion,
    _heuristics: heuristics,
    memoryContext,
    cortexId: "perception",
  };
}

function classifyType(text, heuristics) {
  if (heuristics.simpleQuestion) return "converse";
  if (heuristics.longRunning) return "mission";
  if (heuristics.toolRequired) return "execute";
  if (/(analy|assess|compare|evaluate|review)/.test(text)) return "analyze";
  if (/(create|build|write|generate|draft)/.test(text)) return "create";
  if (/(fix|debug|troubleshoot|diagnose|error)/.test(text)) return "troubleshoot";
  if (/(research|investigate|find|search|look up)/.test(text)) return "research";
  return "converse";
}

/**
 * Pick a strategy for a given analysis. Prefers the adaptive choice when
 * meta-learning data is available; falls back to the heuristic ranker.
 *
 * @param {object} analysis
 * @param {object} [options]
 */
export async function selectStrategy(analysis, options = {}) {
  try {
    const adaptive = await getAdaptiveStrategy(analysis, options);
    if (adaptive && adaptive.strategy) return adaptive;
  } catch {
    /* fall through to heuristic */
  }
  return selectBestStrategy(analysis, options.budget || {});
}

/**
 * Build a concrete plan for a chosen strategy. Each plan is a sequence of
 * cortex steps so the UI can show progress through the pathway.
 *
 * @param {unknown} task
 * @param {object} analysis
 * @param {{ strategy: string, score?: number, ranking?: any[] }} strategyChoice
 */
export function buildPlan(task, analysis, strategyChoice) {
  const strategy = strategyChoice?.strategy || "direct";
  const meta = STRATEGIES[strategy] || STRATEGIES.direct;
  const id = newThoughtId();
  const steps = [
    { cortex: "perception", action: "classify", done: true },
    { cortex: "memory", action: "recall", done: Boolean(analysis?.memoryContext) },
    { cortex: "reasoning", action: "score-strategies", done: true },
    { cortex: "planning", action: "decompose", done: true },
    { cortex: "execution", action: `route:${strategy}`, done: false },
    { cortex: "reflection", action: "critique", done: false },
    { cortex: "learning", action: "record-outcome", done: false },
  ];
  return {
    id,
    task,
    analysis,
    strategy,
    strategyName: meta.name,
    costMultiplier: meta.costMultiplier,
    expectedLatencyMs: meta.latencyMs,
    confidence: Number.isFinite(analysis?.confidence) ? analysis.confidence : 0.6,
    steps,
    createdAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Analyze a task and return a plan (but do not execute it).
 *
 * @param {unknown} task
 * @param {object} [context]
 */
export async function think(task, context = {}) {
  if (task == null || (typeof task !== "string" && typeof task !== "object")) {
    throw new Error("task is required");
  }
  const analysis = await analyzeTask(task, context);
  const strategyChoice = await selectStrategy(analysis, { budget: context?.budget });
  const plan = buildPlan(task, analysis, strategyChoice);
  plan.ranking = strategyChoice?.ranking || [];
  plan.context = sanitizeContext(context);

  await withPathLock(storePath(), async () => {
    const store = await loadStore();
    store.thoughts.push({ ...plan, status: "planned" });
    store.strategyDistribution[plan.strategy] =
      (store.strategyDistribution[plan.strategy] || 0) + 1;
    for (const step of plan.steps) {
      if (step.done) {
        store.cortexActivity[step.cortex] =
          (store.cortexActivity[step.cortex] || 0) + 1;
      }
    }
    await saveStore(store);
  });

  return plan;
}

/**
 * Execute a plan by dispatching to the selected strategy.
 *
 * @param {object} plan
 * @param {object} [context]
 */
export async function execute(plan, context = {}) {
  if (!plan || typeof plan !== "object") {
    throw new Error("plan is required");
  }
  const strategy = plan.strategy || "direct";
  const startedAt = Date.now();
  let output;
  let success = true;
  let errorMessage = null;
  try {
    output = await routeToSubsystem(strategy, plan.task, {
      ...context,
      plan,
      analysis: plan.analysis,
    });
  } catch (err) {
    success = false;
    errorMessage = err?.message || String(err);
  }
  const latencyMs = Date.now() - startedAt;

  // Record the outcome in the router store for adaptive weights.
  try {
    await recordStrategyOutcome(strategy, plan.analysis?.type || "unknown", {
      success,
      cost: plan.costMultiplier || 1,
      latencyMs,
    });
  } catch {
    /* non-fatal */
  }

  // Mark downstream cortex steps as done.
  await withPathLock(storePath(), async () => {
    const store = await loadStore();
    const existing = store.thoughts.find((t) => t.id === plan.id);
    if (existing) {
      existing.status = success ? "executed" : "failed";
      existing.executedAt = new Date().toISOString();
      existing.latencyMs = latencyMs;
      if (errorMessage) existing.error = errorMessage;
      for (const step of existing.steps) {
        if (step.cortex === "execution") step.done = true;
      }
    }
    store.cortexActivity.execution = (store.cortexActivity.execution || 0) + 1;
    store.outcomes.total += 1;
    if (success) store.outcomes.successes += 1;
    else store.outcomes.failures += 1;
    store.outcomes.confidenceSum += Number(plan.confidence || 0);
    await saveStore(store);
  });

  return {
    thoughtId: plan.id,
    strategy,
    success,
    output,
    error: errorMessage,
    latencyMs,
  };
}

/**
 * Record an outcome against a previous thought. Pushes the outcome into the
 * meta-learning module so future strategy selections adapt.
 *
 * @param {{ thoughtId?: string, outcome?: string, feedback?: any, success?: boolean, rating?: number }} input
 */
export async function learn(input = {}) {
  const {
    thoughtId,
    outcome,
    feedback,
    success,
    rating,
  } = input;

  let plan = null;
  if (thoughtId) {
    const store = await loadStore();
    plan = store.thoughts.find((t) => t.id === thoughtId) || null;
  }

  // Update the gbrain store so reflection/learning cortex activity is visible.
  await withPathLock(storePath(), async () => {
    const store = await loadStore();
    if (plan) {
      const existing = store.thoughts.find((t) => t.id === thoughtId);
      if (existing) {
        existing.outcome = outcome || existing.outcome || null;
        existing.feedback = feedback ?? existing.feedback ?? null;
        existing.rating = Number.isFinite(rating) ? rating : existing.rating ?? null;
        existing.success = typeof success === "boolean" ? success : existing.success;
        for (const step of existing.steps) {
          if (step.cortex === "reflection" || step.cortex === "learning") {
            step.done = true;
          }
        }
      }
    }
    store.cortexActivity.reflection = (store.cortexActivity.reflection || 0) + 1;
    store.cortexActivity.learning = (store.cortexActivity.learning || 0) + 1;
    await saveStore(store);
  });

  // Forward to meta-learning.
  const metaMod = await loadMetaLearning();
  if (metaMod && typeof metaMod.recordDecisionOutcome === "function") {
    try {
      await metaMod.recordDecisionOutcome(thoughtId || `th_${Date.now()}`, {
        strategy: plan?.strategy || "unknown",
        taskType: plan?.analysis?.type || "unknown",
        success: typeof success === "boolean" ? success : plan?.success ?? null,
        rating: Number.isFinite(rating) ? rating : undefined,
        duration: plan?.latencyMs,
        outcome: outcome || null,
      });
    } catch {
      /* non-fatal */
    }
  }

  return {
    ok: true,
    thoughtId: thoughtId || null,
    applied: Boolean(plan),
    outcome: outcome || null,
  };
}

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

/**
 * Return a high-level summary of the brain's current state. Used by the
 * dashboard and the `/api/v1/gbrain/state` endpoint.
 */
export async function getBrainState() {
  const store = await loadStore();
  const totalThoughts = store.thoughts.length;
  const successRate =
    store.outcomes.total > 0 ? store.outcomes.successes / store.outcomes.total : 0;
  const avgConfidence =
    store.outcomes.total > 0
      ? store.outcomes.confidenceSum / store.outcomes.total
      : 0;

  const cortexActivity = {};
  for (const id of CORTEX_IDS) {
    cortexActivity[id] = store.cortexActivity[id] || 0;
  }

  const strategyDistribution = { ...store.strategyDistribution };

  let memoryEntries = 0;
  const memoryMod = await loadMemory();
  if (memoryMod && typeof memoryMod.getUnifiedStats === "function") {
    try {
      const stats = await memoryMod.getUnifiedStats(null);
      memoryEntries = Number.isFinite(stats?.totalEntries) ? stats.totalEntries : 0;
    } catch {
      memoryEntries = 0;
    }
  }

  return {
    totalThoughts,
    successRate,
    avgConfidence,
    memoryEntries,
    strategyDistribution,
    cortexActivity,
    cortices: CORTICES,
  };
}

/**
 * Return recent thoughts (newest first) with simple pagination.
 *
 * @param {{ limit?: number, offset?: number }} [opts]
 */
export async function getRecentThoughts({ limit = 20, offset = 0 } = {}) {
  const store = await loadStore();
  const all = [...store.thoughts].reverse();
  const slice = all.slice(offset, offset + limit);
  return { thoughts: slice, total: all.length, limit, offset };
}

/**
 * Fetch a single thought by id.
 *
 * @param {string} id
 */
export async function getThought(id) {
  if (!id) return null;
  const store = await loadStore();
  return store.thoughts.find((t) => t.id === id) || null;
}

/** @internal reset the on-disk store. Test-only. */
export async function _resetStore() {
  await writeJsonPath(storePath(), normalizeStore(null));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sanitizeContext(context) {
  if (!context || typeof context !== "object") return {};
  // Drop obviously large / non-serializable fields so thoughts remain cheap
  // to persist. Keep a small allow-list of useful metadata.
  const out = {};
  for (const key of ["userId", "workspaceId", "domain", "urgency", "budget"]) {
    if (context[key] !== undefined) out[key] = context[key];
  }
  return out;
}

export default {
  CORTICES,
  think,
  execute,
  learn,
  getBrainState,
  getRecentThoughts,
  getThought,
  analyzeTask,
  selectStrategy,
  buildPlan,
};
