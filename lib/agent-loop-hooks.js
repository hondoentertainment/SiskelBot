/**
 * Wave-2 agent-loop hooks. Thin wrappers around the feature-flagged
 * modules so agent-loop.js contains only three short call-sites:
 *   - runUpfrontPlanHook(...)
 *   - runMidLoopCritiqueHook(...)
 *   - runSemanticTrimHook(...)
 *   - runFailureMemoryHook(...)
 *
 * All hooks are no-ops by default and never throw.
 */

import { planningEnabled, buildUpfrontPlan, formatPlanAsSystemMessage } from "./agent-plan.js";
import { shouldCritique, runMidLoopCritique, formatCritiqueNudge } from "./agent-critique.js";
import { semanticTrimEnabled, trimBySemanticRelevance } from "./agent-context-semantic-trim.js";
import { failureMemoryEnabled, recordFailure } from "./agent-failure-memory.js";

/**
 * Run the upfront planning pass. Appends a plan system message to `messages`
 * when the planner succeeds and returns steps.
 *
 * @returns {Promise<{ planInjected: boolean, steps: number }>}
 */
export async function runUpfrontPlanHook({ messages, userMessage, backendFetch, url, model, headers, trajCollector }) {
  if (!planningEnabled() || typeof userMessage !== "string" || !userMessage.trim()) {
    return { planInjected: false, steps: 0 };
  }
  try {
    const fetchFn = typeof backendFetch === "function" ? backendFetch : fetch;
    const plan = await buildUpfrontPlan({
      userMessage,
      backendFetch: fetchFn,
      url,
      model,
      headers: headers || {},
    });
    const planMsg = plan ? formatPlanAsSystemMessage(plan) : "";
    if (planMsg) {
      messages.push({ role: "system", content: planMsg });
      trajCollector?.record?.({ type: "plan", steps: plan.steps?.length || 0 });
      return { planInjected: true, steps: plan.steps?.length || 0 };
    }
  } catch { /* best-effort */ }
  return { planInjected: false, steps: 0 };
}

/**
 * Run the mid-loop critique. Appends a nudge system message when verdict
 * is off-track.
 *
 * @returns {Promise<{ ran: boolean, onTrack: boolean|null, nudged: boolean }>}
 */
export async function runMidLoopCritiqueHook({
  iteration, currentStagnation, messages, userGoal, backendFetch, url, model, headers, trajCollector,
  storageUserId, workspace,
}) {
  if (!shouldCritique(iteration, currentStagnation)) {
    return { ran: false, onTrack: null, nudged: false };
  }
  try {
    const fetchFn = typeof backendFetch === "function" ? backendFetch : fetch;
    const verdict = await runMidLoopCritique({
      messages,
      userGoal,
      backendFetch: fetchFn,
      url,
      model,
      headers: headers || {},
    });
    if (!verdict) return { ran: true, onTrack: null, nudged: false };
    if (verdict.on_track) return { ran: true, onTrack: true, nudged: false };
    const nudge = formatCritiqueNudge(verdict);
    let nudged = false;
    if (nudge) {
      messages.push({ role: "system", content: nudge });
      nudged = true;
    }
    trajCollector?.record?.({
      type: "critique",
      iteration,
      on_track: false,
      reason: verdict.stuck_reason || "",
    });
    if (failureMemoryEnabled()) {
      recordFailure({
        userId: storageUserId,
        workspaceId: workspace,
        kind: "critique_off_track",
        userGoal,
        details: verdict.stuck_reason || "",
      });
    }
    return { ran: true, onTrack: false, nudged };
  } catch {
    return { ran: true, onTrack: null, nudged: false };
  }
}

/**
 * Run the semantic trim hook.
 *
 * @returns {{ trimmedMessages: object[], roundsRemoved: number }}
 */
export function runSemanticTrimHook({ messages, userGoal, trajCollector }) {
  const budget = Number(process.env.AGENT_SEMANTIC_TRIM_BUDGET) || 0;
  if (!semanticTrimEnabled() || !userGoal || budget <= 0) {
    return { trimmedMessages: messages, roundsRemoved: 0 };
  }
  try {
    const r = trimBySemanticRelevance(messages, { budget, userGoal });
    if (r.roundsRemoved > 0) {
      trajCollector?.record?.({ type: "semantic_trim", roundsRemoved: r.roundsRemoved });
      return { trimmedMessages: r.trimmedMessages, roundsRemoved: r.roundsRemoved };
    }
  } catch { /* best-effort */ }
  return { trimmedMessages: messages, roundsRemoved: 0 };
}

/**
 * Record a failure-mode memory. Always best-effort.
 */
export function runFailureMemoryHook(params) {
  if (!failureMemoryEnabled()) return;
  try { recordFailure(params); } catch { /* best-effort */ }
}
