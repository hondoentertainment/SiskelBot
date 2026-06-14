/**
 * Failure-mode memory. When an agent run hits stagnation, re-plan, or
 * repeated tool failure, record a compact observation-category memory so
 * future runs on similar tasks can avoid the same dead-ends.
 *
 * Enabled when AGENT_FAILURE_MEMORY=1.
 */

import { remember, listMemories } from "./agent-memory.js";

const DEFAULT_MAX_FAILURE_MEMORIES = 50;

export function failureMemoryEnabled() {
  return process.env.AGENT_FAILURE_MEMORY === "1";
}

/**
 * Cap how many failure observations live per user/workspace. When we would
 * exceed the cap, skip writing — old entries age out via the global 1000-cap
 * in agent-memory.js.
 */
async function countFailureMemories(userId, workspaceId) {
  try {
    const result = await listMemories(userId, workspaceId, { category: "observation", limit: 200 });
    const memories = result?.memories || [];
    return memories.filter((m) => typeof m?.content === "string" && m.content.startsWith("[failure]")).length;
  } catch {
    return 0;
  }
}

/**
 * Build a single-line summary of a failure.
 * @param {{ kind: string, userGoal?: string, tools?: string[], details?: string }} failure
 */
export function formatFailure(failure) {
  const kind = String(failure?.kind || "unknown");
  const goal = String(failure?.userGoal || "").slice(0, 120).trim();
  const tools = Array.isArray(failure?.tools) ? failure.tools.slice(0, 5).join(",") : "";
  const details = String(failure?.details || "").slice(0, 160).trim();
  const parts = [`[failure] kind=${kind}`];
  if (goal) parts.push(`goal="${goal}"`);
  if (tools) parts.push(`tools=${tools}`);
  if (details) parts.push(`why="${details}"`);
  return parts.join(" ");
}

/**
 * Record a failure as an observation-category memory.
 * Best-effort: never throws.
 *
 * @param {{
 *   userId: string,
 *   workspaceId: string,
 *   kind: "stagnation" | "replan" | "tool_failure" | "budget_exceeded" | "critique_off_track",
 *   userGoal?: string,
 *   tools?: string[],
 *   details?: string,
 * }} params
 */
export async function recordFailure(params) {
  if (!failureMemoryEnabled()) return;
  const { userId, workspaceId } = params || {};
  if (!userId || !workspaceId) return;
  try {
    const existing = await countFailureMemories(userId, workspaceId);
    if (existing >= DEFAULT_MAX_FAILURE_MEMORIES) return;
    const content = formatFailure(params);
    await remember(userId, workspaceId, {
      content,
      category: "observation",
      importance: 2,
      source: "agent-failure-memory",
      metadata: {
        kind: params.kind,
        recordedAt: new Date().toISOString(),
      },
    });
  } catch {
    // Best-effort; never fail the loop.
  }
}
