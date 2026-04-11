/**
 * GBrain integration helpers.
 *
 * Wraps existing orchestrators (agent-loop, swarm, hierarchy, consensus)
 * so that their outcomes are automatically fed back into GBrain
 * meta-learning. The wrappers are non-invasive: they return a new object
 * with the same functions, intercept the primary entry points, and record
 * decisions before/after the underlying call completes.
 *
 * Usage:
 *
 *   import { integrateWithAgentLoop } from "./gbrain-integration.js";
 *   import * as agentLoop from "./agent-loop.js";
 *   const wrapped = integrateWithAgentLoop(agentLoop);
 *   // pass `wrapped` where you would normally pass `agentLoop`.
 *
 * @module gbrain-integration
 */

import { randomUUID } from "crypto";
import {
  recordDecisionOutcome,
  updateStrategyWeights,
  updateModelPerformance,
} from "./gbrain-meta-learning.js";

function newDecisionId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

function inferErrorType(err) {
  if (!err) return undefined;
  if (err.name === "AbortError") return "timeout";
  if (err.code) return String(err.code);
  if (err.message) {
    const m = err.message.toLowerCase();
    if (m.includes("timeout")) return "timeout";
    if (m.includes("tool")) return "tool_error";
    if (m.includes("parse") || m.includes("json")) return "parse_error";
    if (m.includes("rate")) return "rate_limit";
    return "other";
  }
  return "other";
}

async function recordSafely(id, decision, outcome) {
  try {
    await recordDecisionOutcome(id, { decision, outcome });
  } catch (e) {
    console.warn("[gbrain-integration] record failed:", e?.message || e);
  }
}

/**
 * Wrap an agent loop module so any `runAgentLoop`-style entry point logs
 * meta-learning outcomes automatically.
 *
 * @param {object} agentLoop - module exporting `runAgentLoop` (or similar)
 * @returns wrapped module
 */
export function integrateWithAgentLoop(agentLoop) {
  if (!agentLoop || typeof agentLoop !== "object") {
    throw new Error("integrateWithAgentLoop requires an agent-loop module object");
  }

  const wrapped = { ...agentLoop };
  const candidateNames = ["runAgentLoop", "runLoop", "runAgent", "run"];
  const primary = candidateNames.find((n) => typeof agentLoop[n] === "function");
  if (!primary) return wrapped;

  wrapped[primary] = async function (...args) {
    const decisionId = newDecisionId("agentloop");
    const startedAt = Date.now();
    const opts = args[0] && typeof args[0] === "object" ? args[0] : {};
    const decision = {
      taskType: opts.taskType || opts.intent || "agent_loop",
      strategy: "agent_loop",
      model: opts.model,
      tools: Array.isArray(opts.tools) ? opts.tools : undefined,
      workspaceId: opts.workspaceId,
    };
    try {
      const result = await agentLoop[primary].apply(agentLoop, args);
      const duration = Date.now() - startedAt;
      const outcome = {
        success: !result?.error,
        duration,
        cost: result?.cost,
        errorType: result?.error ? inferErrorType(result.error) : undefined,
      };
      await recordSafely(decisionId, decision, outcome);
      return result;
    } catch (err) {
      const duration = Date.now() - startedAt;
      await recordSafely(decisionId, decision, {
        success: false,
        duration,
        errorType: inferErrorType(err),
      });
      throw err;
    }
  };

  return wrapped;
}

/**
 * Wrap a swarm module so `runSwarmDirect`-style calls record specialists
 * and success rates.
 */
