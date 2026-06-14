// CHAOS TEST: agent loop tool always returns "no progress" (runaway tool calls)
// EXPECTED: stagnation detector trips within AGENT_STAGNATION_WINDOW iterations, the loop terminates with stop_reason="stagnation" (not a crash), and the terminate reason is recorded in metrics.
//
// Run with: npm run test:chaos
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";

// Force stagnation detection on, recovery off, and a small window for fast tests.
const ORIGINAL_STAGNATION_STOP = process.env.AGENT_STAGNATION_STOP;
const ORIGINAL_STAGNATION_RECOVERY = process.env.AGENT_STAGNATION_RECOVERY;
const ORIGINAL_STAGNATION_WINDOW = process.env.AGENT_STAGNATION_WINDOW;
const ORIGINAL_ENABLE_METRICS = process.env.ENABLE_METRICS;
delete process.env.AGENT_STAGNATION_STOP; // default = on
delete process.env.AGENT_STAGNATION_RECOVERY; // default = off
process.env.AGENT_STAGNATION_WINDOW = "4";
process.env.ENABLE_METRICS = "1";

const {
  buildStagnationHistory,
  computeFingerprint,
  stagnationDetectionEnabled,
  stagnationRecoveryEnabled,
} = await import("../../lib/agent-stagnation.js");
const { recordAgentRunSummary, getAgentRunSummarySnapshot } = await import(
  "../../lib/metrics.js"
);

/**
 * Minimal agent-loop emulator that mirrors the real loop's stagnation contract:
 *   - Every iteration the "tool" returns the same fingerprint ("no progress").
 *   - The loop appends fingerprints, runs detectStagnation, and breaks on
 *     stagnation with stopReason="stagnation".
 *   - If the iteration budget is exhausted first, stopReason="max_iterations".
 *
 * @param {() => { name: string, args: object }[]} alwaysSameTool
 * @param {{ maxIterations: number, windowSize?: number }} opts
 */
function emulateAgentLoop(alwaysSameTool, { maxIterations, windowSize = 4 }) {
  const tracker = buildStagnationHistory();
  let stopReason = "model_finished";
  let iterationsRun = 0;
  let lastContent = "";

  for (let i = 1; i <= maxIterations; i++) {
    iterationsRun = i;
    const toolCalls = alwaysSameTool();
    if (stagnationDetectionEnabled()) {
      tracker.append(computeFingerprint(toolCalls), i);
      const check = tracker.check({ windowSize });
      if (check.stagnant) {
        if (stagnationRecoveryEnabled()) {
          // recovery would inject a system message; we still terminate here for
          // the chaos test since the fake tool keeps returning the same call.
        }
        lastContent = `(Agent stopped: ${check.reason || "repeated tool calls with no progress"})`;
        stopReason = "stagnation";
        // Mirror the production behavior: emit a run-summary metric so dashboards see the stop.
        recordAgentRunSummary("agent", "stagnation");
        return { stopReason, iterationsRun, lastContent, detail: check };
      }
    }
  }

  if (iterationsRun >= maxIterations) {
    lastContent = "(Agent reached max iterations without final response)";
    stopReason = "max_iterations";
    recordAgentRunSummary("agent", "max_iterations");
  }

  return { stopReason, iterationsRun, lastContent };
}

describe("CHAOS: agent loop runaway (always same tool call, no progress)", () => {
  after(() => {
    if (ORIGINAL_STAGNATION_STOP === undefined) delete process.env.AGENT_STAGNATION_STOP;
    else process.env.AGENT_STAGNATION_STOP = ORIGINAL_STAGNATION_STOP;
    if (ORIGINAL_STAGNATION_RECOVERY === undefined) delete process.env.AGENT_STAGNATION_RECOVERY;
    else process.env.AGENT_STAGNATION_RECOVERY = ORIGINAL_STAGNATION_RECOVERY;
    if (ORIGINAL_STAGNATION_WINDOW === undefined) delete process.env.AGENT_STAGNATION_WINDOW;
    else process.env.AGENT_STAGNATION_WINDOW = ORIGINAL_STAGNATION_WINDOW;
    if (ORIGINAL_ENABLE_METRICS === undefined) delete process.env.ENABLE_METRICS;
    else process.env.ENABLE_METRICS = ORIGINAL_ENABLE_METRICS;
  });

  it(
    "stagnation detector trips before the iteration budget is exhausted",
    { timeout: 10_000 },
    () => {
      const noProgressTool = () => [{ name: "search", args: { q: "same-query" } }];
      const result = emulateAgentLoop(noProgressTool, {
        maxIterations: 50,
        windowSize: 4,
      });

      assert.equal(
        result.stopReason,
        "stagnation",
        `expected stagnation stop, got ${result.stopReason}`,
      );
      assert.ok(
        result.iterationsRun < 50,
        `loop should terminate well before maxIterations (ran ${result.iterationsRun})`,
      );
      // With window=4 and identical fingerprints every iteration, the exact
      // 1-cycle is detectable as soon as we have 2 entries — i.e. iteration 2.
      assert.ok(
        result.iterationsRun <= 6,
        `expected stagnation within ~window iterations, ran ${result.iterationsRun}`,
      );
    },
  );

  it(
    "loop terminates cleanly with a stagnation reason (no crash, no exception)",
    { timeout: 10_000 },
    () => {
      const noProgressTool = () => [{ name: "list", args: {} }];

      let result;
      assert.doesNotThrow(() => {
        result = emulateAgentLoop(noProgressTool, {
          maxIterations: 25,
          windowSize: 4,
        });
      });
      assert.equal(result.stopReason, "stagnation");
      assert.match(result.lastContent, /Agent stopped/);
      assert.ok(result.detail && result.detail.stagnant === true);
      assert.ok(
        typeof result.detail.reason === "string" && result.detail.reason.length > 0,
        "stagnation detail should include a human-readable reason",
      );
    },
  );

  it(
    "the stagnation termination reason is recorded in metrics",
    { timeout: 10_000 },
    () => {
      const before = getAgentRunSummarySnapshot();
      const beforeCount = (before.agent && before.agent.stagnation) || 0;

      emulateAgentLoop(() => [{ name: "noop", args: { x: 1 } }], {
        maxIterations: 25,
        windowSize: 4,
      });

      const after = getAgentRunSummarySnapshot();
      const afterCount = (after.agent && after.agent.stagnation) || 0;
      assert.ok(
        afterCount > beforeCount,
        `expected agent.stagnation counter to increment (before=${beforeCount}, after=${afterCount})`,
      );
    },
  );
});
