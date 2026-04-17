// @ts-check
/**
 * Subagent budget enforcer.
 *
 * Provides a lightweight handle that tracks iteration count, cumulative cost,
 * wall-clock time, and tool-call count against caller-supplied caps. The
 * agent-loop consults `budget.check()` on every iteration and breaks with
 * `stopReason = "budget_exceeded"` when any dimension is over-limit.
 *
 * Limits that are null, undefined, or 0 are treated as "no cap" for that
 * dimension so callers can mix-and-match which dimensions to constrain.
 *
 * @module subagent-budget
 */

/**
 * @typedef {{
 *   check:            () => { exceeded: false } | { exceeded: true, reason: string, detail: object },
 *   recordIteration:  () => void,
 *   recordToolCall:   () => void,
 *   recordCostUsd:    (usd: number) => void,
 *   startTime:        number,
 *   summary:          () => { iterations: number, toolCalls: number, costUsd: number, wallTimeMs: number, exceeded: boolean, reason?: string },
 * }} BudgetHandle
 */

/**
 * Create a new budget handle.
 *
 * @param {{
 *   maxIterations?:  number | null,
 *   maxCostUsd?:     number | null,
 *   maxWallTimeMs?:  number | null,
 *   maxToolCalls?:   number | null,
 * }} limits
 * @returns {BudgetHandle}
 */
export function createBudget(limits = {}) {
  const maxIterations = positiveOrNull(limits.maxIterations);
  const maxCostUsd    = positiveOrNull(limits.maxCostUsd);
  const maxWallTimeMs = positiveOrNull(limits.maxWallTimeMs);
  const maxToolCalls  = positiveOrNull(limits.maxToolCalls);

  const startTime = Date.now();
  let iterations = 0;
  let toolCalls  = 0;
  let costUsd    = 0;

  /** @type {string | null} */
  let cachedReason = null;

  function check() {
    if (maxIterations !== null && iterations >= maxIterations) {
      cachedReason = "iterations_exceeded";
      return { exceeded: true, reason: cachedReason, detail: { iterations, maxIterations } };
    }
    if (maxCostUsd !== null && costUsd >= maxCostUsd) {
      cachedReason = "cost_exceeded";
      return { exceeded: true, reason: cachedReason, detail: { costUsd, maxCostUsd } };
    }
    const wallTimeMs = Date.now() - startTime;
    if (maxWallTimeMs !== null && wallTimeMs >= maxWallTimeMs) {
      cachedReason = "wall_time_exceeded";
      return { exceeded: true, reason: cachedReason, detail: { wallTimeMs, maxWallTimeMs } };
    }
    if (maxToolCalls !== null && toolCalls >= maxToolCalls) {
      cachedReason = "tool_calls_exceeded";
      return { exceeded: true, reason: cachedReason, detail: { toolCalls, maxToolCalls } };
    }
    return { exceeded: false };
  }

  function recordIteration() {
    iterations++;
  }

  function recordToolCall() {
    toolCalls++;
  }

  function recordCostUsd(usd) {
    if (typeof usd === "number" && usd > 0) {
      costUsd += usd;
    }
  }

  function summary() {
    const wallTimeMs = Date.now() - startTime;
    const result = check();
    return {
      iterations,
      toolCalls,
      costUsd,
      wallTimeMs,
      exceeded: result.exceeded,
      ...(result.exceeded ? { reason: result.reason } : {}),
    };
  }

  return {
    check,
    recordIteration,
    recordToolCall,
    recordCostUsd,
    startTime,
    summary,
  };
}

/**
 * Coerce a limit value to a positive number or null (meaning "no cap").
 * @param {unknown} v
 * @returns {number | null}
 */
function positiveOrNull(v) {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}
