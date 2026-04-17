/**
 * spawn_subagent tool implementation.
 *
 * Delegates a subtask to a child agent that runs its own tool-call loop
 * with an independent iteration budget, profile-based system prompt, and
 * tool allowlist. Results are returned as structured JSON to the parent.
 *
 * Depth is capped at 3 to prevent infinite recursion.
 *
 * @module spawn-subagent
 */

import { createAgentSession } from "./agent-session.js";
import { publishAgentRunEvent } from "./agent-run-stream.js";

/** Maximum nesting depth for subagent spawning. */
const MAX_DEPTH = 3;

/** Profile-to-system-prompt mapping. */
const PROFILE_PROMPTS = {
  researcher:
    "You are a research agent. Search, summarize, and return structured findings. Do not execute or modify anything.",
  executor:
    "You are an execution agent. Carry out the plan step by step. Report results.",
  synthesizer:
    "You are a synthesis agent. Combine inputs into a coherent output.",
  code_writer:
    "You are a code-writing agent. Write clean, tested code.",
  reviewer:
    "You are a review agent. Analyze for correctness, security, and quality.",
  default:
    "You are a focused assistant. Complete the goal and return the result.",
};

/**
 * Resolve the system prompt for a given profile name.
 * @param {string} [profile]
 * @returns {string}
 */
export function resolveProfilePrompt(profile) {
  const key = typeof profile === "string" ? profile.trim().toLowerCase() : "default";
  return PROFILE_PROMPTS[key] || PROFILE_PROMPTS.default;
}

/**
 * Truncate a string to a maximum character count.
 * @param {string} str
 * @param {number} max
 * @returns {string}
 */
function truncate(str, max) {
  if (typeof str !== "string") return "";
  return str.length > max ? str.slice(0, max) + "...(truncated)" : str;
}

/**
 * Spawn a child agent to accomplish a delegated subtask.
 *
 * @param {{
 *   goal: string,
 *   profile?: string,
 *   model?: string,
 *   maxIterations?: number,
 *   toolAllowlist?: string[],
 *   context?: string,
 *   parentRunId?: string,
 *   parentSessionId?: string,
 *   workspace?: string,
 *   userId?: string,
 *   depth?: number,
 *   parentTools?: Array<{ type: string, function: { name: string, [k: string]: any } }>,
 *   parentModel?: string,
 *   runAgentLoop: Function,
 *   backendFetch: Function,
 *   buildProxyConfig: Function,
 * }} opts
 * @returns {Promise<{
 *   ok: boolean,
 *   result?: string,
 *   childSessionId?: string,
 *   costUsd?: number,
 *   iterations?: number,
 *   toolCallCount?: number,
 *   error?: string,
 *   code?: string,
 * }>}
 */
export async function spawnSubagent(opts) {
  const {
    goal,
    profile,
    model,
    maxIterations = 10,
    toolAllowlist,
    context,
    parentRunId,
    parentSessionId,
    workspace = "default",
    userId = "anonymous",
    depth = 0,
    parentTools,
    parentModel,
    runAgentLoop,
    backendFetch,
    buildProxyConfig,
  } = opts;

  // --- Depth guard ---
  if (depth >= MAX_DEPTH) {
    return {
      ok: false,
      error: `Subagent nesting depth ${depth} exceeds maximum of ${MAX_DEPTH}`,
      code: "SUBAGENT_DEPTH_EXCEEDED",
    };
  }

  let childSessionId;
  try {
    // --- 1. Create child session ---
    const planSummary = parentSessionId
      ? `[subagent of ${parentSessionId}] ${goal}`
      : goal;

    const childSession = await createAgentSession({
      workspace,
      ownerStorageUserId: userId,
      title: typeof goal === "string" ? goal.slice(0, 200) : "subagent",
      planSummary,
    });
    childSessionId = childSession.id;

    // --- 2. Build system prompt ---
    const systemPrompt = resolveProfilePrompt(profile);

    // --- 3. Build messages ---
    const userContent =
      goal + (context ? "\n\nAdditional context:\n" + context : "");
    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ];

    // --- 4. Determine child tools (always exclude spawn_subagent) ---
    let childTools;
    if (Array.isArray(parentTools)) {
      const base = parentTools.filter(
        (t) => t?.function?.name !== "spawn_subagent"
      );
      if (Array.isArray(toolAllowlist) && toolAllowlist.length > 0) {
        const allowed = new Set(toolAllowlist);
        allowed.delete("spawn_subagent");
        childTools = base.filter(
          (t) => t?.function?.name && allowed.has(t.function.name)
        );
      } else {
        childTools = base;
      }
    } else {
      childTools = [];
    }

    // --- 6. Publish subagent.spawned ---
    if (parentSessionId) {
      try {
        publishAgentRunEvent(parentSessionId, "subagent.spawned", {
          childSessionId,
          parentRunId,
          goal,
          profile: profile || "default",
        });
      } catch {
        /* best-effort */
      }
    }

    // --- 5. Call runAgentLoop ---
    const childModel = model || parentModel || "default";
    const config = typeof buildProxyConfig === "function"
      ? buildProxyConfig(childModel)
      : { baseUrl: "http://localhost", path: "/v1/chat/completions", headers: {} };

    const childReq = {
      userId: userId,
      body: {
        model: childModel,
        messages,
        tools: childTools,
        agentOptions: {
          sessionId: childSessionId,
          workspace,
          maxIterations: Math.max(1, Math.min(maxIterations || 10, 50)),
          depth: depth + 1,
        },
      },
    };
    const childRes = {
      headersSent: false,
      setHeader() {},
    };

    const loopResult = await runAgentLoop(
      childReq,
      childRes,
      config,
      childModel,
      { sessionId: childSessionId },
      backendFetch
    );

    const lastContent = typeof loopResult.content === "string"
      ? loopResult.content
      : "(no response)";
    const iterations = loopResult.iteration || 0;
    const toolCallCount = Array.isArray(loopResult.toolCalls)
      ? loopResult.toolCalls.length
      : 0;

    // --- 7. Publish subagent.done ---
    if (parentSessionId) {
      try {
        publishAgentRunEvent(parentSessionId, "subagent.done", {
          childSessionId,
          result: truncate(lastContent, 2000),
          iterations,
          toolCallCount,
        });
      } catch {
        /* best-effort */
      }
    }

    // --- 8. Return structured result ---
    return {
      ok: true,
      result: lastContent,
      childSessionId,
      iterations,
      toolCallCount,
    };
  } catch (err) {
    // --- 9. Error handling ---
    if (parentSessionId) {
      try {
        publishAgentRunEvent(parentSessionId, "subagent.done", {
          childSessionId,
          error: String(err?.message || err),
        });
      } catch {
        /* best-effort */
      }
    }
    return {
      ok: false,
      error: String(err?.message || err),
      childSessionId,
    };
  }
}
