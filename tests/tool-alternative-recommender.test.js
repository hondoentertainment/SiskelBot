/**
 * Tests for the tool alternative recommender and its integration with
 * buildReplanMessage / analyzeAndBuildReplan.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate storage before importing the modules under test (they read env on load).
const TMP_ROOT = mkdtempSync(join(tmpdir(), "tool-alt-rec-"));
process.env.STORAGE_PATH = TMP_ROOT;

const {
  scoreCandidates,
  recommendAlternatives,
  recommenderEnabled,
} = await import("../lib/tool-alternative-recommender.js");
const {
  recordToolOutcomes,
  resetGenealogy,
} = await import("../lib/agent-genealogy.js");
const {
  buildReplanMessage,
  analyzeAndBuildReplan,
  classifyFailure,
  createTracker,
  trackFailure,
} = await import("../lib/agent-tool-failure-analyzer.js");

test.after(() => {
  try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* noop */ }
});

/* -------------------------------------------------------------------------- */
/* scoreCandidates                                                            */
/* -------------------------------------------------------------------------- */

test("scoreCandidates: empty genealogy returns []", () => {
  const out = scoreCandidates({
    genealogyStats: null,
    failedToolName: "web_search",
    taskText: "search the docs",
    availableTools: new Set(["search_context", "list_context"]),
    minSamples: 1,
  });
  assert.deepEqual(out, []);
});

test("scoreCandidates: excludes failedToolName from results", () => {
  const stats = {
    version: 1,
    updatedAt: 0,
    tools: {
      web_search: { successes: 10, failures: 0, lastTs: 0 },
      search_context: { successes: 10, failures: 0, lastTs: 0 },
    },
  };
  const out = scoreCandidates({
    genealogyStats: stats,
    failedToolName: "web_search",
    taskText: "search things",
    availableTools: new Set(["web_search", "search_context"]),
    minSamples: 1,
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].tool, "search_context");
});

test("scoreCandidates: respects availableTools membership (ignores unlisted)", () => {
  const stats = {
    version: 1,
    updatedAt: 0,
    tools: {
      search_context: { successes: 10, failures: 0, lastTs: 0 },
      list_context: { successes: 10, failures: 0, lastTs: 0 },
      unlisted_tool: { successes: 10, failures: 0, lastTs: 0 },
    },
  };
  const out = scoreCandidates({
    genealogyStats: stats,
    failedToolName: "web_search",
    taskText: "search context",
    availableTools: new Set(["search_context", "list_context"]),
    minSamples: 1,
  });
  const names = out.map((r) => r.tool).sort();
  assert.deepEqual(names, ["list_context", "search_context"]);
});

test("scoreCandidates: keyword-matching candidate scores above non-matching", () => {
  const stats = {
    version: 1,
    updatedAt: 0,
    tools: {
      search_context: { successes: 8, failures: 2, lastTs: 0 }, // matches "search"
      query_database: { successes: 8, failures: 2, lastTs: 0 }, // no keyword match
    },
  };
  const out = scoreCandidates({
    genealogyStats: stats,
    failedToolName: "web_search",
    taskText: "please search the documentation",
    availableTools: new Set(["search_context", "query_database"]),
    minSamples: 1,
  });
  assert.equal(out.length, 2);
  assert.equal(out[0].tool, "search_context");
  assert.equal(out[0].breakdown.keywordMatch, true);
  assert.equal(out[1].tool, "query_database");
  assert.equal(out[1].breakdown.keywordMatch, false);
  assert.ok(out[0].score > out[1].score, "keyword-matching tool must outrank non-matching");
});

test("scoreCandidates: respects minSamples threshold", () => {
  const stats = {
    version: 1,
    updatedAt: 0,
    tools: {
      low_samples: { successes: 2, failures: 0, lastTs: 0 }, // n=2
      high_samples: { successes: 5, failures: 0, lastTs: 0 }, // n=5
    },
  };
  const out = scoreCandidates({
    genealogyStats: stats,
    failedToolName: "other",
    taskText: "anything",
    availableTools: new Set(["low_samples", "high_samples"]),
    minSamples: 3,
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].tool, "high_samples");
});

