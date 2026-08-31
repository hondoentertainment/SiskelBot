/**
 * Shared tool-call batch execution for agent loop (execute_step HITL pause + resume).
 */
import { trace, SpanStatusCode } from "@opentelemetry/api";
import { runTool, AGENT_TOOL_TIMEOUT_MS, TOOLS as registeredTools } from "./agent-tools.js";
import { validateToolCall, toolValidationEnabled } from "./tool-validation.js";
import {
  checkPolicyBeforeTool,
  recordPolicyToolCompletion,
} from "./agent-policy.js";
import {
  truncateToolResultContent,
  getAgentToolResultMaxChars,
} from "./agent-context-trim.js";
import { saveHitlState } from "./agent-hitl-store.js";
import { needsBrowserDomainHitl } from "./browser-agent-tools.js";
import { googleToolNeedsHitl } from "./google-workspace-tools.js";
import { loadWorkspaceAgentSettings } from "./workspace-agent-settings.js";
import { sanitizeUserId } from "./storage.js";
import { runToolWithTransientRetries } from "./agent-tool-retry.js";
import { recordToolTimeout, isEnabled as metricsEnabled } from "./metrics.js";
import { publishAgentRunEvent } from "./agent-run-stream.js";
import { getSessionIdForRunSync, getSessionIdForRun } from "./agent-session.js";
import { fetchWithTimeoutAndRetry } from "./backend-fetch.js";
import {
  judgeToolResult,
  toolResultJudgeEnabled,
  shouldSkipJudge,
} from "./tool-result-judge.js";

let _runAgentLoop = null;
async function getRunAgentLoop() {
  if (!_runAgentLoop) {
    const mod = await import("./agent-loop.js");
    _runAgentLoop = mod.runAgentLoop;
  }
  return _runAgentLoop;
}

const agentTracer = trace.getTracer("siskel-bot-agent", "1.0.0");

/**
 * Default proxy config builder when callers do not supply buildProxyConfig.
 * @param {string} [_model]
 * @returns {{ baseUrl: string; path: string; headers: Record<string, string> }}
 */
export function defaultBuildProxyConfig(_model) {
  const backend = (process.env.BACKEND || "ollama").toLowerCase();
  switch (backend) {
    case "openai":
      return {
        baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
        path: "/chat/completions",
        headers: {
          "Content-Type": "application/json",
          ...(process.env.OPENAI_API_KEY
            ? { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }
            : {}),
        },
      };
    case "vllm":
      return {
        baseUrl: (process.env.VLLM_URL || "http://localhost:8000").replace(/\/$/, ""),
        path: "/v1/chat/completions",
        headers: { "Content-Type": "application/json" },
      };
    default:
      return {
        baseUrl: process.env.OLLAMA_URL || "http://localhost:11434",
        path: "/v1/chat/completions",
        headers: { "Content-Type": "application/json" },
      };
  }
}

function countBatchToolTimeouts(rows) {
  return rows.filter((r) => r.kind === "done" && r.toolTimeout).length;
}

/**
 * @param {object} opts
 * @returns {Promise<{ results: Array<{ tool_call_id: string; content: string }>; hitlPause: object | null }>}
 */
