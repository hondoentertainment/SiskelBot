// @ts-check
/**
 * Single-agent tool loop (extracted from server for testing and OTEL).
 *
 * @typedef {import("./types.d.ts").SiskelRequest} SiskelRequest
 * @typedef {import("./types.d.ts").ProxyConfig} ProxyConfig
 * @typedef {import("./types.d.ts").StreamOptions} StreamOptions
 * @typedef {import("./types.d.ts").AgentLoopResult} AgentLoopResult
 * @typedef {import("./types.d.ts").ToolCallLogEntry} ToolCallLogEntry
 * @typedef {import("./types.d.ts").ToolMetric} ToolMetric
 * @typedef {import("./types.d.ts").ToolContext} ToolContext
 * @typedef {import("./types.d.ts").ChatMessage} ChatMessage
 */
import { randomUUID } from "crypto";
import { trace, SpanStatusCode, context as otelContext } from "@opentelemetry/api";
import {
  getToolsSchema,
  runTool,
  intersectClientToolsWithAllowlist,
  filterToolsByWorkspaceAllowlist,
  AGENT_TOOL_TIMEOUT_MS,
} from "./agent-tools.js";
import { resolveAgentMaxIterations } from "./agent-iterations.js";
import { augmentMessagesWithDefaultSystem } from "./agent-defaults.js";
import { resolveStorageUserId } from "./teams.js";
import { augmentMessagesWithWorkspaceAgent, loadWorkspaceAgentSettings } from "./workspace-agent-settings.js";
import { augmentMessagesForGrounding, checkCitationCoverage } from "./grounding.js";
import { validateToolCall, toolValidationEnabled } from "./tool-validation.js";
import { detectStagnation, stagnationDetectionEnabled } from "./agent-stagnation.js";
import {
  createTrajectoryCollector,
  saveTrajectory,
  trajectoryApiEnabled,
} from "./agent-trajectory.js";
import {
  recordAgentPhaseMs,
  recordAgentRunSummary,
  recordToolTimeout,
  isEnabled as metricsEnabled,
} from "./metrics.js";
import { truncateToolResultContent, getAgentToolResultMaxChars } from "./agent-context-trim.js";
import { getMemoryContext } from "./agent-memory-inject.js";

const agentTracer = trace.getTracer("siskel-bot-agent", "1.0.0");

const MAX_AGENT_TOOL_CALLS_ENV = Number(process.env.MAX_AGENT_TOOL_CALLS) || 0;
const AGENT_MAX_WALL_MS_ENV = Number(process.env.AGENT_MAX_WALL_MS) || 0;

/**
 * Run the agent tool-call loop until the model stops calling tools or a budget is hit.
 *
 * @param {SiskelRequest} req - Express request with body.messages, body.agentOptions
 * @param {import("express").Response} res - Express response (headers set during loop)
 * @param {ProxyConfig} config - Proxy config from buildProxyConfig
 * @param {string} model - Default model identifier
 * @param {StreamOptions} streamOptions - Optional run ID and progress callback
 * @param {typeof fetch} backendFetch - Fetch implementation for backend calls
 * @returns {Promise<AgentLoopResult>}
 */
