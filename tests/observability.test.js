import test from "node:test";
import assert from "node:assert/strict";
import {
  recordLatency,
  recordAgentRun,
  recordTokenUsage,
  getMetricsSummary,
  getLatencyPercentiles,
  getErrorRates,
  getAgentStats,
  getTokenUsageByWorkspace,
  _resetBuckets,
  MAX_BUCKETS,
  minuteTs,
} from "../lib/observability.js";

// Reset before each test
test.beforeEach(() => {
  _resetBuckets();
});

// --- recordLatency & getLatencyPercentiles ---

test("recordLatency: records and getLatencyPercentiles returns correct percentiles", () => {
  // Record 100 requests with increasing latency
  for (let i = 1; i <= 100; i++) {
    recordLatency("/api/v1/chat", "POST", i, 200);
  }

  const result = getLatencyPercentiles(60);
  assert.ok(result.overall);
  assert.equal(result.overall.count, 100);
  assert.ok(result.overall.p50 > 0);
  assert.ok(result.overall.p95 >= result.overall.p50);
  assert.ok(result.overall.p99 >= result.overall.p95);
  assert.equal(result.overall.avg, 51); // avg of 1..100 is 50.5, rounded to 51
});

test("recordLatency: tracks by route", () => {
  recordLatency("/api/v1/chat", "POST", 10, 200);
  recordLatency("/api/v1/chat", "POST", 20, 200);
  recordLatency("/api/v1/workspaces", "GET", 5, 200);

  const result = getLatencyPercentiles(60);
  assert.ok(result.byRoute["POST /api/v1/chat"]);
  assert.equal(result.byRoute["POST /api/v1/chat"].count, 2);
  assert.ok(result.byRoute["GET /api/v1/workspaces"]);
  assert.equal(result.byRoute["GET /api/v1/workspaces"].count, 1);
});

test("getLatencyPercentiles: returns zeros when no data", () => {
  const result = getLatencyPercentiles(60);
  assert.equal(result.overall.count, 0);
  assert.equal(result.overall.p50, 0);
  assert.equal(result.overall.avg, 0);
});

// --- recordLatency status codes & getErrorRates ---

test("getErrorRates: tracks 4xx and 5xx", () => {
  recordLatency("/a", "GET", 1, 200);
  recordLatency("/a", "GET", 1, 200);
  recordLatency("/a", "GET", 1, 400);
  recordLatency("/a", "GET", 1, 404);
  recordLatency("/a", "GET", 1, 500);

  const errors = getErrorRates(60);
  assert.equal(errors.total, 5);
  assert.equal(errors.errors4xx, 2);
  assert.equal(errors.errors5xx, 1);
  assert.equal(errors.rate4xx, 0.4);
  assert.equal(errors.rate5xx, 0.2);
});

test("getErrorRates: returns zeros when no data", () => {
  const errors = getErrorRates(60);
  assert.equal(errors.total, 0);
  assert.equal(errors.rate4xx, 0);
  assert.equal(errors.rate5xx, 0);
});

test("getErrorRates: byMinute is an array", () => {
  recordLatency("/a", "GET", 1, 200);
  const errors = getErrorRates(60);
  assert.ok(Array.isArray(errors.byMinute));
  assert.ok(errors.byMinute.length > 0);
  assert.ok(errors.byMinute[0].minute);
});

// --- recordAgentRun & getAgentStats ---

test("recordAgentRun: records and getAgentStats returns correct stats", () => {
  recordAgentRun("ws-1", 5, 1000, false);
  recordAgentRun("ws-1", 10, 2000, true);
  recordAgentRun("ws-2", 3, 500, false);

  const stats = getAgentStats(60);
  assert.equal(stats.totalRuns, 3);
  assert.equal(stats.avgToolCalls, 6); // (5+10+3)/3 = 6
  assert.equal(stats.avgDurationMs, 1167); // (1000+2000+500)/3 ~= 1167
  assert.equal(stats.stagnationRate, 0.3333); // 1/3
});

test("getAgentStats: returns zeros when no data", () => {
  const stats = getAgentStats(60);
  assert.equal(stats.totalRuns, 0);
  assert.equal(stats.avgToolCalls, 0);
  assert.equal(stats.stagnationRate, 0);
});

test("getAgentStats: byMinute is an array", () => {
  recordAgentRun("ws-1", 5, 1000, false);
  const stats = getAgentStats(60);
  assert.ok(Array.isArray(stats.byMinute));
});

// --- recordTokenUsage & getTokenUsageByWorkspace ---

test("recordTokenUsage: records and aggregates by workspace and model", () => {
  recordTokenUsage("ws-1", "gpt-4o", 100);
  recordTokenUsage("ws-1", "gpt-4o", 50);
  recordTokenUsage("ws-1", "gpt-3.5-turbo", 200);
  recordTokenUsage("ws-2", "gpt-4o", 300);

  const usage = getTokenUsageByWorkspace(60);
  assert.equal(usage.total, 650);
  assert.equal(usage.byWorkspace["ws-1"].total, 350);
  assert.equal(usage.byWorkspace["ws-1"].byModel["gpt-4o"], 150);
  assert.equal(usage.byWorkspace["ws-1"].byModel["gpt-3.5-turbo"], 200);
  assert.equal(usage.byWorkspace["ws-2"].total, 300);
  assert.equal(usage.byModel["gpt-4o"], 450);
  assert.equal(usage.byModel["gpt-3.5-turbo"], 200);
});

test("getTokenUsageByWorkspace: returns zeros when no data", () => {
  const usage = getTokenUsageByWorkspace(60);
  assert.equal(usage.total, 0);
  assert.deepEqual(usage.byWorkspace, {});
  assert.deepEqual(usage.byModel, {});
});

// --- getMetricsSummary ---

test("getMetricsSummary: returns full summary object", () => {
  recordLatency("/api/v1/chat", "POST", 50, 200);
  recordAgentRun("ws-1", 3, 500, false);
  recordTokenUsage("ws-1", "llama3", 1000);

  const summary = getMetricsSummary(60);
  assert.ok(summary.latency);
  assert.ok(summary.errors);
  assert.ok(summary.agents);
  assert.ok(summary.tokens);
  assert.equal(summary.windowMinutes, 60);
  assert.ok(summary.requestsPerSec >= 0);
  assert.equal(summary.totalRequests, 1);
});

test("getMetricsSummary: respects windowMinutes parameter", () => {
  recordLatency("/a", "GET", 1, 200);
  // With 1 minute window the current bucket should be included
  const summary = getMetricsSummary(1);
  assert.equal(summary.windowMinutes, 1);
  assert.equal(summary.totalRequests, 1);
});

// --- Bucket rotation ---

test("MAX_BUCKETS is 60", () => {
  assert.equal(MAX_BUCKETS, 60);
});

test("minuteTs: returns minute-aligned timestamp", () => {
  const ts = minuteTs(1700000000000);
  assert.equal(ts % 60000, 0);
  assert.ok(ts <= 1700000000000);
  assert.ok(ts > 1700000000000 - 60000);
});

test("_resetBuckets: clears all data", () => {
  recordLatency("/a", "GET", 1, 200);
  _resetBuckets();
  const result = getLatencyPercentiles(60);
  assert.equal(result.overall.count, 0);
});