test("scoreCandidates: deterministic for identical inputs", () => {
  const stats = {
    version: 1,
    updatedAt: 0,
    tools: {
      a_tool: { successes: 7, failures: 3, lastTs: 0 },
      b_tool: { successes: 9, failures: 1, lastTs: 0 },
      c_tool: { successes: 9, failures: 1, lastTs: 0 },
    },
  };
  const args = {
    genealogyStats: stats,
    failedToolName: "other",
    taskText: "a task",
    availableTools: new Set(["a_tool", "b_tool", "c_tool"]),
    minSamples: 1,
  };
  const r1 = scoreCandidates(args);
  const r2 = scoreCandidates(args);
  assert.deepEqual(r1, r2);
  // b and c share score -> sampleSize equal -> alphabetical tiebreak
  assert.equal(r1[0].tool, "b_tool");
  assert.equal(r1[1].tool, "c_tool");
});

test("scoreCandidates: handles array availableTools", () => {
  const stats = {
    version: 1,
    updatedAt: 0,
    tools: { search_context: { successes: 5, failures: 0, lastTs: 0 } },
  };
  const out = scoreCandidates({
    genealogyStats: stats,
    failedToolName: "web_search",
    taskText: "search",
    availableTools: ["search_context"],
    minSamples: 1,
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].tool, "search_context");
});

test("scoreCandidates: empty availableTools returns []", () => {
  const out = scoreCandidates({
    genealogyStats: { version: 1, updatedAt: 0, tools: { x: { successes: 5, failures: 0, lastTs: 0 } } },
    failedToolName: "other",
    taskText: "task",
    availableTools: new Set(),
    minSamples: 1,
  });
  assert.deepEqual(out, []);
});

/* -------------------------------------------------------------------------- */
/* recommendAlternatives (integration)                                        */
/* -------------------------------------------------------------------------- */

test("recommendAlternatives: pre-populated genealogy yields top-3 sorted by score", async () => {
  const workspace = "ws-recommend-top3";
  await resetGenealogy(workspace);

  // search_context: keyword match, strong history -> best
  // list_context: keyword match, medium history
  // query_database: no keyword match, strong history
  // remember_workspace_fact: no keyword, weak history (below threshold)
  // fetch_allowed_url: no keyword, medium history
  const outcomes = [];
  for (let i = 0; i < 18; i++) outcomes.push({ tool: "search_context", ok: true });
  for (let i = 0; i < 2; i++) outcomes.push({ tool: "search_context", ok: false });
  for (let i = 0; i < 7; i++) outcomes.push({ tool: "list_context", ok: true });
  for (let i = 0; i < 3; i++) outcomes.push({ tool: "list_context", ok: false });
  for (let i = 0; i < 20; i++) outcomes.push({ tool: "query_database", ok: true });
  for (let i = 0; i < 5; i++) outcomes.push({ tool: "query_database", ok: false });
  for (let i = 0; i < 1; i++) outcomes.push({ tool: "remember_workspace_fact", ok: true });
  for (let i = 0; i < 6; i++) outcomes.push({ tool: "fetch_allowed_url", ok: true });
  for (let i = 0; i < 4; i++) outcomes.push({ tool: "fetch_allowed_url", ok: false });
  await recordToolOutcomes(workspace, outcomes);

  const recs = await recommendAlternatives({
    workspace,
    failedToolName: "web_search",
    taskText: "please search the documentation for authentication details",
    availableTools: new Set([
      "web_search",
      "search_context",
      "list_context",
      "query_database",
      "remember_workspace_fact",
      "fetch_allowed_url",
    ]),
    opts: { limit: 3, minSamples: 3 },
  });

  assert.equal(recs.length, 3, "should return exactly 3 recommendations");
  // failedToolName must not be included
  for (const r of recs) assert.notEqual(r.tool, "web_search");
  // Top-ranked must be a keyword-matching tool (search_context beats all)
  assert.equal(recs[0].tool, "search_context");
  // Sorted best-first
  for (let i = 1; i < recs.length; i++) {
    assert.ok(recs[i - 1].score >= recs[i].score, "scores must be non-increasing");
  }
  // remember_workspace_fact has only n=1 so must be excluded by minSamples=3
  for (const r of recs) assert.notEqual(r.tool, "remember_workspace_fact");
  // Reason strings are shaped as expected
  assert.match(recs[0].reason, /%\s+success rate\s+\(n=\d+\)/);
  assert.match(recs[0].reason, /matches task keyword 'search'/);
});