export async function runAgentLoop(req, res, config, model, streamOptions, backendFetch) {
  const onProgress = streamOptions && typeof streamOptions.onProgress === "function" ? streamOptions.onProgress : null;
  const url = `${config.baseUrl}${config.path}`;
  const workspace = req.body?.agentOptions?.workspace || "default";
  let messages = Array.isArray(req.body?.messages) ? [...req.body.messages] : [];
  messages = augmentMessagesWithDefaultSystem(messages);
  const storageUserId = await resolveStorageUserId(req.userId || "anonymous", workspace);
  messages = await augmentMessagesWithWorkspaceAgent(messages, storageUserId, workspace);
  messages = augmentMessagesForGrounding(messages);

  // Phase 20: Inject long-term memory context
  try {
    const memoryContext = await getMemoryContext(storageUserId, workspace, messages);
    if (memoryContext) {
      const memMsg = { role: "system", content: memoryContext };
      // Insert after existing system messages
      const lastSysIdx = messages.reduce((acc, m, i) => (m.role === "system" ? i : acc), -1);
      messages.splice(lastSysIdx + 1, 0, memMsg);
    }
  } catch {
    // Memory injection is best-effort
  }

  const allowExecution = req.body?.agentOptions?.allowExecution === true;
  const agentOpts = req.body?.agentOptions || {};
  const maxAgentIterations = resolveAgentMaxIterations(agentOpts, process.env.MAX_AGENT_ITERATIONS);
  const setAgentHeader = (name, value) => {
    if (!res.headersSent) res.setHeader(name, value);
  };
  setAgentHeader("X-Agent-Max-Iterations", String(maxAgentIterations));
  const wsSettings = await loadWorkspaceAgentSettings(storageUserId, workspace);
  const workspaceAllowedTools =
    wsSettings.allowedTools?.length > 0 ? new Set(wsSettings.allowedTools) : null;

  const toolCtx = {
    allowExecution:
      process.env.ALLOW_RECIPE_STEP_EXECUTION === "1" && allowExecution,
    projectDir: process.env.PROJECT_DIR || process.cwd(),
    vercelToken: process.env.VERCEL_TOKEN,
    workspace,
    workspaceUserId: storageUserId,
    workspaceAllowedTools,
  };

  const runId = streamOptions?.presetRunId || randomUUID();
  setAgentHeader("X-Agent-Run-Id", runId);

  const rootSpan = agentTracer.startSpan("agent.run", {
    attributes: {
      "agent.run_id": runId,
      "agent.model": req.body?.model || model,
      "agent.max_iterations": maxAgentIterations,
      "agent.workspace": workspace,
    },
  });
  const rootCtx = trace.setSpan(otelContext.active(), rootSpan);

  rootSpan.addEvent("agent.start", {
    model: req.body?.model || model,
    maxIterations: maxAgentIterations,
  });
  try {
  let llmMsTotal = 0;
  let toolsMsTotal = 0;
  let reflectMs = 0;
  const trajCollector = createTrajectoryCollector({
    runId,
    workspace,
    userId: req.userId || null,
  });
  trajCollector.record({ type: "start", model: req.body?.model || model });

  let tools = req.body?.tools?.length
    ? intersectClientToolsWithAllowlist(req.body.tools)
    : getToolsSchema();
  tools = filterToolsByWorkspaceAllowlist(tools, wsSettings.allowedTools);
  const baseToolChoice = agentOpts.toolChoice != null ? agentOpts.toolChoice : req.body?.tool_choice ?? "auto";
  const requiredSeq = Array.isArray(agentOpts.requiredToolSequence)
    ? agentOpts.requiredToolSequence.map((x) => String(x).trim()).filter(Boolean)
    : [];
  const runStarted = Date.now();
  let totalToolCalls = 0;
  let toolTimeoutCount = 0;
  const toolResultMaxChars = getAgentToolResultMaxChars();

  const bodyBase = {
    model: req.body?.model || model,
    messages,
    tools,
    stream: false,
    ...(req.body?.temperature != null && { temperature: req.body.temperature }),
    ...(req.body?.max_tokens != null && { max_tokens: req.body.max_tokens }),
  };
  if (agentOpts.responseFormat && typeof agentOpts.responseFormat === "object") {
    bodyBase.response_format = agentOpts.responseFormat;
  }

  let lastContent = "";
  let iteration = 0;
  const toolCallsLog = [];
  let stopReason = "complete";

  while (iteration < maxAgentIterations) {
    iteration++;
    setAgentHeader("X-Agent-Iteration", String(iteration));
    trajCollector.record({ type: "iteration", iteration });

    if (AGENT_MAX_WALL_MS_ENV > 0 && Date.now() - runStarted > AGENT_MAX_WALL_MS_ENV) {
      lastContent = "(Agent stopped: wall clock budget exceeded)";
      stopReason = "wall_clock";
      setAgentHeader("X-Agent-Truncated", "wall_clock");
      break;
    }

    let toolChoiceThis = baseToolChoice;
    if (requiredSeq.length > 0 && iteration === 1) {
      toolChoiceThis = { type: "function", function: { name: requiredSeq[0] } };
    }

    let data;
    const llmT0 = Date.now();
    const llmSpan = agentTracer.startSpan("llm.chat_completion", {
      attributes: {
        "llm.model": bodyBase.model,
        "llm.iteration": iteration,
        "agent.run_id": runId,
      },
    }, rootCtx);
    try {
      const response = await backendFetch(url, {
        method: "POST",
        headers: config.headers,
        body: JSON.stringify({ ...bodyBase, messages, tool_choice: toolChoiceThis }),
      });

      if (!response.ok) {
        const err = await response.text();
        llmSpan.setStatus({ code: SpanStatusCode.ERROR, message: String(response.status) });
        throw new Error(`Backend error: ${response.status} ${err?.slice(0, 200) || ""}`);
      }

      data = await response.json().catch(() => ({}));
    } catch (e) {
      llmSpan.recordException(e);
      llmSpan.setStatus({ code: SpanStatusCode.ERROR });
      throw e;
    } finally {
      llmSpan.setAttribute("llm.duration_ms", Date.now() - llmT0);
      llmSpan.end();
    }

    const llmRoundMs = Date.now() - llmT0;
    llmMsTotal += llmRoundMs;
    const choice = data.choices?.[0];
    const msg = choice?.message;

    if (!msg) {
      lastContent = "(No response from model)";
      stopReason = "no_message";
      break;
    }

    const content = typeof msg.content === "string" ? msg.content : "";
    const toolCalls = msg.tool_calls;

    if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
      lastContent = content || "(Empty response)";
      stopReason = "model_finished";
      break;
    }

    messages.push(msg);
    const toolsWallT0 = Date.now();
    const toolMetrics = [];
    const results = await Promise.all(
      toolCalls.map(async (tc) => {
        const name = tc.function?.name;
        const argsStr = tc.function?.arguments || "{}";
        let args;
        let parseError = null;
        try {
          args = JSON.parse(argsStr);
        } catch (e) {
          parseError = e?.message || "invalid json";
          args = {};
        }

        if (toolValidationEnabled()) {
          const v = validateToolCall(name, args, { parseError });
          if (!v.valid) {
            toolCallsLog.push({ name, args, iteration, validationError: true, durationMs: 0 });
            toolMetrics.push({ name, durationMs: 0, ok: false, validationError: true });
            trajCollector.record({
              type: "tool_validation_error",
              name,
              iteration,
              errors: v.errors,
            });
            return {
              tool_call_id: tc.id,
              content: JSON.stringify({
                _tool_validation_error: true,
                errors: v.errors,
                repairHint: v.repairHint,
                message: "Correct the tool call; the server did not execute invalid arguments.",
              }),
            };
          }
        }

        trajCollector.record({
          type: "tool_call",
          name,
          iteration,
          argsPreview: trajCollector.truncate(JSON.stringify(args), 240),
        });

        rootSpan.addEvent("tool.call", {
          name: String(name || ""),
          args: JSON.stringify(args).slice(0, 500),
        });

        const execT0 = Date.now();
        try {
          const toolSpan = agentTracer.startSpan(`tool.${name}`, {
            attributes: {
              "agent.tool.name": String(name || ""),
              "agent.tool.iteration": iteration,
              "agent.run_id": runId,
            },
          }, rootCtx);
          let result;
          try {
            result = await runTool(name, args, toolCtx);
          } catch (err) {
            toolSpan.recordException(err);
            toolSpan.setStatus({ code: SpanStatusCode.ERROR });
            toolSpan.setAttribute("agent.tool.duration_ms", Date.now() - execT0);
            toolSpan.end();
            throw err;
          }
          const durationMs = Date.now() - execT0;
          toolSpan.setAttribute("agent.tool.duration_ms", durationMs);
          if (result._timeout) {
            const timeoutMs = result._timeoutMs || AGENT_TOOL_TIMEOUT_MS;
            toolSpan.setAttribute("agent.tool.timeout", true);
            toolSpan.setStatus({ code: SpanStatusCode.ERROR, message: `timeout after ${timeoutMs}ms` });
            toolSpan.end();
            console.warn(`[agent] Tool "${name}" timed out after ${timeoutMs}ms`);
            toolTimeoutCount++;
            toolCallsLog.push({ name, args, iteration, durationMs, ok: false, timeout: true });
            toolMetrics.push({ name, durationMs, ok: false, timeout: true });
            trajCollector.record({
              type: "tool_timeout",
              name,
              iteration,
              timeoutMs,
            });
            if (metricsEnabled()) {
              recordToolTimeout(name);
            }
            return { tool_call_id: tc.id, content: result.content };
          }
          if (result.ok === false) {
            toolSpan.setStatus({ code: SpanStatusCode.ERROR, message: "tool returned ok:false" });
          }
          toolSpan.end();
          let outContent = result.content;
          if (toolResultMaxChars > 0) {
            outContent = truncateToolResultContent(outContent, toolResultMaxChars);
          }
          toolCallsLog.push({ name, args, iteration, durationMs, ok: result.ok !== false });
          toolMetrics.push({ name, durationMs, ok: result.ok !== false });
          trajCollector.record({
            type: "tool_result",
            name,
            iteration,
            ok: result.ok !== false,
            preview: trajCollector.truncate(outContent, 400),
          });
          return { tool_call_id: tc.id, content: outContent };
        } catch (err) {
          const durationMs = Date.now() - execT0;
          toolCallsLog.push({ name, args, iteration, durationMs, ok: false, error: true });
          toolMetrics.push({ name, durationMs, ok: false });
          trajCollector.record({
            type: "tool_error",
            name,
            iteration,
            message: String(err?.message || err),
          });
          return {
            tool_call_id: tc.id,
            content: JSON.stringify({ ok: false, error: String(err?.message || err) }),
          };
        }
      })
    );
    const toolsWallMs = Date.now() - toolsWallT0;
    toolsMsTotal += toolsWallMs;
    onProgress?.({
      type: "agent_progress",
      iteration,
      llmMs: llmRoundMs,
      toolsWallMs,
      tools: toolMetrics,
    });
    for (const r of results) {
      messages.push({
        role: "tool",
        tool_call_id: r.tool_call_id,
        content: r.content,
      });
    }

    totalToolCalls += toolCalls.length;
    if (MAX_AGENT_TOOL_CALLS_ENV > 0 && totalToolCalls >= MAX_AGENT_TOOL_CALLS_ENV) {
      lastContent = "(Agent stopped: tool call budget reached; partial context is in the conversation.)";
      stopReason = "tool_budget";
      setAgentHeader("X-Agent-Truncated", "tool_budget");
      break;
    }

    if (stagnationDetectionEnabled() && detectStagnation(toolCallsLog)) {
      lastContent = "(Agent stopped: repeated identical tool calls with no progress)";
      stopReason = "stagnation";
      setAgentHeader("X-Agent-Stopped", "stagnation");
      break;
    }
  }

  if (iteration >= maxAgentIterations && lastContent === "") {
    lastContent = "(Agent reached max iterations without final response)";
    stopReason = "max_iterations";
    setAgentHeader("X-Agent-Truncated", "max_iterations");
  }

  if (
    process.env.AGENT_PLAN_REFLECT === "1" &&
    stopReason === "model_finished" &&
    typeof lastContent === "string" &&
    lastContent &&
    !lastContent.startsWith("(Agent stopped:") &&
    !lastContent.startsWith("(Agent reached max")
  ) {
    try {
      const reflectMessages = [
        ...messages,
        {
          role: "user",
          content:
            "Briefly summarize what was accomplished and list any recommended follow-ups (one short paragraph). Do not call tools.",
        },
      ];
      const reflT0 = Date.now();
      const rr = await backendFetch(url, {
        method: "POST",
        headers: config.headers,
        body: JSON.stringify({
          model: req.body?.model || model,
          messages: reflectMessages,
          stream: false,
        }),
      });
      reflectMs += Date.now() - reflT0;
      if (rr.ok) {
        const rd = await rr.json().catch(() => ({}));
        const reflect = rd.choices?.[0]?.message?.content;
        if (typeof reflect === "string" && reflect.trim()) {
          lastContent = `${lastContent}\n\n---\n**Reflection**\n${reflect.trim()}`;
        }
      }
    } catch {
      /* optional reflect pass */
    }
  }

  if (toolTimeoutCount > 0) {
    setAgentHeader("X-Agent-Tool-Timeouts", String(toolTimeoutCount));
  }

  const cite = checkCitationCoverage(lastContent, messages);
  if (!cite.skipped && !cite.ok) {
    setAgentHeader("X-Agent-Citations-Missing", "1");
  }

  trajCollector.record({ type: "stop", reason: stopReason, iterations: iteration });
  const trajectorySnapshot = trajCollector.getSnapshot();
  if (trajectoryApiEnabled()) {
    await saveTrajectory(runId, trajectorySnapshot);
  }

  if (metricsEnabled()) {
    recordAgentPhaseMs("single", "llm", llmMsTotal);
    recordAgentPhaseMs("single", "tools", toolsMsTotal);
    if (reflectMs > 0) recordAgentPhaseMs("single", "reflect", reflectMs);
    recordAgentRunSummary("single", stopReason);
  }

  rootSpan.addEvent("agent.finish", {
    iterations: iteration,
    toolCalls: totalToolCalls,
    stopReason,
  });
  rootSpan.setAttributes({
    "agent.iterations": iteration,
    "agent.tool_calls_total": totalToolCalls,
    "agent.stop_reason": stopReason,
  });

  return {
    content: lastContent,
    iteration,
    toolCalls: toolCallsLog,
    runId,
    stopReason,
    citationWarning: !cite.skipped && !cite.ok,
    trajectory: trajectorySnapshot,
  };
  } catch (err) {
    rootSpan.recordException(err);
    rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: String(err?.message || err) });
    throw err;
  } finally {
    rootSpan.end();
  }
}
