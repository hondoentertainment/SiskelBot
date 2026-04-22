/**
 * Shared tool-call batch execution for agent loop (execute_step HITL pause + resume).
 */
import { trace, SpanStatusCode } from "@opentelemetry/api";
import { runTool, TOOLS as registeredTools } from "./agent-tools.js";
import {
  validateToolCall,
  validateToolCallWithRepair,
  toolValidationEnabled,
} from "./tool-validation.js";
import { repairToolArgs, toolArgRepairEnabled } from "./tool-arg-repair.js";
import { judgeToolResult, toolResultJudgeEnabled, shouldSkipJudge } from "./tool-result-judge.js";
import { scrubContent, contentScrubEnabled } from "./content-scrubber.js";
import {
  checkPolicyBeforeTool,
  recordPolicyToolCompletion,
} from "./agent-policy.js";
import {
  truncateToolResultContent,
  getAgentToolResultMaxChars,
} from "./agent-context-trim.js";
import { saveHitlState } from "./agent-hitl-store.js";
import { publishAgentRunEvent } from "./agent-run-stream.js";
import { getSessionIdForRunSync, getSessionIdForRun } from "./agent-session.js";
import { fetchWithTimeoutAndRetry } from "./backend-fetch.js";
import { withRetry, isTransientError } from "./tool-retry.js";

/**
 * Lazy-loaded runAgentLoop to avoid potential circular imports if the
 * dependency graph ever changes. Cached after first resolution.
 * @type {Function|null}
 */
let _runAgentLoop = null;
async function getRunAgentLoop() {
  if (!_runAgentLoop) {
    const mod = await import("./agent-loop.js");
    _runAgentLoop = mod.runAgentLoop;
  }
  return _runAgentLoop;
}

