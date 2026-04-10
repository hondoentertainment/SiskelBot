/**
 * Tests for lib/feedback.js — recordFeedback, getFeedbackStats, getFeedbackForModel, exportFeedback, listFeedback.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  recordFeedback,
  getFeedbackStats,
  getFeedbackForModel,
  exportFeedback,
  listFeedback,
} from "../lib/feedback.js";

const TEST_WS = "test-feedback-ws-" + Date.now();
const TEST_CONV = "conv-" + Date.now();
const TEST_USER = "test-user-fb";

// --- recordFeedback ---

test("recordFeedback stores feedback and returns id + createdAt", async () => {
  const result = await recordFeedback(TEST_CONV, 0, 4, "Great response", TEST_USER, {
    workspaceId: TEST_WS,
    model: "gpt-4o",
    prompt: "What is Node.js?",
    response: "Node.js is a JavaScript runtime.",
  });
  assert.ok(result.id);
  assert.ok(result.createdAt);
});

test("recordFeedback throws on missing conversationId", async () => {
  await assert.rejects(
    () => recordFeedback("", 0, 3, null, TEST_USER, { workspaceId: TEST_WS }),
    { message: "conversationId is required" }
  );
});

test("recordFeedback throws on invalid rating (0)", async () => {
  await assert.rejects(
    () => recordFeedback(TEST_CONV, 0, 0, null, TEST_USER, { workspaceId: TEST_WS }),
    { message: "rating must be an integer between 1 and 5" }
  );
});

test("recordFeedback throws on invalid rating (6)", async () => {
  await assert.rejects(
    () => recordFeedback(TEST_CONV, 0, 6, null, TEST_USER, { workspaceId: TEST_WS }),
    { message: "rating must be an integer between 1 and 5" }
  );
});

test("recordFeedback throws on non-integer rating (3.5)", async () => {
  await assert.rejects(
    () => recordFeedback(TEST_CONV, 0, 3.5, null, TEST_USER, { workspaceId: TEST_WS }),
    { message: "rating must be an integer between 1 and 5" }
  );
});

test("recordFeedback throws on negative messageIndex", async () => {
  await assert.rejects(
    () => recordFeedback(TEST_CONV, -1, 3, null, TEST_USER, { workspaceId: TEST_WS }),
    { message: "messageIndex must be a non-negative number" }
  );
});

test("recordFeedback with null comment stores null", async () => {
  const result = await recordFeedback(TEST_CONV, 1, 5, null, TEST_USER, {
    workspaceId: TEST_WS,
    model: "gpt-4o",
  });
  assert.ok(result.id);
  const items = await listFeedback(TEST_WS);
  const found = items.find((i) => i.id === result.id);
  assert.equal(found.comment, null);
});

// --- listFeedback ---

test("listFeedback returns stored entries", async () => {
  const items = await listFeedback(TEST_WS);
  assert.ok(Array.isArray(items));
  assert.ok(items.length >= 2);
});

test("listFeedback returns empty for nonexistent workspace", async () => {
  const items = await listFeedback("nonexistent-ws-" + Date.now());
  assert.ok(Array.isArray(items));
  assert.equal(items.length, 0);
});

// --- getFeedbackStats ---

test("getFeedbackStats returns correct structure", async () => {
  // Add a few more entries for stats
  await recordFeedback(TEST_CONV, 2, 3, null, TEST_USER, { workspaceId: TEST_WS, model: "gpt-4o" });
  await recordFeedback(TEST_CONV, 3, 2, "Could be better", TEST_USER, { workspaceId: TEST_WS, model: "llama3" });
  await recordFeedback(TEST_CONV, 4, 5, null, TEST_USER, { workspaceId: TEST_WS, model: "llama3" });

  const stats = await getFeedbackStats(TEST_WS);
  assert.ok(typeof stats.total === "number");
  assert.ok(stats.total >= 5);
  assert.ok(typeof stats.avgRating === "number");
  assert.ok(stats.avgRating >= 1 && stats.avgRating <= 5);
  assert.ok(typeof stats.distribution === "object");
  assert.ok(typeof stats.byModel === "object");
});

test("getFeedbackStats distribution sums to total", async () => {
  const stats = await getFeedbackStats(TEST_WS);
  const distSum = Object.values(stats.distribution).reduce((a, b) => a + b, 0);
  assert.equal(distSum, stats.total);
});

test("getFeedbackStats byModel contains known models", async () => {
  const stats = await getFeedbackStats(TEST_WS);
  assert.ok("gpt-4o" in stats.byModel);
  assert.ok("llama3" in stats.byModel);
  assert.ok(stats.byModel["gpt-4o"].total >= 1);
  assert.ok(typeof stats.byModel["gpt-4o"].avgRating === "number");
});

test("getFeedbackStats with period filter", async () => {
  const stats = await getFeedbackStats(TEST_WS, "1d");
  assert.ok(typeof stats.total === "number");
  // All entries were created just now, so should match total
  const allStats = await getFeedbackStats(TEST_WS);
  assert.equal(stats.total, allStats.total);
});

test("getFeedbackStats returns zeros for empty workspace", async () => {
  const stats = await getFeedbackStats("empty-ws-" + Date.now());
  assert.equal(stats.total, 0);
  assert.equal(stats.avgRating, 0);
});

// --- getFeedbackForModel ---

test("getFeedbackForModel returns entries for known model", async () => {
  const entries = await getFeedbackForModel("gpt-4o", 10, TEST_WS);
  assert.ok(Array.isArray(entries));
  assert.ok(entries.length >= 1);
  assert.ok(entries.every((e) => e.model === "gpt-4o"));
  assert.ok("rating" in entries[0]);
  assert.ok("createdAt" in entries[0]);
});

test("getFeedbackForModel returns empty for unknown model", async () => {
  const entries = await getFeedbackForModel("nonexistent-model", 10, TEST_WS);
  assert.equal(entries.length, 0);
});

test("getFeedbackForModel respects limit", async () => {
  const entries = await getFeedbackForModel("gpt-4o", 1, TEST_WS);
  assert.ok(entries.length <= 1);
});

// --- exportFeedback ---

test("exportFeedback json format", async () => {
  const result = await exportFeedback(TEST_WS, "json");
  assert.equal(result.contentType, "application/json");
  assert.ok(result.filename.endsWith(".json"));
  const parsed = JSON.parse(result.data);
  assert.ok(Array.isArray(parsed));
  assert.ok(parsed.length >= 1);
});

test("exportFeedback csv format", async () => {
  const result = await exportFeedback(TEST_WS, "csv");
  assert.equal(result.contentType, "text/csv");
  assert.ok(result.filename.endsWith(".csv"));
  const lines = result.data.split("\n");
  assert.ok(lines.length >= 2); // header + at least one row
  assert.ok(lines[0].includes("id"));
  assert.ok(lines[0].includes("rating"));
});

test("exportFeedback jsonl format", async () => {
  const result = await exportFeedback(TEST_WS, "jsonl");
  assert.equal(result.contentType, "application/x-ndjson");
  assert.ok(result.filename.endsWith(".jsonl"));
  const lines = result.data.split("\n").filter(Boolean);
  assert.ok(lines.length >= 1);
  const first = JSON.parse(lines[0]);
  assert.ok(first.id);
  assert.ok(first.rating);
});

test("exportFeedback defaults to json", async () => {
  const result = await exportFeedback(TEST_WS);
  assert.equal(result.contentType, "application/json");
});
