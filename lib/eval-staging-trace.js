/**
 * Staging trace replay for eval: load a JSON recording (from staging or exports) and run
 * golden-trace + agent_activity criteria offline without calling the LLM.
 */
import { readFile } from "fs/promises";
import { resolve, isAbsolute } from "path";
import { checkGoldenTrace } from "./eval-golden-trace.js";
import { checkAgentActivityCriteria } from "./eval-agent-activity.js";

/**
 * @param {string} baseDir - Directory to resolve relative paths against (usually process.cwd())
 * @param {string} relOrAbs - Path from eval case (`stagingTraceFile`)
 */
export function resolveStagingTracePath(baseDir, relOrAbs) {
  const s = String(relOrAbs || "").trim();
  if (!s) return "";
  if (isAbsolute(s)) return s;
  return resolve(baseDir, s);
}

/**
 * @param {object} record - Parsed JSON from disk
 * @returns {{ goldenTrace: Array; agentActivity: object | null }}
 */
export function deriveTraceFromStagingRecord(record) {
  if (!record || typeof record !== "object") {
    return { goldenTrace: [], agentActivity: null };
  }

  if (Array.isArray(record.goldenTrace) && record.goldenTrace.length > 0) {
    const agentActivity =
      record.agentActivity && typeof record.agentActivity === "object" ? record.agentActivity : null;
    return { goldenTrace: record.goldenTrace, agentActivity };
  }

  if (Array.isArray(record.trace) && record.trace.length > 0) {
    const agentActivity =
      record.agentActivity && typeof record.agentActivity === "object" ? record.agentActivity : null;
    return { goldenTrace: record.trace, agentActivity };
  }

  if (record.agentActivity && typeof record.agentActivity === "object") {
    const act = record.agentActivity;
    const tcs = Array.isArray(act.toolCalls) ? act.toolCalls : [];
    const goldenTrace = tcs.map((tc) => {
      const name =
        (tc && typeof tc.name === "string" && tc.name) ||
        (tc?.function && typeof tc.function.name === "string" && tc.function.name) ||
        "";
      let args = {};
      if (tc?.function?.arguments != null) {
        try {
          args =
            typeof tc.function.arguments === "string"
              ? JSON.parse(tc.function.arguments || "{}")
              : tc.function.arguments;
        } catch {
          args = {};
        }
      } else if (tc && typeof tc.args === "object") {
        args = tc.args;
      } else if (tc && typeof tc.arguments === "object") {
        args = tc.arguments;
      }
      return { name, arguments: args };
    });
    return { goldenTrace: goldenTrace.filter((t) => t.name), agentActivity: act };
  }

  if (Array.isArray(record.toolCalls) && record.toolCalls.length > 0) {
    const agentActivity = { type: "agent_activity", toolCalls: record.toolCalls, swarmSteps: record.swarmSteps || [] };
    return deriveTraceFromStagingRecord({ ...record, agentActivity });
  }

  if (Array.isArray(record.steps)) {
    const goldenTrace = [];
    for (const step of record.steps) {
      if (!step || typeof step !== "object") continue;
      if (step.type === "tool_call" && typeof step.name === "string") {
        let args = {};
        if (typeof step.argsPreview === "string") {
          try {
            args = JSON.parse(step.argsPreview);
          } catch {
            args = {};
          }
        }
        goldenTrace.push({ name: step.name, arguments: args });
      }
    }
    if (goldenTrace.length > 0) {
      return {
        goldenTrace,
        agentActivity: {
          type: "agent_activity",
          toolCalls: goldenTrace.map((t) => ({ name: t.name, args: t.arguments })),
          swarmSteps: [],
        },
      };
    }
  }

  return { goldenTrace: [], agentActivity: null };
}

/**
 * @param {string} absPath
 * @returns {Promise<object>}
 */
export async function loadStagingTraceRecord(absPath) {
  const raw = await readFile(absPath, "utf8");
  return JSON.parse(raw);
}

/**
 * Run golden + agent_activity checks for a staging_trace eval case.
 * @param {object} evalCase - Same criteria fields as `trace` + `chat` agent_activity cases
 * @param {object} record - Parsed JSON
 * @returns {{ pass: boolean; reason?: string }}
 */
export function evaluateStagingTraceCase(evalCase, record) {
  const { goldenTrace, agentActivity } = deriveTraceFromStagingRecord(record);

  const needsGolden =
    evalCase.expectedToolSequence != null ||
    evalCase.expectedToolNames != null ||
    evalCase.expectedToolCalls != null;
  const needsActivity =
    evalCase.expectedAgentActivityToolNames != null ||
    evalCase.expectedAgentActivityToolSequence != null ||
    evalCase.expectedMinAgentActivityToolCalls != null ||
    evalCase.expectedSwarmStepNames != null ||
    evalCase.expectedMinSwarmSteps != null;

  if (!needsGolden && !needsActivity) {
    return {
      pass: false,
      reason:
        "staging_trace case needs expectedToolSequence, expectedToolNames, expectedToolCalls, and/or agent_activity expectations",
    };
  }

  if (needsGolden) {
    if (!goldenTrace.length) {
      return { pass: false, reason: "staging trace record contained no derivable tool calls for golden checks" };
    }
    const g = checkGoldenTrace(evalCase, goldenTrace);
    if (!g.pass) return g;
  }

  if (needsActivity) {
    if (!agentActivity) {
      return { pass: false, reason: "Record has no agentActivity/toolCalls for agent_activity criteria" };
    }
    const a = checkAgentActivityCriteria(evalCase, agentActivity);
    if (!a.pass) return a;
  }

  return { pass: true };
}
