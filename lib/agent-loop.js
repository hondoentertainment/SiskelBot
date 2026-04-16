// @ts-check
/**
 * Single-agent tool loop (extracted from server for testing and OTEL).
 * @module agent-loop
 */
import { randomUUID } from "crypto";
import { trace, SpanStatusCode } from "@opentelemetry/api";
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
  recordReflection,
  isEnabled as metricsEnabled,
} from "./metrics.js";
import { truncateToolResultContent, getAgentToolResultMaxChars } from "./agent-context-trim.js";
import { createToolStream } from "./tool-stream.js";
import { detectChain, buildChainPlan, executePlan } from "./tool-chaining.js";
import { getRequestId } from "./request-context.js";
import { globalToolDiscovery, classifyTaskType } from "./tool-discovery.js";
import { shouldReflect, reflectOnResponse, reviseResponse } from "./agent-reflection.js";
import { globalDecisionLog } from "./explainability.js";
import {
  recordReasoningStep,
  extractStepFromIteration,
} from "./reasoning-memory.js";
import { publishAgentRunEvent } from "./agent-run-stream.js";
import { getSessionIdForRunSync, getSessionIdForRun } from "./agent-session.js";
import { getModelCost } from "./smart-router.js";

const agentTracer = trace.getTracer("siskel-bot-agent", "1.0.0");

const MAX_AGENT_TOOL_CALLS_ENV = Number(process.env.MAX_AGENT_TOOL_CALLS) || 0;
const AGENT_MAX_WALL_MS_ENV = Number(process.env.AGENT_MAX_WALL_MS) || 0;

/**
 * Per-run cumulative cost accumulator. Keyed by runId. Cleaned up when the
 * agent loop emits a `done` event so memory does not grow without bound.
 * @type {Map<string, { totalUsd: number, prompt: number, completion: number, total: number }>}
 */
const runCostAccumulators = new Map();

/**
 * Add a chat-completion's usage tokens to the per-run accumulator and emit
 * a `cost.update` event on the session emitter. Designed to be called once
 * per chat-completion response. Best-effort: never throws.
 *
 * @param {{
 *   sessionId: string,
 *   runId: string,
 *   model: string,
 *   iteration?: number,
 *   usage?: { prompt_tokens?: number, completion_tokens?: number, total_tokens?: number } | null,
 * }} args
 */
function emitCostUpdate(args) {
  try {
    const sessionId = String(args?.sessionId || "").trim();
    const runId = String(args?.runId || "").trim();
    if (!sessionId || !runId) return;
    const usage = args.usage || {};
    const prompt = Math.max(0, Number(usage.prompt_tokens) || 0);
    const completion = Math.max(0, Number(usage.completion_tokens) || 0);
    const total =
      Math.max(0, Number(usage.total_tokens) || 0) || prompt + completion;

    const model = String(args.model || "");
    const costPer1k = Number(getModelCost(model)) || 0;
    const stepUsd = costPer1k > 0 ? (total / 1000) * costPer1k : 0;

    const acc =
      runCostAccumulators.get(runId) ||
      { totalUsd: 0, prompt: 0, completion: 0, total: 0 };
    acc.totalUsd += stepUsd;
    acc.prompt += prompt;
    acc.completion += completion;
    acc.total += total;
    runCostAccumulators.set(runId, acc);

    publishAgentRunEvent(sessionId, "cost.update", {
      totalUsd: acc.totalUsd,
      tokens: { prompt: acc.prompt, completion: acc.completion, total: acc.total },
      model,
      ...(args.iteration != null ? { iteration: args.iteration } : {}),
      runId,
    });
  } catch {
    /* live publishing is best-effort */
  }
}

/**
 * Drop the per-run cost accumulator. Called on `done` (and on error) so the
 * Map stays bounded by active run lifetime.
 *
 * @param {string} runId
 */
function disposeRunCostAccumulator(runId) {
  if (!runId) return;
  runCostAccumulators.delete(String(runId));
}

/** Test helper — exposed only for unit tests. */
export function __getRunCostAccumulatorForTests(runId) {
  return runCostAccumulators.get(String(runId)) || null;
}

/** Test helper — clears all accumulators. */
export function __resetRunCostAccumulatorsForTests() {
  runCostAccumulators.clear();
}

