import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  recordOutcome,
  getProfileStats,
  suggestProfile,
  getWorkspaceLearningStats,
  __resetLearningForTests,
} from "../lib/agent-learning.js";

describe("agent-learning", () => {
  beforeEach(() => {
    __resetLearningForTests();
  });

  // ── recordOutcome + getProfileStats roundtrip ──────────────────────────

  it("records an outcome and returns correct stats", () => {
    recordOutcome({
      workspace: "ws1",
      profile: "researcher",
      goal: "find info",
      toolsUsed: ["search_context", "fetch_allowed_url"],
      iterations: 5,
      costUsd: 0.1,
      success: true,
      durationMs: 3000,
    });

    const stats = getProfileStats("ws1", "researcher");
    assert.equal(stats.profile, "researcher");
    assert.equal(stats.runs, 1);
    assert.equal(stats.successRate, 1);
    assert.equal(stats.avgCost, 0.1);
    assert.equal(stats.avgIterations, 5);
    assert.equal(stats.avgDuration, 3000);
    assert.deepEqual(stats.topTools, ["search_context", "fetch_allowed_url"]);
  });

  it("returns zero stats for unknown workspace", () => {
    const stats = getProfileStats("nonexistent", "researcher");
    assert.equal(stats.runs, 0);
    assert.equal(stats.successRate, 0);
    assert.deepEqual(stats.topTools, []);
  });

  it("returns zero stats for unknown profile in known workspace", () => {
    recordOutcome({
      workspace: "ws1",
      profile: "executor",
      goal: "deploy",
      toolsUsed: [],
      iterations: 1,
      costUsd: 0.01,
      success: true,
      durationMs: 500,
    });

    const stats = getProfileStats("ws1", "researcher");
    assert.equal(stats.runs, 0);
    assert.equal(stats.successRate, 0);
  });

  it("computes averages across multiple outcomes", () => {
    for (let i = 0; i < 4; i++) {
      recordOutcome({
        workspace: "ws1",
        profile: "executor",
        goal: "run step",
        toolsUsed: ["execute_step"],
        iterations: 10 + i,
        costUsd: 0.2 + i * 0.1,
        success: i < 3, // 3 successes, 1 failure
        durationMs: 1000 * (i + 1),
      });
    }

    const stats = getProfileStats("ws1", "executor");
    assert.equal(stats.runs, 4);
    assert.equal(stats.successRate, 0.75);
    assert.equal(stats.avgCost, (0.2 + 0.3 + 0.4 + 0.5) / 4);
    assert.equal(stats.avgIterations, (10 + 11 + 12 + 13) / 4);
    assert.equal(stats.avgDuration, (1000 + 2000 + 3000 + 4000) / 4);
  });

  // ── getProfileStats without profile (all profiles) ────────────────────

  it("returns all profile stats when profile is omitted", () => {
    recordOutcome({ workspace: "ws1", profile: "researcher", goal: "g", toolsUsed: [], iterations: 1, costUsd: 0.1, success: true, durationMs: 100 });
    recordOutcome({ workspace: "ws1", profile: "executor", goal: "g", toolsUsed: [], iterations: 2, costUsd: 0.2, success: false, durationMs: 200 });

    const all = getProfileStats("ws1");
    assert.equal(Array.isArray(all), true);
    assert.equal(all.length, 2);
    const names = all.map((s) => s.profile).sort();
    assert.deepEqual(names, ["executor", "researcher"]);
  });

  it("returns empty array for unknown workspace when profile omitted", () => {
    const all = getProfileStats("nope");
    assert.deepEqual(all, []);
  });

  // ── suggestProfile with enough data ───────────────────────────────────

  it("suggests the best profile when enough data exists", () => {
    // Profile A: high success, low cost, low iterations
    for (let i = 0; i < 10; i++) {
      recordOutcome({
        workspace: "ws1",
        profile: "fast_profile",
        goal: "do stuff",
        toolsUsed: ["search_context"],
        iterations: 3,
        costUsd: 0.05,
        success: true,
        durationMs: 500,
      });
    }

    // Profile B: lower success, higher cost, more iterations
    for (let i = 0; i < 10; i++) {
      recordOutcome({
        workspace: "ws1",
        profile: "slow_profile",
        goal: "do stuff",
        toolsUsed: ["execute_step"],
        iterations: 15,
        costUsd: 1.0,
        success: i < 5, // 50% success
        durationMs: 10000,
      });
    }

    const suggestion = suggestProfile("ws1", "do stuff");
    assert.equal(suggestion.profile, "fast_profile");
    assert.equal(suggestion.confidence > 0, true);
    assert.equal(typeof suggestion.reason, "string");
  });

  // ── suggestProfile with insufficient data ─────────────────────────────

  it("returns default with confidence 0 when insufficient data", () => {
    // Only 3 records (below the threshold of 5)
    for (let i = 0; i < 3; i++) {
      recordOutcome({
        workspace: "ws1",
        profile: "researcher",
        goal: "research",
        toolsUsed: [],
        iterations: 2,
        costUsd: 0.1,
        success: true,
        durationMs: 1000,
      });
    }

    const suggestion = suggestProfile("ws1", "research");
    assert.equal(suggestion.profile, "default");
    assert.equal(suggestion.confidence, 0);
    assert.equal(suggestion.reason, "insufficient data");
  });

  it("returns default when workspace has no data at all", () => {
    const suggestion = suggestProfile("empty_ws", "anything");
    assert.equal(suggestion.profile, "default");
    assert.equal(suggestion.confidence, 0);
  });

  // ── Workspace isolation ───────────────────────────────────────────────

  it("isolates data between workspaces", () => {
    recordOutcome({ workspace: "ws_a", profile: "researcher", goal: "g", toolsUsed: ["t1"], iterations: 1, costUsd: 0.1, success: true, durationMs: 100 });
    recordOutcome({ workspace: "ws_b", profile: "researcher", goal: "g", toolsUsed: ["t2"], iterations: 2, costUsd: 0.2, success: false, durationMs: 200 });

    const statsA = getProfileStats("ws_a", "researcher");
    const statsB = getProfileStats("ws_b", "researcher");

    assert.equal(statsA.runs, 1);
    assert.equal(statsA.successRate, 1);
    assert.equal(statsB.runs, 1);
    assert.equal(statsB.successRate, 0);
  });

  it("workspace learning stats are isolated", () => {
    for (let i = 0; i < 3; i++) {
      recordOutcome({ workspace: "ws_x", profile: "executor", goal: "g", toolsUsed: [], iterations: 1, costUsd: 0.1, success: true, durationMs: 100 });
    }
    recordOutcome({ workspace: "ws_y", profile: "researcher", goal: "g", toolsUsed: [], iterations: 1, costUsd: 0.1, success: true, durationMs: 100 });

    const xStats = getWorkspaceLearningStats("ws_x");
    const yStats = getWorkspaceLearningStats("ws_y");

    assert.equal(xStats.totalRuns, 3);
    assert.equal(xStats.profiles.length, 1);
    assert.equal(yStats.totalRuns, 1);
    assert.equal(yStats.profiles.length, 1);
  });

  // ── Cap at 1000 records ───────────────────────────────────────────────

  it("caps records at 1000 per profile per workspace, evicting oldest", () => {
    for (let i = 0; i < 1050; i++) {
      recordOutcome({
        workspace: "ws1",
        profile: "executor",
        goal: `goal_${i}`,
        toolsUsed: [],
        iterations: i,
        costUsd: 0.01,
        success: true,
        durationMs: 100,
      });
    }

    const stats = getProfileStats("ws1", "executor");
    assert.equal(stats.runs, 1000);

    // The oldest records (0-49) should have been evicted; avg iterations
    // should reflect records 50-1049
    const expectedAvgIterations = (50 + 1049) / 2; // midpoint of 50..1049
    assert.ok(
      Math.abs(stats.avgIterations - expectedAvgIterations) < 0.01,
      `expected avgIterations ~${expectedAvgIterations}, got ${stats.avgIterations}`,
    );
  });

  // ── topTools ranking ──────────────────────────────────────────────────

  it("ranks topTools by frequency in successful runs only", () => {
    // 3 successful runs using tool_a and tool_b
    for (let i = 0; i < 3; i++) {
      recordOutcome({
        workspace: "ws1",
        profile: "researcher",
        goal: "research",
        toolsUsed: ["tool_a", "tool_b"],
        iterations: 2,
        costUsd: 0.1,
        success: true,
        durationMs: 500,
      });
    }

    // 2 successful runs using tool_a and tool_c
    for (let i = 0; i < 2; i++) {
      recordOutcome({
        workspace: "ws1",
        profile: "researcher",
        goal: "research",
        toolsUsed: ["tool_a", "tool_c"],
        iterations: 3,
        costUsd: 0.15,
        success: true,
        durationMs: 600,
      });
    }

    // 1 failed run using tool_d — should NOT count
    recordOutcome({
      workspace: "ws1",
      profile: "researcher",
      goal: "research",
      toolsUsed: ["tool_d", "tool_d", "tool_d"],
      iterations: 10,
      costUsd: 1.0,
      success: false,
      durationMs: 5000,
    });

    const stats = getProfileStats("ws1", "researcher");
    // tool_a: 5 uses, tool_b: 3 uses, tool_c: 2 uses
    assert.equal(stats.topTools[0], "tool_a");
    assert.equal(stats.topTools[1], "tool_b");
    assert.equal(stats.topTools[2], "tool_c");
    assert.ok(!stats.topTools.includes("tool_d"), "tool_d should not appear (only from failed runs)");
  });

  // ── getWorkspaceLearningStats ─────────────────────────────────────────

  it("returns aggregate workspace learning stats", () => {
    for (let i = 0; i < 5; i++) {
      recordOutcome({ workspace: "ws1", profile: "researcher", goal: "g", toolsUsed: ["search_context"], iterations: 3, costUsd: 0.1, success: true, durationMs: 500 });
    }
    for (let i = 0; i < 3; i++) {
      recordOutcome({ workspace: "ws1", profile: "executor", goal: "g", toolsUsed: ["execute_step"], iterations: 10, costUsd: 0.5, success: i < 2, durationMs: 2000 });
    }

    const wStats = getWorkspaceLearningStats("ws1");
    assert.equal(wStats.totalRuns, 8);
    assert.equal(wStats.profiles.length, 2);

    const researcher = wStats.profiles.find((p) => p.profile === "researcher");
    assert.equal(researcher.runs, 5);
    assert.equal(researcher.successRate, 1);
  });

  it("returns empty workspace learning stats for unknown workspace", () => {
    const wStats = getWorkspaceLearningStats("nonexistent");
    assert.deepEqual(wStats.profiles, []);
    assert.equal(wStats.totalRuns, 0);
  });

  // ── __resetLearningForTests ───────────────────────────────────────────

  it("reset clears all data", () => {
    recordOutcome({ workspace: "ws1", profile: "executor", goal: "g", toolsUsed: [], iterations: 1, costUsd: 0.1, success: true, durationMs: 100 });
    assert.equal(getProfileStats("ws1", "executor").runs, 1);

    __resetLearningForTests();

    assert.equal(getProfileStats("ws1", "executor").runs, 0);
    assert.deepEqual(getWorkspaceLearningStats("ws1").profiles, []);
  });

  // ── suggestProfile scoring ────────────────────────────────────────────

  it("scoring formula weights success, cost, and iterations correctly", () => {
    // Profile "cheap": 100% success, lowest cost, mid iterations
    for (let i = 0; i < 10; i++) {
      recordOutcome({ workspace: "ws1", profile: "cheap", goal: "g", toolsUsed: [], iterations: 5, costUsd: 0.01, success: true, durationMs: 500 });
    }
    // Profile "reliable": 100% success, highest cost, highest iterations
    for (let i = 0; i < 10; i++) {
      recordOutcome({ workspace: "ws1", profile: "reliable", goal: "g", toolsUsed: [], iterations: 20, costUsd: 1.0, success: true, durationMs: 5000 });
    }
    // Profile "risky": 60% success, lowest cost, lowest iterations
    for (let i = 0; i < 10; i++) {
      recordOutcome({ workspace: "ws1", profile: "risky", goal: "g", toolsUsed: [], iterations: 2, costUsd: 0.01, success: i < 6, durationMs: 200 });
    }

    const suggestion = suggestProfile("ws1", "g");
    // "cheap" should win: 1.0 * 0.4 + 1.0 * 0.3 + high-normalized * 0.3
    // "reliable" penalized on cost and iterations
    // "risky" penalized on success rate
    assert.equal(suggestion.profile, "cheap");
    assert.ok(suggestion.confidence > 0.5, `expected confidence > 0.5, got ${suggestion.confidence}`);
  });

  it("suggestProfile picks among profiles that all meet the minimum record threshold", () => {
    // One profile at exactly 5 records (the minimum), one at 4 (below minimum)
    for (let i = 0; i < 5; i++) {
      recordOutcome({ workspace: "ws1", profile: "just_enough", goal: "g", toolsUsed: [], iterations: 3, costUsd: 0.1, success: true, durationMs: 500 });
    }
    for (let i = 0; i < 4; i++) {
      recordOutcome({ workspace: "ws1", profile: "not_enough", goal: "g", toolsUsed: [], iterations: 1, costUsd: 0.01, success: true, durationMs: 100 });
    }

    const suggestion = suggestProfile("ws1", "g");
    assert.equal(suggestion.profile, "just_enough");
    assert.ok(suggestion.confidence > 0, "should have non-zero confidence");
  });
});
