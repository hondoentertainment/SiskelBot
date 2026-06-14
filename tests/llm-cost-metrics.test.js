/**
 * Tests for per-workspace LLM token + cost Prometheus metrics
 * (siskelbot_llm_tokens_total, siskelbot_llm_cost_usd_total).
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.ENABLE_METRICS = "1";

const { parseCostConfig } = await import("../lib/smart-router.js");
const {
  recordLlmUsage,
  renderPrometheus,
  __resetLlmUsageMetricsForTests,
} = await import("../lib/metrics.js");

// Seed MODEL_COSTS so cost calculation has known values for these tests.
parseCostConfig("gpt-4o:0.005,gpt-4o-mini:0.0006");

function withWorkspaceLabelEnabled(fn) {
  const prev = process.env.METRICS_WORKSPACE_LABEL;
  process.env.METRICS_WORKSPACE_LABEL = "1";
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.METRICS_WORKSPACE_LABEL;
    else process.env.METRICS_WORKSPACE_LABEL = prev;
  }
}

test("recordLlmUsage accumulates input + output tokens per (workspace, model)", () => {
  __resetLlmUsageMetricsForTests();
  withWorkspaceLabelEnabled(() => {
    recordLlmUsage({
      workspaceId: "ws_alpha",
      model: "gpt-4o",
      inputTokens: 100,
      outputTokens: 50,
    });
    recordLlmUsage({
      workspaceId: "ws_alpha",
      model: "gpt-4o",
      inputTokens: 30,
      outputTokens: 70,
    });
    recordLlmUsage({
      workspaceId: "ws_beta",
      model: "gpt-4o-mini",
      inputTokens: 200,
      outputTokens: 100,
    });

    const out = renderPrometheus();
    assert.match(
      out,
      /siskelbot_llm_tokens_total\{workspace="ws_alpha",model="gpt_4o",direction="input"\} 130/
    );
    assert.match(
      out,
      /siskelbot_llm_tokens_total\{workspace="ws_alpha",model="gpt_4o",direction="output"\} 120/
    );
    assert.match(
      out,
      /siskelbot_llm_tokens_total\{workspace="ws_beta",model="gpt_4o_mini",direction="input"\} 200/
    );
    assert.match(
      out,
      /siskelbot_llm_tokens_total\{workspace="ws_beta",model="gpt_4o_mini",direction="output"\} 100/
    );
  });
});

test("recordLlmUsage computes cost using MODEL_COSTS for known models", () => {
  __resetLlmUsageMetricsForTests();
  withWorkspaceLabelEnabled(() => {
    // 1000 + 1000 = 2000 tokens, gpt-4o cost = $0.005 / 1K tokens
    // expected: (2000 / 1000) * 0.005 = $0.01
    recordLlmUsage({
      workspaceId: "ws_cost",
      model: "gpt-4o",
      inputTokens: 1000,
      outputTokens: 1000,
    });

    const out = renderPrometheus();
    const match = out.match(
      /siskelbot_llm_cost_usd_total\{workspace="ws_cost"\} ([\d.]+)/
    );
    assert.ok(match, "expected cost line for ws_cost");
    const cost = Number(match[1]);
    assert.ok(
      Math.abs(cost - 0.01) < 1e-6,
      `expected ~$0.010000, got ${match[1]}`
    );
  });
});

test("recordLlmUsage records tokens but cost = 0 for unknown models", () => {
  __resetLlmUsageMetricsForTests();
  withWorkspaceLabelEnabled(() => {
    recordLlmUsage({
      workspaceId: "ws_unknown",
      model: "some-unmapped-model",
      inputTokens: 500,
      outputTokens: 250,
    });

    const out = renderPrometheus();
    assert.match(
      out,
      /siskelbot_llm_tokens_total\{workspace="ws_unknown",model="some_unmapped_model",direction="input"\} 500/
    );
    assert.match(
      out,
      /siskelbot_llm_tokens_total\{workspace="ws_unknown",model="some_unmapped_model",direction="output"\} 250/
    );
    // No cost line should be emitted for ws_unknown when cost is 0.
    assert.doesNotMatch(
      out,
      /siskelbot_llm_cost_usd_total\{workspace="ws_unknown"\}/
    );
  });
});

test("renderPrometheus emits HELP/TYPE for siskelbot_llm_tokens_total and siskelbot_llm_cost_usd_total", () => {
  __resetLlmUsageMetricsForTests();
  withWorkspaceLabelEnabled(() => {
    recordLlmUsage({
      workspaceId: "ws_help",
      model: "gpt-4o",
      inputTokens: 10,
      outputTokens: 20,
    });
    const out = renderPrometheus();
    assert.match(
      out,
      /# HELP siskelbot_llm_tokens_total Tokens consumed by workspace, model, and direction/
    );
    assert.match(out, /# TYPE siskelbot_llm_tokens_total counter/);
    assert.match(
      out,
      /# HELP siskelbot_llm_cost_usd_total Cumulative LLM cost in USD by workspace/
    );
    assert.match(out, /# TYPE siskelbot_llm_cost_usd_total counter/);
  });
});

test("with METRICS_WORKSPACE_LABEL unset, workspace label is 'aggregated'", () => {
  __resetLlmUsageMetricsForTests();
  const prev = process.env.METRICS_WORKSPACE_LABEL;
  delete process.env.METRICS_WORKSPACE_LABEL;
  try {
    recordLlmUsage({
      workspaceId: "ws_should_be_hidden",
      model: "gpt-4o",
      inputTokens: 100,
      outputTokens: 100,
    });
    recordLlmUsage({
      workspaceId: "ws_other",
      model: "gpt-4o",
      inputTokens: 50,
      outputTokens: 50,
    });

    const out = renderPrometheus();
    // Real workspace ids must NOT appear in the output.
    assert.doesNotMatch(out, /ws_should_be_hidden/);
    assert.doesNotMatch(out, /ws_other/);
    // Everything is collapsed under workspace="aggregated".
    assert.match(
      out,
      /siskelbot_llm_tokens_total\{workspace="aggregated",model="gpt_4o",direction="input"\} 150/
    );
    assert.match(
      out,
      /siskelbot_llm_tokens_total\{workspace="aggregated",model="gpt_4o",direction="output"\} 150/
    );
    assert.match(
      out,
      /siskelbot_llm_cost_usd_total\{workspace="aggregated"\} [\d.]+/
    );
  } finally {
    if (prev === undefined) delete process.env.METRICS_WORKSPACE_LABEL;
    else process.env.METRICS_WORKSPACE_LABEL = prev;
  }
});
