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
import { detectStagnation, stagnationDetectionEnabled, stagnationRecoveryEnabled } from "./agent-stagnation.js";
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
import {
  truncateToolResultContent,
  getAgentToolResultMaxChars,
  getAgentToolHistoryMaxMessages,
  getAgentToolHistoryMaxChars,
  applyToolMessageBudget,
} from "./agent-context-trim.js";
import {
  resolveEffectivePolicy,
  createPolicyState,
  recordPolicyToolCompletion,
  checkPolicyAfterRound,
} from "./agent-policy.js";
import { executeAgentToolBatch } from "./agent-loop-execute-tools.js";
import { takeHitlState } from "./agent-hitl-store.js";
import {
  appendAgentSessionEvent,
  assertAgentSessionForRun,
  linkRunToAgentSession,
  agentSessionApiEnabled,
} from "./agent-session.js";
import {
  bindSessionAbortController,
  tryBeginWorkspaceAgentRun,
  endWorkspaceAgentRun,
} from "./agent-run-control.js";

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
  const resumeAfterHitl = streamOptions?.resumeAfterHitl === true;
  let messages = Array.isArray(req.body?.messages) ? [...req.body.messages] : [];
  const storageUserId = await resolveStorageUserId(req.userId || "anonymous", workspace);
  if (!resumeAfterHitl) {
    messages = augmentMessagesWithDefaultSystem(messages);
    messages = await augmentMessagesWithWorkspaceAgent(messages, storageUserId, workspace);
    messages = augmentMessagesForGrounding(messages);
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
  const effectivePolicy = resolveEffectivePolicy(wsSettings.agentPolicy || {});
  const deniedList = wsSettings.agentPolicy?.deniedTools || [];
  const workspaceDeniedTools = new Set(deniedList.map((x) => String(x).trim()).filter(Boolean));
  const policyState = createPolicyState(effectivePolicy, { deniedTools: workspaceDeniedTools });
  const workspaceRootEnv = (process.env.WORKSPACE_ROOT || "").trim();
  const sessionId = typeof agentOpts.sessionId === "string" ? agentOpts.sessionId.trim() : "";
  let releaseSessionConcurrency = () => {};
  let releaseSessionAbortBinding = () => {};

  if (sessionId && !resumeAfterHitl) {
    if (!agentSessionApiEnabled()) {
      return hitlResumeErrorResponse(
        "(Agent sessions API disabled. Unset AGENT_SESSION_API=0 on the server.)",
        "session_api_disabled"
      );
    }
    const sessOk = await assertAgentSessionForRun(sessionId, workspace, storageUserId);
    if (!sessOk.ok) {
      return hitlResumeErrorResponse(`(${sessOk.message})`, "session_invalid");
    }
    const conc = tryBeginWorkspaceAgentRun(workspace);
    if (!conc.ok) {
      return hitlResumeErrorResponse(
        `(Too many concurrent agent runs for this workspace; maximum is ${conc.max}.)`,
        "concurrency_limited"
      );
    }
    releaseSessionConcurrency = () => endWorkspaceAgentRun(workspace);
  }

  const toolCtx = {
    allowExecution:
      process.env.ALLOW_RECIPE_STEP_EXECUTION === "1" && allowExecution,
    projectDir: process.env.PROJECT_DIR || process.cwd(),
    vercelToken: process.env.VERCEL_TOKEN,
    workspace,
    workspaceUserId: storageUserId,
    workspaceAllowedTools,
    workspaceDeniedTools,
    ...(workspaceRootEnv ? { workspaceFilesystemRoot: workspaceRootEnv } : {}),
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
  if (sessionId) setAgentHeader("X-Agent-Session-Id", sessionId);

  /** @type {AbortSignal | undefined} */
  let abortSignal = streamOptions?.abortSignal;
  if (sessionId && !resumeAfterHitl) {
    const bind = bindSessionAbortController(sessionId);
    releaseSessionAbortBinding = bind.release;
    if (bind.controller) abortSignal = bind.controller.signal;
    await appendAgentSessionEvent(sessionId, { type: "run_start", runId });
    await linkRunToAgentSession(sessionId, runId);
  }
  try {
  let llmMsTotal = 0;
  let toolsMsTotal = 0;
  let reflectMs = 0;
  let verifyMs = 0;
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
  const hc = streamOptions?.hitlContinue;
  const runStarted = hc?.runStarted ?? Date.now();
  let totalToolCalls = hc ? hc.totalToolCalls : 0;
  let toolTimeoutCount = 0;
  const toolResultMaxChars = getAgentToolResultMaxChars();
  const toolHistoryMaxMsgs = getAgentToolHistoryMaxMessages();
  const toolHistoryMaxChars = getAgentToolHistoryMaxChars();
  const traceRequestId =
    typeof req.requestId === "string" && req.requestId.trim() ? req.requestId.trim() : undefined;
  let stagnationRecoveryUsed = false;

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
  let iteration = hc ? hc.iteration : 0;
  const toolCallsLog = [];
  if (hc) {
    messages = hc.messages;
    for (const e of hc.toolCallsLog) toolCallsLog.push(e);
    llmMsTotal = hc.llmMsTotal;
    toolsMsTotal = hc.toolsMsTotal;
    stagnationRecoveryUsed = hc.stagnationRecoveryUsed;
    Object.assign(policyState.categoryCounts, hc.policySnapshot.categoryCounts);
    policyState.externalFetches = hc.policySnapshot.externalFetches;
    policyState.totalToolMs = hc.policySnapshot.totalToolMs;
    trajCollector.record({ type: "hitl_resume", iteration: hc.iteration, totalToolCalls: hc.totalToolCalls });
    messages = applyToolMessageBudget(messages, toolHistoryMaxMsgs, toolHistoryMaxChars);
  }
  let stopReason = "complete";
  let stopDetail = "";
  let skipAgentWhile = false;
  if (hc) {
    if (MAX_AGENT_TOOL_CALLS_ENV > 0 && totalToolCalls >= MAX_AGENT_TOOL_CALLS_ENV) {
      lastContent = "(Agent stopped: tool call budget reached; partial context is in the conversation.)";
      stopReason = "tool_budget";
      setAgentHeader("X-Agent-Truncated", "tool_budget");
      skipAgentWhile = true;
    } else if (stagnationDetectionEnabled() && detectStagnation(toolCallsLog)) {
      if (stagnationRecoveryEnabled() && !stagnationRecoveryUsed) {
        stagnationRecoveryUsed = true;
        messages.push({
          role: "user",
          content:
            "You appear stuck repeating the same tool calls with no progress. Reassess the situation: try different tools or arguments, or answer from context without redundant calls.",
        });
        setAgentHeader("X-Agent-Stagnation-Recovery", "1");
      } else {
        lastContent = "(Agent stopped: repeated identical tool calls with no progress)";
        stopReason = "stagnation";
        setAgentHeader("X-Agent-Stopped", "stagnation");
        skipAgentWhile = true;
      }
    }
    if (!skipAgentWhile && hc) {
      const afterRoundHc = checkPolicyAfterRound(policyState);
      if (!afterRoundHc.ok) {
        lastContent = "(Agent stopped: policy budget exceeded)";
        stopReason = "policy_blocked";
        stopDetail = afterRoundHc.reason;
        setAgentHeader("X-Agent-Stopped", "policy_blocked");
        setAgentHeader("X-Agent-Policy-Code", afterRoundHc.code);
        skipAgentWhile = true;
      }
    }
  }

  while (!skipAgentWhile && iteration < maxAgentIterations) {
    iteration++;
    setAgentHeader("X-Agent-Iteration", String(iteration));
    trajCollector.record({ type: "iteration", iteration });

    if (abortSignal?.aborted) {
      lastContent = "(Agent run cancelled.)";
      stopReason = "cancelled";
      setAgentHeader("X-Agent-Stopped", "cancelled");
      break;
    }

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
    try {
      await agentTracer.startActiveSpan(
        "agent.llm_round",
        {
          attributes: {
            "agent.run_id": runId,
            "agent.iteration": iteration,
            ...((process.env.AGENT_EXECUTE_STEP_HITL === "1" || agentOpts.requireExecuteStepApproval === true) && {
              "agent.hitl_execute_step": true,
            }),
          },
        },
        async (span) => {
          try {
            const response = await backendFetch(url, {
              method: "POST",
              headers: config.headers,
              body: JSON.stringify({ ...bodyBase, messages, tool_choice: toolChoiceThis }),
              signal: abortSignal,
            });

            if (!response.ok) {
              const err = await response.text();
              span.setStatus({ code: SpanStatusCode.ERROR, message: String(response.status) });
              throw new Error(`Backend error: ${response.status} ${err?.slice(0, 200) || ""}`);
            }

            data = await response.json().catch(() => ({}));
          } catch (e) {
            span.recordException(e);
            span.setStatus({ code: SpanStatusCode.ERROR });
            throw e;
          }
        }
      );
    } catch (e) {
      if (abortSignal?.aborted || e?.name === "AbortError") {
        lastContent = "(Agent run cancelled.)";
        stopReason = "cancelled";
        setAgentHeader("X-Agent-Stopped", "cancelled");
        break;
      }
      throw e;
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
        let args = {};
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
    const setStopPolicy = (check) => {
      stopReason = "policy_blocked";
      stopDetail = check.reason;
      setAgentHeader("X-Agent-Stopped", "policy_blocked");
      setAgentHeader("X-Agent-Policy-Code", check.code);
    };
    const { results, hitlPause, toolMetrics } = await executeAgentToolBatch({
      toolCalls,
      iteration,
      runId,
      toolCtx,
      policyState,
      toolCallsLog,
      trajCollector,
      traceRequestId,
      setStopPolicy,
      agentOpts,
      hitlContext: {
        userId: req.userId ?? null,
        runId,
        workspace,
        storageUserId,
        allowExecution: toolCtx.allowExecution === true,
        messages: JSON.parse(JSON.stringify(messages)),
        iteration,
        maxAgentIterations,
        runStarted,
        totalToolCalls,
        toolCallsLog: JSON.parse(JSON.stringify(toolCallsLog)),
        policySnapshot: {
          categoryCounts: { ...policyState.categoryCounts },
          externalFetches: policyState.externalFetches,
          totalToolMs: policyState.totalToolMs,
        },
        effectivePolicy: JSON.parse(JSON.stringify(effectivePolicy)),
        stagnationRecoveryUsed,
        llmMsTotal,
        toolsMsTotal,
        bodyBaseModel: bodyBase.model,
        tools,
        requiredSeq,
        baseToolChoice,
        temperature: req.body?.temperature,
        max_tokens: req.body?.max_tokens,
        responseFormat: agentOpts.responseFormat,
        workspaceAllowedToolsList: wsSettings.allowedTools || [],
        traceRequestId,
      },
    });
    const toolsWallMs = Date.now() - toolsWallT0;
    toolsMsTotal += toolsWallMs;
    if (hitlPause) {
      setAgentHeader("X-Agent-Pending-Execute-Step", "1");
      onProgress?.({
        type: "agent_pending_execution",
        resumeToken: hitlPause.token,
        pendingSteps: hitlPause.pendingSteps,
        iteration,
      });
      onProgress?.({
        type: "agent_progress",
        iteration,
        llmMs: llmRoundMs,
        toolsWallMs,
        tools: hitlPause.toolMetrics,
      });
      lastContent =
        "(Paused: human approval required before recipe step execution. POST /v1/agent/resume-execute-step with JSON body { resumeToken, approved: true }.)";
      stopReason = "hitl_pending";
      trajCollector.record({
        type: "hitl_pending",
        resumeToken: hitlPause.token,
        pendingSteps: hitlPause.pendingSteps,
      });
      break;
    }
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

    messages = applyToolMessageBudget(messages, toolHistoryMaxMsgs, toolHistoryMaxChars);

    totalToolCalls += toolCalls.length;
    if (MAX_AGENT_TOOL_CALLS_ENV > 0 && totalToolCalls >= MAX_AGENT_TOOL_CALLS_ENV) {
      lastContent = "(Agent stopped: tool call budget reached; partial context is in the conversation.)";
      stopReason = "tool_budget";
      setAgentHeader("X-Agent-Truncated", "tool_budget");
      break;
    }

    if (stagnationDetectionEnabled() && detectStagnation(toolCallsLog)) {
      if (stagnationRecoveryEnabled() && !stagnationRecoveryUsed) {
        stagnationRecoveryUsed = true;
        messages.push({
          role: "user",
          content:
            "You appear stuck repeating the same tool calls with no progress. Reassess the situation: try different tools or arguments, or answer from context without redundant calls.",
        });
        setAgentHeader("X-Agent-Stagnation-Recovery", "1");
        continue;
      }
      lastContent = "(Agent stopped: repeated identical tool calls with no progress)";
      stopReason = "stagnation";
      setAgentHeader("X-Agent-Stopped", "stagnation");
      break;
    }
    const afterRound = checkPolicyAfterRound(policyState);
    if (!afterRound.ok) {
      lastContent = "(Agent stopped: policy budget exceeded)";
      stopReason = "policy_blocked";
      stopDetail = afterRound.reason;
      setAgentHeader("X-Agent-Stopped", "policy_blocked");
      setAgentHeader("X-Agent-Policy-Code", afterRound.code);
      break;
    }
    if (stopReason === "policy_blocked") {
      lastContent = `(Agent stopped: policy blocked tool usage${stopDetail ? ` - ${stopDetail}` : ""})`;
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
    !lastContent.startsWith("(Agent reached max") &&
    !lastContent.startsWith("(Paused:")
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
        signal: abortSignal,
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

  if (
    process.env.AGENT_VERIFY_PASS === "1" &&
    stopReason === "model_finished" &&
    typeof lastContent === "string" &&
    lastContent &&
    !lastContent.startsWith("(Agent stopped:") &&
    !lastContent.startsWith("(Agent reached max") &&
    !lastContent.startsWith("(Paused:")
  ) {
    try {
      const verifyMessages = [
        ...messages,
        {
          role: "user",
          content:
            "Verification pass: Review your last assistant reply (final user-visible answer). In one short paragraph, state whether each factual claim is supported by prior tool results or cited context; flag any unsupported or speculative claims. Do not call tools.",
        },
      ];
      const vT0 = Date.now();
      const vr = await backendFetch(url, {
        method: "POST",
        headers: config.headers,
        body: JSON.stringify({
          model: req.body?.model || model,
          messages: verifyMessages,
          stream: false,
        }),
        signal: abortSignal,
      });
      verifyMs += Date.now() - vT0;
      if (vr.ok) {
        const vd = await vr.json().catch(() => ({}));
        const verify = vd.choices?.[0]?.message?.content;
        if (typeof verify === "string" && verify.trim()) {
          lastContent = `${lastContent}\n\n---\n**Verification**\n${verify.trim()}`;
        }
      }
    } catch {
      /* optional verification pass */
    }
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

  if (sessionId) {
    await appendAgentSessionEvent(sessionId, { type: "run_end", runId, stopReason });
  }

  if (metricsEnabled()) {
    recordAgentPhaseMs("single", "llm", llmMsTotal);
    recordAgentPhaseMs("single", "tools", toolsMsTotal);
    if (reflectMs > 0) recordAgentPhaseMs("single", "reflect", reflectMs);
    if (verifyMs > 0) recordAgentPhaseMs("single", "verify", verifyMs);
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
    stopDetail,
    citationWarning: !cite.skipped && !cite.ok,
    constraints: {
      policy: effectivePolicy,
      usage: {
        categoryCounts: policyState.categoryCounts,
        externalFetches: policyState.externalFetches,
        totalToolMs: Math.round(policyState.totalToolMs),
      },
    },
    trajectory: trajectorySnapshot,
  };
  } catch (err) {
    rootSpan.recordException(err);
    rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: String(err?.message || err) });
    throw err;
  } finally {
    rootSpan.end();
  }
  } finally {
    releaseSessionConcurrency();
    releaseSessionAbortBinding();
  }
}

function hitlResumeErrorResponse(msg, stopReason) {
  const rid = randomUUID();
  return {
    content: msg,
    iteration: 0,
    toolCalls: [],
    runId: rid,
    stopReason,
    stopDetail: "",
    citationWarning: false,
    constraints: {
      policy: {},
      usage: { categoryCounts: { read: 0, write: 0, network: 0 }, externalFetches: 0, totalToolMs: 0 },
    },
    trajectory: { runId: rid, steps: [], stepCount: 0 },
  };
}

/**
 * Continue the agent loop after POST /v1/agent/resume-execute-step with approved: true.
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 * @param {object} config
 * @param {string} model
 * @param {{ presetRunId?: string; onProgress?: function }} streamOptions
 * @param {typeof fetch} backendFetch
 * @param {string} resumeToken
 */
export async function resumeAgentLoopFromHitlToken(req, res, config, model, streamOptions, backendFetch, resumeToken) {
  const token = String(resumeToken || "").trim();
  if (!token) {
    return hitlResumeErrorResponse("(Missing resumeToken.)", "hitl_resume_invalid");
  }
  const saved = takeHitlState(token);
  if (!saved) {
    return hitlResumeErrorResponse("(Invalid or expired resume token.)", "hitl_resume_invalid");
  }
  if (String(saved.userId || "") !== String(req.userId || "")) {
    return hitlResumeErrorResponse("(Resume token does not match your session.)", "hitl_resume_auth");
  }

  const workspace = saved.workspace || "default";
  const storageUserId2 = await resolveStorageUserId(req.userId || "anonymous", workspace);
  const wsSettings2 = await loadWorkspaceAgentSettings(storageUserId2, workspace);
  const workspaceAllowedTools2 =
    wsSettings2.allowedTools?.length > 0 ? new Set(wsSettings2.allowedTools) : null;
  const denied2 = new Set(
    (wsSettings2.agentPolicy?.deniedTools || []).map((x) => String(x).trim()).filter(Boolean)
  );
  const workspaceRoot2 = (process.env.WORKSPACE_ROOT || "").trim();
  const allowExec2 = saved.allowExecution === true;
  const toolCtx2 = {
    allowExecution: process.env.ALLOW_RECIPE_STEP_EXECUTION === "1" && allowExec2,
    projectDir: process.env.PROJECT_DIR || process.cwd(),
    vercelToken: process.env.VERCEL_TOKEN,
    workspace,
    workspaceUserId: storageUserId2,
    workspaceAllowedTools: workspaceAllowedTools2,
    workspaceDeniedTools: denied2,
    ...(workspaceRoot2 ? { workspaceFilesystemRoot: workspaceRoot2 } : {}),
  };

  const toolResultMaxChars2 = getAgentToolResultMaxChars();
  const toolHistoryMaxMsgs2 = getAgentToolHistoryMaxMessages();
  const toolHistoryMaxChars2 = getAgentToolHistoryMaxChars();

  let messages2 = JSON.parse(JSON.stringify(saved.messages));
  const toolCallsLog2 = JSON.parse(JSON.stringify(saved.toolCallsLog));
  let extraToolsMs = 0;
  const snap = saved.toolCallsSnapshot || [];
  const psResume = policyStateFromSnapshot(saved, denied2);

  for (const tc of snap) {
    const id = tc.id;
    if (Object.prototype.hasOwnProperty.call(saved.completedContentById || {}, id)) {
      messages2.push({ role: "tool", tool_call_id: id, content: saved.completedContentById[id] });
      continue;
    }
    const args = saved.hitlArgsById?.[id];
    if (!args || typeof args !== "object") {
      messages2.push({
        role: "tool",
        tool_call_id: id,
        content: JSON.stringify({ ok: false, error: "Missing saved arguments for execute_step resume." }),
      });
      continue;
    }
    const t0 = Date.now();
    const result = await runTool("execute_step", args, toolCtx2);
    const durationMs = Date.now() - t0;
    extraToolsMs += durationMs;
    let outContent = result.content;
    if (toolResultMaxChars2 > 0) {
      outContent = truncateToolResultContent(outContent, toolResultMaxChars2);
    }
    recordPolicyToolCompletion(psResume, "execute_step", durationMs);
    toolCallsLog2.push({
      name: "execute_step",
      args,
      iteration: saved.iteration,
      durationMs,
      ok: result.ok !== false,
    });
    messages2.push({ role: "tool", tool_call_id: id, content: outContent });
  }

  messages2 = applyToolMessageBudget(messages2, toolHistoryMaxMsgs2, toolHistoryMaxChars2);
  const newTotal = saved.totalToolCalls + snap.length;

  const innerReq = {
    ...req,
    body: {
      ...req.body,
      model: saved.bodyBaseModel || req.body?.model || model,
      messages: messages2,
      agentMode: true,
      agentOptions: {
        workspace,
        allowExecution: allowExec2,
        toolChoice: saved.baseToolChoice,
        requiredToolSequence: saved.requiredSeq,
        responseFormat: saved.responseFormat,
      },
      temperature: saved.temperature ?? req.body?.temperature,
      max_tokens: saved.max_tokens ?? req.body?.max_tokens,
      tool_choice: saved.baseToolChoice ?? req.body?.tool_choice ?? "auto",
    },
  };

  return runAgentLoop(innerReq, res, config, model, {
    ...streamOptions,
    presetRunId: saved.runId,
    resumeAfterHitl: true,
    hitlContinue: {
      iteration: saved.iteration,
      messages: messages2,
      totalToolCalls: newTotal,
      toolCallsLog: toolCallsLog2,
      llmMsTotal: saved.llmMsTotal,
      toolsMsTotal: saved.toolsMsTotal + extraToolsMs,
      stagnationRecoveryUsed: saved.stagnationRecoveryUsed,
      policySnapshot: {
        categoryCounts: { ...psResume.categoryCounts },
        externalFetches: psResume.externalFetches,
        totalToolMs: psResume.totalToolMs,
      },
      runStarted: saved.runStarted,
    },
  }, backendFetch);
}

function policyStateFromSnapshot(saved, deniedToolsSet) {
  const eff = JSON.parse(JSON.stringify(saved.effectivePolicy || {}));
  const denied =
    deniedToolsSet instanceof Set ? deniedToolsSet : new Set(Array.isArray(deniedToolsSet) ? deniedToolsSet : []);
  const ps = createPolicyState(eff, { deniedTools: denied });
  Object.assign(ps.categoryCounts, saved.policySnapshot.categoryCounts);
  ps.externalFetches = saved.policySnapshot.externalFetches;
  ps.totalToolMs = saved.policySnapshot.totalToolMs;
  return ps;
}