test("recommendAlternatives: no qualifying candidates returns []", async () => {
  const workspace = "ws-recommend-empty";
  await resetGenealogy(workspace);
  await recordToolOutcomes(workspace, [{ tool: "solo_tool", ok: true }]);
  const recs = await recommendAlternatives({
    workspace,
    failedToolName: "solo_tool",
    taskText: "do a thing",
    availableTools: new Set(["solo_tool"]),
    opts: { limit: 3, minSamples: 3 },
  });
  assert.deepEqual(recs, []);
});

test("recommendAlternatives: missing workspace data returns []", async () => {
  const recs = await recommendAlternatives({
    workspace: "ws-never-touched-" + Date.now(),
    failedToolName: "web_search",
    taskText: "search",
    availableTools: new Set(["search_context", "list_context"]),
    opts: { limit: 3, minSamples: 3 },
  });
  assert.deepEqual(recs, []);
});

test("recommendAlternatives: reason without keyword match omits keyword clause", async () => {
  const workspace = "ws-no-keyword";
  await resetGenealogy(workspace);
  const outcomes = [];
  for (let i = 0; i < 10; i++) outcomes.push({ tool: "fetch_allowed_url", ok: true });
  await recordToolOutcomes(workspace, outcomes);
  const recs = await recommendAlternatives({
    workspace,
    failedToolName: "web_search",
    taskText: "completely unrelated tokens xyzzy",
    availableTools: new Set(["web_search", "fetch_allowed_url"]),
    opts: { limit: 3, minSamples: 3 },
  });
  assert.equal(recs.length, 1);
  assert.equal(recs[0].tool, "fetch_allowed_url");
  assert.doesNotMatch(recs[0].reason, /matches task keyword/);
  assert.match(recs[0].reason, /success rate \(n=10\)/);
});

/* -------------------------------------------------------------------------- */
/* recommenderEnabled                                                         */
/* -------------------------------------------------------------------------- */

test("recommenderEnabled: defaults to true", () => {
  const prev = process.env.AGENT_TOOL_ALTERNATIVE_RECOMMEND;
  delete process.env.AGENT_TOOL_ALTERNATIVE_RECOMMEND;
  try {
    assert.equal(recommenderEnabled(), true);
  } finally {
    if (prev !== undefined) process.env.AGENT_TOOL_ALTERNATIVE_RECOMMEND = prev;
  }
});

test("recommenderEnabled: flips to false when AGENT_TOOL_ALTERNATIVE_RECOMMEND=0", () => {
  const prev = process.env.AGENT_TOOL_ALTERNATIVE_RECOMMEND;
  process.env.AGENT_TOOL_ALTERNATIVE_RECOMMEND = "0";
  try {
    assert.equal(recommenderEnabled(), false);
  } finally {
    if (prev === undefined) delete process.env.AGENT_TOOL_ALTERNATIVE_RECOMMEND;
    else process.env.AGENT_TOOL_ALTERNATIVE_RECOMMEND = prev;
  }
});

test("recommenderEnabled: any value other than '0' is enabled", () => {
  const prev = process.env.AGENT_TOOL_ALTERNATIVE_RECOMMEND;
  process.env.AGENT_TOOL_ALTERNATIVE_RECOMMEND = "1";
  try {
    assert.equal(recommenderEnabled(), true);
  } finally {
    if (prev === undefined) delete process.env.AGENT_TOOL_ALTERNATIVE_RECOMMEND;
    else process.env.AGENT_TOOL_ALTERNATIVE_RECOMMEND = prev;
  }
});

