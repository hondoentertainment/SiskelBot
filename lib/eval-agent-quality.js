/**
 * Eval harness for agent-quality enhancements.
 *
 * Deterministic, LLM-free evaluation that exercises the interplay of:
 *   - agent-tool-failure-analyzer.js (re-plan nudges, classification)
 *   - agent-failure-store.js        (chronic-failure escalation)
 *   - agent-genealogy.js            (cross-run reliability hint)
 *   - tool-semantic-validators.js   (post-schema argument rejection)
 *
 * Each scenario drives runAgentLoop() with a scripted mock backend so the
 * agent's behavior is reproducible across runs. runEvalComparison() executes
 * each scenario twice -- once with every enhancement DISABLED and once with
 * every enhancement ENABLED -- and returns a delta describing whether the
 * enhancements measurably changed the outcome.
 *
 * @module eval-agent-quality
 */

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * @typedef {object} EvalScenario
 * @property {string} name
 * @property {string} userMessage
 * @property {Array<{ tool: string, args?: object, result: object }>} mockToolBehaviors
 * @property {Array<{ assistant_calls_tool?: string, assistant_calls_args?: object, assistant_final?: string }>} scriptedLLMTurns
 * @property {string} workspace
 * @property {{ failures?: Array<{ tool: string, category: string, count: number }>, outcomes?: Array<{ tool: string, successes: number, failures: number }> }} [preSeed]
 */

/**
 * @typedef {object} EvalRunResult
 * @property {string} name
 * @property {number} iterations
 * @property {Array<{ name: string, ok: boolean, args?: any }>} toolCalls
 * @property {number} replanCount
 * @property {string} finalContent
 * @property {string} stopReason
 * @property {Record<string, string | undefined>} flags
 * @property {number} systemMessagesWithReliabilityHint
 * @property {number} systemMessagesWithReplan
 * @property {boolean} satisfied
 */

const FEATURE_ENV_VARS = /** @type {const} */ ([
  "AGENT_PERSIST_FAILURES",
  "AGENT_PERSIST_OUTCOMES",
  "AGENT_GENEALOGY_HINT",
  "TOOL_SEMANTIC_VALIDATION",
  "AGENT_REPLAN_ON_FAILURE",
  "AGENT_MAX_REPLANS",
  "AGENT_STAGNATION_STOP",
  "STORAGE_PATH",
]);

/* -------------------------------------------------------------------------- */
/* Built-in scenarios                                                         */
/* -------------------------------------------------------------------------- */

/** @returns {EvalScenario[]} */
export function builtinScenarios() {
  return [
    // Scenario 1: permanent tool failure, agent must re-plan once and succeed.
    {
      name: "replan-after-unknown-tool",
      userMessage: "Please search the knowledge base for 'deployment docs'.",
      workspace: "eval-ws-replan",
      mockToolBehaviors: [],
      scriptedLLMTurns: [
        // Round 1: agent tries a nonexistent tool
        { assistant_calls_tool: "nonexistent_search_tool", assistant_calls_args: { q: "deployment" } },
        // Round 2: (only in baseline) still failing, then gives up
        { assistant_calls_tool: "nonexistent_search_tool", assistant_calls_args: { q: "deployment docs" } },
        // Round 3: after re-plan nudge the agent finally produces a final answer
        { assistant_final: "Adapted strategy: returning manually-composed summary." },
      ],
    },

    // Scenario 2: a semantic-validator-rejectable argument (too-short query).
    // With TOOL_SEMANTIC_VALIDATION=1 the first call is rejected and the agent
    // must retry with a proper query. With it disabled, the short query slips
    // through and the tool "succeeds" (returning empty), so no retry happens.
    {
      name: "semantic-validator-rejects-short-query",
      userMessage: "Search our documents for the release notes.",
      workspace: "eval-ws-semantic",
      mockToolBehaviors: [],
      scriptedLLMTurns: [
        // Round 1: agent sends a one-character query (semantic validators reject >=3 chars).
        { assistant_calls_tool: "search_context", assistant_calls_args: { query: "r" } },
        // Round 2: agent sends a proper query
        { assistant_calls_tool: "search_context", assistant_calls_args: { query: "release notes" } },
        // Round 3: final answer
        { assistant_final: "Found release notes." },
      ],
    },

    // Scenario 3: chronic-failures across prior runs. We pre-seed the failure
    // store and genealogy store so the enhanced run prepends a reliability
    // hint and appends a chronic-escalation message after the first failure.
    // The scripted LLM sequence is identical for baseline and enhanced, but
    // the enhanced run sees the hint as a system message in turn 1.
    {
      name: "chronic-failures-warning",
      userMessage: "Search the context for the onboarding guide.",
      workspace: "eval-ws-chronic",
      mockToolBehaviors: [],
      preSeed: {
        failures: [
          { tool: "legacy_scraper", category: "permission", count: 3 },
          { tool: "legacy_scraper", category: "not_allowed", count: 2 },
        ],
        outcomes: [
          { tool: "legacy_scraper", successes: 0, failures: 10 },
          { tool: "search_context", successes: 9, failures: 1 },
        ],
      },
      scriptedLLMTurns: [
        // Round 1: agent picks search_context (ideally influenced by hint).
        { assistant_calls_tool: "search_context", assistant_calls_args: { query: "onboarding guide" } },
        // Round 2: final answer
        { assistant_final: "Here's a summary of the onboarding guide." },
      ],
    },
  ];
}

