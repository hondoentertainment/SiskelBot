/**
 * Tests for Prometheus metrics on agent tool failures, outcomes, and swarm
 * conflicts.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.ENABLE_METRICS = "1";

const {
  recordToolFailure,
  recordToolOutcome,
  recordSwarmConflict,
  renderPrometheus,
  __resetAgentQualityMetricsForTests,
  __getAgentQualityMetricsForTests,
} = await import("../lib/metrics.js");

test("recordToolFailure: accumulates per (tool, category)", () => {
  __resetAgentQualityMetricsForTests();
  recordToolFailure("web_search", "rate_limit");
  recordToolFailure("web_search", "rate_limit");
  recordToolFailure("web_search", "timeout");
  recordToolFailure("fetch_allowed_url", "permission");
  const snap = __getAgentQualityMetricsForTests();
  assert.equal(snap.failures["web_search\x00rate_limit"], 2);
  assert.equal(snap.failures["web_search\x00timeout"], 1);
  assert.equal(snap.failures["fetch_allowed_url\x00permission"], 1);
});

test("recordToolOutcome: increments success / failure buckets", () => {
  __resetAgentQualityMetricsForTests();
  recordToolOutcome("search_context", true);
  recordToolOutcome("search_context", true);
  recordToolOutcome("search_context", false);
  recordToolOutcome("web_search", false);
  const snap = __getAgentQualityMetricsForTests();
  assert.equal(snap.outcomes["search_context\x00success"], 2);
  assert.equal(snap.outcomes["search_context\x00failure"], 1);
  assert.equal(snap.outcomes["web_search\x00failure"], 1);
});

test("recordSwarmConflict: increments by type", () => {
  __resetAgentQualityMetricsForTests();
  recordSwarmConflict("polarity");
  recordSwarmConflict("polarity");
  recordSwarmConflict("numeric");
  recordSwarmConflict("divergent");
  const snap = __getAgentQualityMetricsForTests();
  assert.equal(snap.conflicts.polarity, 2);
  assert.equal(snap.conflicts.numeric, 1);
  assert.equal(snap.conflicts.divergent, 1);
});

test("renderPrometheus: emits siskelbot_agent_tool_failure_total samples", () => {
  __resetAgentQualityMetricsForTests();
  recordToolFailure("web_search", "rate_limit");
  const out = renderPrometheus();
  assert.match(out, /# TYPE siskelbot_agent_tool_failure_total counter/);
  assert.match(
    out,
    /siskelbot_agent_tool_failure_total\{tool="web_search",category="rate_limit"\} 1/,
  );
});

test("renderPrometheus: emits siskelbot_agent_tool_outcome_total samples", () => {
  __resetAgentQualityMetricsForTests();
  recordToolOutcome("list_context", true);
  recordToolOutcome("list_context", false);
  const out = renderPrometheus();
  assert.match(out, /siskelbot_agent_tool_outcome_total\{tool="list_context",outcome="success"\} 1/);
  assert.match(out, /siskelbot_agent_tool_outcome_total\{tool="list_context",outcome="failure"\} 1/);
});

test("renderPrometheus: emits siskelbot_swarm_conflict_total samples", () => {
  __resetAgentQualityMetricsForTests();
  recordSwarmConflict("polarity");
  const out = renderPrometheus();
  assert.match(out, /# TYPE siskelbot_swarm_conflict_total counter/);
  assert.match(out, /siskelbot_swarm_conflict_total\{type="polarity"\} 1/);
});

test("record functions are no-ops when ENABLE_METRICS=0", async () => {
  const orig = process.env.ENABLE_METRICS;
  process.env.ENABLE_METRICS = "0";
  __resetAgentQualityMetricsForTests();
  recordToolFailure("x", "permission");
  recordToolOutcome("x", true);
  recordSwarmConflict("polarity");
  const snap = __getAgentQualityMetricsForTests();
  assert.equal(Object.keys(snap.failures).length, 0);
  assert.equal(Object.keys(snap.outcomes).length, 0);
  assert.equal(Object.keys(snap.conflicts).length, 0);
  if (orig !== undefined) process.env.ENABLE_METRICS = orig;
  else delete process.env.ENABLE_METRICS;
});

test("label sanitization: malicious label chars do not break Prometheus output", () => {
  __resetAgentQualityMetricsForTests();
  recordToolFailure('bad"tool\\name', "rate_limit");
  const out = renderPrometheus();
  // Each emitted line must still parse as one sample (tool label is sanitized).
  const samples = out.split("\n").filter((l) => l.startsWith("siskelbot_agent_tool_failure_total{"));
  assert.ok(samples.length >= 1);
  // Count quote chars in the sample line; must be exactly 4 (two label values wrapped)
  const quotes = samples[0].match(/"/g) || [];
  assert.equal(quotes.length, 4, `sample line should have 4 quote chars, got: ${samples[0]}`);
});
