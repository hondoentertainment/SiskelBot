/**
 * E2E: full agent request with all quality features enabled.
 *
 * Scenario: user asks "search the docs for auth"; the mock backend scripts
 * one tool_call to search_context followed by a final text answer. We verify
 * that every quality subsystem wired into runAgentLoop fires in the right
 * order and persists its effects.
 *
 * What we cover:
 *   - runAgentLoop completes with stopReason = "model_finished"
 *   - Trajectory collector records a tool_call + tool_result pair
 *   - Genealogy store records a successful outcome for search_context
 *   - Failure store stays empty for this workspace
 *   - Prometheus tool-outcome counter increments
 *   - Content scrubber does NOT redact anything (result is clean)
 *   - Tool-result judge does NOT append an advisory (fast-path, judge passes)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate storage BEFORE importing any module that touches it.
const TMP_ROOT = mkdtempSync(join(tmpdir(), "e2e-full-pipeline-"));
const savedEnv = {
  STORAGE_PATH: process.env.STORAGE_PATH,
  ENABLE_METRICS: process.env.ENABLE_METRICS,
  AGENT_TOOL_RESULT_JUDGE: process.env.AGENT_TOOL_RESULT_JUDGE,
  AGENT_CONTENT_SCRUB: process.env.AGENT_CONTENT_SCRUB,
  AGENT_TRAJECTORY_API: process.env.AGENT_TRAJECTORY_API,
  AGENT_PROMPT_PATCH: process.env.AGENT_PROMPT_PATCH,
  AGENT_GENEALOGY_HINT: process.env.AGENT_GENEALOGY_HINT,
  AGENT_PERSIST_OUTCOMES: process.env.AGENT_PERSIST_OUTCOMES,
  AGENT_PERSIST_FAILURES: process.env.AGENT_PERSIST_FAILURES,
};
process.env.STORAGE_PATH = TMP_ROOT;
process.env.ENABLE_METRICS = "1";
process.env.AGENT_TOOL_RESULT_JUDGE = "1";
process.env.AGENT_CONTENT_SCRUB = "1";
process.env.AGENT_TRAJECTORY_API = "1";
// Explicit defaults for things we rely on being "on"
delete process.env.AGENT_PROMPT_PATCH;
delete process.env.AGENT_GENEALOGY_HINT;
delete process.env.AGENT_PERSIST_OUTCOMES;
delete process.env.AGENT_PERSIST_FAILURES;

const { runAgentLoop } = await import("../../lib/agent-loop.js");
const { loadToolOutcomes } = await import("../../lib/agent-genealogy.js");
const { loadFailureStats } = await import("../../lib/agent-failure-store.js");
const {
  renderPrometheus,
  __resetAgentQualityMetricsForTests,
} = await import("../../lib/metrics.js");

test.after(() => {
  for (const k of Object.keys(savedEnv)) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* noop */ }
});

/**
 * Build a mock backend that returns scripted responses. Each call pops one.
 * The judge (when enabled) also calls backendFetch, so we intercept any call
 * whose body indicates a judge prompt and return a "satisfactory:true" JSON.
 */
function scriptedBackend(scenario) {
  let agentRound = 0;
  const capturedBodies = [];
  const fetcher = async (_url, opts) => {
    let body;
    try { body = JSON.parse(opts.body); } catch { body = {}; }
    capturedBodies.push(body);
    const isJudge =
      Array.isArray(body.messages) &&
      body.messages.some((m) => m.role === "system" && /JSON-only judge/i.test(m.content || ""));
    if (isJudge) {
      return {
        ok: true,
        headers: { get: () => "application/json" },
        json: async () => ({
          choices: [
            { message: { role: "assistant", content: '{"satisfactory": true, "confidence": 0.9}' } },
          ],
        }),
      };
    }
    const entry = scenario[Math.min(agentRound, scenario.length - 1)];
    agentRound++;
    return {
      ok: true,
      headers: { get: () => "application/json" },
      json: async () => entry,
    };
  };
  fetcher.captured = capturedBodies;
  return fetcher;
}

