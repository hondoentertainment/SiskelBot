/**
 * Staging trace replay: load recorded traces and run them through the eval
 * validation logic (golden-trace + agent_activity checks) without a live LLM.
 */
import { getTrace, listTraces, traceToEvalCase } from "./trace-recorder.js";
import { checkGoldenTrace } from "./eval-golden-trace.js";
import {
  checkAgentActivityCriteria,
} from "./eval-agent-activity.js";
import { deriveTraceFromStagingRecord } from "./eval-staging-trace.js";

/**
 * Replay a single recorded trace through eval validation.
 * Derives goldenTrace + agentActivity from the stored record, then runs
 * the same checks used by eval-runner for `staging_trace` cases.
 *
 * @param {string} traceId
 * @param {object} [expectations] - Optional override expectations; when omitted, auto-generated from the trace
 * @returns {Promise<{ traceId: string, pass: boolean, reason?: string, toolNames: string[], evalCase: object }>}
 */
export async function replayTrace(traceId, expectations = null) {
  const trace = await getTrace(traceId);
  if (!trace) {
    return {
      traceId,
      pass: false,
      reason: `Trace not found: ${traceId}`,
      toolNames: [],
      evalCase: null,
    };
  }

  return replayTraceRecord(trace, expectations);
}

/**
 * Replay a trace record object (already loaded) through eval validation.
 * @param {object} trace - Full trace record
 * @param {object} [expectations] - Optional override expectations
 * @returns {{ traceId: string, pass: boolean, reason?: string, toolNames: string[], evalCase: object }}
 */
export function replayTraceRecord(trace, expectations = null) {
  const traceId = trace.traceId || "unknown";

  // Derive golden trace and agent activity using the same logic as eval-staging-trace
  const { goldenTrace, agentActivity } = deriveTraceFromStagingRecord(trace);

  // Generate eval case from trace (auto expectations)
  const autoEvalCase = traceToEvalCase(trace);

  // Use provided expectations or fall back to auto-generated ones
  const evalCase = expectations
    ? { ...autoEvalCase, ...expectations }
    : autoEvalCase;

  const toolNames = goldenTrace.map((t) => t.name || t.tool || "").filter(Boolean);

  // No tool calls to validate
  if (goldenTrace.length === 0) {
    return {
      traceId,
      pass: false,
      reason: "Trace contains no tool calls to validate",
      toolNames: [],
      evalCase,
    };
  }

  // Run golden trace checks if we have sequence/names/calls expectations
  const hasGoldenExpectations =
    evalCase.expectedToolSequence != null ||
    evalCase.expectedToolNames != null ||
    evalCase.expectedToolCalls != null;

  if (hasGoldenExpectations) {
    const goldenCheck = checkGoldenTrace(evalCase, goldenTrace);
    if (!goldenCheck.pass) {
      return {
        traceId,
        pass: false,
        reason: goldenCheck.reason,
        toolNames,
        evalCase,
      };
    }
  }

  // Run agent activity checks if we have activity expectations
  const hasActivityExpectations =
    evalCase.expectedAgentActivityToolNames != null ||
    evalCase.expectedAgentActivityToolSequence != null ||
    evalCase.expectedMinAgentActivityToolCalls != null ||
    evalCase.expectedSwarmStepNames != null ||
    evalCase.expectedMinSwarmSteps != null;

  if (hasActivityExpectations && agentActivity) {
    const activityCheck = checkAgentActivityCriteria(evalCase, agentActivity);
    if (!activityCheck.pass) {
      return {
        traceId,
        pass: false,
        reason: activityCheck.reason,
        toolNames,
        evalCase,
      };
    }
  } else if (hasActivityExpectations && !agentActivity) {
    return {
      traceId,
      pass: false,
      reason: "Trace has agent_activity expectations but no agentActivity data",
      toolNames,
      evalCase,
    };
  }

  return {
    traceId,
    pass: true,
    toolNames,
    evalCase,
  };
}

/**
 * Replay all traces matching a filter.
 * @param {{ type?: string, workspace?: string, limit?: number }} options
 * @returns {Promise<{ results: object[], passed: number, failed: number, total: number }>}
 */
export async function replayAll(options = {}) {
  const limit = options.limit || 100;
  const listing = await listTraces({ ...options, limit });
  const results = [];

  for (const item of listing.items) {
    const result = await replayTrace(item.traceId);
    results.push(result);
  }

  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  return { results, passed, failed, total: results.length };
}