export async function executeAgentToolBatch(opts) {
  const {
    toolCalls,
    iteration,
    runId,
    toolCtx: rawToolCtx,
    policyState,
    toolCallsLog,
    trajCollector,
    traceRequestId,
    setStopPolicy,
    agentOpts,
    hitlContext,
    sessionId: sessionIdOpt,
    maxToolExtraRetries = 0,
    backendFetch: callerBackendFetch,
    buildProxyConfig: callerBuildProxyConfig,
    currentTools: callerCurrentTools,
    currentModel: callerCurrentModel,
    depth: callerDepth,
    userIntent: callerUserIntent,
  } = opts;

  const toolCtx = { ...rawToolCtx };
  if (typeof toolCtx.runAgentLoop !== "function") {
    toolCtx.runAgentLoop = await getRunAgentLoop();
  }
  if (typeof toolCtx.backendFetch !== "function") {
    toolCtx.backendFetch =
      typeof callerBackendFetch === "function" ? callerBackendFetch : fetchWithTimeoutAndRetry;
  }
  if (typeof toolCtx.buildProxyConfig !== "function") {
    toolCtx.buildProxyConfig =
      typeof callerBuildProxyConfig === "function" ? callerBuildProxyConfig : defaultBuildProxyConfig;
  }
  if (!Array.isArray(toolCtx.currentTools)) {
    toolCtx.currentTools = Array.isArray(callerCurrentTools) ? callerCurrentTools : registeredTools;
  }
  if (typeof toolCtx.currentModel !== "string" && typeof callerCurrentModel === "string") {
    toolCtx.currentModel = callerCurrentModel;
  }
  if (toolCtx.runId == null && typeof runId === "string") {
    toolCtx.runId = runId;
  }
  if (toolCtx.agentSessionId == null) {
    const sid =
      (typeof sessionIdOpt === "string" && sessionIdOpt.trim()) ||
      (typeof agentOpts?.sessionId === "string" && agentOpts.sessionId.trim()) ||
      "";
    if (sid) toolCtx.agentSessionId = sid;
  }
  if (toolCtx.depth == null) {
    toolCtx.depth =
      typeof callerDepth === "number"
        ? callerDepth
        : typeof agentOpts?.depth === "number"
          ? agentOpts.depth
          : 0;
  }

  const hitlEnabled =
    process.env.AGENT_EXECUTE_STEP_HITL === "1" || agentOpts?.requireExecuteStepApproval === true;

  const toolResultMaxChars = getAgentToolResultMaxChars();
  const toolMetrics = [];

  let liveSessionId =
    typeof sessionIdOpt === "string" && sessionIdOpt.trim() ? sessionIdOpt.trim() : "";
  if (!liveSessionId && typeof runId === "string" && runId) {
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

  function previewForEvent(v, max = 400) {
    try {
      const s = typeof v === "string" ? v : JSON.stringify(v ?? "");
      return s.length > max ? `${s.slice(0, max)}…` : s;
    } catch {
      return "";
    }
  }

  function publishToolResultEvent(name, payload) {
    if (!liveSessionId) return;
    try {
      publishAgentRunEvent(liveSessionId, "tool.result", {
        tool: name,
        result: payload,
        runId,
      });
    } catch { /* best-effort */ }
  }

  const rowResults = await Promise.all(
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
          toolCallsLog.push({ name, args, iteration, validationError: true, durationMs: 0, ok: false });
          toolMetrics.push({ name, durationMs: 0, ok: false, validationError: true });
          trajCollector.record({
            type: "tool_validation_error",
            name,
            iteration,
            errors: v.errors,
          });
          return {
            kind: "done",
            tool_call_id: tc.id,
            validationError: true,
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
      const policyCheck = checkPolicyBeforeTool(policyState, name);
      if (!policyCheck.ok) {
        toolCallsLog.push({
          name,
          args,
          iteration,
          durationMs: 0,
          ok: false,
          policyError: true,
          policyCode: policyCheck.code,
        });
        toolMetrics.push({ name, durationMs: 0, ok: false, policyError: true });
        setStopPolicy(policyCheck);
        return {
          kind: "done",
          tool_call_id: tc.id,
          policyBlocked: true,
          content: JSON.stringify({
            ok: false,
            error: `Policy blocked tool "${name}": ${policyCheck.reason}`,
            code: policyCheck.code,
          }),
        };
      }

      if (
        name === "execute_step" &&
        hitlEnabled &&
        toolCtx.allowExecution &&
        typeof args?.action === "string" &&
        args.action.trim()
      ) {
        toolMetrics.push({ name, durationMs: 0, ok: true, pendingHitl: true });
        return { kind: "hitl", tc, args, name };
      }

      if (
        (name === "browser_open_extract_text" || name === "browser_capture_screenshot") &&
        typeof args?.url === "string" &&
        args.url.trim()
      ) {
        try {
          const uid = sanitizeUserId(toolCtx.workspaceUserId || "anonymous");
          const ws = typeof toolCtx.workspace === "string" ? toolCtx.workspace : "default";
          const wsSettings = await loadWorkspaceAgentSettings(uid, ws);
          const hosts = wsSettings?.agentPolicy?.browserAllowedHosts || [];
          const decision = needsBrowserDomainHitl(args.url, hosts);
          if (decision.needsHitl) {
            toolMetrics.push({ name, durationMs: 0, ok: true, pendingHitl: true, browserDomainHitl: true });
            return { kind: "hitl", tc, args, name };
          }
        } catch {
          /* settings lookup failure: fall through to normal execution / allowlist checks */
        }
      }

      if (googleToolNeedsHitl(name)) {
        toolMetrics.push({ name, durationMs: 0, ok: true, pendingHitl: true, googleHitl: true });
        return { kind: "hitl", tc, args, name };
      }

      if (liveSessionId) {
        try {
          publishAgentRunEvent(liveSessionId, "tool.call", {
            tool: name,
            arguments: args,
            runId,
          });
        } catch { /* live event publishing is best-effort */ }
      }

      const execT0 = Date.now();
      try {
        const wrapped = await agentTracer.startActiveSpan(
          "agent.tool.invoke",
          {
            attributes: {
              "agent.run_id": runId,
              "agent.iteration": iteration,
              "tool.name": String(name || ""),
              ...(traceRequestId ? { "http.request_id": traceRequestId, "siskel.request_id": traceRequestId } : {}),
            },
          },
          async (span) => {
            try {
              return await runToolWithTransientRetries({
                toolName: name,
                policyState,
                maxExtraRetries: maxToolExtraRetries,
                invoke: () => runTool(name, args, toolCtx),
              });
            } catch (err) {
              span.recordException(err);
              span.setStatus({ code: SpanStatusCode.ERROR });
              throw err;
            }
          }
        );
        const durationMs = wrapped.totalDurationMs ?? Date.now() - execT0;
        if (wrapped.policyBlockedOnRetry) {
          toolCallsLog.push({
            name,
            args,
            iteration,
            durationMs,
            ok: false,
            policyError: true,
            policyCode: "POLICY_RETRY_BLOCKED",
            toolRetries: wrapped.retryCount || 0,
          });
          toolMetrics.push({ name, durationMs, ok: false, policyError: true });
          trajCollector.record({
            type: "tool_result",
            name,
            iteration,
            ok: false,
            preview: trajCollector.truncate(wrapped.content, 400),
          });
          let outContent = wrapped.content;
          if (toolResultMaxChars > 0) {
            outContent = truncateToolResultContent(outContent, toolResultMaxChars);
          }
          publishToolResultEvent(name, previewForEvent(outContent));
          return { kind: "done", tool_call_id: tc.id, content: outContent };
        }
        if (wrapped._timeout) {
          const timeoutMs = wrapped._timeoutMs || AGENT_TOOL_TIMEOUT_MS;
          console.warn(`[agent] Tool "${name}" timed out after ${timeoutMs}ms`);
          if (metricsEnabled()) {
            recordToolTimeout(name);
          }
          let outContent = wrapped.content;
          if (toolResultMaxChars > 0) {
            outContent = truncateToolResultContent(outContent, toolResultMaxChars);
          }
          toolCallsLog.push({
            name,
            args,
            iteration,
            durationMs,
            ok: false,
            timeout: true,
            toolRetries: wrapped.retryCount || 0,
          });
          toolMetrics.push({ name, durationMs, ok: false, timeout: true });
          trajCollector.record({
            type: "tool_timeout",
            name,
            iteration,
            timeoutMs,
          });
          publishToolResultEvent(name, previewForEvent(outContent));
          return { kind: "done", tool_call_id: tc.id, content: outContent, toolTimeout: true };
        }
        const result = { content: wrapped.content, ok: wrapped.ok };
        let outContent = result.content;
        if (toolResultMaxChars > 0) {
          outContent = truncateToolResultContent(outContent, toolResultMaxChars);
        }

        if (
          toolResultJudgeEnabled() &&
          !shouldSkipJudge(name) &&
          typeof callerUserIntent === "string" &&
          callerUserIntent.length > 0 &&
          typeof toolCtx.backendFetch === "function" &&
          typeof toolCtx.buildProxyConfig === "function"
        ) {
          try {
            const judgeFn = async (prompt) => {
              const cfg = toolCtx.buildProxyConfig(toolCtx.currentModel);
              const judgeUrl = `${cfg.baseUrl}${cfg.path}`;
              const resp = await toolCtx.backendFetch(judgeUrl, {
                method: "POST",
                headers: cfg.headers,
                body: JSON.stringify({
                  model: toolCtx.currentModel || cfg.model || "default",
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
              userIntent: callerUserIntent,
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
          } catch { /* judge is advisory; never fail the loop */ }
        }

        toolCallsLog.push({
          name,
          args,
          iteration,
          durationMs,
          ok: result.ok !== false,
          toolRetries: wrapped.retryCount || 0,
        });
        toolMetrics.push({ name, durationMs, ok: result.ok !== false });
        trajCollector.record({
          type: "tool_result",
          name,
          iteration,
          ok: result.ok !== false,
          preview: trajCollector.truncate(outContent, 400),
        });
        publishToolResultEvent(name, previewForEvent(outContent));
        return { kind: "done", tool_call_id: tc.id, content: outContent };
      } catch (err) {
        const durationMs = Date.now() - execT0;
        recordPolicyToolCompletion(policyState, name, durationMs);
        toolCallsLog.push({ name, args, iteration, durationMs, ok: false, error: true });
        toolMetrics.push({ name, durationMs, ok: false });
        trajCollector.record({
          type: "tool_error",
          name,
          iteration,
          message: String(err?.message || err),
        });
        publishToolResultEvent(name, { ok: false, error: String(err?.message || err) });
        return {
          kind: "done",
          tool_call_id: tc.id,
          content: JSON.stringify({ ok: false, error: String(err?.message || err) }),
        };
      }
    })
  );

  const hitlRows = rowResults.filter((r) => r.kind === "hitl");
  const anyHardStop = rowResults.some(
    (r) => r.kind === "done" && (r.validationError || r.policyBlocked)
  );
  if (hitlRows.length > 0 && anyHardStop) {
    for (let i = 0; i < rowResults.length; i++) {
      const r = rowResults[i];
      if (r.kind === "hitl") {
        rowResults[i] = {
          kind: "done",
          tool_call_id: toolCalls[i].id,
          content: JSON.stringify({
            ok: false,
            error:
              "execute_step approval pause was skipped because another tool call in the same batch failed validation or policy.",
            code: "HITL_SKIPPED_PEER_FAILURE",
          }),
        };
      }
    }
  }
  if (hitlRows.length > 0 && !anyHardStop) {
    const completedContentById = {};
    for (const r of rowResults) {
      if (r.kind === "done") completedContentById[r.tool_call_id] = r.content;
    }
    const token = saveHitlState({
      ...hitlContext,
      completedContentById,
      hitlToolCallIds: hitlRows.map((h) => h.tc.id),
      hitlArgsById: Object.fromEntries(hitlRows.map((h) => [h.tc.id, h.args])),
      toolCallsSnapshot: toolCalls.map((tc) => ({
        id: tc.id,
        type: tc.type,
        function: tc.function
          ? { name: tc.function.name, arguments: tc.function.arguments }
          : undefined,
      })),
    });
    return {
      results: [],
      hitlPause: {
        token,
        pendingSteps: hitlRows.map((h) => ({
          toolCallId: h.tc.id,
          action: h.args?.action,
          payload: h.args?.payload,
        })),
        toolMetrics,
      },
      hadToolExecutionFailure: false,
      toolTimeoutCount: countBatchToolTimeouts(rowResults),
    };
  }

  const sessionId = typeof sessionIdOpt === "string" ? sessionIdOpt.trim() : "";
  let hadToolExecutionFailure = false;
  if (sessionId) {
    const { appendAgentSessionEvent } = await import("./agent-session.js");
    for (let i = 0; i < rowResults.length; i++) {
      const r = rowResults[i];
      if (!r || r.kind !== "done" || r.validationError || r.policyBlocked) continue;
      const name = toolCalls[i]?.function?.name;
      const raw = r.content;
      if (typeof raw !== "string" || !raw.trim()) continue;
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }
      if (parsed && typeof parsed === "object" && parsed.ok === false) {
        hadToolExecutionFailure = true;
        await appendAgentSessionEvent(sessionId, {
          type: "tool_failed",
          iteration,
          toolName: typeof name === "string" ? name : "",
          code: typeof parsed.code === "string" ? parsed.code : undefined,
          error: typeof parsed.error === "string" ? parsed.error.slice(0, 500) : undefined,
        });
      }
    }
  }

  const results = toolCalls.map((tc, i) => {
    const r = rowResults[i];
    if (r && r.kind === "done") {
      return { tool_call_id: tc.id, content: r.content };
    }
    return { tool_call_id: tc.id, content: "{}" };
  });

  return {
    results,
    hitlPause: null,
    toolMetrics,
    hadToolExecutionFailure,
    toolTimeoutCount: countBatchToolTimeouts(rowResults),
  };
}
