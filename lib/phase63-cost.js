/**
 * Phase 63 cost attribution.
 *
 * Records usage from the Phase 63 code-generation tools (repo-rag,
 * pr-review-agent, test-gen) into `usage-tracker` and computes a billable
 * line via `pricing-engine`. Callers should invoke `recordPhase63Usage`
 * after each tool call so the metering is reliable even when the LLM
 * loop short-circuits.
 *
 * The set of recognised features is closed — passing an unknown feature
 * throws, since silent typos here would silently lose revenue.
 */
import { recordUsage } from "./usage-tracker.js";
import { computeCost } from "./pricing-engine.js";

export const PHASE63_FEATURES = Object.freeze([
  "repo-rag",
  "pr-review-agent",
  "test-gen",
  "refactor-agent",
  "migration-assistant",
]);

const FEATURE_SET = new Set(PHASE63_FEATURES);

function clampInt(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

/**
 * Record one Phase 63 tool invocation.
 *
 * @param {Object} entry
 * @param {string} entry.feature - One of PHASE63_FEATURES
 * @param {string} entry.workspaceId
 * @param {string} [entry.userId]
 * @param {string} [entry.model] - LLM model id when applicable
 * @param {number} [entry.inputTokens]
 * @param {number} [entry.outputTokens]
 * @param {number} [entry.calls=1] - Discrete tool invocations represented
 * @returns {Promise<{ recorded: boolean, cost: object | null }>}
 */
export async function recordPhase63Usage(entry = {}) {
  const feature = String(entry.feature || "").trim();
  if (!FEATURE_SET.has(feature)) {
    throw new Error(`Unknown Phase 63 feature: ${feature}`);
  }
  const workspaceId = String(entry.workspaceId || "").trim();
  if (!workspaceId) {
    throw new Error("workspaceId required for Phase 63 cost attribution");
  }

  const inputTokens = clampInt(entry.inputTokens);
  const outputTokens = clampInt(entry.outputTokens);
  const calls = Math.max(1, clampInt(entry.calls) || 1);

  await recordUsage({
    workspace: workspaceId,
    userId: entry.userId,
    model: entry.model || `phase63:${feature}`,
    backend: `phase63:${feature}`,
    feature,
    inputTokens,
    outputTokens,
  });

  let cost = null;
  try {
    cost = await computeCost({
      workspaceId,
      usage: {
        modelId: entry.model || null,
        inputTokens,
        outputTokens,
        calls,
        feature,
      },
    });
  } catch {
    cost = null;
  }

  return { recorded: true, cost };
}
