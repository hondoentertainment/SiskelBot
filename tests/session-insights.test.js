import test from "node:test";
import assert from "node:assert/strict";
import {
  generateInsights,
  getInsights,
  listInsights,
  getReplayTimeline,
} from "../lib/session-insights.js";

const ws = () => `test-ws-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const run = () => `run-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const sampleTrajectory = {
  sessionId: "sess-123",
  iterationCount: 5,
  totalCostUsd: 0.02,
  durationMs: 3000,
  steps: [
    { type: "tool_call", name: "readFile", input: "path/to/file", output: "content", durationMs: 100, success: true, at: 1000 },
    { type: "tool_call", name: "writeFile", input: "path/to/file", output: "ok", durationMs: 150, success: true, at: 1100 },
    { type: "error", name: "failedTool", success: false, at: 1200 },
  ],
};

test("generateInsights creates insight record with stats", async () => {
  const workspaceId = ws();
  const runId = run();
  const insight = await generateInsights(workspaceId, runId, sampleTrajectory, null);
  assert.equal(insight.workspaceId, workspaceId);
  assert.equal(insight.runId, runId);
  assert.equal(insight.sessionId, "sess-123");
  assert.ok(typeof insight.insightId === "string");
  assert.ok(typeof insight.summary === "string" && insight.summary.length > 0);
  assert.equal(insight.toolCallCount, 2);
});

test("generateInsights with llmClient function", async () => {
  const workspaceId = ws();
  const runId = run();
  const llmResult = JSON.stringify({
    summary: "The agent performed file operations.",
    recommendations: [{ title: "Improve error handling", description: "Catch errors.", priority: "high" }],
  });
  const llmClient = async () => llmResult;
  const insight = await generateInsights(workspaceId, runId, sampleTrajectory, llmClient);
  assert.equal(insight.summary, "The agent performed file operations.");
  assert.equal(insight.recommendations.length, 1);
  assert.equal(insight.recommendations[0].priority, "high");
  assert.equal(insight.status, "ready");
});

test("generateInsights with llmClient.complete method", async () => {
  const workspaceId = ws();
  const runId = run();
  const llmClient = {
    complete: async () => JSON.stringify({ summary: "Done via complete.", recommendations: [] }),
  };
  const insight = await generateInsights(workspaceId, runId, sampleTrajectory, llmClient);
  assert.equal(insight.summary, "Done via complete.");
  assert.equal(insight.status, "ready");
});

test("generateInsights with llmClient.chat method", async () => {
  const workspaceId = ws();
  const runId = run();
  const llmClient = {
    chat: async () => ({ choices: [{ message: { content: JSON.stringify({ summary: "Done via chat.", recommendations: [] }) } }] }),
  };
  const insight = await generateInsights(workspaceId, runId, sampleTrajectory, llmClient);
  assert.equal(insight.summary, "Done via chat.");
});

test("getInsights retrieves previously generated insight", async () => {
  const workspaceId = ws();
  const runId = run();
  await generateInsights(workspaceId, runId, sampleTrajectory, null);
  const insight = await getInsights(workspaceId, runId);
  assert.ok(insight !== null);
  assert.equal(insight.runId, runId);
});

test("getInsights returns null for nonexistent run", async () => {
  const workspaceId = ws();
  const result = await getInsights(workspaceId, "nonexistent-run");
  assert.equal(result, null);
});

test("listInsights returns all insights up to limit", async () => {
  const workspaceId = ws();
  const run1 = run();
  const run2 = run();
  await generateInsights(workspaceId, run1, sampleTrajectory, null);
  await generateInsights(workspaceId, run2, sampleTrajectory, null);
  const list = await listInsights(workspaceId);
  assert.ok(list.length >= 2);
});

test("getReplayTimeline returns timeline steps", async () => {
  const workspaceId = ws();
  const runId = run();
  await generateInsights(workspaceId, runId, sampleTrajectory, null);
  const timeline = await getReplayTimeline(workspaceId, runId);
  assert.ok(Array.isArray(timeline));
  assert.ok(timeline.length > 0);
  assert.ok(timeline[0].type);
  assert.ok(timeline[0].name);
});

test("getReplayTimeline returns null for nonexistent run", async () => {
  const workspaceId = ws();
  const result = await getReplayTimeline(workspaceId, "no-such-run");
  assert.equal(result, null);
});

test("generateInsights handles empty trajectory", async () => {
  const workspaceId = ws();
  const runId = run();
  const insight = await generateInsights(workspaceId, runId, {}, null);
  assert.ok(typeof insight.summary === "string");
  assert.equal(insight.toolCallCount, 0);
});

test("generateInsights with invalid llmClient response falls back to default summary", async () => {
  const workspaceId = ws();
  const runId = run();
  const llmClient = async () => "not valid json {{";
  const insight = await generateInsights(workspaceId, runId, sampleTrajectory, llmClient);
  assert.ok(typeof insight.summary === "string" && insight.summary.length > 0);
  assert.equal(insight.status, "failed");
});
