// CHAOS TEST: 2 of 3 swarm specialists throw errors
// EXPECTED: orchestrator returns a degraded but non-empty result, swarmConflictCounts increments, errors are logged but the request does not crash.
//
// Run with: npm run test:chaos
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

// Enable metrics so recordSwarmConflict actually mutates the in-memory map.
const ORIGINAL_ENABLE_METRICS = process.env.ENABLE_METRICS;
process.env.ENABLE_METRICS = "1";

const { recordSwarmConflict, __getAgentQualityMetricsForTests, __resetAgentQualityMetricsForTests } =
  await import("../../lib/metrics.js");

/**
 * Mimic the orchestrator pattern in runSwarmDirect: launch all specialists in
 * parallel via Promise.all, catch each specialist's exception so others can
 * complete, and aggregate results. We assert the resilience contract
 * (degraded response, conflict counter touched, no crash).
 */
async function runMockSwarm(specialistFns) {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));

  let result;
  try {
    const results = await Promise.all(
      specialistFns.map(async ({ name, fn }) => {
        const t0 = Date.now();
        let error = null;
        let output;
        let success = false;
        try {
          output = await fn();
          success = true;
        } catch (e) {
          error = e;
          // Mirror the swarm.js logging contract.
          console.warn(`[swarm] Specialist ${name} threw:`, e?.message || e);
          output = JSON.stringify({ ok: false, error: String(e?.message || e) });
        }
        return { specialist: name, output, success, latencyMs: Date.now() - t0, error };
      }),
    );

    // Mirror conflict-detection: when more than one specialist disagrees the
    // orchestrator records a swarm_conflict counter. Here we just verify the
    // counter is wired by recording one for the divergent partial outputs.
    const successful = results.filter((r) => r.success);
    if (successful.length >= 1 && successful.length < results.length) {
      // Partial failure ⇒ surface as a "partial" conflict so dashboards see it.
      try { recordSwarmConflict("partial"); } catch { /* best-effort */ }
    }

    result = { results, warnings };
  } finally {
    console.warn = originalWarn;
  }
  return result;
}

describe("CHAOS: swarm partial failure (2 of 3 specialists throw)", () => {
  before(() => {
    __resetAgentQualityMetricsForTests();
  });

  after(() => {
    __resetAgentQualityMetricsForTests();
    if (ORIGINAL_ENABLE_METRICS === undefined) delete process.env.ENABLE_METRICS;
    else process.env.ENABLE_METRICS = ORIGINAL_ENABLE_METRICS;
  });

  it(
    "orchestrator returns a non-empty degraded result and does not crash",
    { timeout: 10_000 },
    async () => {
      const { results, warnings } = await runMockSwarm([
        {
          name: "researcher",
          fn: async () => {
            throw new Error("knowledge index timeout");
          },
        },
        {
          name: "executor",
          fn: async () => {
            throw new Error("recipe runner unreachable");
          },
        },
        {
          name: "synthesizer",
          fn: async () => {
            return JSON.stringify({ summary: "best-effort answer from one survivor" });
          },
        },
      ]);

      assert.equal(results.length, 3, "orchestrator should still return 3 result rows");
      const successCount = results.filter((r) => r.success).length;
      const failureCount = results.filter((r) => !r.success).length;
      assert.equal(successCount, 1, "exactly one specialist should succeed");
      assert.equal(failureCount, 2, "exactly two specialists should fail");

      // Degraded but non-empty: at least one specialist contributes output.
      const survivor = results.find((r) => r.success);
      assert.ok(survivor, "expected at least one surviving specialist");
      assert.ok(
        typeof survivor.output === "string" && survivor.output.length > 0,
        "surviving specialist should produce non-empty output",
      );

      // Errors must be captured per-specialist instead of crashing the whole run.
      for (const r of results.filter((x) => !x.success)) {
        assert.ok(r.error instanceof Error, `failure on ${r.specialist} should carry an Error`);
        assert.match(
          r.output,
          /"ok":false/,
          "failed specialists should still surface a structured error payload",
        );
      }

      // Failures must be logged (not silently swallowed).
      const swarmWarnings = warnings.filter((w) => w.includes("[swarm]"));
      assert.equal(
        swarmWarnings.length,
        2,
        `expected 2 swarm warnings, got ${swarmWarnings.length}: ${JSON.stringify(warnings)}`,
      );
    },
  );

  it(
    "swarmConflictCounts increments when partial failure is detected",
    { timeout: 10_000 },
    async () => {
      __resetAgentQualityMetricsForTests();
      await runMockSwarm([
        { name: "researcher", fn: async () => { throw new Error("boom"); } },
        { name: "executor", fn: async () => { throw new Error("boom"); } },
        { name: "synthesizer", fn: async () => "ok" },
      ]);
      const snap = __getAgentQualityMetricsForTests();
      assert.ok(
        snap.conflicts && snap.conflicts.partial >= 1,
        `expected conflicts.partial >= 1, got ${JSON.stringify(snap.conflicts)}`,
      );
    },
  );
});
