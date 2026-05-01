import { join } from "path";
import { randomUUID } from "crypto";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const MAX_INSIGHTS = 500;
const MAX_SESSION_DATA_CHARS = 20000;

function storePath(workspaceId) {
  return join(getDataDir(), "session-insights", String(workspaceId).trim().slice(0, 50).replace(/[^a-zA-Z0-9._-]/g, "") + ".json");
}

function normalizeStore(raw) {
  if (raw && typeof raw === "object" && Array.isArray(raw.insights)) return raw;
  return { insights: [] };
}

function buildTimelineFromPayload(payload) {
  if (!payload || typeof payload !== "object") return [];
  const steps = Array.isArray(payload.steps) ? payload.steps : [];
  return steps.map((step) => ({
    at: typeof step.at === "number" ? step.at : (typeof step.startedAt === "number" ? step.startedAt : 0),
    type: step.type || "tool_call",
    name: step.name || step.tool || "unknown",
    input: step.input != null ? String(step.input).slice(0, 2000) : null,
    output: step.output != null ? String(step.output).slice(0, 2000) : null,
    durationMs: typeof step.durationMs === "number" ? step.durationMs : null,
    success: step.success !== false,
  }));
}

function computeStats(trajectoryPayload) {
  const steps = Array.isArray(trajectoryPayload?.steps) ? trajectoryPayload.steps : [];
  const toolCalls = steps.filter((s) => s.type === "tool_call" || (!s.type && s.tool));
  return {
    toolCallCount: toolCalls.length,
    iterationCount: typeof trajectoryPayload?.iterationCount === "number" ? trajectoryPayload.iterationCount : steps.length,
    totalCostUsd: typeof trajectoryPayload?.totalCostUsd === "number" ? trajectoryPayload.totalCostUsd : null,
    durationMs: typeof trajectoryPayload?.durationMs === "number" ? trajectoryPayload.durationMs : null,
    toolSequence: toolCalls.map((s) => s.name || s.tool || "unknown").slice(0, 50),
  };
}

async function callLlm(llmClient, sessionDataStr) {
  const prompt = `Analyze this agent session and provide: 1) a 2-3 sentence summary, 2) up to 5 improvement recommendations. Session data: ${sessionDataStr}. Respond with JSON: { "summary": string, "recommendations": [{ "title": string, "description": string, "priority": "high"|"medium"|"low" }] }`;

  try {
    let raw = "";
    if (typeof llmClient === "function") {
      raw = await llmClient(prompt);
    } else if (llmClient && typeof llmClient.complete === "function") {
      raw = await llmClient.complete(prompt);
    } else if (llmClient && typeof llmClient.chat === "function") {
      const resp = await llmClient.chat({ messages: [{ role: "user", content: prompt }], stream: false });
      raw = resp?.choices?.[0]?.message?.content || "";
    } else {
      return null;
    }

    const jsonMatch = String(raw).match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
      recommendations: Array.isArray(parsed.recommendations)
        ? parsed.recommendations.slice(0, 5).map((r) => ({
            title: String(r.title || ""),
            description: String(r.description || ""),
            priority: ["high", "medium", "low"].includes(r.priority) ? r.priority : "medium",
          }))
        : [],
    };
  } catch {
    return null;
  }
}

export async function generateInsights(workspaceId, runId, trajectoryPayload, llmClient) {
  const stats = computeStats(trajectoryPayload);
  const sessionDataStr = JSON.stringify({
    runId,
    toolCallCount: stats.toolCallCount,
    iterationCount: stats.iterationCount,
    totalCostUsd: stats.totalCostUsd,
    durationMs: stats.durationMs,
    toolSequence: stats.toolSequence,
    model: trajectoryPayload?.model,
    errorCount: Array.isArray(trajectoryPayload?.steps)
      ? trajectoryPayload.steps.filter((s) => s.type === "error" || s.success === false).length
      : 0,
  }).slice(0, MAX_SESSION_DATA_CHARS);

  const insightId = randomUUID();
  const generatedAt = Date.now();
  const timeline = buildTimelineFromPayload(trajectoryPayload);

  const record = {
    insightId,
    workspaceId: String(workspaceId),
    runId: String(runId),
    sessionId: trajectoryPayload?.sessionId || null,
    generatedAt,
    summary: "",
    toolCallCount: stats.toolCallCount,
    iterationCount: stats.iterationCount,
    totalCostUsd: stats.totalCostUsd,
    durationMs: stats.durationMs,
    recommendations: [],
    timeline,
    status: "pending",
  };

  const path = storePath(workspaceId);
  await withPathLock(path, async () => {
    const data = normalizeStore(await readJsonPath(path, null));
    data.insights = data.insights.filter((i) => i.runId !== runId);
    data.insights.unshift(record);
    data.insights = data.insights.slice(0, MAX_INSIGHTS);
    await writeJsonPath(path, data);
  });

  const llmResult = await callLlm(llmClient, sessionDataStr);

  record.summary = llmResult?.summary || `Agent run ${runId} completed ${stats.toolCallCount} tool calls across ${stats.iterationCount} iterations.`;
  record.recommendations = llmResult?.recommendations || [];
  record.status = llmResult ? "ready" : "failed";

  await withPathLock(path, async () => {
    const data = normalizeStore(await readJsonPath(path, null));
    const idx = data.insights.findIndex((i) => i.insightId === insightId);
    if (idx !== -1) {
      data.insights[idx] = record;
    }
    await writeJsonPath(path, data);
  });

  return record;
}

export async function getInsights(workspaceId, runId) {
  const path = storePath(workspaceId);
  const data = normalizeStore(await readJsonPath(path, null));
  return data.insights.find((i) => i.runId === runId) || null;
}

export async function listInsights(workspaceId, limit = 50) {
  const path = storePath(workspaceId);
  const data = normalizeStore(await readJsonPath(path, null));
  return data.insights.slice(0, Math.min(limit, MAX_INSIGHTS));
}

export async function getReplayTimeline(workspaceId, runId) {
  const insight = await getInsights(workspaceId, runId);
  return insight?.timeline || null;
}
