/**
 * Tests for the agent-quality eval harness (lib/eval-agent-quality.js).
 *
 * These are deterministic -- no real LLM, no real filesystem outside of an
 * isolated tmpdir set per-scenario by the harness itself.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Give the harness a safe default STORAGE_PATH so module-level initialization
// (which may call getDataDir() once on import) lands in a scratch directory
// rather than the repo's data/ dir.
const tmpRoot = mkdtempSync(join(tmpdir(), "siskel-eval-tests-"));
process.env.STORAGE_PATH = tmpRoot;

const {
  builtinScenarios,
  runEvalScenario,
  runEvalComparison,
  runFullEval,
} = await import("../lib/eval-agent-quality.js");

test.after(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
});

test("builtinScenarios: returns at least 3 scenarios each with valid shape", () => {
  const scenarios = builtinScenarios();
  assert.ok(Array.isArray(scenarios), "scenarios should be an array");
  assert.ok(scenarios.length >= 3, `expected >=3 scenarios, got ${scenarios.length}`);

  for (const s of scenarios) {
    assert.equal(typeof s.name, "string", "scenario.name should be a string");
    assert.ok(s.name.length > 0, "scenario.name should be non-empty");
    assert.equal(typeof s.userMessage, "string");
    assert.ok(s.userMessage.length > 0);
    assert.equal(typeof s.workspace, "string");
    assert.ok(Array.isArray(s.mockToolBehaviors));
    assert.ok(Array.isArray(s.scriptedLLMTurns));
    assert.ok(s.scriptedLLMTurns.length > 0, "scenario must have >=1 scripted turn");

    for (const turn of s.scriptedLLMTurns) {
      assert.ok(
        typeof turn.assistant_calls_tool === "string" ||
          typeof turn.assistant_final === "string",
        "turn must declare either a tool call or a final text response",
      );
    }
  }
});

test("runEvalScenario: returns the expected result shape for a simple scenario", async () => {
  const scenario = builtinScenarios().find((s) => s.name === "replan-after-unknown-tool");
  assert.ok(scenario, "replan scenario should exist");

  const result = await runEvalScenario(scenario, {
    AGENT_PERSIST_FAILURES: "1",
    AGENT_PERSIST_OUTCOMES: "1",
    AGENT_GENEALOGY_HINT: "1",
    TOOL_SEMANTIC_VALIDATION: "1",
  });

  assert.equal(result.name, scenario.name);
  assert.equal(typeof result.iterations, "number");
  assert.ok(result.iterations > 0);
  assert.ok(Array.isArray(result.toolCalls));
  assert.equal(typeof result.replanCount, "number");
  assert.equal(typeof result.finalContent, "string");
  assert.equal(typeof result.stopReason, "string");
  assert.equal(typeof result.satisfied, "boolean");
  assert.equal(typeof result.systemMessagesWithReplan, "number");
  assert.equal(typeof result.systemMessagesWithReliabilityHint, "number");
  assert.deepEqual(Object.keys(result.flags).sort(), [
    "AGENT_GENEALOGY_HINT",
    "AGENT_PERSIST_FAILURES",
    "AGENT_PERSIST_OUTCOMES",
    "TOOL_SEMANTIC_VALIDATION",
  ]);
});

test("runEvalComparison: re-plan scenario -- both runs run, re-plan nudge fires", async () => {
  const scenario = builtinScenarios().find((s) => s.name === "replan-after-unknown-tool");
  const cmp = await runEvalComparison(scenario);

  // Both runs must have completed with a valid stopReason.
  assert.ok(cmp.baseline.stopReason.length > 0);
  assert.ok(cmp.enhanced.stopReason.length > 0);

  // The re-plan analyzer is a core agent-loop feature (not guarded by our
  // enhancement flags) so both baseline and enhanced should emit at least one
  // re-plan system message for the failing unknown_tool.
  assert.ok(
    cmp.baseline.systemMessagesWithReplan >= 1,
    `baseline should see at least one re-plan nudge, saw ${cmp.baseline.systemMessagesWithReplan}`,
  );
  assert.ok(
    cmp.enhanced.systemMessagesWithReplan >= 1,
    `enhanced should see at least one re-plan nudge, saw ${cmp.enhanced.systemMessagesWithReplan}`,
  );

  // The failure store + genealogy hint are workspace-scoped; the baseline
  // should have zero reliability hints (no preSeed + persistence disabled),
  // and enhanced should also be zero for this scenario (no preSeed).
  assert.equal(cmp.baseline.systemMessagesWithReliabilityHint, 0);
});

test("runEvalComparison: chronic-failures scenario -- enhanced run cites the reliability hint", async () => {
  const scenario = builtinScenarios().find((s) => s.name === "chronic-failures-warning");
  const cmp = await runEvalComparison(scenario);

  // Baseline has persistence disabled, so even though we pre-seeded data into
  // the tmp STORAGE_PATH the hint is gated by AGENT_GENEALOGY_HINT.
  assert.equal(
    cmp.baseline.systemMessagesWithReliabilityHint,
    0,
    "baseline must not inject reliability hint when AGENT_GENEALOGY_HINT=0",
  );

  // Enhanced has both the pre-seeded outcomes and AGENT_GENEALOGY_HINT=1, so
  // the hint should land in at least one outgoing LLM request.
  assert.ok(
    cmp.enhanced.systemMessagesWithReliabilityHint >= 1,
    `enhanced should inject reliability hint at least once, saw ${cmp.enhanced.systemMessagesWithReliabilityHint}`,
  );

  // Both runs should converge to model_finished because the scripted LLM
  // immediately picks a working tool and then gives a final answer.
  assert.equal(cmp.enhanced.stopReason, "model_finished");
  assert.equal(cmp.baseline.stopReason, "model_finished");
  assert.ok(cmp.enhanced.satisfied, "enhanced should be satisfied");
  assert.ok(cmp.baseline.satisfied, "baseline should also be satisfied here");
});

test("runEvalComparison: semantic-validator scenario -- enhanced rejects short query", async () => {
  const scenario = builtinScenarios().find((s) => s.name === "semantic-validator-rejects-short-query");
  const cmp = await runEvalComparison(scenario);

  // In the enhanced run, the first search_context({query:"r"}) must be
  // rejected by the semantic validator (minStringLength >= 3). That surfaces
  // as a validationError entry (ok:false) in the toolCalls log, whereas the
  // baseline run (semantic validation disabled) would have let it through.
  const enhancedFirst = cmp.enhanced.toolCalls[0];
  assert.ok(enhancedFirst, "enhanced should have at least one tool call recorded");
  assert.equal(
    enhancedFirst.ok,
    false,
    "enhanced: semantic validator should have rejected the short query on turn 1",
  );

  // Enhanced run should have seen a re-plan nudge fired by the rejection.
  assert.ok(
    cmp.enhanced.systemMessagesWithReplan >= 1,
    "enhanced run should emit a re-plan nudge after semantic rejection",
  );

  // Delta: enhanced must differ meaningfully from baseline on this scenario.
  assert.notEqual(
    cmp.enhanced.systemMessagesWithReplan,
    cmp.baseline.systemMessagesWithReplan,
    "enhanced should differ from baseline in re-plan count",
  );
});

test("runFullEval: produces a sane report across all builtin scenarios", async () => {
  const report = await runFullEval();
  assert.equal(typeof report, "object");
  assert.ok(report.totalScenarios >= 3);
  assert.equal(report.scenarios.length, report.totalScenarios);
  assert.equal(
    report.enhancedImproved + report.enhancedRegressed + report.unchanged,
    report.totalScenarios,
  );
  assert.equal(typeof report.totals.totalIterationsSaved, "number");
  assert.equal(typeof report.totals.totalToolCallsSaved, "number");
  assert.equal(typeof report.totals.totalReplansSaved, "number");

  // Every scenario must have both baseline and enhanced populated.
  for (const s of report.scenarios) {
    assert.equal(typeof s.scenario, "string");
    assert.ok(s.baseline, `baseline result for ${s.scenario}`);
    assert.ok(s.enhanced, `enhanced result for ${s.scenario}`);
    assert.ok(s.baseline.iterations > 0);
    assert.ok(s.enhanced.iterations > 0);
  }

  // Sanity: at least one scenario should show an enhanced-side improvement
  // (either more reliability hints or a re-plan-count difference). This is
  // the whole point of the harness: if nothing ever measurably changes, the
  // harness is not exercising the enhancements.
  const anyDifferent = report.scenarios.some(
    (s) =>
      s.enhanced.systemMessagesWithReliabilityHint !== s.baseline.systemMessagesWithReliabilityHint ||
      s.enhanced.systemMessagesWithReplan !== s.baseline.systemMessagesWithReplan ||
      s.enhanced.toolCalls.length !== s.baseline.toolCalls.length ||
      s.enhanced.satisfied !== s.baseline.satisfied ||
      s.enhanced.iterations !== s.baseline.iterations,
  );
  assert.ok(
    anyDifferent,
    "at least one scenario should show measurable differences between baseline and enhanced",
  );
});
