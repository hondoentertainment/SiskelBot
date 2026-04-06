import test from "node:test";
import assert from "node:assert/strict";

test.before(() => {
  process.env.STORAGE_PATH = "/tmp/analytics-test-" + Date.now();
});

await test("estimateCost returns 0 for local backends", async () => {
  const { estimateCost } = await import("../lib/analytics.js");
  const ollamaResult = estimateCost(1000, 500, "ollama");
  assert.equal(ollamaResult.cost, 0);
  assert.equal(ollamaResult.source, "local");

  const vllmResult = estimateCost(1000, 500, "vllm");
  assert.equal(vllmResult.cost, 0);
  assert.equal(vllmResult.source, "local");
});

await test("estimateCost returns positive cost for openai", async () => {
  const { estimateCost } = await import("../lib/analytics.js");
  const result = estimateCost(10000, 5000, "openai");
  assert.ok(result.cost > 0);
  assert.equal(result.source, "openai");
});

await test("estimateCost handles zero tokens", async () => {
  const { estimateCost } = await import("../lib/analytics.js");
  const result = estimateCost(0, 0, "openai");
  assert.equal(result.cost, 0);
});

await test("exportToCsv produces valid CSV", async () => {
  const { exportToCsv } = await import("../lib/analytics.js");
  const records = [
    { timestamp: "2025-01-01T00:00:00Z", model: "gpt-4", inputTokens: 100, outputTokens: 50, backend: "openai", workspace: "default", userId: "user1" },
    { timestamp: "2025-01-02T00:00:00Z", model: "llama3", inputTokens: 200, outputTokens: 100, backend: "ollama" },
  ];
  const csv = exportToCsv(records);
  const lines = csv.split("\n");
  assert.equal(lines[0], "timestamp,model,inputTokens,outputTokens,backend,workspace,userId");
  assert.equal(lines.length, 3);
  assert.ok(lines[1].includes("gpt-4"));
  assert.ok(lines[2].includes("llama3"));
});

await test("exportToCsv escapes commas in values", async () => {
  const { exportToCsv } = await import("../lib/analytics.js");
  const records = [
    { timestamp: "2025-01-01", model: "model,with,commas", inputTokens: 10, outputTokens: 5, backend: "test" },
  ];
  const csv = exportToCsv(records);
  assert.ok(csv.includes('"model,with,commas"'));
});

await test("exportToJson returns valid JSON string", async () => {
  const { exportToJson } = await import("../lib/analytics.js");
  const data = { totalRequests: 10, totalTokens: 500 };
  const json = exportToJson(data);
  const parsed = JSON.parse(json);
  assert.equal(parsed.totalRequests, 10);
  assert.equal(parsed.totalTokens, 500);
});

await test("getDashboard returns expected structure", async () => {
  // First record some usage
  const { recordUsage } = await import("../lib/usage-tracker.js");
  await recordUsage({ model: "gpt-4", inputTokens: 100, outputTokens: 50, backend: "openai" });

  const { getDashboard } = await import("../lib/analytics.js");
  const dashboard = await getDashboard(7);
  assert.ok(typeof dashboard.totalRequests === "number");
  assert.ok(typeof dashboard.totalTokens === "number");
  assert.ok(typeof dashboard.totalCost === "number");
  assert.equal(dashboard.days, 7);
  assert.ok(typeof dashboard.byModel === "object");
  assert.ok(typeof dashboard.byDay === "object");
  assert.ok(dashboard.conversationStats);
  assert.ok(Array.isArray(dashboard.topModels));
});
