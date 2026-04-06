import { randomUUID } from "crypto";
import { validate } from "../lib/validate.js";

export default function mountChatRoutes(app, deps) {
  const {
    chatAuth,
    requireScope,
    perKeyChatRateLimiter,
    chatRateLimiter,
    logRequest,
    apiError,
    backendFetch,
    buildProxyConfig,
    setQuotaHeaders,
    BACKEND,
    MODEL_PRESETS,
    AB_ROUTING_ENABLED,
    MODEL_ROUTING_CONFIG,
    ENABLE_AGENT_SWARM,
    ALLOW_RECIPE_STEP_EXECUTION,
    STREAM_AGENT_FINAL,
    AGENT_STREAM_CHUNK_SIZE,
    USAGE_ALERT_TOKENS,
    // lib imports
    recordChatRequest,
    recordTokensUsed,
    isQuotaConfigured,
    checkQuota,
    estimate,
    selectBackend,
    logRouting,
    intersectClientToolsWithAllowlist,
    getToolsSchema,
    resolveAgentMaxIterations,
    runSwarm,
    runSwarmLegacy,
    intersectSwarmSpecialistsWithAllowlist,
    getSwarmSelectableSpecialistNames,
    runAgentLoop,
    pipeLlmChatStreamToSse,
    recordUsage,
    getTotalTokensInWindow,
    emitEvent,
    reportError,
    autoRecordEnabled,
    recordTrace,
  } = deps;

  const validateChat = validate({ body: { messages: "array", model: "?string", stream: "?boolean" } });

  // POST /v1/chat/completions
  app.post("/v1/chat/completions", chatAuth, requireScope("write"), perKeyChatRateLimiter, chatRateLimiter, logRequest, validateChat, async (req, res) => {
    recordChatRequest();
    try {
      const workspace = req.body?.agentOptions?.workspace || "default";
      const userId = req.userId || null;

      // Per-workspace token quota check
      if (isQuotaConfigured()) {
        const inputTokens = estimate.inputFromMessages(req.body?.messages || []);
        const { allowed, quota } = await checkQuota(workspace, userId, inputTokens + 512);
        if (!allowed && quota) {
          res.setHeader("X-Quota-Limit", String(quota.limit));
          res.setHeader("X-Quota-Remaining", "0");
          res.setHeader("X-Quota-Reset", String(quota.resetAt));
          return res.status(429).json({
            error: "Workspace token quota exceeded",
            code: "QUOTA_EXCEEDED",
            hint: "Quota resets at period end. Contact admin or use a different workspace.",
          });
        }
      }

      // A/B routing: select backend per-request when MODEL_ROUTING is configured
      const requestId = randomUUID();
      let activeBackend = BACKEND;
      if (AB_ROUTING_ENABLED) {
        activeBackend = selectBackend(MODEL_ROUTING_CONFIG, requestId);
        logRouting(requestId, activeBackend, MODEL_ROUTING_CONFIG);
      }

      const config = buildProxyConfig(activeBackend);
      const url = `${config.baseUrl}${config.path}`;
      const model = req.body?.model || MODEL_PRESETS[activeBackend]?.[0] || "unknown";
      const agentMode = req.body?.agentMode === true;
      const swarmMode = req.body?.swarmMode === true;
      const hasTools = Array.isArray(req.body?.tools) && req.body.tools.length > 0;

      if (agentMode || swarmMode || hasTools) {
        const tools = hasTools ? intersectClientToolsWithAllowlist(req.body.tools) : getToolsSchema();
        const bodyWithTools = { ...req.body, tools, tool_choice: req.body?.tool_choice ?? "auto" };
        if (!hasTools) req.body = bodyWithTools;

        let content, iteration, toolCalls, swarmSteps;
        let swarmResult = null;
        if (agentMode && swarmMode && ENABLE_AGENT_SWARM) {
          const swarmMaxIter = resolveAgentMaxIterations(req.body?.agentOptions || {}, process.env.MAX_AGENT_ITERATIONS);
          swarmResult = await runSwarm(req, res, config, model, {
            backendFetch,
            maxIterations: swarmMaxIter,
            allowRecipeExecution: ALLOW_RECIPE_STEP_EXECUTION,
          });
          content = swarmResult.content;
          iteration = swarmResult.iteration;
          swarmSteps = swarmResult.swarmSteps;
        } else {
          const useAgentProgressStream = agentMode && !swarmMode;
          let presetRunId = null;
          if (useAgentProgressStream) {
            presetRunId = randomUUID();
            res.setHeader("Content-Type", "text/event-stream");
            res.setHeader("Cache-Control", "no-cache");
            res.setHeader("Connection", "keep-alive");
            res.setHeader("X-Agent-Run-Id", presetRunId);
            await setQuotaHeaders(res, workspace, userId);
            if (typeof res.flushHeaders === "function") res.flushHeaders();
          }
          const agentLoopResult = await runAgentLoop(
            req,
            res,
            config,
            model,
            useAgentProgressStream
              ? {
                  presetRunId,
                  onProgress: (evt) => {
                    try {
                      res.write(`data: ${JSON.stringify(evt)}\n\n`);
                    } catch (_) {}
                  },
                }
              : null,
            backendFetch
          );
          content = agentLoopResult.content;
          iteration = agentLoopResult.iteration;
          toolCalls = agentLoopResult.toolCalls;
          req._agentLoopMeta = agentLoopResult;
        }

        if (!res.headersSent) {
          res.setHeader("Content-Type", "text/event-stream");
          res.setHeader("Cache-Control", "no-cache");
          res.setHeader("Connection", "keep-alive");
          res.setHeader("X-Agent-Iteration", String(iteration));
          if (req._agentLoopMeta?.runId) {
            res.setHeader("X-Agent-Run-Id", req._agentLoopMeta.runId);
          }
          if (AB_ROUTING_ENABLED) {
            res.setHeader("x-model-backend", activeBackend);
            res.setHeader("x-model-request-id", requestId);
          }
          await setQuotaHeaders(res, workspace, userId);
          if (typeof res.flushHeaders === "function") res.flushHeaders();
        }

        if (toolCalls?.length || swarmSteps?.length || req._agentLoopMeta) {
          const meta = req._agentLoopMeta || {};
          const traj = meta.trajectory;
          const trajectorySummary =
            traj && Array.isArray(traj.steps)
              ? {
                  runId: traj.runId,
                  stepCount: traj.stepCount,
                  stopReason: meta.stopReason,
                  steps: traj.steps.slice(0, 40),
                }
              : undefined;
          const activityEvent = JSON.stringify({
            type: "agent_activity",
            toolCalls: toolCalls || [],
            swarmSteps: swarmSteps || [],
            iteration,
            runId: meta.runId,
            stopReason: meta.stopReason,
            citationWarning: meta.citationWarning,
            trajectory: trajectorySummary,
          });
          res.write(`data: ${activityEvent}\n\n`);
        }

        const inputTokens = estimate.inputFromMessages(req.body?.messages || []);
        let outputTokens = estimate.outputFromChars(content?.length || 0);

        if (swarmResult?.synthesisDeferred) {
          const d = swarmResult.synthesisDeferred;
          const { fullText, error } = await pipeLlmChatStreamToSse(res, backendFetch, d.url, d.config, d.synthBody);
          content = fullText || "";
          if (error && !content.trim()) {
            content = `Synthesis error: ${error}\n\n${swarmResult.fallbackAggregate || ""}`;
            res.write(
              `data: ${JSON.stringify({ choices: [{ delta: { content }, index: 0, finish_reason: "stop" }] })}\n\n`
            );
          }
          outputTokens = estimate.outputFromChars(content?.length || 0);
        } else if (
          (STREAM_AGENT_FINAL || (agentMode && !swarmMode)) &&
          content &&
          typeof content === "string"
        ) {
          for (let i = 0; i < content.length; i += AGENT_STREAM_CHUNK_SIZE) {
            const part = content.slice(i, i + AGENT_STREAM_CHUNK_SIZE);
            const isLast = i + AGENT_STREAM_CHUNK_SIZE >= content.length;
            const chunk = JSON.stringify({
              choices: [{ delta: { content: part }, index: 0, ...(isLast ? { finish_reason: "stop" } : {}) }],
            });
            res.write(`data: ${chunk}\n\n`);
          }
        } else {
          const chunk = JSON.stringify({
            choices: [{ delta: { content }, index: 0, finish_reason: "stop" }],
          });
          res.write(`data: ${chunk}\n\n`);
        }

        outputTokens = estimate.outputFromChars(content?.length || 0);
        recordTokensUsed(inputTokens, outputTokens);
        await recordUsage({ timestamp: new Date().toISOString(), model, inputTokens, outputTokens, backend: BACKEND, workspace, userId }).catch(() => {});

        if (autoRecordEnabled()) {
          try {
            const tracePayload = req._agentLoopMeta || {};
            await recordTrace({
              runId: tracePayload.runId || undefined,
              workspace: req.body?.agentOptions?.workspace || "default",
              userId: req.userId || null,
              steps: tracePayload.trajectory?.steps || [],
              stepCount: tracePayload.trajectory?.stepCount || 0,
              toolCalls: tracePayload.toolCalls || [],
              swarmSteps: swarmSteps || [],
              stopReason: tracePayload.stopReason || undefined,
              content: typeof content === "string" ? content.slice(0, 2000) : null,
              type: swarmResult ? "swarm" : "agent",
            });
          } catch (e) {
            console.warn("[trace-recorder] Auto-record failed:", e?.message || e);
          }
        }

        res.write("data: [DONE]\n\n");
        res.end();
        const ws = req.body?.agentOptions?.workspace || "default";
        await emitEvent("message_sent", { content: content?.slice(0, 500), model, iteration }, { workspaceId: ws, userId: req.userId });
        return;
      }

      const inputTokens = estimate.inputFromMessages(req.body?.messages || []);

      let response;
      try {
        response = await backendFetch(url, {
          method: "POST",
          headers: config.headers,
          body: JSON.stringify({ ...req.body, stream: true }),
        });
      } catch (fetchErr) {
        if (fetchErr.code === "CIRCUIT_OPEN") {
          return res.status(503).json({
            error: "Backend temporarily unavailable",
            code: "CIRCUIT_OPEN",
            hint: "Retry after a few seconds.",
          });
        }
        throw fetchErr;
      }

      if (!response.ok) {
        const err = await response.text();
        const code = response.status === 429 ? "RATE_LIMITED" : "BACKEND_ERROR";
        return res.status(response.status).json({
          error: `${BACKEND} error`,
          code,
          hint: response.status === 429 ? "Backend rate limit exceeded; retry later." : err || "Backend returned an error.",
        });
      }

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      if (AB_ROUTING_ENABLED) {
        res.setHeader("x-model-backend", activeBackend);
        res.setHeader("x-model-request-id", requestId);
      }
      await setQuotaHeaders(res, workspace, userId);
      res.flushHeaders();

      let buffer = "";
      let outputChars = 0;
      let outputContent = "";
      let usageFromApi = null;

      for await (const chunk of response.body) {
        const text = chunk.toString("utf8");
        buffer += text;
        const parts = buffer.split("\n\n");
        buffer = parts.pop() || "";
        for (const part of parts) {
          const dataMatch = part.match(/^data: (.+)$/m);
          if (!dataMatch) continue;
          const data = dataMatch[1];
          if (data === "[DONE]") continue;
          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta?.content;
            if (typeof delta === "string") {
              outputChars += delta.length;
              outputContent += delta;
            }
            const usage = parsed.usage || parsed.choices?.[0]?.usage;
            if (usage && (usage.prompt_tokens != null || usage.completion_tokens != null)) {
              usageFromApi = { ...usage };
            }
          } catch (_) {}
        }
        res.write(chunk);
        if (res.flush) res.flush();
      }

      await emitEvent(
        "message_sent",
        { content: outputContent?.slice(0, 500), model },
        { workspaceId: workspace, userId }
      );

      const outputTokens = usageFromApi?.completion_tokens ?? estimate.outputFromChars(outputChars);
      const finalInputTokens = usageFromApi?.prompt_tokens ?? inputTokens;
      recordTokensUsed(finalInputTokens, outputTokens);
      await recordUsage({
        timestamp: new Date().toISOString(),
        model,
        inputTokens: finalInputTokens,
        outputTokens,
        backend: BACKEND,
        workspace,
        userId,
      }).catch((e) => console.warn("[usage-tracker] Record failed:", e.message));

      if (USAGE_ALERT_TOKENS) {
        const totalInWindow = await getTotalTokensInWindow();
        if (totalInWindow >= USAGE_ALERT_TOKENS) {
          res.setHeader("X-Usage-Alert", "1");
          console.warn(`[usage] Budget alert: ${totalInWindow} tokens >= ${USAGE_ALERT_TOKENS}`);
        }
      }

      res.end();
    } catch (err) {
      if (err.code === "CIRCUIT_OPEN") {
        return res.status(503).json({
          error: "Backend temporarily unavailable",
          code: "CIRCUIT_OPEN",
          hint: "Retry after a few seconds.",
        });
      }
      console.error("Proxy error:", err.message);
      const hint =
        BACKEND === "vllm"
          ? "Is vLLM running? Try: vllm serve <model> --max-model-len 4096"
          : BACKEND === "ollama"
            ? "Is Ollama running? Try: ollama serve"
            : BACKEND === "openai"
              ? "Check OPENAI_API_KEY is set and valid"
              : "Check backend configuration";

      return apiError(res, 502, "BACKEND_UNREACHABLE", err.message, hint);
    }
  });

  // POST /v1/agent/swarm
  app.post("/v1/agent/swarm", chatAuth, requireScope("write"), perKeyChatRateLimiter, chatRateLimiter, logRequest, async (req, res) => {
    recordChatRequest();
    try {
      if (!ENABLE_AGENT_SWARM) {
        return res.status(400).json({
          error: "Swarm mode is disabled",
          code: "SWARM_DISABLED",
          hint: "Set ENABLE_AGENT_SWARM=1 to enable.",
        });
      }
      req.body = req.body || {};
      req.body.agentMode = true;
      req.body.swarmMode = true;
      if (!req.body.agentOptions) req.body.agentOptions = {};
      const workspace = req.body.agentOptions.workspace || "default";
      const userId = req.userId || null;

      if (isQuotaConfigured()) {
        const inputTokens = estimate.inputFromMessages(req.body?.messages || []);
        const { allowed, quota } = await checkQuota(workspace, userId, inputTokens + 512);
        if (!allowed && quota) {
          res.setHeader("X-Quota-Limit", String(quota.limit));
          res.setHeader("X-Quota-Remaining", "0");
          res.setHeader("X-Quota-Reset", String(quota.resetAt));
          return res.status(429).json({
            error: "Workspace token quota exceeded",
            code: "QUOTA_EXCEEDED",
          });
        }
      }

      const config = buildProxyConfig(BACKEND);
      const model = req.body?.model || MODEL_PRESETS[BACKEND]?.[0] || "unknown";
      const swarmMaxIter = resolveAgentMaxIterations(req.body?.agentOptions || {}, process.env.MAX_AGENT_ITERATIONS);
      const { content, iteration } = await runSwarm(req, res, config, model, {
        backendFetch,
        maxIterations: swarmMaxIter,
        allowRecipeExecution: ALLOW_RECIPE_STEP_EXECUTION,
      });

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Agent-Iteration", String(iteration));
      await setQuotaHeaders(res, workspace, userId);
      res.flushHeaders();

      const inputTokens = estimate.inputFromMessages(req.body?.messages || []);
      const outputTokens = estimate.outputFromChars(content?.length || 0);
      recordTokensUsed(inputTokens, outputTokens);
      await recordUsage({
        timestamp: new Date().toISOString(),
        model,
        inputTokens,
        outputTokens,
        backend: BACKEND,
        workspace,
        userId,
      }).catch(() => {});

      const chunk = JSON.stringify({
        choices: [{ delta: { content }, index: 0, finish_reason: "stop" }],
      });
      res.write(`data: ${chunk}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      await emitEvent("message_sent", { content: content?.slice(0, 500), model, iteration }, { workspaceId: workspace, userId });
    } catch (err) {
      reportError(err);
      res.status(500).json({
        error: "Swarm execution failed",
        code: "SWARM_ERROR",
        hint: err?.message || "Internal error",
      });
    }
  });

  // POST /v1/swarm (legacy)
  app.post("/v1/swarm", chatAuth, requireScope("write"), perKeyChatRateLimiter, chatRateLimiter, logRequest, async (req, res) => {
    try {
      const query = typeof req.body?.query === "string" ? req.body.query.trim() : "";
      const specialists = Array.isArray(req.body?.specialists)
        ? intersectSwarmSpecialistsWithAllowlist(
            req.body.specialists.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim())
          )
        : getSwarmSelectableSpecialistNames();
      const workspace = req.body?.workspace || "default";
      const allowExecution = req.body?.allowExecution === true;

      if (!specialists.length) {
        return res.status(400).json({ error: "No valid specialists specified", code: "INVALID_SPECIALISTS" });
      }

      const { aggregation, metrics } = await runSwarmLegacy(specialists, query, {
        workspace,
        allowExecution,
        projectDir: process.env.PROJECT_DIR || process.cwd(),
        vercelToken: process.env.VERCEL_TOKEN,
      });

      res.setHeader("X-Swarm-Agents", String(metrics.agentCount));
      res.setHeader("X-Swarm-Duration-Ms", String(metrics.durationMs));
      res.json({ aggregation, query, specialists });
    } catch (err) {
      reportError(err);
      res.status(500).json({
        error: "Swarm execution failed",
        code: "SWARM_ERROR",
        hint: err?.message || "Internal error",
      });
    }
  });
}
