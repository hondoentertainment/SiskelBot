/**
 * Generates MCP tool definitions from agent profiles and handles their
 * invocation via spawnSubagent. Gated behind EXPOSE_AGENT_MCP_TOOLS=1.
 *
 * @module mcp-agent-tools
 */

import { listProfiles, getBuiltInProfiles } from "./agent-profiles.js";
import { spawnSubagent } from "./spawn-subagent.js";

/**
 * Convert a single agent profile to an MCP tool definition.
 * Tool name follows the convention `agent_<profile.id>`.
 *
 * @param {object} profile - An agent profile object.
 * @returns {object} MCP tool definition with name, description, and inputSchema.
 */
export function profileToMcpTool(profile) {
  return {
    name: `agent_${profile.id}`,
    description: (profile.systemPrompt || "").slice(0, 200),
    inputSchema: {
      type: "object",
      properties: {
        goal: { type: "string", description: "The goal or task to accomplish" },
        context: { type: "string", description: "Additional context for the agent" },
        maxIterations: { type: "number", description: "Maximum iterations for the agent loop" },
      },
      required: ["goal"],
    },
  };
}

/**
 * Generate MCP tool definitions for all agent profiles in a workspace.
 * When no workspace is provided, only built-in profiles are returned.
 *
 * @param {string} [workspace] - Optional workspace ID.
 * @returns {Promise<object[]>} Array of MCP tool definitions.
 */
export async function generateAgentMcpTools(workspace) {
  const profiles = workspace
    ? await listProfiles(workspace)
    : getBuiltInProfiles();
  return profiles.map(profileToMcpTool);
}

/**
 * Handle an MCP tools/call for an agent profile tool.
 *
 * Parses the profile ID from the tool name (agent_<profileId>), then
 * delegates to spawnSubagent with the resolved profile.
 *
 * @param {string} toolName - MCP tool name (e.g. "agent_researcher").
 * @param {object} args - Tool call arguments { goal, context?, maxIterations? }.
 * @param {object} context - Execution context with runAgentLoop, backendFetch, etc.
 * @returns {Promise<object>} MCP tool result { content: [{type, text}], isError? }.
 */
export async function handleAgentMcpToolCall(toolName, args, context = {}) {
  const profileId = toolName.replace(/^agent_/, "");
  if (!profileId || profileId === toolName) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: `Invalid agent tool name: ${toolName}` }) }],
      isError: true,
    };
  }

  const goal = args?.goal;
  if (typeof goal !== "string" || !goal.trim()) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: "goal is required" }) }],
      isError: true,
    };
  }

  const result = await spawnSubagent({
    goal: goal.trim(),
    profile: profileId,
    context: args.context || undefined,
    maxIterations: typeof args.maxIterations === "number" ? args.maxIterations : undefined,
    workspace: context.workspace || "default",
    userId: context.userId || "anonymous",
    runAgentLoop: context.runAgentLoop,
    backendFetch: context.backendFetch,
    buildProxyConfig: context.buildProxyConfig,
  });

  if (!result.ok) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: result.error, code: result.code }) }],
      isError: true,
    };
  }

  return {
    content: [{ type: "text", text: result.result || "" }],
  };
}
