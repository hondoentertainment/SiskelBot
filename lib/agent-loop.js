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
  recordToolFailure,
  recordToolOutcome,
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
import {
  runUpfrontPlanHook,
  runMidLoopCritiqueHook,
  runSemanticTrimHook,
  runFailureMemoryHook,
} from "./agent-loop-hooks.js";
import { getModelCost } from "./smart-router.js";
import { resolveEffectiveMaxTransientRetries } from "./agent-tool-retry.js";
import { takeHitlState } from "./agent-hitl-store.js";
import {
  appendAgentSessionEvent,
  assertAgentSessionForRun,
  linkRunToAgentSession,
  agentSessionApiEnabled,
  getSessionIdForRunSync,
  getSessionIdForRun,
} from "./agent-session.js";
import {
  bindSessionAbortController,
  tryBeginWorkspaceAgentRun,
  endWorkspaceAgentRun,
} from "./agent-run-control.js";
import { createTracker, analyzeAndBuildReplan } from "./agent-tool-failure-analyzer.js";
import { recommendAlternatives, recommenderEnabled } from "./tool-alternative-recommender.js";
import { recordRunFailures, isChronicallyBroken } from "./agent-failure-store.js";
import { recordToolOutcomes, buildReliabilityHint } from "./agent-genealogy.js";
import { publishAgentRunEvent } from "./agent-run-stream.js";
import { parseCompletionStream } from "./agent-stream-parser.js";
import {
  emitCostUpdate,
  disposeRunCostAccumulator,
  __getAccumulatorForTests as __getRunCostAccumulatorForTests,
  __resetAccumulatorsForTests as __resetRunCostAccumulatorsForTests,
} from "./agent-cost-emitter.js";
import { flushRunBilling } from "./agent-run-billing.js";

