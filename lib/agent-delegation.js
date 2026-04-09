/**
 * Phase 29: Agent-to-agent delegation.
 * Allows a parent agent run to delegate tasks to specialist sub-agents.
 */
import { randomUUID } from "crypto";
import { getSpecialist, getSpecialists } from "./specialists.js";
import { getToolsForNames, runTool } from "./agent-tools.js";

const MAX_DELEGATION_DEPTH = Number(process.env.AGENT_MAX_DELEGATION_DEPTH) || 3;
const MAX_SUB_ITERATIONS = Number(process.env.AGENT_SUB_ITERATIONS) || 5;

/**
 * Delegate a task to a specialist sub-agent.
 * Creates a sub-agent run with the specialist's system prompt,
 * passes context from the parent agent, and runs a mini tool loop.
 *
 * @param {string} parentRunId - The parent agent run ID
 * @param {string} specialistName - The specialist to delegate to
 * @param {string} task - The task description
 * @param {{ depth?: number, backendFetch?: Function, buildProxyConfig?: Function, model?: string, workspaceId?: string }} context
 * @returns {Promise<{ runId: string, response: string, toolCalls: object[], specialist: string, duration: number }>}
 */
export async function delegateToSpecialist(parentRunId, specialistName, task, context = {}) {
  const depth = context.depth || 0;
  if (depth >= MAX_DELEGATION_DEPTH) {
    return {
      runId: randomUUID(),
      response: `[delegation-limit] Maximum delegation depth (${MAX_DELEGATION_DEPTH}) reached. Cannot delegate further.`,
      toolCalls: [],
      specialist: specialistName,
      duration: 0,
    };
  }

  const specialist = getSpecialist(specialistName);
  if (!specialist) {
    return {
      runId: randomUUID(),
      response: `[error] Unknown specialist: ${specialistName}. Available: ${getSpecialists().map(s => s.name).join(", ")}`,
      toolCalls: [],
      specialist: specialistName,
      duration: 0,
    };
  }

  const runId = randomUUID();
  const startedAt = Date.now();
  const toolCalls = [];

  const messages = [
    { role: "system", content: specialist.systemPrompt },
    {
      role: "user",
      content: `Parent agent (run: ${parentRunId}) has delegated the following task to you:\n\n${task}`,
    },
  ];

  // Build tool schemas for the specialist's allowed tools
  const toolSchemas = specialist.tools.length > 0 ? getToolsForNames(specialist.tools) : [];

  let response = "";

  if (typeof context.backendFetch === "function" && typeof context.buildProxyConfig === "function") {
    const config = context.buildProxyConfig(context.model || "default");
    const url = `${config.baseUrl}${config.path}`;

    const toolCtx = {
      allowExecution: false,
      projectDir: process.env.PROJECT_DIR || process.cwd(),
      workspace: context.workspaceId || "default",
    };

    let iteration = 0;
    let currentMessages = [...messages];

    while (iteration < MAX_SUB_ITERATIONS) {
      iteration++;

      const body = {
        model: context.model || "default",
        messages: currentMessages,
        stream: false,
        ...(toolSchemas.length > 0 ? { tools: toolSchemas, tool_choice: "auto" } : {}),
      };

      try {
        const resp = await context.backendFetch(url, {
          method: "POST",
          headers: config.headers,
          body: JSON.stringify(body),
        });

        if (!resp.ok) {
          response = `[backend-error] ${resp.status}`;
          break;
        }

        const data = await resp.json();
        const choice = data.choices?.[0];
        const msg = choice?.message;

        if (!msg) {
          response = "(No response from specialist)";
          break;
        }

        const content = typeof msg.content === "string" ? msg.content : "";
        const msgToolCalls = msg.tool_calls;

        if (!Array.isArray(msgToolCalls) || msgToolCalls.length === 0) {
          response = content || "(Empty response from specialist)";
          break;
        }

        // Process tool calls
        currentMessages.push(msg);
        for (const tc of msgToolCalls) {
          const name = tc.function?.name;
          let args;
          try {
            args = JSON.parse(tc.function?.arguments || "{}");
          } catch {
            args = {};
          }

          let result;
          try {
            result = await runTool(name, args, toolCtx);
            toolCalls.push({ name, args, ok: true });
          } catch (err) {
            result = { content: JSON.stringify({ error: err.message }), ok: false };
            toolCalls.push({ name, args, ok: false, error: err.message });
          }

          currentMessages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: typeof result.content === "string" ? result.content : JSON.stringify(result),
          });
        }
      } catch (err) {
        response = `[delegation-error] ${err.message}`;
        break;
      }
    }

    if (!response && iteration >= MAX_SUB_ITERATIONS) {
      response = "(Sub-agent reached max iterations without final response)";
    }
  } else {
    // Dry run mode: no backend available
    response = `[dry-run] Specialist "${specialist.name}" would process: ${task.slice(0, 200)}`;
  }

  const duration = Date.now() - startedAt;

  return {
    runId,
    response,
    toolCalls,
    specialist: specialistName,
    duration,
  };
}

/**
 * Get the list of available specialist agents that can be delegated to.
 * @returns {object[]}
 */
export function getAvailableSpecialists() {
  return getSpecialists().map((s) => ({
    name: s.name,
    description: s.systemPrompt.split("\n")[0].replace(/^You are an? /, ""),
    tools: s.tools,
  }));
}
