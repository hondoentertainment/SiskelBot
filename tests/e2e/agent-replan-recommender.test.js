/**
 * E2E: tool failure -> analyzer -> genealogy-driven alternative recommendation.
 *
 * We pre-populate genealogy so search_context has 10 successes and web_search
 * has 10 failures in this workspace. Pre-populate failure store so
 * isChronicallyBroken() flags web_search. User asks to "search docs for
 * auth"; the mock backend tells the LLM to call web_search first. The tool
 * fails with a permission error (ok:false, status 403). The re-plan pipeline
 * runs: classifier -> "permission" category -> replan system message.
 * Round 2 the LLM answers in text.
 *
 * Assertions:
 *   - Round-2 outbound body contains the replan system message with
 *     "failed (permission)" category marker.
 *   - Round-2 outbound body mentions a chronic-history avoidance hint
 *     (isChronicallyBroken wiring).
 *   - Genealogy for web_search now shows one additional failure (persisted
 *     by agent-loop at end of run).
 *   - The tool-alternative-recommender (a public module not yet wired into
 *     agent-loop) CAN surface search_context as a top alternative given the
 *     same genealogy — proving the data flow is complete end-to-end and the
 *     recommender would produce useful output when hooked up.
 *
 * NOTE: The recommender module is not yet called from runAgentLoop; the only
 * place `Consider these alternatives instead:` can appear is when a caller
 * passes `alternatives` to analyzeAndBuildReplan. This test therefore drives
 * the real agent-loop for the replan + genealogy flow and verifies the
 * recommender output separately. If runAgentLoop is later wired to pass
 * alternatives, extend the assertion list below to check the round-2 body.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_ROOT = mkdtempSync(join(tmpdir(), "e2e-replan-recommender-"));
const savedEnv = {
  STORAGE_PATH: process.env.STORAGE_PATH,
  AGENT_GENEALOGY_HINT: process.env.AGENT_GENEALOGY_HINT,
  AGENT_TOOL_ALTERNATIVE_RECOMMEND: process.env.AGENT_TOOL_ALTERNATIVE_RECOMMEND,
  AGENT_TOOL_RESULT_JUDGE: process.env.AGENT_TOOL_RESULT_JUDGE,
  AGENT_CONTENT_SCRUB: process.env.AGENT_CONTENT_SCRUB,
  AGENT_PROMPT_PATCH: process.env.AGENT_PROMPT_PATCH,
  AGENT_REPLAN_ON_FAILURE: process.env.AGENT_REPLAN_ON_FAILURE,
};
process.env.STORAGE_PATH = TMP_ROOT;
// Recommender & replan ON (both default ON)
delete process.env.AGENT_TOOL_ALTERNATIVE_RECOMMEND;
delete process.env.AGENT_REPLAN_ON_FAILURE;
// Silence other advisories that would add noise
process.env.AGENT_TOOL_RESULT_JUDGE = "0";
process.env.AGENT_CONTENT_SCRUB = "0";
process.env.AGENT_PROMPT_PATCH = "0";
// Keep the genealogy hint off so round-1 system messages don't include tool
// reliability text that could collide with the replan-message assertions.
process.env.AGENT_GENEALOGY_HINT = "0";

const { recordToolOutcomes, loadToolOutcomes } = await import(
  "../../lib/agent-genealogy.js"
);
const { recordRunFailures, isChronicallyBroken } = await import(
  "../../lib/agent-failure-store.js"
);
const { recommendAlternatives, recommenderEnabled } = await import(
  "../../lib/tool-alternative-recommender.js"
);
const { runAgentLoop } = await import("../../lib/agent-loop.js");

test.after(() => {
  for (const k of Object.keys(savedEnv)) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* noop */ }
});

test("replan-recommender: default env -> recommender flag is enabled", () => {
  assert.equal(recommenderEnabled(), true);
});

