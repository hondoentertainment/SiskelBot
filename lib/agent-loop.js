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
import { computeFingerprint, buildStagnationHistory, stagnationDetectionEnabled, stagnationRecoveryEnabled } from "./agent-stagnation.js";
import { runUpfrontPlanHook, runMidLoopCritiqueHook, runSemanticTrimHook, runFailureMemoryHook } from "./agent-loop-hooks.js";
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
import { executeAgentToolBatch } from "./agent-loop-execute-tools.js";
import { createPolicyState, resolveEffectivePolicy } from "./agent-policy.js";
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
import { parseCompletionStream } from "./agent-stream-parser.js";
import { saveCheckpoint, loadCheckpoint } from "./agent-checkpoint.js";
import { createTracker, analyzeAndBuildReplan } from "./agent-tool-failure-analyzer.js";
import { recordRunFailures, isChronicallyBroken } from "./agent-failure-store.js";
import { recordToolOutcomes, buildReliabilityHint } from "./agent-genealogy.js";
import { getActivePatchContent } from "./agent-prompt-tuner.js";
import { recordToolFailure, recordToolOutcome, recordLlmUsage } from "./metrics.js";
import { judgeToolResult, toolResultJudgeEnabled, shouldSkipJudge } from "./tool-result-judge.js";
import { scrubContent, contentScrubEnabled } from "./content-scrubber.js";

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
  /** @type {number} */
  let stepUsd = 0;
  try {
    const sessionId = String(args?.sessionId || "").trim();
    const runId = String(args?.runId || "").trim();
    if (!sessionId || !runId) return stepUsd;
    const usage = args.usage || {};
    const prompt = Math.max(0, Number(usage.prompt_tokens) || 0);
    const completion = Math.max(0, Number(usage.completion_tokens) || 0);
    const total =
      Math.max(0, Number(usage.total_tokens) || 0) || prompt + completion;

    const model = String(args.model || "");
    const costPer1k = Number(getModelCost(model)) || 0;
    stepUsd = costPer1k > 0 ? (total / 1000) * costPer1k : 0;

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
  return stepUsd;
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
  // Cross-run reliability hint: inject a compact summary of tools that have
  // historically succeeded/failed in this workspace so the LLM can bias its
  // tool selection. Silently skipped when there's not enough signal.
  if (process.env.AGENT_GENEALOGY_HINT !== "0") {
    try {
      // Pull the most recent user-turn text so the hint can prefer tools
      // whose names match what the user is actually asking for.
      const lastUser = [...messages].reverse().find((m) => m?.role === "user");
      const taskText = typeof lastUser?.content === "string" ? lastUser.content : "";
      const hint = await buildReliabilityHint(workspace, { taskText });
      if (hint) messages.push({ role: "system", content: hint });
    } catch { /* genealogy hint is best-effort */ }
  }

  // Persisted tuned-prompt patch (offline-synthesized from failure +
  // genealogy + conflict data, admin-reviewed + applied). Gated by the
  // AGENT_PROMPT_PATCH env var (default enabled) and by the patch status
  // being "applied" in the store.
  if (process.env.AGENT_PROMPT_PATCH !== "0") {
    try {
      const patchContent = await getActivePatchContent(workspace);
      if (patchContent) messages.push({ role: "system", content: patchContent });
    } catch { /* prompt patch is best-effort */ }
  }
  const allowExecution = req.body?.agentOptions?.allowExecution === true;
  const agentOpts = req.body?.agentOptions || {};
  // Optional subagent budget handle (see lib/subagent-budget.js). When present
  // the loop checks budget.check() every iteration and terminates cleanly on
  // any exceeded dimension (cost, time, iterations, tool calls).
  const budget = agentOpts.budget || null;
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
  if (liveSessionId) {
    toolCtx.agentSessionId = liveSessionId;
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
  const effectivePolicy = resolveEffectivePolicy(wsSettings.agentPolicy || {});
  const policyState = createPolicyState(effectivePolicy, {
    deniedTools: wsSettings.agentPolicy?.deniedTools || [],
  });
  const setStopPolicy = (policyCheck) => {
    if (policyCheck) {
      trajCollector.record({
        type: "tool_policy_blocked",
        iteration,
        code: policyCheck.code,
        reason: policyCheck.reason,
      });
    }
  };

  // liveSessionId already resolved above (line ~173); streaming agent's
  // duplicate resolved during wave-8 merge.

  /** @type {Record<string, any>} */
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

  /** @type {string} */
  let lastContent = "";
  /** @type {SiskelBot.ToolCallLogEntry[]} */
  const toolCallsLog = [];
  const stagnationTracker = buildStagnationHistory();
  /** @type {string} */
  let stopReason = "complete";

  // Re-plan on permanent tool failure: counter and config
  const replanEnabled = process.env.AGENT_REPLAN_ON_FAILURE !== "0";
  const AGENT_MAX_REPLANS = Number(process.env.AGENT_MAX_REPLANS) || 3;
  let replanCount = 0;
  /** @type {string[]} */
  const replanFailedTools = [];
  const failureTracker = createTracker();
  /** @type {Array<{ tool: string; category: string }>} */
  const runFailures = [];

  // Resume from checkpoint when agentOpts.resume is set
  if (agentOpts.resume && liveSessionId) {
    try {
      const ckpt = await loadCheckpoint(liveSessionId);
      if (ckpt && Array.isArray(ckpt.messages) && ckpt.messages.length > 0) {
        messages = ckpt.messages;
        iteration = typeof ckpt.iteration === "number" ? ckpt.iteration : 0;
        if (liveSessionId) {
          try {
            publishAgentRunEvent(liveSessionId, "status.change", {
              status: "resumed",
              fromIteration: iteration,
            });
          } catch { /* live publishing is best-effort */ }
        }
      }
    } catch { /* checkpoint restore is best-effort; start fresh on failure */ }
  }

  // Upfront planning (AGENT_UPFRONT_PLAN=1): best-effort DAG before tools fire.
  /** @type {object | null} */
  let upfrontPlanDagForCheckpoint = null;
  const upfrontPlanResult = await runUpfrontPlanHook({
    messages,
    userMessage: typeof lastUserMsg?.content === "string" ? lastUserMsg.content : "",
    backendFetch,
    url,
    model: req.body?.model || model,
    headers: config.headers,
    trajCollector,
    agentSessionId: liveSessionId || "",
    storageUserId,
    workspace,
  });
  if (upfrontPlanResult?.planDag && typeof upfrontPlanResult.planDag === "object") {
    upfrontPlanDagForCheckpoint = upfrontPlanResult.planDag;
  }

  const userGoalForLoop = typeof lastUserMsg?.content === "string" ? lastUserMsg.content : "";

  while (iteration < maxAgentIterations) {
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

          // FALLBACK: if the backend does not return an SSE stream (e.g. it
          // ignores stream:true or returns application/json), fall back to the
          // non-streaming JSON path so the loop still works.
          const ct = typeof response.headers?.get === "function"
            ? (response.headers.get("content-type") || "")
            : "";
          if (!ct.includes("text/event-stream")) {
            data = await response.json().catch(() => ({}));
          } else {
            // Streaming path: parse SSE chunks incrementally.
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
              // "done" chunk just terminates the for-await loop naturally.
            }

            // Compact sparse array (some indices may be empty if backend skips)
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
                ? { prompt_tokens: streamUsage.prompt_tokens, completion_tokens: streamUsage.completion_tokens, total_tokens: streamUsage.total_tokens }
                : { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
              model: bodyBase.model,
            };
          }
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
    // emitCostUpdate returns the step USD so the budget handle can track spend.
    let stepUsd = 0;
    if (liveSessionId) {
      stepUsd = emitCostUpdate({
        sessionId: liveSessionId,
        runId,
        model: bodyBase.model,
        iteration,
        usage: data?.usage || null,
      });
    } else if (budget) {
      // Compute stepUsd even without a live session so the budget tracks cost.
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
    // Record per-workspace LLM usage for Prometheus (siskelbot_llm_tokens_total
    // and siskelbot_llm_cost_usd_total). Best-effort; never throws.
    try {
      const usage = data?.usage || {};
      recordLlmUsage({
        workspaceId: workspace,
        model: bodyBase.model,
        inputTokens: Number(usage.prompt_tokens) || 0,
        outputTokens: Number(usage.completion_tokens) || 0,
      });
    } catch {
      /* metrics are best-effort */
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

    /** @type {Array<{ tool_call_id: string; content: string }>} */
    let results;

    if (detectedChains.length === 0) {
      const batch = await executeAgentToolBatch({
        toolCalls,
        iteration,
        runId,
        toolCtx,
        policyState,
        toolCallsLog,
        trajCollector,
        traceRequestId: requestId,
        setStopPolicy,
        agentOpts,
        hitlContext: {
          userId: req.userId || null,
          runId,
          workspace,
          storageUserId,
          allowExecution: toolCtx.allowExecution,
          messages,
          iteration,
          maxAgentIterations,
          runStarted,
          totalToolCalls,
          toolCallsLog,
          policySnapshot: {
            categoryCounts: { ...policyState.categoryCounts },
            externalFetches: policyState.externalFetches,
            totalToolMs: policyState.totalToolMs,
          },
          effectivePolicy,
          stagnationRecoveryUsed: false,
          llmMsTotal,
          toolsMsTotal,
          bodyBaseModel: bodyBase.model,
          tools,
          requiredSeq,
          baseToolChoice,
          responseFormat: bodyBase.response_format,
          workspaceAllowedToolsList: Array.from(workspaceAllowedTools || []),
          traceRequestId: requestId,
        },
        sessionId: liveSessionId,
        backendFetch,
        buildProxyConfig: () => config,
        currentTools: tools,
        currentModel: bodyBase.model,
        depth: agentOpts.depth,
        userIntent: userGoalForLoop,
      });
      if (Array.isArray(batch.toolMetrics)) toolMetrics.push(...batch.toolMetrics);
      if (batch.hitlPause) {
        stopReason = "hitl_pending";
        lastContent = "(Agent paused: execute_step is waiting for human approval)";
        setAgentHeader("X-Agent-Pending-Execute-Step", "1");
        onProgress?.({
          type: "agent_pending_execution",
          resumeToken: batch.hitlPause.token,
          pendingSteps: batch.hitlPause.pendingSteps,
          iteration,
        });
        if (liveSessionId) {
          try {
            publishAgentRunEvent(liveSessionId, "status.change", {
              status: "waiting_for_approval",
              iteration,
              runId,
            });
          } catch { /* live publishing is best-effort */ }
        }
        break;
      }
      results = batch.results;
    } else {
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

        // Content scrub: redact secrets / PII / prompt-injection markers from
        // tool output BEFORE the LLM sees it. Best-effort; never fail the loop.
        // Skip PII scrubbing for workspace_git_* tools (commit-author emails
        // would be over-redacted).
        if (contentScrubEnabled() && typeof outContent === "string") {
          try {
            const isGitTool = typeof name === "string" && name.startsWith("workspace_git");
            const scrubbed = scrubContent(outContent, { pii: !isGitTool });
            if (scrubbed && scrubbed.modified && typeof scrubbed.scrubbed === "string") {
              outContent = scrubbed.scrubbed;
            }
          } catch { /* scrubber is defense-in-depth; never fail the loop */ }
        }

        // Post-execution judge: ask a cheap model whether this tool result
        // addresses the user intent. Advisory-only; fails open.
        if (
          toolResultJudgeEnabled() &&
          !shouldSkipJudge(name) &&
          result.ok !== false
        ) {
          try {
            const lastUserMsg = [...messages].reverse().find((m) => m?.role === "user");
            const userIntent = typeof lastUserMsg?.content === "string" ? lastUserMsg.content : "";
            if (userIntent.length > 0) {
              const judgeFn = async (prompt) => {
                const resp = await backendFetch(url, {
                  method: "POST",
                  headers: config.headers,
                  body: JSON.stringify({
                    model: bodyBase.model,
                    messages: [
                      { role: "system", content: "You are a strict JSON-only judge." },
                      { role: "user", content: prompt },
                    ],
                    stream: false,
                    temperature: 0,
                  }),
                });
                if (!resp || !resp.ok) return "";
                const data = await resp.json().catch(() => ({}));
                return String(data?.choices?.[0]?.message?.content || "");
              };
              const verdict = await judgeToolResult({
                toolName: name,
                toolArgs: args,
                toolResult: outContent,
                userIntent,
                callFn: judgeFn,
                timeoutMs: Number(process.env.AGENT_TOOL_RESULT_JUDGE_TIMEOUT_MS) || 8000,
              });
              if (verdict && verdict.satisfactory === false && (verdict.confidence ?? 0) >= 0.6) {
                const advisory = `\n\n[judge] ${verdict.issue || "result may not address the request"}. ${verdict.suggestion || ""}`.trim();
                outContent = `${outContent}${advisory}`;
                trajCollector.record({
                  type: "judge_advisory",
                  name,
                  iteration,
                  issue: verdict.issue || "",
                  confidence: verdict.confidence ?? 0,
                });
              }
            }
          } catch { /* judge is advisory; never fail the loop */ }
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
    results = parsedCalls.map((pc) => {
      if (validationResults.has(pc.tc.id)) return validationResults.get(pc.tc.id);
      const ci = callsForChain.findIndex((c) => c._tcId === pc.tc.id);
      if (ci >= 0 && resultsByIdx.has(ci)) return resultsByIdx.get(ci);
      return {
        tool_call_id: pc.tc.id,
        content: JSON.stringify({ ok: false, error: "Tool was not executed" }),
      };
    });
    }

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

    // Persist checkpoint after each successful iteration so the run can be
    // resumed from this point after a crash, timeout, or manual pause.
    if (liveSessionId) {
      saveCheckpoint(liveSessionId, {
        sessionId: liveSessionId,
        iteration,
        messages,
        runId,
        model: bodyBase.model,
        timestamp: Date.now(),
        version: 1,
        ...(upfrontPlanDagForCheckpoint && { upfrontPlanDag: upfrontPlanDagForCheckpoint }),
      }).catch(() => {});
    }

    // Re-plan nudge: when a tool result indicates a permanent failure, inject
    // a system message so the LLM can adapt its strategy before the next turn.
    if (replanEnabled) {
      for (const r of results) {
        let parsed;
        try { parsed = JSON.parse(r.content); } catch { continue; }
        if (!parsed || typeof parsed !== "object") continue;
        const isFail = parsed.ok === false || parsed._tool_validation_error === true;
        if (!isFail) continue;
        // Identify which tool failed
        const failedCall = parsedCalls.find((pc) => pc.tc.id === r.tool_call_id);
        const toolName = failedCall?.name || "unknown";
        const toolArgs = failedCall?.args;

        replanCount++;
        if (!replanFailedTools.includes(toolName)) replanFailedTools.push(toolName);

        if (replanCount <= AGENT_MAX_REPLANS) {
          const { classified, history, message } = analyzeAndBuildReplan({
            toolName,
            parsed,
            args: toolArgs,
            tracker: failureTracker,
            attempt: replanCount,
            maxAttempts: AGENT_MAX_REPLANS,
          });
          runFailures.push({ tool: toolName, category: classified.category });
          try { recordToolFailure(toolName, classified.category); } catch { /* metrics best-effort */ }
          // Cross-run escalation: if this tool has a history of terminal
          // failures in prior runs, append a stronger avoidance hint.
          let finalMessage = message;
          try {
            const chronic = await isChronicallyBroken(workspace, toolName);
            if (chronic.chronic) {
              finalMessage = `${message} Prior runs in this workspace have seen ${chronic.terminalCount} terminal '${chronic.dominantCategory}' failures from '${toolName}'; strongly prefer a different tool.`;
            }
          } catch { /* chronic lookup is best-effort */ }
          messages.push({ role: "system", content: finalMessage });
          if (liveSessionId) {
            try {
              publishAgentRunEvent(liveSessionId, "status.change", {
                status: "replanning",
                failedTool: toolName,
                attempt: replanCount,
                category: classified.category,
                terminal: classified.terminal,
                repeat: history.repeat,
              });
            } catch { /* live publishing is best-effort */ }
          }
        } else {
          lastContent = "(Agent stopped: re-plan attempts exhausted after repeated tool failures)";
          stopReason = "replan_exhausted";
          setAgentHeader("X-Agent-Stopped", "replan_exhausted");
          if (liveSessionId) {
            try {
              publishAgentRunEvent(liveSessionId, "done", {
                reason: "replan_exhausted",
                failedTools: replanFailedTools,
              });
            } catch { /* live publishing is best-effort */ }
          }
          runFailureMemoryHook({
            userId: storageUserId,
            workspaceId: workspace,
            kind: "replan",
            userGoal: userGoalForLoop,
            tools: replanFailedTools,
            details: "replan attempts exhausted",
          });
          break;
        }
      }
      if (stopReason === "replan_exhausted") break;
    }

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

    // N-cycle rolling window stagnation detection
    let currentStagnation = null;
    if (stagnationDetectionEnabled()) {
      const iterationToolCalls = parsedCalls.map((pc) => ({ name: pc.name, args: pc.args }));
      stagnationTracker.append(computeFingerprint(iterationToolCalls), iteration);
      currentStagnation = stagnationTracker.check();
      if (currentStagnation.stagnant) {
        if (stagnationRecoveryEnabled()) {
          messages.push({
            role: "user",
            content: `[System] Stagnation detected (${currentStagnation.reason}). You are repeating the same tool calls. Try a different approach, use different arguments, or provide a final answer.`,
          });
        } else {
          lastContent = `(Agent stopped: ${currentStagnation.reason || "repeated tool calls with no progress"})`;
          stopReason = "stagnation";
          setAgentHeader("X-Agent-Stopped", "stagnation");
          runFailureMemoryHook({
            userId: storageUserId,
            workspaceId: workspace,
            kind: "stagnation",
            userGoal: userGoalForLoop,
            tools: parsedCalls.map((pc) => pc.name).filter(Boolean),
            details: currentStagnation.reason,
          });
          break;
        }
      }
    }

    // Mid-loop self-critique (AGENT_MID_LOOP_CRITIQUE=1) and semantic trim
    // (AGENT_SEMANTIC_TRIM=1 + AGENT_SEMANTIC_TRIM_BUDGET>0). Both are
    // feature-flagged and no-ops by default.
    await runMidLoopCritiqueHook({
      iteration,
      currentStagnation,
      messages,
      userGoal: userGoalForLoop,
      backendFetch,
      url,
      model: req.body?.model || model,
      headers: config.headers,
      trajCollector,
      storageUserId,
      workspace,
    });
    const trimResult = runSemanticTrimHook({ messages, userGoal: userGoalForLoop, trajCollector });
    if (trimResult.roundsRemoved > 0) messages = trimResult.trimmedMessages;
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
        // Record per-workspace LLM usage for Prometheus on the reflect pass.
        try {
          const reflectUsage = rd?.usage || {};
          recordLlmUsage({
            workspaceId: workspace,
            model: bodyBase.model,
            inputTokens: Number(reflectUsage.prompt_tokens) || 0,
            outputTokens: Number(reflectUsage.completion_tokens) || 0,
          });
        } catch {
          /* metrics are best-effort */
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
      budget_exceeded: "Hit subagent budget limit",
      stagnation: "Detected repeated tool calls with no progress",
      replan_exhausted: "Exhausted re-plan attempts after repeated tool failures",
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
      const donePayload = { reason: stopReason };
      if (budget && stopReason === "budget_exceeded") {
        donePayload.budgetSummary = budget.summary();
      }
      publishAgentRunEvent(liveSessionId, "done", donePayload);
    } catch { /* live publishing is best-effort */ }
  }
  // Drop the per-run cost accumulator now that the run is terminal so the
  // map stays bounded by the lifetime of in-flight runs only.
  disposeRunCostAccumulator(runId);

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

  return {
    content: lastContent,
    iteration,
    toolCalls: toolCallsLog,
    runId,
    stopReason,
    ...(budget && stopReason === "budget_exceeded" ? { budgetSummary: budget.summary() } : {}),
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
