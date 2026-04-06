import test from "node:test";
import assert from "node:assert/strict";

test.before(() => {
  process.env.STORAGE_PATH = "/tmp/analytics-engine-test-" + Date.now();
});

await test("getUsageTrends returns dataPoints for 7d period", async () => {
  const { recordUsage } = await import("../lib/usage-tracker.js");
  // Seed data
  await recordUsage({ model: "gpt-4", inputTokens: 200, outputTokens: 100, backend: "openai", workspace: "ws-test", userId: "u1" });
  await recordUsage({ model: "gpt-4", inputTokens: 150, outputTokens: 80, backend: "openai", workspace: "ws-test", userId: "u2" });
  await recordUsage({ model: "llama3", inputTokens: 300, outputTokens: 200, backend: "ollama", workspace: "ws-test", userId: "u1" });

  const { getUsageTrends } = await import("../lib/analytics-engine.js");
  const result = await getUsageTrends("ws-test", "7d", "day");
  assert.ok(result.dataPoints);
  assert.ok(Array.isArray(result.dataPoints));
  assert.ok(result.dataPoints.length > 0);
  // Each data point has the required fields
  const dp = result.dataPoints.find(d => d.requests > 0);
  assert.ok(dp, "should have at least one datapoint with requests");
  assert.ok(typeof dp.timestamp === "string");
  assert.ok(typeof dp.requests === "number");
  assert.ok(typeof dp.tokens === "number");
  assert.ok(typeof dp.cost === "number");
  assert.ok(typeof dp.errors === "number");
});

await test("getUsageTrends with hourly granularity", async () => {
  const { getUsageTrends } = await import("../lib/analytics-engine.js");
  const result = await getUsageTrends("ws-test", "24h", "hour");
  assert.ok(result.dataPoints);
  assert.ok(result.dataPoints.length > 0);
  // Hourly keys include 'T' followed by hour
  const dp = result.dataPoints.find(d => d.requests > 0);
  if (dp) assert.ok(dp.timestamp.includes("T"), "hourly timestamp should include T");
});

await test("getUsageTrends with weekly granularity", async () => {
  const { getUsageTrends } = await import("../lib/analytics-engine.js");
  const result = await getUsageTrends(undefined, "30d", "week");
  assert.ok(result.dataPoints);
  assert.ok(result.dataPoints.length > 0);
});

await test("getUsageTrends with no workspace returns all data", async () => {
  const { getUsageTrends } = await import("../lib/analytics-engine.js");
  const result = await getUsageTrends(undefined, "7d", "day");
  assert.ok(result.dataPoints);
  const total = result.dataPoints.reduce((s, d) => s + d.requests, 0);
  assert.ok(total >= 3, "should include all 3 seeded records");
});

await test("getTopModels returns model usage sorted by tokens", async () => {
  const { getTopModels } = await import("../lib/analytics-engine.js");
  const models = await getTopModels("ws-test", "7d");
  assert.ok(Array.isArray(models));
  assert.ok(models.length >= 2, "should have at least gpt-4 and llama3");
  // First model should have most tokens
  assert.ok(models[0].tokens >= models[models.length - 1].tokens);
  // Each entry has required fields
  for (const m of models) {
    assert.ok(typeof m.model === "string");
    assert.ok(typeof m.requests === "number");
    assert.ok(typeof m.tokens === "number");
    assert.ok(typeof m.avgLatency === "number");
  }
});

await test("getTopModels returns empty array when no data matches", async () => {
  const { getTopModels } = await import("../lib/analytics-engine.js");
  const models = await getTopModels("nonexistent-workspace", "7d");
  assert.ok(Array.isArray(models));
  assert.equal(models.length, 0);
});

await test("getTopUsers returns user data sorted by tokens", async () => {
  const { getTopUsers } = await import("../lib/analytics-engine.js");
  const users = await getTopUsers("ws-test", "7d");
  assert.ok(Array.isArray(users));
  assert.ok(users.length >= 1);
  for (const u of users) {
    assert.ok(typeof u.userId === "string");
    assert.ok(typeof u.requests === "number");
    assert.ok(typeof u.tokens === "number");
  }
});

await test("getCostEstimate calculates cost with breakdown", async () => {
  const { getCostEstimate } = await import("../lib/analytics-engine.js");
  const result = await getCostEstimate("ws-test", "7d");
  assert.ok(typeof result.totalTokens === "number");
  assert.ok(result.totalTokens > 0);
  assert.ok(typeof result.estimatedCost === "number");
  assert.ok(typeof result.breakdown === "object");
  // gpt-4 (openai backend) should have nonzero cost
  assert.ok(result.breakdown["gpt-4"] > 0, "gpt-4 should have nonzero cost");
  // llama3 (ollama backend) should have zero cost
  assert.equal(result.breakdown["llama3"], 0, "ollama model should have $0 cost");
});

await test("getCostEstimate returns zero for all-local backends", async () => {
  const { getCostEstimate } = await import("../lib/analytics-engine.js");
  // Use nonexistent workspace to get empty results
  const result = await getCostEstimate("nonexistent", "7d");
  assert.equal(result.totalTokens, 0);
  assert.equal(result.estimatedCost, 0);
  assert.deepEqual(result.breakdown, {});
});

await test("getAgentStats returns agent statistics structure", async () => {
  const { getAgentStats } = await import("../lib/analytics-engine.js");
  const result = await getAgentStats("ws-test", "7d");
  assert.ok(typeof result.totalRuns === "number");
  assert.ok(typeof result.avgIterations === "number");
  assert.ok(typeof result.toolUsage === "object");
  assert.ok(typeof result.successRate === "number");
  assert.ok(typeof result.avgDuration === "number");
  // No agent records in seed data, so defaults
  assert.equal(result.totalRuns, 0);
  assert.equal(result.successRate, 100);
});

await test("getErrorBreakdown returns empty array when no errors", async () => {
  const { getErrorBreakdown } = await import("../lib/analytics-engine.js");
  const result = await getErrorBreakdown("ws-test", "7d");
  assert.ok(Array.isArray(result));
  assert.equal(result.length, 0);
});

await test("period parsing defaults to 7 days for unknown period", async () => {
  const { getUsageTrends } = await import("../lib/analytics-engine.js");
  const result = await getUsageTrends(undefined, "unknown", "day");
  assert.ok(result.dataPoints);
  assert.ok(result.dataPoints.length > 0);
});

await test("granularity defaults to day for unknown value", async () => {
  const { getUsageTrends } = await import("../lib/analytics-engine.js");
  const result = await getUsageTrends(undefined, "7d", "invalid");
  assert.ok(result.dataPoints);
  assert.ok(result.dataPoints.length > 0);
});
