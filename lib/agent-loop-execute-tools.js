/**
 * Shared tool-call batch execution for agent loop (execute_step HITL pause + resume).
 */
import { trace, SpanStatusCode } from "@opentelemetry/api";
import { runTool } from "./agent-tools.js";
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
import { publishAgentRunEvent } from "./agent-run-stream.js";

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
    toolCtx,
    policyState,
    toolCallsLog,
    trajCollector,
    traceRequestId,
    setStopPolicy,
    agentOpts,
    hitlContext,
    sessionId: sessionIdOpt,
  } = opts;

  const hitlEnabled =
    process.env.AGENT_EXECUTE_STEP_HITL === "1" || agentOpts?.requireExecuteStepApproval === true;

  const toolResultMaxChars = getAgentToolResultMaxChars();
  const toolMetrics = [];
  const liveSessionId =
    typeof sessionIdOpt === "string" && sessionIdOpt.trim() ? sessionIdOpt.trim() : "";

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

      const execT0 = Date.now();
      try {
        const result = await agentTracer.startActiveSpan(
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
        const durationMs = Date.now() - execT0;
        let outContent = result.content;
        if (toolResultMaxChars > 0) {
          outContent = truncateToolResultContent(outContent, toolResultMaxChars);
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

  return { results, hitlPause: null, toolMetrics, hadToolExecutionFailure };
}