export { __getRunCostAccumulatorForTests, __resetRunCostAccumulatorsForTests };

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
    if (process.env.AGENT_GENEALOGY_HINT !== "0") {
      try {
        const lastUser = [...messages].reverse().find((m) => m?.role === "user");
        const taskText = typeof lastUser?.content === "string" ? lastUser.content : "";
        const hint = await buildReliabilityHint(workspace, { taskText });
        if (hint) messages.push({ role: "system", content: hint });
      } catch { /* genealogy hint is best-effort */ }
    }
  }
  const allowExecution = req.body?.agentOptions?.allowExecution === true;
  const agentOpts = req.body?.agentOptions || {};
  const budget = agentOpts.budget || null;
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
    ...(sessionId ? { agentSessionId: sessionId } : {}),
  };

  const runId = streamOptions?.presetRunId || randomUUID();
  setAgentHeader("X-Agent-Run-Id", runId);

  let liveSessionId =
    sessionId ||
    (typeof streamOptions?.sessionId === "string" && streamOptions.sessionId.trim()) ||
    "";
  let iteration = 0;

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
  if (!liveSessionId && runId) {
    const fromMemory = getSessionIdForRunSync(runId);
    if (fromMemory) {
      liveSessionId = fromMemory;
    } else {
      try {
        const resolved = await getSessionIdForRun(runId);
        if (resolved) liveSessionId = resolved;
      } catch { /* resolution is best-effort */ }
    }
  }
  try {
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
    : getToolsSchema({ workspace });
  tools = filterToolsByWorkspaceAllowlist(tools, wsSettings.allowedTools, { workspace });
  if (!sessionId) {
    tools = tools.filter((t) => t?.function?.name !== "update_agent_session_plan");
  }
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
    stream: true,
    stream_options: { include_usage: true },
    ...(req.body?.temperature != null && { temperature: req.body.temperature }),
    ...(req.body?.max_tokens != null && { max_tokens: req.body.max_tokens }),
  };
  if (agentOpts.responseFormat && typeof agentOpts.responseFormat === "object") {
    bodyBase.response_format = agentOpts.responseFormat;
  }

  let lastContent = "";
  iteration = hc ? hc.iteration : 0;
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
  const replanEnabled = process.env.AGENT_REPLAN_ON_FAILURE !== "0";
  const AGENT_MAX_REPLANS = Number(process.env.AGENT_MAX_REPLANS) || 3;
  let replanCount = 0;
  const replanFailedTools = [];
  const failureTracker = createTracker();
  const runFailures = [];
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

  if (!resumeAfterHitl && !hc) {
    const lastUserForPlan = [...messages].reverse().find((m) => m?.role === "user");
    const userMessageForPlan =
      typeof lastUserForPlan?.content === "string" ? lastUserForPlan.content : "";
    await runUpfrontPlanHook({
      messages,
      userMessage: userMessageForPlan,
      backendFetch,
      url,
      model: bodyBase.model,
      headers: config.headers,
      trajCollector,
      agentSessionId: sessionId,
      storageUserId,
      workspace,
    });
  }

  const lastUserGoalMsg = [...messages].reverse().find((m) => m?.role === "user");
  const userGoal =
    typeof lastUserGoalMsg?.content === "string" ? lastUserGoalMsg.content : "";

  while (!skipAgentWhile && iteration < maxAgentIterations) {
    iteration++;
    if (budget) {
      budget.recordIteration();
      const budgetResult = budget.check();
      if (budgetResult.exceeded) {
        lastContent = `(Agent stopped: subagent budget exceeded — ${budgetResult.reason})`;
        stopReason = "budget_exceeded";
        setAgentHeader("X-Agent-Truncated", "budget_exceeded");
        break;
      }
    }
    setAgentHeader("X-Agent-Iteration", String(iteration));
    trajCollector.record({ type: "iteration", iteration });

    if (liveSessionId) {
      try {
        publishAgentRunEvent(liveSessionId, "status.change", {
          status: "running",
          iteration,
        });
      } catch { /* live publishing is best-effort */ }
    }

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
      await otelContext.with(trace.setSpan(otelContext.active(), llmSpan), async () => {
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
          async (roundSpan) => {
            try {
              const response = await backendFetch(url, {
                method: "POST",
                headers: config.headers,
                body: JSON.stringify({ ...bodyBase, messages, tool_choice: toolChoiceThis }),
                signal: abortSignal,
              });

              if (!response.ok) {
                const err = await response.text();
                roundSpan.setStatus({ code: SpanStatusCode.ERROR, message: String(response.status) });
                throw new Error(`Backend error: ${response.status} ${err?.slice(0, 200) || ""}`);
              }

              const ct = typeof response.headers?.get === "function"
                ? (response.headers.get("content-type") || "")
                : "";
              if (!ct.includes("text/event-stream")) {
                data = await response.json().catch(() => ({}));
              } else {
                let streamContent = "";
                let streamToolCalls = [];
                let streamUsage = null;

                for await (const chunk of parseCompletionStream(response)) {
                  if (chunk.type === "delta") {
                    streamContent += chunk.content;
                    if (liveSessionId) {
                      publishAgentRunEvent(liveSessionId, "token", { delta: chunk.content, iteration });
                    }
                  } else if (chunk.type === "tool_call_delta") {
                    if (!streamToolCalls[chunk.index]) {
                      streamToolCalls[chunk.index] = {
                        id: chunk.id || "",
                        type: "function",
                        function: { name: chunk.name || "", arguments: "" },
                      };
                    }
                    if (chunk.name) streamToolCalls[chunk.index].function.name = chunk.name;
                    streamToolCalls[chunk.index].function.arguments += chunk.arguments_delta;
                    if (chunk.id) streamToolCalls[chunk.index].id = chunk.id;
                  } else if (chunk.type === "usage") {
                    streamUsage = chunk;
                  }
                }

                const compactToolCalls = streamToolCalls.filter(Boolean);
                data = {
                  choices: [{
                    message: {
                      role: "assistant",
                      content: streamContent || null,
                      ...(compactToolCalls.length ? { tool_calls: compactToolCalls } : {}),
                    },
                    finish_reason: compactToolCalls.length ? "tool_calls" : "stop",
                  }],
                  usage: streamUsage
                    ? {
                        prompt_tokens: streamUsage.prompt_tokens,
                        completion_tokens: streamUsage.completion_tokens,
                        total_tokens: streamUsage.total_tokens,
                      }
                    : { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
                  model: bodyBase.model,
                };
              }
            } catch (e) {
              roundSpan.recordException(e);
              roundSpan.setStatus({ code: SpanStatusCode.ERROR });
              throw e;
            }
          }
        );
      });
    } catch (e) {
      llmSpan.recordException(e);
      llmSpan.setStatus({ code: SpanStatusCode.ERROR });
      if (abortSignal?.aborted || e?.name === "AbortError") {
        lastContent = "(Agent run cancelled.)";
        stopReason = "cancelled";
        setAgentHeader("X-Agent-Stopped", "cancelled");
        break;
      }
      throw e;
    } finally {
      llmSpan.setAttribute("llm.duration_ms", Date.now() - llmT0);
      llmSpan.end();
    }

    const llmRoundMs = Date.now() - llmT0;
    llmMsTotal += llmRoundMs;
    let stepUsd = 0;
    if (liveSessionId) {
      stepUsd = emitCostUpdate({
        sessionId: liveSessionId,
        runId,
        model: bodyBase.model,
        iteration,
        usage: data?.usage || null,
      }) || 0;
    } else if (budget) {
      const usage = data?.usage || {};
      const totalTok =
        Math.max(0, Number(usage.total_tokens) || 0) ||
        (Math.max(0, Number(usage.prompt_tokens) || 0) +
          Math.max(0, Number(usage.completion_tokens) || 0));
      const costPer1k = Number(getModelCost(bodyBase.model)) || 0;
      stepUsd = costPer1k > 0 ? (totalTok / 1000) * costPer1k : 0;
    }
    if (budget && stepUsd > 0) {
      budget.recordCostUsd(stepUsd);
    }
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
    const setStopPolicy = (check) => {
      stopReason = "policy_blocked";
      stopDetail = check.reason;
      setAgentHeader("X-Agent-Stopped", "policy_blocked");
      setAgentHeader("X-Agent-Policy-Code", check.code);
    };
    const {
      results,
      hitlPause,
      toolMetrics,
      hadToolExecutionFailure,
      toolTimeoutCount: batchToolTimeouts,
    } = await executeAgentToolBatch({
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
      sessionId: sessionId || undefined,
      userIntent: userGoal,
      backendFetch,
      buildProxyConfig: (m) => ({
        baseUrl: config.baseUrl,
        path: config.path,
        headers: config.headers,
        model: m || bodyBase.model,
      }),
      currentModel: bodyBase.model,
      maxToolExtraRetries: resolveEffectiveMaxTransientRetries(wsSettings.agentPolicy),
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
    toolTimeoutCount += batchToolTimeouts || 0;
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

    const parsedCalls = toolCalls.map((tc) => {
      const name = tc.function?.name;
      let args = {};
      try {
        args = JSON.parse(tc.function?.arguments || "{}");
      } catch { /* ignore */ }
      return { tc, name, args };
    });

    if (replanEnabled) {
      for (const r of results) {
        let parsed;
        try { parsed = JSON.parse(r.content); } catch { continue; }
        if (!parsed || typeof parsed !== "object") continue;
        const isFail = parsed.ok === false || parsed._tool_validation_error === true;
        if (!isFail) continue;
        const failedCall = parsedCalls.find((pc) => pc.tc.id === r.tool_call_id);
        const toolName = failedCall?.name || "unknown";
        const toolArgs = failedCall?.args;

        replanCount++;
        if (!replanFailedTools.includes(toolName)) replanFailedTools.push(toolName);

        if (replanCount <= AGENT_MAX_REPLANS) {
          let alternatives = [];
          if (recommenderEnabled()) {
            try {
              const lastUser = [...messages].reverse().find((m) => m?.role === "user");
              const taskText = typeof lastUser?.content === "string" ? lastUser.content : "";
              const availableToolNames = tools
                .map((t) => t?.function?.name)
                .filter((n) => typeof n === "string" && n.length > 0);
              const recs = await recommendAlternatives({
                workspace,
                failedToolName: toolName,
                taskText,
                availableTools: availableToolNames,
              });
              alternatives = recs.map((rec) => rec.tool);
            } catch { /* recommender is best-effort */ }
          }

          const { classified, history, message } = analyzeAndBuildReplan({
            toolName,
            parsed,
            args: toolArgs,
            tracker: failureTracker,
            attempt: replanCount,
            maxAttempts: AGENT_MAX_REPLANS,
            alternatives,
          });
          runFailures.push({ tool: toolName, category: classified.category });
          try { recordToolFailure(toolName, classified.category); } catch { /* metrics best-effort */ }
          let finalMessage = message;
          try {
            const chronic = await isChronicallyBroken(workspace, toolName);
            if (chronic.chronic) {
              finalMessage = `${message} Prior runs in this workspace have seen ${chronic.terminalCount} terminal '${chronic.dominantCategory}' failures from '${toolName}'; strongly prefer a different tool.`;
            }
          } catch { /* chronic lookup is best-effort */ }
          messages.push({ role: "system", content: finalMessage });
        } else {
          lastContent = "(Agent stopped: re-plan attempts exhausted after repeated tool failures)";
          stopReason = "replan_exhausted";
          setAgentHeader("X-Agent-Stopped", "replan_exhausted");
          runFailureMemoryHook({
            userId: storageUserId,
            workspaceId: workspace,
            kind: "replan_exhausted",
            userGoal,
            details: replanFailedTools.join(", "),
          });
          break;
        }
      }
      if (stopReason === "replan_exhausted") break;
    }

    if (
      sessionId &&
      hadToolExecutionFailure &&
      process.env.AGENT_SESSION_REPLAN_NUDGE === "1"
    ) {
      messages.push({
        role: "user",
        content:
          "Some tools returned ok:false or an error. Reassess the situation: you may call update_agent_session_plan to revise planDag/planSummary, adjust tool arguments, or try different tools.",
      });
    }

    messages = applyToolMessageBudget(messages, toolHistoryMaxMsgs, toolHistoryMaxChars);

    const { trimmedMessages } = runSemanticTrimHook({ messages, userGoal, trajCollector });
    messages = trimmedMessages;

    await runMidLoopCritiqueHook({
      iteration,
      currentStagnation:
        stagnationDetectionEnabled() && detectStagnation(toolCallsLog) ? { stagnant: true } : {},
      messages,
      userGoal,
      backendFetch,
      url,
      model: bodyBase.model,
      headers: config.headers,
      trajCollector,
      storageUserId,
      workspace,
    });

    totalToolCalls += toolCalls.length;
    if (budget) {
      for (let _tc = 0; _tc < toolCalls.length; _tc++) {
        budget.recordToolCall();
      }
    }
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
      runFailureMemoryHook({
        userId: storageUserId,
        workspaceId: workspace,
        kind: "stagnation",
        userGoal,
      });
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

  if (runFailures.length > 0 && process.env.AGENT_PERSIST_FAILURES !== "0") {
    try {
      await recordRunFailures(workspace, runFailures);
    } catch { /* failure store is best-effort */ }
  }

  if (toolCallsLog.length > 0 && process.env.AGENT_PERSIST_OUTCOMES !== "0") {
    try {
      const outcomes = toolCallsLog
        .filter((t) => typeof t?.name === "string" && t.name.length > 0)
        .map((t) => ({ tool: t.name, ok: t.ok === true }));
      if (outcomes.length > 0) {
        await recordToolOutcomes(workspace, outcomes);
        for (const o of outcomes) {
          try { recordToolOutcome(o.tool, o.ok); } catch { /* metrics best-effort */ }
        }
      }
    } catch { /* genealogy store is best-effort */ }
  }

  if (liveSessionId) {
    try {
      const donePayload = { reason: stopReason };
      if (budget && stopReason === "budget_exceeded") {
        donePayload.budgetSummary = budget.summary();
      }
      publishAgentRunEvent(liveSessionId, "done", donePayload);
    } catch { /* live publishing is best-effort */ }
  }
  await flushRunBilling({ runId, workspace, model: bodyBase.model });

  return {
    content: lastContent,
    iteration,
    toolCalls: toolCallsLog,
    runId,
    stopReason,
    stopDetail,
    ...(budget && stopReason === "budget_exceeded" ? { budgetSummary: budget.summary() } : {}),
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
  } catch (err) {
    if (liveSessionId) {
      try {
        const payload = {
          message: String(err?.message || err),
          ...(err?.code != null ? { code: err.code } : {}),
          ...(runId ? { runId } : {}),
          ...(iteration > 0 ? { iteration } : {}),
        };
        publishAgentRunEvent(liveSessionId, "error", payload);
        publishAgentRunEvent(liveSessionId, "done", { reason: "error" });
      } catch { /* never let publish fail the loop */ }
    }
    try {
      await flushRunBilling({ runId, workspace, model: req.body?.model || model });
    } catch { /* billing flush is best-effort */ }
    throw err;
  } finally {
    releaseSessionConcurrency();
    releaseSessionAbortBinding();
    if (runId) {
      try { disposeRunCostAccumulator(runId); } catch { /* best-effort */ }
    }
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