/* -------------------------------------------------------------------------- */
/* buildReplanMessage / analyzeAndBuildReplan integration                      */
/* -------------------------------------------------------------------------- */

test("buildReplanMessage: with alternatives appends the expected line", () => {
  const failure = classifyFailure("web_search", { status: 429, error: "rate limited" }, { q: "x" });
  const tracker = createTracker();
  const history = trackFailure(tracker, "web_search", { q: "x" }, failure.category);
  const msg = buildReplanMessage({
    toolName: "web_search",
    failure,
    history,
    attempt: 1,
    maxAttempts: 3,
    alternatives: ["search_context", "list_context", "query_database"],
  });
  assert.match(msg, /Consider these alternatives instead: search_context, list_context, query_database\./);
});

test("buildReplanMessage: without alternatives never mentions alternatives (backwards compat)", () => {
  // Use a classifier category whose hint doesn't itself contain the word
  // "alternative", so we can pin down the line we added.
  const failure = classifyFailure("web_search", { ok: false, error: "weird thing happened" }, { q: "x" });
  const tracker = createTracker();
  const history = trackFailure(tracker, "web_search", { q: "x" }, failure.category);
  const msgWithout = buildReplanMessage({
    toolName: "web_search",
    failure,
    history,
    attempt: 1,
    maxAttempts: 3,
  });
  const msgWith = buildReplanMessage({
    toolName: "web_search",
    failure,
    history,
    attempt: 1,
    maxAttempts: 3,
    alternatives: ["search_context"],
  });
  // The sentinel phrase is only present when alternatives were supplied.
  assert.doesNotMatch(msgWithout, /Consider these alternatives instead/);
  assert.match(msgWith, /Consider these alternatives instead/);
  // Dropping the optional param must produce the same string as before
  // the feature existed (behavioral compat).
  const legacyEquivalent = buildReplanMessage({
    toolName: "web_search",
    failure,
    history,
    attempt: 1,
    maxAttempts: 3,
  });
  assert.equal(msgWithout, legacyEquivalent);
});

test("buildReplanMessage: empty alternatives array omits the appended line", () => {
  const failure = classifyFailure("web_search", { status: 429, error: "rate limited" }, { q: "x" });
  const tracker = createTracker();
  const history = trackFailure(tracker, "web_search", { q: "x" }, failure.category);
  const msg = buildReplanMessage({
    toolName: "web_search",
    failure,
    history,
    alternatives: [],
  });
  assert.doesNotMatch(msg, /Consider these alternatives instead/);
});

test("buildReplanMessage: alternatives beyond 3 are truncated", () => {
  const failure = classifyFailure("web_search", { status: 429, error: "rate limited" }, { q: "x" });
  const tracker = createTracker();
  const history = trackFailure(tracker, "web_search", { q: "x" }, failure.category);
  const msg = buildReplanMessage({
    toolName: "web_search",
    failure,
    history,
    alternatives: ["alpha", "bravo", "charlie", "delta", "echo"],
  });
  assert.match(msg, /Consider these alternatives instead: alpha, bravo, charlie\./);
  assert.doesNotMatch(msg, /delta/);
  assert.doesNotMatch(msg, /echo/);
});

test("analyzeAndBuildReplan: passes alternatives through when provided", () => {
  const tracker = createTracker();
  const out = analyzeAndBuildReplan({
    toolName: "search_context",
    parsed: { ok: false, error: "nothing found" },
    args: { query: "abcdef" },
    tracker,
    attempt: 1,
    maxAttempts: 3,
    alternatives: ["list_context", "semantic_search_context"],
  });
  assert.match(out.message, /Consider these alternatives instead: list_context, semantic_search_context\./);
});

test("analyzeAndBuildReplan: without alternatives is backwards-compatible", () => {
  const tracker = createTracker();
  const out = analyzeAndBuildReplan({
    toolName: "search_context",
    parsed: { ok: false, error: "nothing found" },
    args: { query: "abcdef" },
    tracker,
    attempt: 1,
    maxAttempts: 3,
  });
  assert.doesNotMatch(out.message, /alternative/i);
});