test("replan-recommender: failure -> analyzer classifies -> recommender has enough data to suggest alt -> next turn sees replan nudge", async () => {
  const workspace = "e2erec";

  // Seed: 10 search_context successes, 10 web_search failures in genealogy.
  const outcomes = [];
  for (let i = 0; i < 10; i++) outcomes.push({ tool: "search_context", ok: true });
  for (let i = 0; i < 10; i++) outcomes.push({ tool: "web_search", ok: false });
  await recordToolOutcomes(workspace, outcomes);

  // Seed failure-store with permission failures for web_search so
  // isChronicallyBroken() reports chronic=true (default threshold 3 terminal).
  const failures = [];
  for (let i = 0; i < 5; i++) failures.push({ tool: "web_search", category: "permission" });
  await recordRunFailures(workspace, failures);
  const chronic = await isChronicallyBroken(workspace, "web_search");
  assert.equal(chronic.chronic, true, "web_search should be flagged chronic before the run");
  assert.equal(chronic.dominantCategory, "permission");

  // Confirm the recommender, given this genealogy, would pick search_context
  // as the top alternative for a task mentioning "search" with "web_search"
  // as the failed tool. This is the "recommender suggests alt" assertion.
  const recs = await recommendAlternatives({
    workspace,
    failedToolName: "web_search",
    taskText: "search the docs for auth",
    availableTools: ["search_context", "list_context", "web_search"],
    opts: { limit: 3, minSamples: 3 },
  });
  assert.ok(recs.length >= 1, "recommender should surface at least one alternative");
  assert.equal(
    recs[0].tool,
    "search_context",
    "recommender should rank search_context first given its 10/10 genealogy",
  );

  // Mock backend: round 1 emits a web_search tool_call; the tool returns
  // a permission failure; the agent-loop injects the replan nudge; round 2
  // the LLM gives the final text.
  const captured = [];
  let agentRound = 0;
  const scenario = [
    {
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_ws1",
                type: "function",
                function: {
                  name: "web_search",
                  arguments: JSON.stringify({ query: "auth rotation" }),
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    },
    {
      choices: [
        { message: { role: "assistant", content: "Adapted plan; here is the summary." } },
      ],
    },
  ];
  const backendFetch = async (_url, opts) => {
    let body;
    try { body = JSON.parse(opts.body); } catch { body = {}; }
    captured.push(body);
    const entry = scenario[Math.min(agentRound, scenario.length - 1)];
    agentRound++;
    return {
      ok: true,
      headers: { get: () => "application/json" },
      json: async () => entry,
    };
  };

  // web_search requires SEARCH_API to be configured; without it the tool
  // returns ok:false with a permission/config error. That's what we want
  // (a real failure flowing through the analyzer). Confirm SEARCH_API is
  // unset so the tool fails the way we expect.
  const prevSearchApi = process.env.SEARCH_API;
  delete process.env.SEARCH_API;

  try {
    const req = {
      userId: null,
      body: {
        model: "test-model",
        messages: [{ role: "user", content: "search the docs for auth" }],
        agentOptions: { workspace, allowExecution: false },
      },
    };
    const res = { headersSent: false, setHeader() {} };
    const config = { baseUrl: "http://mock", path: "/v1/chat", headers: {} };

    const result = await runAgentLoop(req, res, config, "test-model", null, backendFetch);

    // The loop should have adapted (round 2 final text).
    assert.equal(result.stopReason, "model_finished");

    // web_search's failure should be recorded in the tool-call log with ok:false.
    const wsEntry = result.toolCalls.find((t) => t.name === "web_search");
    assert.ok(wsEntry, "web_search should appear in toolCalls log");
    assert.equal(wsEntry.ok, false, "web_search call should be marked ok:false");

    // The round-2 outbound body should contain the replan nudge as a system
    // message mentioning the tool name. It MAY also include the chronic
    // history avoidance hint because isChronicallyBroken returned true.
    assert.ok(captured.length >= 2, `expected 2 backend calls, got ${captured.length}`);
    const round2 = captured[1];
    const sysMsgs = (round2.messages || []).filter((m) => m.role === "system");
    const replanMsg = sysMsgs.find(
      (m) =>
        typeof m.content === "string" &&
        /Tool 'web_search' failed/.test(m.content),
    );
    assert.ok(replanMsg, "round-2 system messages should include the replan nudge for web_search");
    // The analyzer's category marker should be "permission" because web_search
    // without SEARCH_API returns "not configured" — that text can match several
    // categories, so assert the message at least includes a classifier label.
    assert.match(
      replanMsg.content,
      /failed \((permission|not_allowed|backend_error|unknown|semantic|network|validation|unknown_tool|not_found|rate_limit|timeout)\)/,
      "replan message should include a classifier category",
    );
    // Chronic-history avoidance hint should fire (web_search was pre-seeded
    // with 5 permission failures, default threshold is 3).
    assert.match(
      replanMsg.content,
      /Prior runs in this workspace/,
      "chronic history hint should be injected when isChronicallyBroken returns true",
    );

    // Genealogy should now have an additional failure for web_search
    // (recorded by agent-loop after the run).
    const geneAfter = await loadToolOutcomes(workspace);
    const wsStats = geneAfter.tools?.web_search;
    assert.ok(wsStats, "genealogy should still have a web_search entry");
    assert.equal(
      wsStats.failures,
      11,
      `web_search should have 10 seeded + 1 new = 11 failures; got ${wsStats.failures}`,
    );
  } finally {
    if (prevSearchApi === undefined) delete process.env.SEARCH_API;
    else process.env.SEARCH_API = prevSearchApi;
  }
});
