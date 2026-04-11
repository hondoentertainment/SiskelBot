/**
 * Tests for lib/explainability.js — Phase 32.5 decision logging and
 * human-readable narrative generation.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  createDecisionLog,
  formatDecisionExplanation,
  parsePeriod,
  globalDecisionLog,
} from "../lib/explainability.js";

// --- recordDecision ---

test("recordDecision stores a decision with normalized fields", () => {
  const log = createDecisionLog();
  const rec = log.recordDecision({
    runId: "run-1",
    turnIndex: 2,
    decisionType: "tool_selection",
    chosen: "search_context",
    alternatives: ["semantic_search_context", "list_context"],
    reasoning: "keyword match preferred",
    confidence: 0.85,
    factors: [
      { name: "keyword_match", weight: 0.6, value: "exact" },
      { name: "latency", weight: 0.3, value: 12 },
    ],
    workspaceId: "default",
  });
  assert.equal(rec.runId, "run-1");
  assert.equal(rec.decisionType, "tool_selection");
  assert.equal(rec.chosen, "search_context");
  assert.equal(rec.alternatives.length, 2);
  assert.equal(rec.confidence, 0.85);
  assert.equal(rec.factors.length, 2);
  assert.equal(rec.factors[0].name, "keyword_match");
  assert.ok(rec.timestamp > 0);
});

test("recordDecision throws on invalid decisionType", () => {
  const log = createDecisionLog();
  assert.throws(
    () => log.recordDecision({ runId: "r", chosen: "x", decisionType: "bogus" }),
    /invalid decisionType/
  );
});

test("recordDecision throws on missing runId", () => {
  const log = createDecisionLog();
  assert.throws(
    () => log.recordDecision({ chosen: "x", decisionType: "tool_selection" }),
    /runId is required/
  );
});

test("recordDecision throws on missing chosen", () => {
  const log = createDecisionLog();
  assert.throws(
    () => log.recordDecision({ runId: "r", decisionType: "tool_selection" }),
    /chosen is required/
  );
});

test("recordDecision clamps confidence to [0,1] and filters chosen from alternatives", () => {
  const log = createDecisionLog();
  const rec = log.recordDecision({
    runId: "r",
    decisionType: "tool_selection",
    chosen: "a",
    alternatives: ["a", "b", "c"],
    confidence: 1.7,
  });
  assert.equal(rec.confidence, 1);
  assert.deepEqual(rec.alternatives, ["b", "c"]);

  const rec2 = log.recordDecision({
    runId: "r",
    decisionType: "tool_selection",
    chosen: "a",
    confidence: -0.5,
  });
  assert.equal(rec2.confidence, 0);
});

test("recordDecision clamps factor weight to [0,1] and filters invalid entries", () => {
  const log = createDecisionLog();
  const rec = log.recordDecision({
    runId: "r",
    decisionType: "tool_selection",
    chosen: "a",
    factors: [
      { name: "f1", weight: 2, value: 1 },
      { name: "f2", weight: -1, value: 2 },
      { weight: 0.5 }, // missing name, should be dropped
      null,
    ],
  });
  assert.equal(rec.factors.length, 2);
  assert.equal(rec.factors[0].weight, 1);
  assert.equal(rec.factors[1].weight, 0);
});

// --- retrieval ---

test("getDecisionsForRun returns only matching run", () => {
  const log = createDecisionLog();
  log.recordDecision({ runId: "a", decisionType: "tool_selection", chosen: "x" });
  log.recordDecision({ runId: "a", decisionType: "termination", chosen: "model_finished" });
  log.recordDecision({ runId: "b", decisionType: "tool_selection", chosen: "y" });

  const aDecisions = log.getDecisionsForRun("a");
  const bDecisions = log.getDecisionsForRun("b");
  assert.equal(aDecisions.length, 2);
  assert.equal(bDecisions.length, 1);
  assert.equal(bDecisions[0].chosen, "y");
});

test("getDecision returns individual decision by index", () => {
  const log = createDecisionLog();
  log.recordDecision({ runId: "r", decisionType: "tool_selection", chosen: "first" });
  log.recordDecision({ runId: "r", decisionType: "tool_selection", chosen: "second" });
  assert.equal(log.getDecision("r", 0).chosen, "first");
  assert.equal(log.getDecision("r", 1).chosen, "second");
  assert.equal(log.getDecision("r", 99), null);
  assert.equal(log.getDecision("missing", 0), null);
});

// --- explainDecision / formatDecisionExplanation ---

test("formatDecisionExplanation formats tool_selection with factors", () => {
  const decision = {
    decisionType: "tool_selection",
    chosen: "search_context",
    alternatives: ["semantic_search_context"],
    factors: [
      { name: "keyword_match", weight: 0.6, value: "exact" },
      { name: "latency", weight: 0.3, value: 12 },
    ],
    confidence: 0.85,
  };
  const text = formatDecisionExplanation(decision);
  assert.match(text, /Selected tool `search_context`/);
  assert.match(text, /over `semantic_search_context`/);
  assert.match(text, /keyword_match \(weight 0\.60/);
  assert.match(text, /confidence 0\.85/);
});

test("formatDecisionExplanation handles termination decisions", () => {
  const decision = {
    decisionType: "termination",
    chosen: "max_iterations",
    reasoning: "Hit iteration cap",
    confidence: 0.7,
  };
  const text = formatDecisionExplanation(decision);
  assert.match(text, /Terminated run due to `max_iterations`/);
  assert.match(text, /Hit iteration cap/);
});

test("formatDecisionExplanation handles specialist_delegation", () => {
  const decision = {
    decisionType: "specialist_delegation",
    chosen: "researcher",
    alternatives: ["executor"],
    factors: [{ name: "intent_mode", weight: 0.8, value: "llm" }],
    confidence: 0.9,
  };
  const text = formatDecisionExplanation(decision);
  assert.match(text, /Delegated to specialist `researcher`/);
  assert.match(text, /over `executor`/);
});

test("explainDecision returns formatted explanation", () => {
  const log = createDecisionLog();
  log.recordDecision({
    runId: "r",
    decisionType: "tool_selection",
    chosen: "search_context",
    alternatives: ["list_context"],
    confidence: 0.8,
    factors: [{ name: "w", weight: 0.5, value: "ok" }],
  });
  const out = log.explainDecision("r", 0);
  assert.ok(out);
  assert.match(out, /Selected tool `search_context`/);
  assert.equal(log.explainDecision("r", 99), null);
});

// --- generateRunExplanation ---

test("generateRunExplanation returns summary, keyDecisions, alternatives, confidence", () => {
  const log = createDecisionLog();
  log.recordDecision({
    runId: "run-x",
    turnIndex: 1,
    decisionType: "tool_selection",
    chosen: "search_context",
    alternatives: ["semantic_search_context"],
    confidence: 0.9,
    factors: [{ name: "f", weight: 0.5, value: 1 }],
  });
  log.recordDecision({
    runId: "run-x",
    turnIndex: 2,
    decisionType: "tool_selection",
    chosen: "list_context",
    alternatives: ["search_context"],
    confidence: 0.7,
  });
  log.recordDecision({
    runId: "run-x",
    turnIndex: 3,
    decisionType: "termination",
    chosen: "model_finished",
    confidence: 0.95,
  });

  const explanation = log.generateRunExplanation("run-x");
  assert.ok(explanation);
  assert.equal(explanation.runId, "run-x");
  assert.ok(explanation.summary.length > 0);
  assert.match(explanation.summary, /3 decisions/);
  assert.ok(Array.isArray(explanation.keyDecisions));
  assert.ok(explanation.keyDecisions.length > 0);
  assert.ok(explanation.alternatives.includes("semantic_search_context"));
  assert.ok(explanation.confidence > 0 && explanation.confidence <= 1);
  assert.equal(explanation.decisionCount, 3);
  assert.equal(explanation.typeCounts.tool_selection, 2);
  assert.equal(explanation.typeCounts.termination, 1);
});

test("generateRunExplanation returns null for unknown run", () => {
  const log = createDecisionLog();
  assert.equal(log.generateRunExplanation("nope"), null);
});

// --- getDecisionStats ---

test("getDecisionStats aggregates by type and computes averages", () => {
  const log = createDecisionLog();
  log.recordDecision({
    runId: "r1",
    decisionType: "tool_selection",
    chosen: "a",
    alternatives: ["b", "c"],
    confidence: 0.8,
    workspaceId: "ws1",
  });
  log.recordDecision({
    runId: "r1",
    decisionType: "tool_selection",
    chosen: "b",
    alternatives: ["a"],
    confidence: 0.6,
    workspaceId: "ws1",
  });
  log.recordDecision({
    runId: "r2",
    decisionType: "termination",
    chosen: "model_finished",
    confidence: 0.95,
    workspaceId: "ws1",
  });
  log.recordDecision({
    runId: "r3",
    decisionType: "tool_selection",
    chosen: "x",
    workspaceId: "ws2",
  });

  const all = log.getDecisionStats();
  assert.equal(all.total, 4);
  assert.equal(all.runCount, 3);
  assert.equal(all.typeDistribution.tool_selection, 3);
  assert.equal(all.typeDistribution.termination, 1);
  assert.ok(all.avgConfidence > 0);
  assert.ok(all.avgAlternativesConsidered >= 0);

  const ws1 = log.getDecisionStats("ws1");
  assert.equal(ws1.total, 3);
  assert.equal(ws1.runCount, 2);
  assert.equal(ws1.typeDistribution.tool_selection, 2);
  assert.equal(ws1.workspaceId, "ws1");

  assert.ok(ws1.chosenByType.tool_selection.a === 1);
  assert.ok(ws1.chosenByType.tool_selection.b === 1);
});

test("getDecisionStats filters by period", async () => {
  const log = createDecisionLog();
  // Old decision (1 hour ago)
  log.recordDecision({
    runId: "old",
    decisionType: "tool_selection",
    chosen: "a",
    timestamp: Date.now() - 60 * 60 * 1000,
  });
  log.recordDecision({
    runId: "new",
    decisionType: "tool_selection",
    chosen: "b",
  });
  const recent = log.getDecisionStats(null, 5 * 60 * 1000); // 5 min
  assert.equal(recent.total, 1);
});

// --- listRuns ---

test("listRuns returns runs sorted by most recent activity", () => {
  const log = createDecisionLog();
  log.recordDecision({
    runId: "old",
    decisionType: "tool_selection",
    chosen: "a",
    timestamp: 1000,
  });
  log.recordDecision({
    runId: "new",
    decisionType: "tool_selection",
    chosen: "b",
    timestamp: 2000,
  });
  log.recordDecision({
    runId: "new",
    decisionType: "termination",
    chosen: "model_finished",
    timestamp: 3000,
  });

  const runs = log.listRuns();
  assert.equal(runs.length, 2);
  assert.equal(runs[0].runId, "new");
  assert.equal(runs[0].decisionCount, 2);
  assert.equal(runs[1].runId, "old");
});

test("listRuns filters by workspace", () => {
  const log = createDecisionLog();
  log.recordDecision({
    runId: "a",
    decisionType: "tool_selection",
    chosen: "x",
    workspaceId: "ws1",
  });
  log.recordDecision({
    runId: "b",
    decisionType: "tool_selection",
    chosen: "y",
    workspaceId: "ws2",
  });
  const ws1 = log.listRuns("ws1");
  assert.equal(ws1.length, 1);
  assert.equal(ws1[0].runId, "a");
});

// --- multiple decision types ---

test("all valid decision types are accepted", () => {
  const log = createDecisionLog();
  const types = [
    "tool_selection",
    "model_selection",
    "specialist_delegation",
    "termination",
    "retry",
    "skip",
    "reflection",
  ];
  for (const t of types) {
    assert.doesNotThrow(() => {
      log.recordDecision({ runId: "r", decisionType: t, chosen: "x" });
    });
  }
  assert.equal(log.getDecisionsForRun("r").length, types.length);
});

// --- parsePeriod helper ---

test("parsePeriod parses common period strings", () => {
  assert.equal(parsePeriod("1h"), 60 * 60 * 1000);
  assert.equal(parsePeriod("7d"), 7 * 24 * 60 * 60 * 1000);
  assert.equal(parsePeriod("30m"), 30 * 60 * 1000);
  assert.equal(parsePeriod("2w"), 2 * 7 * 24 * 60 * 60 * 1000);
  assert.equal(parsePeriod(""), 0);
  assert.equal(parsePeriod("garbage"), 0);
  assert.equal(parsePeriod(null), 0);
});

// --- globalDecisionLog ---

test("globalDecisionLog is a working singleton", () => {
  globalDecisionLog.clear();
  const before = globalDecisionLog._all().length;
  globalDecisionLog.recordDecision({
    runId: "global-test",
    decisionType: "tool_selection",
    chosen: "x",
  });
  assert.equal(globalDecisionLog._all().length, before + 1);
  assert.equal(globalDecisionLog.getDecisionsForRun("global-test").length, 1);
  globalDecisionLog.clear();
  assert.equal(globalDecisionLog._all().length, 0);
});

// --- clear ---

test("clear empties the log", () => {
  const log = createDecisionLog();
  log.recordDecision({ runId: "r", decisionType: "tool_selection", chosen: "x" });
  assert.equal(log._all().length, 1);
  log.clear();
  assert.equal(log._all().length, 0);
});