test("full-pipeline: one request, all features on, every store sees the right effect", async (t) => {
  __resetAgentQualityMetricsForTests();
  const workspace = "e2e-full";

  const scenario = [
    // Round 1: LLM calls search_context.
    {
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "search_context",
                  arguments: JSON.stringify({ query: "auth token rotation" }),
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    },
    // Round 2: LLM produces the final answer.
    {
      choices: [
        { message: { role: "assistant", content: "Here's what I found about auth." } },
      ],
    },
  ];

  const backendFetch = scriptedBackend(scenario);

  const req = {
    userId: null,
    body: {
      model: "test-model",
      messages: [
        { role: "user", content: "search the docs for auth" },
      ],
      agentOptions: { workspace, allowExecution: false },
    },
  };
  const res = { headersSent: false, setHeader() {} };
  const config = { baseUrl: "http://mock", path: "/v1/chat", headers: {} };

  const result = await runAgentLoop(req, res, config, "test-model", null, backendFetch);

  // Core loop behaviour
  assert.equal(result.stopReason, "model_finished");
  assert.ok(result.content.includes("auth"));
  assert.equal(result.iteration, 2);

  // One successful search_context call was logged.
  const searchEntry = result.toolCalls.find((c) => c.name === "search_context");
  assert.ok(searchEntry, "search_context should appear in toolCalls");
  assert.equal(searchEntry.ok, true);

  // Trajectory captured both tool_call and tool_result events.
  assert.ok(result.trajectory, "trajectory snapshot should be attached");
  const steps = Array.isArray(result.trajectory.steps) ? result.trajectory.steps : [];
  const toolCallSteps = steps.filter((s) => s.type === "tool_call" && s.name === "search_context");
  const toolResultSteps = steps.filter((s) => s.type === "tool_result" && s.name === "search_context");
  assert.ok(toolCallSteps.length >= 1, "trajectory should include a tool_call step");
  assert.ok(toolResultSteps.length >= 1, "trajectory should include a tool_result step");

  // Genealogy store: a success was recorded for search_context.
  const genealogy = await loadToolOutcomes(workspace);
  const sc = genealogy.tools?.search_context;
  assert.ok(sc, "genealogy should have an entry for search_context");
  assert.equal(sc.successes, 1, "search_context should have exactly 1 success recorded");
  assert.equal(sc.failures || 0, 0);

  // Failure store: stays empty because nothing failed.
  const failStats = await loadFailureStats(workspace);
  assert.deepEqual(failStats.tools || {}, {}, "failure store should be empty on happy path");

  // Prometheus: tool-outcome counter incremented for search_context success.
  const prom = renderPrometheus();
  assert.match(
    prom,
    /siskelbot_agent_tool_outcome_total\{[^}]*tool="search_context"[^}]*outcome="success"\}\s+(?:[1-9]\d*)/,
    "tool-outcome success counter should be present and non-zero",
  );

  // Judge advisory: should NOT appear for the successful clean result. The
  // tool-result content in messages should not contain "[judge]".
  const toolMessages = scenario /* unused but documents structure */;
  void toolMessages;
  // Inspect the captured round-2 request body: the tool-result message it
  // contains should not have a judge advisory marker. The judge adds its own
  // captured body between rounds, so filter down to agent round bodies first.
  const agentBodies = backendFetch.captured.filter(
    (b) =>
      !(Array.isArray(b.messages) &&
        b.messages.some((m) => m.role === "system" && /JSON-only judge/i.test(m.content || ""))),
  );
  assert.ok(agentBodies.length >= 2, `expected at least 2 agent-round bodies, got ${agentBodies.length}`);
  const round2Body = agentBodies[1];
  const toolRoleMsgs = (round2Body.messages || []).filter((m) => m.role === "tool");
  assert.ok(toolRoleMsgs.length >= 1, "round 2 should include at least one tool-role message");
  for (const m of toolRoleMsgs) {
    assert.ok(
      !String(m.content).includes("[judge]"),
      "clean tool result should not have a judge advisory appended",
    );
  }

  // Content scrubber: clean input means no [REDACTED_*] markers in any message.
  const allMsgsText = (round2Body.messages || []).map((m) => String(m.content || "")).join("\n");
  assert.ok(
    !/\[REDACTED_/.test(allMsgsText),
    "no REDACTED markers should appear when tool output is clean",
  );
});
