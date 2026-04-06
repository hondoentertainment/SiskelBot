import test from "node:test";
import assert from "node:assert/strict";

test.before(() => {
  process.env.STORAGE_PATH = "/tmp/usage-test-" + Date.now();
});

await test("recordUsage stores an entry", async () => {
  const { recordUsage, getTotalTokensInWindow } = await import("../lib/usage-tracker.js");
  await recordUsage({
    model: "gpt-4",
    inputTokens: 100,
    outputTokens: 50,
    backend: "openai",
    workspace: "ws1",
    userId: "user1",
  });
  const total = await getTotalTokensInWindow();
  assert.ok(total >= 150);
});

await test("recordUsage handles missing fields gracefully", async () => {
  const { recordUsage } = await import("../lib/usage-tracker.js");
  await recordUsage({});
  // Should not throw
});

await test("getSummary returns aggregated data", async () => {
  const { getSummary } = await import("../lib/usage-tracker.js");
  const summary = await getSummary(30);
  assert.ok(typeof summary.totalRequests === "number");
  assert.ok(summary.totalRequests >= 1);
  assert.ok(typeof summary.totalInputTokens === "number");
  assert.ok(typeof summary.totalOutputTokens === "number");
  assert.ok(typeof summary.totalTokens === "number");
  assert.equal(summary.totalTokens, summary.totalInputTokens + summary.totalOutputTokens);
  assert.ok(typeof summary.byModel === "object");
  assert.ok(typeof summary.byDay === "object");
  assert.equal(summary.days, 30);
});

await test("getSummary byModel tracks per-model stats", async () => {
  const { getSummary } = await import("../lib/usage-tracker.js");
  const summary = await getSummary(30);
  assert.ok(summary.byModel["gpt-4"]);
  assert.ok(summary.byModel["gpt-4"].requests >= 1);
});

await test("getTotalTokensInWindow returns total across all records", async () => {
  const { getTotalTokensInWindow } = await import("../lib/usage-tracker.js");
  const total = await getTotalTokensInWindow();
  assert.ok(typeof total === "number");
  assert.ok(total >= 150);
});

await test("getRecordsForPeriod filters by workspace", async () => {
  const { getRecordsForPeriod } = await import("../lib/usage-tracker.js");
  const records = await getRecordsForPeriod(30, { workspace: "ws1" });
  assert.ok(records.length >= 1);
  for (const r of records) {
    assert.equal(r.workspace, "ws1");
  }
});

await test("getRecordsForPeriod filters by userId", async () => {
  const { getRecordsForPeriod } = await import("../lib/usage-tracker.js");
  const records = await getRecordsForPeriod(30, { userId: "user1" });
  assert.ok(records.length >= 1);
  for (const r of records) {
    assert.equal(r.userId, "user1");
  }
});

await test("estimate.inputFromMessages counts tokens from messages", async () => {
  const { estimate } = await import("../lib/usage-tracker.js");
  const tokens = estimate.inputFromMessages([
    { role: "user", content: "Hello world" },
    { role: "assistant", content: "Hi there" },
  ]);
  assert.ok(typeof tokens === "number");
  assert.ok(tokens >= 1);
});

await test("estimate.inputFromMessages returns minimum 1 for empty array", async () => {
  const { estimate } = await import("../lib/usage-tracker.js");
  const tokens = estimate.inputFromMessages([]);
  // Empty messages still yields Math.max(1, 0) = 1 per the implementation
  assert.equal(tokens, 1);
});

await test("estimate.outputFromChars estimates tokens from char count", async () => {
  const { estimate } = await import("../lib/usage-tracker.js");
  const tokens = estimate.outputFromChars("a".repeat(100));
  assert.equal(tokens, 25);
});