export function integrateWithSwarm(swarm) {
  if (!swarm || typeof swarm !== "object") {
    throw new Error("integrateWithSwarm requires a swarm module object");
  }
  const wrapped = { ...swarm };
  const candidateNames = ["runSwarmDirect", "runSwarm", "run"];
  const primary = candidateNames.find((n) => typeof swarm[n] === "function");
  if (!primary) return wrapped;

  wrapped[primary] = async function (...args) {
    const decisionId = newDecisionId("swarm");
    const startedAt = Date.now();
    // runSwarmDirect(specialistNames, query, opts)
    const specialists = args[0];
    const opts = args[2] && typeof args[2] === "object" ? args[2] : {};
    const decision = {
      taskType: opts.taskType || opts.intent || "swarm",
      strategy: "swarm",
      specialists: Array.isArray(specialists) ? specialists : undefined,
      model: opts.model,
      workspaceId: opts.workspaceId,
    };
    try {
      const result = await swarm[primary].apply(swarm, args);
      const duration = Date.now() - startedAt;
      const outcome = {
        success: !result?.error,
        duration,
        errorType: result?.error ? inferErrorType(result.error) : undefined,
      };
      await recordSafely(decisionId, decision, outcome);
      if (decision.taskType && decision.strategy) {
        await updateStrategyWeights(decision.taskType, decision.strategy, outcome);
      }
      return result;
    } catch (err) {
      const duration = Date.now() - startedAt;
      await recordSafely(decisionId, decision, {
        success: false,
        duration,
        errorType: inferErrorType(err),
      });
      throw err;
    }
  };

  return wrapped;
}

/**
 * Wrap a hierarchy module so `executeHierarchy`-style calls record outcomes.
 */
export function integrateWithHierarchy(hierarchy) {
  if (!hierarchy || typeof hierarchy !== "object") {
    throw new Error("integrateWithHierarchy requires a hierarchy module object");
  }
  const wrapped = { ...hierarchy };
  const candidateNames = ["executeHierarchy", "runHierarchy", "run"];
  const primary = candidateNames.find((n) => typeof hierarchy[n] === "function");
  if (!primary) return wrapped;

  wrapped[primary] = async function (...args) {
    const decisionId = newDecisionId("hierarchy");
    const startedAt = Date.now();
    const opts = args[1] && typeof args[1] === "object" ? args[1] : {};
    const decision = {
      taskType: opts.taskType || "hierarchy",
      strategy: "hierarchy",
      model: opts.model,
      workspaceId: opts.workspaceId,
    };
    try {
      const result = await hierarchy[primary].apply(hierarchy, args);
      const duration = Date.now() - startedAt;
      const outcome = {
        success: !result?.error,
        duration,
        errorType: result?.error ? inferErrorType(result.error) : undefined,
      };
      await recordSafely(decisionId, decision, outcome);
      if (decision.model) {
        await updateModelPerformance(decision.model, decision.taskType, outcome);
      }
      return result;
    } catch (err) {
      const duration = Date.now() - startedAt;
      await recordSafely(decisionId, decision, {
        success: false,
        duration,
        errorType: inferErrorType(err),
      });
      throw err;
    }
  };

  return wrapped;
}

/**
 * Wrap a consensus module so `executeConsensus`-style calls record outcomes.
 */
export function integrateWithConsensus(consensus) {
  if (!consensus || typeof consensus !== "object") {
    throw new Error("integrateWithConsensus requires a consensus module object");
  }
  const wrapped = { ...consensus };
  const candidateNames = ["executeConsensus", "runConsensus", "run"];
  const primary = candidateNames.find((n) => typeof consensus[n] === "function");
  if (!primary) return wrapped;

  wrapped[primary] = async function (...args) {
    const decisionId = newDecisionId("consensus");
    const startedAt = Date.now();
    const opts = args[1] && typeof args[1] === "object" ? args[1] : {};
    const decision = {
      taskType: opts.taskType || "consensus",
      strategy: opts.voting || "consensus",
      model: opts.judgeModel || opts.model,
      workspaceId: opts.workspaceId,
    };
    try {
      const result = await consensus[primary].apply(consensus, args);
      const duration = Date.now() - startedAt;
      const outcome = {
        success: !result?.error,
        duration,
        errorType: result?.error ? inferErrorType(result.error) : undefined,
      };
      await recordSafely(decisionId, decision, outcome);
      return result;
    } catch (err) {
      const duration = Date.now() - startedAt;
      await recordSafely(decisionId, decision, {
        success: false,
        duration,
        errorType: inferErrorType(err),
      });
      throw err;
    }
  };

  return wrapped;
}

export const _internals = { newDecisionId, inferErrorType };