/**
 * Run the single-agent tool-call loop. The LLM calls tools, results feed back,
 * and the loop continues until the model produces a text response or limits are hit.
 *
 * @param {import("express").Request & { userId?: string; body?: any; authenticatedViaDeploymentKey?: boolean }} req
 * @param {import("express").Response} res
 * @param {{ baseUrl: string; path: string; headers: Record<string, string> }} config - buildProxyConfig result
 * @param {string} model - default model identifier
 * @param {{ presetRunId?: string; onProgress?: (event: SiskelBot.AgentProgressEvent) => void }} streamOptions
 * @param {typeof globalThis.fetch} backendFetch
 * @returns {Promise<SiskelBot.AgentLoopResult>}
 */
export async function runAgentLoop(req, res, config, model, streamOptions, backendFetch) {
  // Hoisted across the top-level try/catch/finally so the error boundary can
  // reference them even if a throw occurs mid-setup.
  /** @type {string} */
  let liveSessionId = "";
  /** @type {string} */
  let runId = "";
  /** @type {number} */
  let iteration = 0;

  try {
  const onProgress = streamOptions && typeof streamOptions.onProgress === "function" ? streamOptions.onProgress : null;
  const url = `${config.baseUrl}${config.path}`;
  const workspace = req.body?.agentOptions?.workspace || "default";
  let messages = Array.isArray(req.body?.messages) ? [...req.body.messages] : [];
  messages = augmentMessagesWithDefaultSystem(messages);
  const storageUserId = await resolveStorageUserId(req.userId || "anonymous", workspace);
  messages = await augmentMessagesWithWorkspaceAgent(messages, storageUserId, workspace);
  messages = augmentMessagesForGrounding(messages);
  const allowExecution = req.body?.agentOptions?.allowExecution === true;
  const agentOpts = req.body?.agentOptions || {};
  // Resolve liveSessionId from callers first; if only a runId is known, fall
  // back to the persisted reverse index (see lib/agent-session.js
  // getSessionIdForRun) so publishAgentRunEvent() can fire for SSE consumers.
  liveSessionId =
    (typeof agentOpts.sessionId === "string" && agentOpts.sessionId.trim()) ||
    (typeof streamOptions?.sessionId === "string" && streamOptions.sessionId.trim()) ||
    "";
  const maxAgentIterations = resolveAgentMaxIterations(agentOpts, process.env.MAX_AGENT_ITERATIONS);
  const setAgentHeader = (name, value) => {
    if (!res.headersSent) res.setHeader(name, value);
  };
  setAgentHeader("X-Agent-Max-Iterations", String(maxAgentIterations));
  const wsSettings = await loadWorkspaceAgentSettings(storageUserId, workspace);
  const workspaceAllowedTools =
    wsSettings.allowedTools?.length > 0 ? new Set(wsSettings.allowedTools) : null;

  /** @type {SiskelBot.AgentContext} */
  const toolCtx = {
    allowExecution:
      process.env.ALLOW_RECIPE_STEP_EXECUTION === "1" && allowExecution,
    projectDir: process.env.PROJECT_DIR || process.cwd(),
    vercelToken: process.env.VERCEL_TOKEN,
    workspace,
    workspaceUserId: storageUserId,
    workspaceAllowedTools,
  };

  runId = streamOptions?.presetRunId || randomUUID();
  setAgentHeader("X-Agent-Run-Id", runId);
  // Fallback: if the caller supplied only a runId (not a sessionId), resolve
  // a sessionId via the runId → sessionId reverse index so live SSE events
  // still publish. Prefer the synchronous mirror on the hot path; do an
  // async persisted lookup only when the mirror is cold.
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
  // Phase 32.4: conversationId used for reasoning memory. Fall back to runId
  // so reasoning is still grouped per run when no explicit conversation exists.
  const reasoningConversationId =
    (typeof req.body?.conversationId === "string" && req.body.conversationId) ||
    (typeof agentOpts.conversationId === "string" && agentOpts.conversationId) ||
    runId;
  let llmMsTotal = 0;
  let toolsMsTotal = 0;
  let reflectMs = 0;
  const requestId = getRequestId();
  const trajCollector = createTrajectoryCollector({
    runId,
    workspace,
    userId: req.userId || null,
    requestId,
  });
  trajCollector.record({ type: "start", model: req.body?.model || model, requestId });

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
  // Phase 32.3: derive a task type from the most recent user message so we
  // can attribute tool usage to task categories for future recommendations.
  const lastUserMsg = [...messages].reverse().find(
    (m) => m && m.role === "user" && typeof m.content === "string"
  );
  const discoveryTaskType = classifyTaskType(lastUserMsg?.content || "").type;
  const toolResultMaxChars = getAgentToolResultMaxChars();
  const toolStream = createToolStream(onProgress ? res : null);

  /** @type {Record<string, any>} */
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

  /** @type {string} */
  let lastContent = "";
  /** @type {SiskelBot.ToolCallLogEntry[]} */
  const toolCallsLog = [];
  /** @type {string} */
  let stopReason = "complete";

  while (iteration < maxAgentIterations) {
    iteration++;
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
    if (iteration > 1) {
      toolStream.emitAgentThinking(`Planning next step (iteration ${iteration})`);
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

    /** @type {any} */
    let data;
    const llmT0 = Date.now();
    await agentTracer.startActiveSpan(
      "agent.llm_round",
      {
        attributes: {
          "agent.run_id": runId,
          "agent.iteration": iteration,
        },
      },
      async (span) => {
        try {
          const response = await backendFetch(url, {
            method: "POST",
            headers: config.headers,
            body: JSON.stringify({ ...bodyBase, messages, tool_choice: toolChoiceThis }),
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

    const llmRoundMs = Date.now() - llmT0;
    llmMsTotal += llmRoundMs;
    // Emit a live cost.update event for SSE consumers (Agent Run hero footer).
    // Uses cumulative-per-run accounting so the footer can tick monotonically.
    if (liveSessionId) {
      emitCostUpdate({
        sessionId: liveSessionId,
        runId,
        model: bodyBase.model,
        iteration,
        usage: data?.usage || null,
      });
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
    const toolMetrics = [];

    // Parse all tool calls and run validation first
    const parsedCalls = toolCalls.map((tc) => {
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
      return { tc, name, args, parseError };
    });

    // Phase 32.5: record tool-selection decisions. The LLM has chosen a tool;
    // other tools in `tools` are the alternatives that were considered.
    try {
      const availableToolNames = Array.isArray(tools)
        ? tools
            .map((t) => t?.function?.name || t?.name)
            .filter((n) => typeof n === "string" && n.length > 0)
        : [];
      for (const pc of parsedCalls) {
        if (!pc?.name) continue;
        const alternatives = availableToolNames.filter((n) => n !== pc.name);
        globalDecisionLog.recordDecision({
          runId,
          turnIndex: iteration,
          decisionType: "tool_selection",
          chosen: pc.name,
          alternatives,
          reasoning:
            content && content.trim()
              ? content.trim().slice(0, 400)
              : `Model invoked ${pc.name} after iteration ${iteration}`,
          confidence: pc.parseError ? 0.35 : 0.8,
          factors: [
            { name: "llm_preference", weight: 0.6, value: pc.name },
            {
              name: "argument_validity",
              weight: 0.25,
              value: pc.parseError ? "invalid" : "valid",
            },
            { name: "tool_available", weight: 0.15, value: availableToolNames.length },
          ],
          workspaceId: workspace,
        });
      }
    } catch {
      /* explainability must never break the loop */
    }

    // Validation pass: collect early-exit results for invalid calls
    const validationResults = new Map();
    for (const pc of parsedCalls) {
      if (toolValidationEnabled()) {
        const v = validateToolCall(pc.name, pc.args, { parseError: pc.parseError });
        if (!v.valid) {
          toolCallsLog.push({ name: pc.name, args: pc.args, iteration, validationError: true, durationMs: 0, ok: false });
          toolMetrics.push({ name: pc.name, durationMs: 0, ok: false, validationError: true });
          trajCollector.record({ type: "tool_validation_error", name: pc.name, iteration, errors: v.errors });
          validationResults.set(pc.tc.id, {
            tool_call_id: pc.tc.id,
            content: JSON.stringify({
              _tool_validation_error: true,
              errors: v.errors,
              repairHint: v.repairHint,
              message: "Correct the tool call; the server did not execute invalid arguments.",
            }),
          });
        }
      }
    }

    // Build chain-aware execution for valid calls
    const validCalls = parsedCalls.filter((pc) => !validationResults.has(pc.tc.id));
    const callsForChain = validCalls.map((pc, i) => ({ name: pc.name, args: pc.args, _tcId: pc.tc.id, _idx: i }));

    // Detect chains and parallel groups among the valid calls
    const { chains: detectedChains, parallel: detectedParallel } = detectChain(
      callsForChain.map((c) => ({ name: c.name, args: c.args }))
    );

    // Wrapped runTool that integrates tracing, trajectory, truncation, and streaming
    const tracedRunTool = async (name, args, ctx) => {
      trajCollector.record({
        type: "tool_call",
        name,
        iteration,
        argsPreview: trajCollector.truncate(JSON.stringify(args), 240),
      });
      toolStream.emitToolStart(name, args);
      const execT0 = Date.now();
      try {
        const result = await agentTracer.startActiveSpan(
          "agent.tool.invoke",
          {
            attributes: {
              "agent.run_id": runId,
              "agent.iteration": iteration,
              "tool.name": String(name || ""),
            },
          },
          async (span) => {
            try {
              return await runTool(name, args, ctx);
            } catch (err) {
              span.recordException(err);
              span.setStatus({ code: SpanStatusCode.ERROR });
              throw err;
            }
          }
        );
        const durationMs = Date.now() - execT0;
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
        toolStream.emitToolResult(name, { ok: result.ok !== false, preview: outContent.slice(0, 200) }, durationMs);
        try {
          globalToolDiscovery.recordToolUsage(name, {
            taskType: discoveryTaskType,
            success: result.ok !== false,
            durationMs,
            resultSize: typeof outContent === "string" ? outContent.length : 0,
          });
        } catch { /* discovery is best-effort */ }
        return { content: outContent, ok: result.ok };
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
        toolStream.emitToolError(name, String(err?.message || err));
        try {
          globalToolDiscovery.recordToolUsage(name, {
            taskType: discoveryTaskType,
            success: false,
            durationMs,
          });
        } catch { /* discovery is best-effort */ }
        throw err;
      }
    };

    // Execute via chain plan (handles parallel + sequential chains)
    const plan = buildChainPlan(callsForChain.map((c) => ({ name: c.name, args: c.args })));
    const chainExecResults = await executePlan(plan, toolCtx, tracedRunTool);

    // Map execution results back to tool_call_ids
    const resultsByIdx = new Map();
    for (const r of chainExecResults) {
      const matchIdx = callsForChain.findIndex(
        (c) => c.name === r.name && !resultsByIdx.has(c._idx)
      );
      if (matchIdx >= 0) {
        resultsByIdx.set(callsForChain[matchIdx]._idx, {
          tool_call_id: callsForChain[matchIdx]._tcId,
          content: r.result,
        });
      }
    }

    // Assemble final results in original order
    const results = parsedCalls.map((pc) => {
      if (validationResults.has(pc.tc.id)) return validationResults.get(pc.tc.id);
      const ci = callsForChain.findIndex((c) => c._tcId === pc.tc.id);
      if (ci >= 0 && resultsByIdx.has(ci)) return resultsByIdx.get(ci);
      return {
        tool_call_id: pc.tc.id,
        content: JSON.stringify({ ok: false, error: "Tool was not executed" }),
      };
    });

    if (detectedChains.length > 0) {
      trajCollector.record({
        type: "tool_chain",
        iteration,
        chainCount: detectedChains.length,
        parallelCount: detectedParallel.length,
      });
    }

    const toolsWallMs = Date.now() - toolsWallT0;
    toolsMsTotal += toolsWallMs;
    onProgress?.({
      type: "agent_progress",
      iteration,
      llmMs: llmRoundMs,
      toolsWallMs,
      tools: toolMetrics,
      chainsDetected: detectedChains.length,
    });
    for (const r of results) {
      messages.push({
        role: "tool",
        tool_call_id: r.tool_call_id,
        content: r.content,
      });
    }

    // Phase 32.4: record a reasoning step for this iteration so the agent's
    // chain-of-thought across turns is auditable and recallable.
    try {
      const stepPayload = extractStepFromIteration({
        turnIndex: iteration,
        toolCalls: parsedCalls.map((pc) => ({ name: pc.name, args: pc.args })),
        toolResults: results,
        modelContent: content,
      });
      if (stepPayload) {
        await recordReasoningStep(reasoningConversationId, {
          ...stepPayload,
          workspaceId: workspace,
        });
      }
    } catch {
      // reasoning memory is best-effort; never fail the agent loop.
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
        if (liveSessionId) {
          emitCostUpdate({
            sessionId: liveSessionId,
            runId,
            model: bodyBase.model,
            iteration,
            usage: rd?.usage || null,
          });
        }
        const reflect = rd.choices?.[0]?.message?.content;
        if (typeof reflect === "string" && reflect.trim()) {
          lastContent = `${lastContent}\n\n---\n**Reflection**\n${reflect.trim()}`;
        }
      }
    } catch {
      /* optional reflect pass */
    }
    // Phase 32.5: record reflection decision
    try {
      globalDecisionLog.recordDecision({
        runId,
        turnIndex: iteration,
        decisionType: "reflection",
        chosen: "plan_reflect",
        alternatives: ["skip_reflection"],
        reasoning: "AGENT_PLAN_REFLECT=1; appended summary after model_finished",
        confidence: 0.7,
        factors: [
          { name: "env_flag", weight: 0.6, value: "AGENT_PLAN_REFLECT" },
          { name: "stop_reason", weight: 0.4, value: stopReason },
        ],
        workspaceId: workspace,
      });
    } catch {
      /* never fail on explainability */
    }
  }

  // Phase 32.1: self-critique pass. Skippable, never blocks the agent flow.
  if (
    stopReason === "model_finished" &&
    typeof lastContent === "string" &&
    lastContent &&
    !lastContent.startsWith("(Agent stopped:") &&
    !lastContent.startsWith("(Agent reached max") &&
    shouldReflect(messages, { agentMode: true, response: lastContent })
  ) {
    try {
      const reflectCfg = {
        baseUrl: config.baseUrl,
        path: config.path,
        headers: config.headers,
      };
      const modelId = req.body?.model || model;
      const verdict = await reflectOnResponse(
        lastContent,
        { messages },
        backendFetch,
        reflectCfg,
        modelId
      );
      reflectMs += Number(verdict.reflectionDurationMs) || 0;
      trajCollector.record({
        type: "reflection",
        needsRevision: verdict.needsRevision,
        issues: Array.isArray(verdict.issues) ? verdict.issues.slice(0, 5) : [],
        durationMs: verdict.reflectionDurationMs,
        ...(verdict.error ? { error: verdict.error } : {}),
      });
      setAgentHeader("X-Agent-Reflection", verdict.needsRevision ? "revised" : "ok");
      if (metricsEnabled()) {
        recordReflection(verdict.needsRevision, verdict.reflectionDurationMs || 0);
      }
      if (verdict.needsRevision && !verdict.error) {
        const reviseT0 = Date.now();
        const revision = await reviseResponse(
          lastContent,
          verdict,
          { messages },
          backendFetch,
          reflectCfg,
          modelId
        );
        reflectMs += Date.now() - reviseT0;
        if (revision.revised && revision.revised !== lastContent && !revision.error) {
          trajCollector.record({
            type: "reflection_revision",
            improvementSummary: revision.improvementSummary || "",
          });
          lastContent = revision.revised;
        }
      }
    } catch (err) {
      trajCollector.record({
        type: "reflection_error",
        message: String(err?.message || err),
      });
    }
  }

  const cite = checkCitationCoverage(lastContent, messages);
  if (!cite.skipped && !cite.ok) {
    setAgentHeader("X-Agent-Citations-Missing", "1");
  }

  trajCollector.record({ type: "stop", reason: stopReason, iterations: iteration });

  // Phase 32.5: record termination decision
  try {
    const terminationReasons = {
      model_finished: "LLM returned final text without further tool calls",
      max_iterations: "Hit iteration budget before converging",
      tool_budget: "Hit configured tool call budget",
      wall_clock: "Hit wall-clock timeout",
      stagnation: "Detected repeated tool calls with no progress",
      no_message: "Backend returned no message in response",
      complete: "Run completed",
    };
    const altReasons = Object.keys(terminationReasons).filter((r) => r !== stopReason);
    globalDecisionLog.recordDecision({
      runId,
      turnIndex: iteration,
      decisionType: "termination",
      chosen: stopReason,
      alternatives: altReasons,
      reasoning: terminationReasons[stopReason] || `Stopped: ${stopReason}`,
      confidence: stopReason === "model_finished" ? 0.95 : 0.7,
      factors: [
        { name: "iterations_used", weight: 0.5, value: iteration },
        { name: "max_iterations", weight: 0.3, value: maxAgentIterations },
        { name: "total_tool_calls", weight: 0.2, value: totalToolCalls },
      ],
      workspaceId: workspace,
    });
  } catch {
    /* explainability must never break the loop */
  }

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

  if (liveSessionId) {
    try {
      publishAgentRunEvent(liveSessionId, "done", { reason: stopReason });
    } catch { /* live publishing is best-effort */ }
  }
  // Drop the per-run cost accumulator now that the run is terminal so the
  // map stays bounded by the lifetime of in-flight runs only.
  disposeRunCostAccumulator(runId);

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
    // Top-level error boundary: surface the failure to live SSE subscribers
    // (so the Agent Run UI can render an error state) and ensure the per-run
    // cost accumulator is cleaned up via `finally`. Never let publish failures
    // mask the original error — rethrow unchanged.
    if (liveSessionId) {
      try {
        /** @type {{ message: string, code?: string, runId?: string, iteration?: number }} */
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
    throw err;
  } finally {
    if (runId) {
      try { disposeRunCostAccumulator(runId); } catch { /* best-effort */ }
    }
  }
}