/**
 * Build a minimal proxy config from environment variables.
 * Used as a fallback when no buildProxyConfig is supplied by the caller.
 * @param {string} [_model]
 * @returns {{ baseUrl: string, path: string, headers: Record<string, string> }}
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

const agentTracer = trace.getTracer("siskel-bot-agent", "1.0.0");

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
    // Optional overrides for spawn_subagent wiring. When omitted the function
    // falls back to lazy imports / env-based defaults so existing callers are
    // unaffected.
    backendFetch: callerBackendFetch,
    buildProxyConfig: callerBuildProxyConfig,
    currentTools: callerCurrentTools,
    currentModel: callerCurrentModel,
    depth: callerDepth,
    // Last user-turn text (for the post-execution result judge to compare
    // the tool result against intent). Optional; falls back to "" which
    // causes the judge to short-circuit with satisfactory:true.
    userIntent: callerUserIntent,
  } = opts;

  // --- Enrich toolCtx with fields required by spawn_subagent ---------------
  // We merge onto a shallow copy so the caller's original object is untouched.
  const toolCtx = { ...rawToolCtx };

  // runAgentLoop — resolved lazily to avoid any future circular-import risk.
  if (typeof toolCtx.runAgentLoop !== "function") {
    toolCtx.runAgentLoop = await getRunAgentLoop();
  }

  // backendFetch — prefer caller-supplied, then existing ctx, then backend-fetch module.
  if (typeof toolCtx.backendFetch !== "function") {
    toolCtx.backendFetch =
      typeof callerBackendFetch === "function"
        ? callerBackendFetch
        : fetchWithTimeoutAndRetry;
  }

  // buildProxyConfig — prefer caller-supplied, then existing ctx, then env-based default.
  if (typeof toolCtx.buildProxyConfig !== "function") {
    toolCtx.buildProxyConfig =
      typeof callerBuildProxyConfig === "function"
        ? callerBuildProxyConfig
        : defaultBuildProxyConfig;
  }

  // currentTools (parentTools for spawn_subagent) — prefer caller, then
  // fall back to the full registered TOOLS array.
  if (!Array.isArray(toolCtx.currentTools)) {
    toolCtx.currentTools = Array.isArray(callerCurrentTools)
      ? callerCurrentTools
      : registeredTools;
  }

  // currentModel
  if (typeof toolCtx.currentModel !== "string" && typeof callerCurrentModel === "string") {
    toolCtx.currentModel = callerCurrentModel;
  }

  // runId — make it accessible to tools that need it (e.g. spawn_subagent → parentRunId).
  if (toolCtx.runId == null && typeof runId === "string") {
    toolCtx.runId = runId;
  }

  // agentSessionId — resolved from explicit sessionId opt or agentOpts.
  if (toolCtx.agentSessionId == null) {
    const sid =
      (typeof sessionIdOpt === "string" && sessionIdOpt.trim()) ||
      (typeof agentOpts?.sessionId === "string" && agentOpts.sessionId.trim()) ||
      "";
    if (sid) toolCtx.agentSessionId = sid;
  }

  // depth — subagent nesting level.
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
  // Resolve the sessionId for live SSE events. Prefer the explicitly supplied
  // value; otherwise fall back to the runId → sessionId reverse index
  // (lib/agent-session.js getSessionIdForRun). Sync mirror first to keep the
  // batch-execute path hot; fall back to a persisted async lookup only when
  // the mirror is cold.
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
        let v;
        if (toolArgRepairEnabled() && !parseError) {
          // Build a best-effort repairFn that routes through the agent's
          // backendFetch + proxy config. Any error inside the repairFn is
          // swallowed by validateToolCallWithRepair so we fall back to today's
          // behavior on failure.
          const repairFn = async ({ toolName, args: failingArgs, repairHint }) => {
            try {
              const callFn = async (prompt) => {
                const cfg = (typeof toolCtx.buildProxyConfig === "function")
                  ? toolCtx.buildProxyConfig(toolCtx.currentModel)
                  : defaultBuildProxyConfig(toolCtx.currentModel);
                const body = {
                  model: toolCtx.currentModel || process.env.AGENT_MODEL || "gpt-4o-mini",
                  messages: [
                    { role: "system", content: "You repair malformed tool-call arguments. Output only a single JSON object." },
                    { role: "user", content: prompt },
                  ],
                  temperature: 0,
                  stream: false,
                };
                const res = await toolCtx.backendFetch(
                  `${cfg.baseUrl}${cfg.path}`,
                  {
                    method: "POST",
                    headers: cfg.headers,
                    body: JSON.stringify(body),
                  },
                  (process.env.BACKEND || "ollama").toLowerCase()
                );
                if (!res || !res.ok) throw new Error(`repair backend status ${res?.status}`);
                const data = await res.json();
                return data?.choices?.[0]?.message?.content ?? "";
              };
              return await repairToolArgs({
                toolName,
                args: failingArgs,
                repairHint,
                callFn,
                timeoutMs: Number(process.env.AGENT_TOOL_ARG_REPAIR_TIMEOUT_MS) || 10000,
              });
            } catch (err) {
              return { ok: false, error: String(err?.message || err) };
            }
          };
          v = await validateToolCallWithRepair(name, args, { parseError, repairFn });
          if (v.valid && v.repairedArgs) {
            // Swap the original args for the repaired ones before execution.
            args = v.repairedArgs;
            trajCollector.record({
              type: "tool_args_repaired",
              name,
              iteration,
              argsPreview: trajCollector.truncate(JSON.stringify(args), 240),
            });
          }
        } else {
          v = validateToolCall(name, args, { parseError });
        }
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

      if (liveSessionId) {
        try {
          publishAgentRunEvent(liveSessionId, "tool.call", {
            tool: name,
            arguments: args,
            runId,
          });
        } catch { /* live event publishing is best-effort */ }
      }

      const retryDisabled = process.env.AGENT_TOOL_RETRY_DISABLED === "1";
      const execT0 = Date.now();
      try {
        const tracedRunTool = () =>
          agentTracer.startActiveSpan(
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
                return await runTool(name, args, toolCtx);
              } catch (err) {
                span.recordException(err);
                span.setStatus({ code: SpanStatusCode.ERROR });
                throw err;
              }
            }
          );

        const result = retryDisabled
          ? await tracedRunTool()
          : await withRetry(tracedRunTool, {
              maxRetries: Number(process.env.AGENT_TOOL_RETRY_MAX) || 3,
              isTransient: isTransientError,
              onRetry: (err, attempt, delay) => {
                if (liveSessionId) {
                  try {
                    publishAgentRunEvent(liveSessionId, "tool.retry", {
                      tool: name,
                      attempt,
                      error: err.message,
                      delayMs: delay,
                      runId,
                    });
                  } catch { /* retry event publishing is best-effort */ }
                }
              },
            });
        const durationMs = Date.now() - execT0;
        let outContent = result.content;
        if (toolResultMaxChars > 0) {
          outContent = truncateToolResultContent(outContent, toolResultMaxChars);
        }

        // Content scrub: redact secrets / PII / prompt-injection markers from
        // tool output BEFORE the LLM sees it. Best-effort; scrubber failures
        // must not break the tool call. git_* tools skip PII scrubbing (commit
        // author emails would be over-redacted).
        if (contentScrubEnabled() && typeof outContent === "string") {
          try {
            const isGitTool = typeof name === "string" && name.startsWith("workspace_git");
            const result = scrubContent(outContent, { pii: !isGitTool });
            if (result && result.modified && typeof result.scrubbed === "string") {
              outContent = result.scrubbed;
            }
          } catch { /* scrubber is defense-in-depth; never fail the loop */ }
        }

        // Post-execution judge: ask a cheap model whether this tool result
        // actually addresses the user intent. Advisory-only; failure modes
        // fail open (satisfactory:true). Gated + per-tool skipped by default.
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
              const url = `${cfg.baseUrl}${cfg.path}`;
              const resp = await toolCtx.backendFetch(url, {
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
            // Only act on high-confidence negative verdicts (>= 0.6). Append
            // a compact advisory to the content so the LLM sees the signal.
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

        recordPolicyToolCompletion(policyState, name, durationMs);
        toolCallsLog.push({ name, args, iteration, durationMs, ok: result.ok !== false });
        toolMetrics.push({ name, durationMs, ok: result.ok !== false });
        trajCollector.record({
          type: "tool_result",
          name,
          iteration,
          ok: result.ok !== false,
          preview: trajCollector.truncate(outContent, 400),
        });
        if (liveSessionId) {
          try {
            publishAgentRunEvent(liveSessionId, "tool.result", {
              tool: name,
              result: previewForEvent(outContent),
              runId,
            });
          } catch { /* live event publishing is best-effort */ }
        }
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
        if (liveSessionId) {
          try {
            publishAgentRunEvent(liveSessionId, "tool.result", {
              tool: name,
              result: { ok: false, error: String(err?.message || err) },
              runId,
            });
          } catch { /* best-effort */ }
        }
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
      sessionId: liveSessionId || hitlContext?.sessionId || undefined,
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
    };
  }

  // Use the reverse-index-resolved liveSessionId so tool_failed events land
  // on the right session even when the caller only knew the runId.
  const sessionId = liveSessionId;
  let hadToolExecutionFailure = false;
  const { appendAgentSessionEvent } = sessionId
    ? await import("./agent-session.js")
    : { appendAgentSessionEvent: null };
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
      if (sessionId && appendAgentSessionEvent) {
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

  return { results, hitlPause: null, toolMetrics, hadToolExecutionFailure };
}
