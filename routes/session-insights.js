import {
  generateInsights,
  getInsights,
  listInsights,
  getReplayTimeline,
} from "../lib/session-insights.js";

export function mountSessionInsightsRoutes(app, deps) {
  const { apiError, dualRegister } = deps;

  dualRegister("get", "/workspaces/:workspaceId/session-insights", async (req, res) => {
    const { workspaceId } = req.params;
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    try {
      const insights = await listInsights(workspaceId, limit);
      res.json({ ok: true, insights });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  dualRegister("get", "/workspaces/:workspaceId/session-insights/:runId", async (req, res) => {
    const { workspaceId, runId } = req.params;
    try {
      const insight = await getInsights(workspaceId, runId);
      if (!insight) return apiError(res, 404, "NOT_FOUND", "Insight not found");
      res.json({ ok: true, insight });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  dualRegister("post", "/workspaces/:workspaceId/session-insights/:runId/generate", async (req, res) => {
    const { workspaceId, runId } = req.params;
    const { trajectoryPayload, sessionId } = req.body || {};
    if (!trajectoryPayload || typeof trajectoryPayload !== "object") {
      return apiError(res, 400, "INVALID_INPUT", "trajectoryPayload is required");
    }
    if (sessionId) trajectoryPayload.sessionId = sessionId;
    try {
      const llmClient = deps.backendFetch
        ? {
            chat: async ({ messages }) => {
              const config = deps.buildProxyConfig ? deps.buildProxyConfig("default") : { baseUrl: "", path: "/v1/chat/completions", headers: {} };
              const url = `${config.baseUrl}${config.path}`;
              const resp = await deps.backendFetch(url, {
                method: "POST",
                headers: { ...config.headers, "Content-Type": "application/json" },
                body: JSON.stringify({ model: config.model || "default", messages, stream: false }),
              });
              if (!resp.ok) return null;
              return resp.json();
            },
          }
        : null;
      const insight = await generateInsights(workspaceId, runId, trajectoryPayload, llmClient);
      res.status(201).json({ ok: true, insight });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  dualRegister("get", "/workspaces/:workspaceId/session-insights/:runId/timeline", async (req, res) => {
    const { workspaceId, runId } = req.params;
    try {
      const timeline = await getReplayTimeline(workspaceId, runId);
      if (!timeline) return apiError(res, 404, "NOT_FOUND", "Insight not found");

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders?.();

      for (const event of timeline) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      res.write("data: {\"done\":true}\n\n");
      res.end();
    } catch (err) {
      if (!res.headersSent) return apiError(res, 500, "INTERNAL_ERROR", err.message);
      res.end();
    }
  });
}
