import test from "node:test";
import assert from "node:assert/strict";
import {
  recordAgentPhaseMs,
  recordAgentRunSummary,
  renderPrometheus,
} from "../lib/metrics.js";

test("agent phase and run summary metrics export when ENABLE_METRICS=1", () => {
  const prev = process.env.ENABLE_METRICS;
  process.env.ENABLE_METRICS = "1";
  const uniq = `utest_${Date.now()}`;
  recordAgentPhaseMs(uniq, "llm", 100);
  recordAgentPhaseMs(uniq, "tools", 50);
  recordAgentRunSummary(uniq, "model_finished");
  const text = renderPrometheus();
  assert.ok(text.includes("siskelbot_agent_phase_milliseconds_sum"));
  assert.ok(text.includes("siskelbot_agent_phase_samples_total"));
  assert.ok(text.includes("siskelbot_agent_runs_total"));
  assert.ok(text.includes(`mode="${uniq}"`) || text.includes(`mode="utest_`));
  process.env.ENABLE_METRICS = prev;
});
