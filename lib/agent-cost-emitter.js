// @ts-check
/**
 * Shared helper for emitting `cost.update` events on the Agent Run SSE stream.
 *
 * Extracted as a clean parallel implementation of the inline emitter in
 * lib/agent-loop.js (wave 5). Used by call sites OUTSIDE the single-agent
 * tool loop: swarm specialists, scheduled agents, and direct chat streaming.
 *
 * NOTE: lib/agent-loop.js still owns its own inline accumulator to avoid
 * churn in the error-boundary work happening there in parallel. That module
 * will migrate to this helper later; for now the two implementations use
 * independent per-run Maps, which is safe because the runIds they service
 * never overlap (each runId is produced by exactly one call site).
 *
 * Semantics mirror agent-loop.js exactly:
 *   - Per-run cumulative accumulator of {prompt, completion, total, totalUsd}
 *   - totalUsd = Σ (step.total_tokens / 1000) × getModelCost(model)
 *   - Best-effort: publish failures never propagate to the caller
 *   - Dispose on terminal event to keep the Map bounded by in-flight runs
 *
 * @module agent-cost-emitter
 */

import { publishAgentRunEvent } from "./agent-run-stream.js";
import { getModelCost } from "./smart-router.js";
import { getAgentSession } from "./agent-session.js";

/**
 * Per-run cumulative cost accumulator. Keyed by runId.
 * @type {Map<string, { totalUsd: number, prompt: number, completion: number, total: number }>}
 */
const runCostAccumulators = new Map();

/**
 * Per-parent cost rollup tracker. Tracks child session cost contributions
 * so the parent's cost.update can include a breakdown.
 * Key: parentSessionId, Value: Map<childSessionId, latestChildTotalUsd>
 * @type {Map<string, Map<string, number>>}
 */
const parentCostMap = new Map();

/**
 * Add a chat-completion's usage tokens to the per-run accumulator and emit
 * a `cost.update` event on the session emitter. Designed to be called once
 * per chat-completion response. Best-effort: never throws.
 *
 * @param {{
 *   sessionId?: string,
 *   runId?: string,
 *   model?: string,
 *   iteration?: number,
 *   usage?: { prompt_tokens?: number, completion_tokens?: number, total_tokens?: number } | null,
 * }} args
 */
export function emitCostUpdate(args) {
  try {
    const sessionId = String(args?.sessionId || "").trim();
    const runId = String(args?.runId || "").trim();
    if (!sessionId || !runId) return 0;
    const usage = args.usage || {};
    const prompt = Math.max(0, Number(usage.prompt_tokens) || 0);
    const completion = Math.max(0, Number(usage.completion_tokens) || 0);
    const total =
      Math.max(0, Number(usage.total_tokens) || 0) || prompt + completion;

    const model = String(args.model || "");
    const costPer1k = Number(getModelCost(model)) || 0;
    const stepUsd = costPer1k > 0 ? (total / 1000) * costPer1k : 0;

    const acc =
      runCostAccumulators.get(runId) ||
      { totalUsd: 0, prompt: 0, completion: 0, total: 0 };
    acc.totalUsd += stepUsd;
    acc.prompt += prompt;
    acc.completion += completion;
    acc.total += total;
    runCostAccumulators.set(runId, acc);

    publishAgentRunEvent(sessionId, "cost.update", {
      totalUsd: acc.totalUsd,
      tokens: { prompt: acc.prompt, completion: acc.completion, total: acc.total },
      model,
      ...(args.iteration != null ? { iteration: args.iteration } : {}),
      runId,
    });

    // Roll up cost to immediate parent session (one level only).
    // The parent's own cost.update listener will naturally cascade if the
    // parent itself has a parent, because any cost.update on the parent's
    // sessionId triggers the same rollup path for the grandparent.
    rollupCostToParent(sessionId, acc.totalUsd).catch(() => {});
    return stepUsd;
  } catch {
    /* live publishing is best-effort */
    return 0;
  }
}

/**
 * Roll up a child session's cost to its immediate parent.
 * Publishes a cost.update on the parent's sessionId with breakdown.
 * Only does one level of rollup; cascading happens naturally because
 * the parent's cost.update will trigger its own rollup if it has a parent.
 *
 * @param {string} childSessionId
 * @param {number} childTotalUsd
 */
async function rollupCostToParent(childSessionId, childTotalUsd) {
  try {
    const childSession = await getAgentSession(childSessionId);
    if (!childSession || !childSession.parentSessionId) return;
    const parentId = childSession.parentSessionId;

    let childMap = parentCostMap.get(parentId);
    if (!childMap) {
      childMap = new Map();
      parentCostMap.set(parentId, childMap);
    }
    childMap.set(childSessionId, childTotalUsd);

    let childCostUsd = 0;
    for (const v of childMap.values()) childCostUsd += v;

    // Parent's own cost (from its own runs)
    const parentSession = await getAgentSession(parentId);
    const ownCostUsd = typeof parentSession?.costUsd === "number" ? parentSession.costUsd : 0;

    publishAgentRunEvent(parentId, "cost.update", {
      totalUsd: ownCostUsd + childCostUsd,
      childCostUsd,
      ownCostUsd,
    });
  } catch {
    /* best-effort */
  }
}

/**
 * Drop the per-run cost accumulator. Call on terminal events (done/error)
 * so the Map stays bounded by the lifetime of in-flight runs only.
 *
 * @param {string} runId
 */
export function disposeRunCostAccumulator(runId) {
  if (!runId) return;
  runCostAccumulators.delete(String(runId));
}

/** Test helper — exposed only for unit tests. */
export function __getAccumulatorForTests(runId) {
  return runCostAccumulators.get(String(runId)) || null;
}

/** Test helper — clears all accumulators. */
export function __resetAccumulatorsForTests() {
  runCostAccumulators.clear();
  parentCostMap.clear();
}

/** Test helper — get the parent cost map for inspection. */
export function __getParentCostMapForTests() {
  return parentCostMap;
}