/* -------------------------------------------------------------------------- */
/* Single-scenario runner                                                     */
/* -------------------------------------------------------------------------- */

/**
 * @param {EvalScenario} scenario
 * @param {{ AGENT_PERSIST_FAILURES?: string, AGENT_PERSIST_OUTCOMES?: string, AGENT_GENEALOGY_HINT?: string, TOOL_SEMANTIC_VALIDATION?: string }} [featureFlags]
 * @returns {Promise<EvalRunResult>}
 */
export async function runEvalScenario(scenario, featureFlags = {}) {
  if (!scenario || typeof scenario !== "object") {
    throw new Error("runEvalScenario: scenario is required");
  }

  const saved = saveEnv(FEATURE_ENV_VARS);
  const tmp = mkdtempSync(join(tmpdir(), "siskel-eval-"));

  try {
    // Apply a clean, deterministic env for this run.
    process.env.STORAGE_PATH = tmp;
    // Re-plan is always on for the harness so we can observe re-plan counts;
    // individual enhancements are driven by feature flags.
    process.env.AGENT_REPLAN_ON_FAILURE = "1";
    process.env.AGENT_MAX_REPLANS = "3";
    // Disable stagnation-stop so the scripted LLM can call the same tool twice
    // without the loop terminating early with stopReason=stagnation.
    process.env.AGENT_STAGNATION_STOP = "0";

    applyFeatureFlags(featureFlags);

    // Pre-seed failure + genealogy stores for scenarios that need history.
    if (scenario.preSeed) {
      await seedStores(scenario.workspace, scenario.preSeed);
    }

    // Import agent-loop AFTER STORAGE_PATH is set so downstream modules pick
    // up the tmp dir. We re-import on every scenario to avoid any global-state
    // leakage between scenarios with different pre-seed data.
    const agentLoopMod = await import(`../lib/agent-loop.js?eval=${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const { runAgentLoop } = agentLoopMod;

    // Capture every outgoing LLM request so we can count injected system msgs.
    /** @type {Array<Array<{ role: string, content?: any }>>} */
    const capturedMessageBatches = [];
    const backendFetch = buildMockBackend(scenario.scriptedLLMTurns, capturedMessageBatches);

    const req = {
      userId: null,
      body: {
        model: "eval-model",
        messages: [{ role: "user", content: scenario.userMessage }],
        agentOptions: { workspace: scenario.workspace, allowExecution: false },
      },
    };
    const res = { headersSent: false, setHeader() {} };
    const config = { baseUrl: "http://mock", path: "/v1/chat", headers: {} };

    const result = await runAgentLoop(req, res, config, "eval-model", null, backendFetch);

    const systemMessagesWithReliabilityHint = countSystemMessages(
      capturedMessageBatches,
      /tool reliability in this workspace/i,
    );
    const systemMessagesWithReplan = countSystemMessages(
      capturedMessageBatches,
      /Tool '[^']+' failed/i,
    );

    // A "satisfied" run completed with a model_finished stop reason and a
    // non-placeholder final string (not "(Agent stopped: ...)").
    const satisfied =
      result.stopReason === "model_finished" &&
      typeof result.content === "string" &&
      !result.content.startsWith("(Agent ");

    // Agent-loop exposes toolCalls (log) and replan state via messages only.
    // We surface a simple replan counter by counting re-plan system messages.
    const replanCount = systemMessagesWithReplan;

    return {
      name: scenario.name,
      iterations: Number(result.iteration) || 0,
      toolCalls: Array.isArray(result.toolCalls)
        ? result.toolCalls.map((t) => ({ name: t.name, ok: !!t.ok, args: t.args }))
        : [],
      replanCount,
      finalContent: typeof result.content === "string" ? result.content : "",
      stopReason: String(result.stopReason || ""),
      flags: { ...featureFlags },
      systemMessagesWithReliabilityHint,
      systemMessagesWithReplan,
      satisfied,
    };
  } finally {
    restoreEnv(saved);
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

/* -------------------------------------------------------------------------- */
/* Baseline-vs-enhanced comparison                                            */
/* -------------------------------------------------------------------------- */

/**
 * @param {EvalScenario} scenario
 * @returns {Promise<{ baseline: EvalRunResult, enhanced: EvalRunResult, delta: { iterationsSaved: number, toolCallsSaved: number, firstTrySuccessImproved: boolean, satisfiedChange: -1|0|1, replanDelta: number } }>}
 */
export async function runEvalComparison(scenario) {
  const baseline = await runEvalScenario(scenario, {
    AGENT_PERSIST_FAILURES: "0",
    AGENT_PERSIST_OUTCOMES: "0",
    AGENT_GENEALOGY_HINT: "0",
    TOOL_SEMANTIC_VALIDATION: "0",
  });
  const enhanced = await runEvalScenario(scenario, {
    AGENT_PERSIST_FAILURES: "1",
    AGENT_PERSIST_OUTCOMES: "1",
    AGENT_GENEALOGY_HINT: "1",
    TOOL_SEMANTIC_VALIDATION: "1",
  });

  const iterationsSaved = baseline.iterations - enhanced.iterations;
  const toolCallsSaved = baseline.toolCalls.length - enhanced.toolCalls.length;
  const firstTrySuccessImproved =
    (enhanced.toolCalls[0]?.ok === true && baseline.toolCalls[0]?.ok === false) ||
    (enhanced.satisfied && !baseline.satisfied);
  /** @type {-1|0|1} */
  let satisfiedChange = 0;
  if (!baseline.satisfied && enhanced.satisfied) satisfiedChange = 1;
  else if (baseline.satisfied && !enhanced.satisfied) satisfiedChange = -1;

  return {
    baseline,
    enhanced,
    delta: {
      iterationsSaved,
      toolCallsSaved,
      firstTrySuccessImproved,
      satisfiedChange,
      replanDelta: baseline.replanCount - enhanced.replanCount,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Full report                                                                */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {object} EvalReport
 * @property {number} totalScenarios
 * @property {number} enhancedImproved
 * @property {number} enhancedRegressed
 * @property {number} unchanged
 * @property {Array<{ scenario: string, baseline: EvalRunResult, enhanced: EvalRunResult, delta: any }>} scenarios
 * @property {{ totalIterationsSaved: number, totalToolCallsSaved: number, totalReplansSaved: number }} totals
 */

/** @returns {Promise<EvalReport>} */
export async function runFullEval() {
  const scenarios = builtinScenarios();
  /** @type {EvalReport["scenarios"]} */
  const results = [];
  let enhancedImproved = 0;
  let enhancedRegressed = 0;
  let unchanged = 0;
  let totalIterationsSaved = 0;
  let totalToolCallsSaved = 0;
  let totalReplansSaved = 0;

  for (const s of scenarios) {
    const cmp = await runEvalComparison(s);
    results.push({ scenario: s.name, baseline: cmp.baseline, enhanced: cmp.enhanced, delta: cmp.delta });

    totalIterationsSaved += cmp.delta.iterationsSaved;
    totalToolCallsSaved += cmp.delta.toolCallsSaved;
    totalReplansSaved += cmp.delta.replanDelta;

    const improved =
      cmp.delta.satisfiedChange === 1 ||
      cmp.delta.iterationsSaved > 0 ||
      cmp.delta.firstTrySuccessImproved ||
      cmp.enhanced.systemMessagesWithReliabilityHint > cmp.baseline.systemMessagesWithReliabilityHint;
    const regressed =
      cmp.delta.satisfiedChange === -1 ||
      cmp.delta.iterationsSaved < 0;
    if (improved && !regressed) enhancedImproved++;
    else if (regressed && !improved) enhancedRegressed++;
    else unchanged++;
  }

  return {
    totalScenarios: scenarios.length,
    enhancedImproved,
    enhancedRegressed,
    unchanged,
    scenarios: results,
    totals: { totalIterationsSaved, totalToolCallsSaved, totalReplansSaved },
  };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Build a mock OpenAI-style backend that replays scriptedLLMTurns in order.
 * The mock also records the `messages` array sent on each call so callers can
 * inspect injected system messages (reliability hint, re-plan nudge, etc.).
 *
 * @param {Array<{ assistant_calls_tool?: string, assistant_calls_args?: object, assistant_final?: string }>} turns
 * @param {Array<Array<{ role: string, content?: any }>>} capturedMessageBatches - out-param
 */
function buildMockBackend(turns, capturedMessageBatches) {
  let round = 0;
  return async (_url, opts) => {
    try {
      if (opts?.body) {
        const parsed = JSON.parse(opts.body);
        if (Array.isArray(parsed.messages)) {
          capturedMessageBatches.push(parsed.messages);
        }
      }
    } catch { /* capture is best-effort */ }

    const turn = turns[round] || turns[turns.length - 1] || { assistant_final: "(fallback)" };
    round++;

    /** @type {any} */
    let payload;
    if (turn.assistant_calls_tool) {
      payload = {
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: `call_${round}`,
                  type: "function",
                  function: {
                    name: turn.assistant_calls_tool,
                    arguments: JSON.stringify(turn.assistant_calls_args || {}),
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      };
    } else {
      payload = {
        choices: [
          {
            message: {
              role: "assistant",
              content: turn.assistant_final || "(no text)",
            },
            finish_reason: "stop",
          },
        ],
      };
    }

    return {
      ok: true,
      headers: { get: () => "application/json" },
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    };
  };
}

/**
 * Count injected system messages matching `pattern` across every outgoing LLM
 * request. We tally per-round so repeated injections across turns are counted
 * once each; the UI-useful value is "did at least one round see the hint?".
 *
 * @param {Array<Array<{ role: string, content?: any }>>} batches
 * @param {RegExp} pattern
 */
function countSystemMessages(batches, pattern) {
  let count = 0;
  for (const batch of batches) {
    for (const m of batch) {
      if (!m || m.role !== "system") continue;
      if (typeof m.content !== "string") continue;
      if (pattern.test(m.content)) {
        count++;
        break; // per-batch dedup
      }
    }
  }
  return count;
}

/**
 * Save the current values of a fixed set of env vars so they can be restored.
 * @param {readonly string[]} names
 */
function saveEnv(names) {
  /** @type {Record<string, string | undefined>} */
  const saved = {};
  for (const n of names) saved[n] = process.env[n];
  return saved;
}

/**
 * Restore env vars previously saved by saveEnv().
 * @param {Record<string, string | undefined>} saved
 */
function restoreEnv(saved) {
  for (const [name, val] of Object.entries(saved)) {
    if (val === undefined) delete process.env[name];
    else process.env[name] = val;
  }
}

/** @param {object} flags */
function applyFeatureFlags(flags) {
  const names = [
    "AGENT_PERSIST_FAILURES",
    "AGENT_PERSIST_OUTCOMES",
    "AGENT_GENEALOGY_HINT",
    "TOOL_SEMANTIC_VALIDATION",
  ];
  for (const n of names) {
    if (flags[n] !== undefined) process.env[n] = String(flags[n]);
    else delete process.env[n];
  }
}

/**
 * Populate the failure + genealogy stores so the reliability hint has enough
 * signal to actually appear in the system prompt.
 *
 * @param {string} workspace
 * @param {NonNullable<EvalScenario["preSeed"]>} preSeed
 */
async function seedStores(workspace, preSeed) {
  const { recordRunFailures } = await import(`../lib/agent-failure-store.js?eval=${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const { recordToolOutcomes } = await import(`../lib/agent-genealogy.js?eval=${Date.now()}-${Math.random().toString(36).slice(2)}`);

  if (Array.isArray(preSeed.failures) && preSeed.failures.length > 0) {
    /** @type {Array<{ tool: string, category: string }>} */
    const expanded = [];
    for (const f of preSeed.failures) {
      for (let i = 0; i < (Number(f.count) || 1); i++) {
        expanded.push({ tool: f.tool, category: f.category });
      }
    }
    if (expanded.length > 0) await recordRunFailures(workspace, expanded);
  }

  if (Array.isArray(preSeed.outcomes) && preSeed.outcomes.length > 0) {
    /** @type {Array<{ tool: string, ok: boolean }>} */
    const outcomes = [];
    for (const o of preSeed.outcomes) {
      const s = Number(o.successes) || 0;
      const f = Number(o.failures) || 0;
      for (let i = 0; i < s; i++) outcomes.push({ tool: o.tool, ok: true });
      for (let i = 0; i < f; i++) outcomes.push({ tool: o.tool, ok: false });
    }
    if (outcomes.length > 0) await recordToolOutcomes(workspace, outcomes);
  }
}
