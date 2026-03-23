/**
 * Agent swarm coordinator: specialist agents (researcher, executor, synthesizer),
 * intent detection, parallel specialist execution (Promise.all), and aggregation.
 * Direct-tool paths (legacy /v1/swarm) fan out independent tools per specialist in parallel.
 * Phase 90: optional client roster via `SWARM_CLIENT_SPECIALISTS` + `agentOptions.swarmSpecialists` (header `X-Swarm-Roster-Source`).
 * Phase 91: optional `SWARM_SPECIALISTS_ALLOWLIST` intersects all swarm specialist resolution paths and client roster options.
 * Observability: tracks specialists, latency, success/failure; emits webhook events; provides header metadata.
 */
import { randomUUID } from "crypto";
import { emitEvent } from "./webhooks.js";
import { getSpecialist, getSpecialists, getModelForSpecialist } from "./specialists.js";
import { recordSwarm, recordAgentPhaseMs, recordAgentRunSummary } from "./metrics.js";
import { getToolsForNames, runTool, filterToolsByWorkspaceAllowlist } from "./agent-tools.js";
import { validateToolCall, toolValidationEnabled } from "./tool-validation.js";
import { detectStagnation, stagnationDetectionEnabled } from "./agent-stagnation.js";
import { augmentMessagesForGrounding } from "./grounding.js";
import { augmentMessagesWithDefaultSystem } from "./agent-defaults.js";
import { augmentMessagesWithWorkspaceAgent, loadWorkspaceAgentSettings } from "./workspace-agent-settings.js";
import { resolveStorageUserId } from "./teams.js";
import { detectIntentForSwarm, detectIntentKeyword } from "./swarm-intent-v2.js";

const WORKSPACE = "default";
const MAX_AGENT_TOOL_CALLS_SWARM = Number(process.env.MAX_AGENT_TOOL_CALLS) || 0;
const AGENT_MAX_WALL_MS_SWARM = Number(process.env.AGENT_MAX_WALL_MS) || 0;

/** @deprecated Import from ./swarm-intent-v2.js; re-exported for compatibility. */
export function detectIntent(message) {
  return detectIntentKeyword(message);
}

/** Query looks like a knowledge document id (for legacy/direct swarm fetch-by-id). */
const CONTEXT_DOC_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let warnedEmptySwarmSpecialistsAllowlist = false;

/**
 * Phase 91: Optional comma-separated allowlist (`SWARM_SPECIALISTS_ALLOWLIST`). When set, only these specialist names may run in LLM swarm (client roster, parallel, and intent paths).
 * @returns {Set<string>|null}
 */
export function parseSwarmSpecialistsAllowlistSet() {
  const raw = (process.env.SWARM_SPECIALISTS_ALLOWLIST || "").trim();
  if (!raw) return null;
  const names = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return names.length ? new Set(names) : null;
}

/** @returns {string[]|null} */
export function getSwarmSpecialistsAllowlistNames() {
  const s = parseSwarmSpecialistsAllowlistSet();
  return s ? [...s] : null;
}

/**
 * @param {string[]} names
 * @returns {string[]}
 */
export function intersectSwarmSpecialistsWithAllowlist(names) {
  const allow = parseSwarmSpecialistsAllowlistSet();
  if (!allow || !Array.isArray(names)) return Array.isArray(names) ? [...names] : [];
  return names.filter((n) => allow.has(n));
}

/** When intent / defaults yield no specialists after allowlist, pick first allowlisted non-synthesizer, else researcher / any specialist. */
function resolveSwarmAllowlistFallback() {
  const allow = parseSwarmSpecialistsAllowlistSet();
  if (allow && allow.size > 0) {
    for (const n of allow) {
      const sp = getSpecialist(n);
      if (sp && sp.name !== "synthesizer") return [n];
    }
  }
  const r = getSpecialist("researcher");
  if (r) return ["researcher"];
  const alt = getSpecialists().find((s) => s.name !== "synthesizer");
  return alt ? [alt.name] : [];
}

/**
 * Non-synthesizer specialists exposed to the client for swarm roster UI, intersected with Phase 91 allowlist.
 * @returns {string[]}
 */
export function getSwarmSelectableSpecialistNames() {
  const base = getSpecialists()
    .filter((s) => s.name !== "synthesizer")
    .map((s) => s.name);
  const out = intersectSwarmSpecialistsWithAllowlist(base);
  if (!warnedEmptySwarmSpecialistsAllowlist && parseSwarmSpecialistsAllowlistSet() && out.length === 0) {
    warnedEmptySwarmSpecialistsAllowlist = true;
    console.warn(
      "[swarm] SWARM_SPECIALISTS_ALLOWLIST matches no configured specialists; swarm roster UI will be empty."
    );
  }
  return out;
}

/**
 * Phase 78: Resolve LLM swarm specialists — optional full parallel fan-out (researcher + executor).
 * Phase 90: Optional client roster `agentOptions.swarmSpecialists` when `SWARM_CLIENT_SPECIALISTS=1` (multiple agents in parallel).
 * Phase 91: `SWARM_SPECIALISTS_ALLOWLIST` intersects every resolution path.
 * Precedence: client roster → parallel fan-out → intent.
 *
 * @param {{ researcher: boolean, executor: boolean }} intent
 * @param {object} [agentOptions]
 * @returns {{ specialistNames: string[], parallelFanOut: boolean, rosterSource: "client"|"parallel"|"intent" }}
 */
export function resolveSwarmSpecialistNames(intent, agentOptions = {}) {
  const agentOpts = agentOptions || {};

  if (process.env.SWARM_CLIENT_SPECIALISTS === "1" && Array.isArray(agentOpts.swarmSpecialists) && agentOpts.swarmSpecialists.length > 0) {
    const maxN = Math.min(12, Math.max(1, Number(process.env.SWARM_MAX_SPECIALISTS) || 8));
    const seen = new Set();
    const names = [];
    for (const x of agentOpts.swarmSpecialists) {
      const n = String(x || "").trim();
      if (!n || seen.has(n)) continue;
      const sp = getSpecialist(n);
      if (sp && sp.name !== "synthesizer") {
        seen.add(n);
        names.push(n);
        if (names.length >= maxN) break;
      }
    }
    const filtered = intersectSwarmSpecialistsWithAllowlist(names);
    if (filtered.length > 0) {
      return { specialistNames: filtered, parallelFanOut: false, rosterSource: "client" };
    }
  }

  const envParallel = String(process.env.SWARM_PARALLEL_AGENTS || "").trim() === "1";
  let parallelFanOut = envParallel;
  if (agentOpts.parallelAgents === true) parallelFanOut = true;
  if (agentOpts.parallelAgents === false) parallelFanOut = false;

  if (parallelFanOut) {
    const parallelNames = intersectSwarmSpecialistsWithAllowlist(["researcher", "executor"]);
    if (parallelNames.length === 0) {
      parallelFanOut = false;
    } else if (parallelNames.length === 1) {
      return { specialistNames: parallelNames, parallelFanOut: false, rosterSource: "parallel" };
    } else {
      return { specialistNames: parallelNames, parallelFanOut: true, rosterSource: "parallel" };
    }
  }
  let eligible = [];
  if (intent.researcher) eligible.push("researcher");
  if (intent.executor) eligible.push("executor");
  eligible = intersectSwarmSpecialistsWithAllowlist(eligible);
  let specialistNames =
    eligible.length > 0 ? eligible : intersectSwarmSpecialistsWithAllowlist(["researcher"]);
  if (specialistNames.length === 0) {
    specialistNames = resolveSwarmAllowlistFallback();
  }
  return { specialistNames, parallelFanOut: false, rosterSource: "intent" };
}

/**
 * Run independent researcher tools in parallel (direct / legacy swarm paths).
 * @param {string[]} toolNames - from specialist.tools
 */
async function fetchResearcherToolPartsParallel(toolNames, q, toolCtx) {
  const jobs = [];
  if (toolNames.includes("list_context")) {
    jobs.push(
      runTool("list_context", {}, toolCtx).then((r) => ["list_context", JSON.parse(r.content)])
    );
  }
  if (toolNames.includes("search_context")) {
    jobs.push(
      runTool("search_context", { query: q || "general" }, toolCtx).then((r) => ["search_context", JSON.parse(r.content)])
    );
  }
  if (toolNames.includes("semantic_search_context")) {
    jobs.push(
      runTool("semantic_search_context", { query: q || "general" }, toolCtx).then((r) => [
        "semantic_search_context",
        JSON.parse(r.content),
      ])
    );
  }
  if (toolNames.includes("get_context_document") && CONTEXT_DOC_ID_RE.test(q)) {
    jobs.push(
      runTool("get_context_document", { id: q }, toolCtx).then((r) => ["get_context_document", JSON.parse(r.content)])
    );
  }
  if (jobs.length === 0) return {};
  const entries = await Promise.all(jobs);
  return Object.fromEntries(entries);
}

/**
 * Run independent executor tools in parallel (direct / legacy swarm paths).
 */
async function fetchExecutorToolPartsParallel(toolNames, q, toolCtx) {
  const jobs = [];
  if (toolNames.includes("list_recipes")) {
    jobs.push(
      runTool("list_recipes", {}, toolCtx).then((r) => ["list_recipes", JSON.parse(r.content)])
    );
  }
  if (toolNames.includes("get_recipe")) {
    jobs.push(
      runTool("get_recipe", { name: q || "default" }, toolCtx).then((r) => ["get_recipe", JSON.parse(r.content)])
    );
  }
  if (jobs.length === 0) return {};
  const entries = await Promise.all(jobs);
  return Object.fromEntries(entries);
}

/**
 * Run specialists directly (tool-only, no LLM) for POST /v1/swarm.
 * Fault-tolerant: if one specialist throws, log it, include error in aggregation, let others complete.
 * @param {string[]} specialistNames - e.g. ['researcher','executor']
 * @param {string} query
 * @param {object} opts - { workspace, allowExecution, projectDir?, vercelToken? }
 * @returns {{ aggregation: object[], metrics: { agentCount: number, durationMs: number } }}
 */
export async function runSwarmDirect(specialistNames, query, opts = {}) {
  const runId = randomUUID();
  const workspace = opts.workspace || WORKSPACE;
  const toolCtx = {
    allowExecution: opts.allowExecution === true,
    projectDir: opts.projectDir || process.env.PROJECT_DIR || process.cwd(),
    vercelToken: opts.vercelToken || process.env.VERCEL_TOKEN,
    workspace,
  };

  await emitEvent("swarm_started", { runId, specialists: specialistNames, query }, { workspaceId: workspace });
  const startMs = Date.now();

  const results = await Promise.all(
    specialistNames.map(async (name) => {
      const t0 = Date.now();
      let success = false;
      let output = "";
      let error = null;
      try {
        const def = getSpecialist(name);
        if (!def) throw new Error(`Unknown specialist: ${name}`);
        const tools = def.tools || [];
        const q = (query || "").trim();

        if (name === "researcher") {
          const parts = await fetchResearcherToolPartsParallel(tools, q, toolCtx);
          output = JSON.stringify(parts);
          success = Object.keys(parts).length > 0;
        } else if (name === "executor") {
          const parts = await fetchExecutorToolPartsParallel(tools, q, toolCtx);
          output = JSON.stringify(parts);
          success = Object.keys(parts).length > 0;
        } else if (tools.includes("search_context")) {
          const r = await runTool("search_context", { query: query || "" }, toolCtx);
          output = r.content;
          success = true;
        } else if (tools.includes("list_context")) {
          const r = await runTool("list_context", {}, toolCtx);
          output = r.content;
          success = true;
        } else if (tools.includes("get_recipe")) {
          const r = await runTool("get_recipe", { name: query || "default" }, toolCtx);
          output = r.content;
          success = !output.includes('"error"');
        } else {
          output = JSON.stringify({ error: `Specialist ${name} has no runnable tools for query` });
        }
      } catch (e) {
        error = e;
        console.warn(`[swarm] Specialist ${name} threw:`, e?.message || e);
        output = JSON.stringify({ ok: false, error: String(e?.message || e) });
      }
      const latencyMs = Date.now() - t0;
      await emitEvent(
        "swarm_specialist_completed",
        { runId, specialist: name, success, latencyMs, error: error?.message },
        { workspaceId: workspace }
      );
      return { specialist: name, output, success, latencyMs, error };
    })
  );

  const durationMs = Date.now() - startMs;
  await emitEvent(
    "swarm_completed",
    {
      runId,
      specialistCount: results.length,
      successCount: results.filter((r) => r.success).length,
      durationMs,
      specialists: results.map((r) => ({ name: r.specialist, success: r.success, latencyMs: r.latencyMs })),
    },
    { workspaceId: workspace }
  );

  const aggregation = results.map((r) => ({
    specialist: r.specialist,
    output: r.output,
    success: r.success,
    latencyMs: r.latencyMs,
    error: r.error?.message,
  }));

  return {
    aggregation,
    metrics: { agentCount: results.length, durationMs },
  };
}

/**
 * Run a specialist's agent loop (LLM + tools) until no more tool_calls.
 * @param {string} specialistName - researcher | executor
 * @param {object[]} messages - Chat messages (will be prefixed with system prompt)
 * @param {object} opts - { url, config, model, toolCtx, backendFetch, maxIterations, storageUserId, workspace, agentOptions?, swarmRunStartedMs? }
 * @returns {Promise<{ content: string }>}
 */
async function runSpecialistLoop(specialistName, messages, opts) {
  const specialist = getSpecialist(specialistName);
  if (!specialist) {
    return { content: JSON.stringify({ error: `Unknown specialist: ${specialistName}` }) };
  }

  const {
    url,
    config,
    model,
    toolCtx,
    backendFetch,
    maxIterations = 5,
    storageUserId,
    workspace,
    agentOptions = {},
    swarmRunStartedMs,
  } = opts;
  const specialistModel = getModelForSpecialist(specialistName, model);
  let tools = specialist.tools?.length ? getToolsForNames(specialist.tools) : [];
  const systemMsg = { role: "system", content: specialist.systemPrompt };
  const su = storageUserId || toolCtx?.workspaceUserId || "anonymous";
  const ws = workspace || toolCtx?.workspace || WORKSPACE;
  tools = filterToolsByWorkspaceAllowlist(tools, toolCtx?.workspaceAllowedToolNames);
  let currentMessages = augmentMessagesWithDefaultSystem([systemMsg, ...messages]);
  currentMessages = await augmentMessagesWithWorkspaceAgent(currentMessages, su, ws);
  currentMessages = augmentMessagesForGrounding(currentMessages);
  let lastContent = "";
  const toolCallsLog = [];
  let totalToolCalls = 0;
  const runAnchor = swarmRunStartedMs ?? Date.now();
  const baseToolChoice = agentOptions.toolChoice != null ? agentOptions.toolChoice : "auto";
  const requiredSeq = Array.isArray(agentOptions.requiredToolSequence)
    ? agentOptions.requiredToolSequence.map((x) => String(x).trim()).filter(Boolean)
    : [];

  for (let i = 0; i < maxIterations; i++) {
    if (AGENT_MAX_WALL_MS_SWARM > 0 && Date.now() - runAnchor > AGENT_MAX_WALL_MS_SWARM) {
      lastContent = "(Specialist stopped: wall clock budget exceeded)";
      break;
    }

    let toolChoiceThis = baseToolChoice;
    if (requiredSeq.length > 0 && i === 0) {
      toolChoiceThis = { type: "function", function: { name: requiredSeq[0] } };
    }

    const body = {
      model: specialistModel,
      messages: currentMessages,
      stream: false,
      ...(tools.length > 0 && {
        tools,
        tool_choice: toolChoiceThis,
      }),
    };
    if (agentOptions.responseFormat && typeof agentOptions.responseFormat === "object") {
      body.response_format = agentOptions.responseFormat;
    }

    const response = await backendFetch(url, {
      method: "POST",
      headers: config.headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Backend error: ${response.status} ${err?.slice(0, 200) || ""}`);
    }

    const data = await response.json().catch(() => ({}));
    const choice = data.choices?.[0];
    const msg = choice?.message;

    if (!msg) {
      lastContent = "(No response from model)";
      break;
    }

    const content = typeof msg.content === "string" ? msg.content : "";
    const toolCalls = msg.tool_calls;

    if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
      lastContent = content || "(Empty response)";
      break;
    }

    currentMessages.push(msg);
    const iteration = i + 1;

    // Run tool calls in parallel
    const results = await Promise.all(
      toolCalls.map(async (tc) => {
        const name = tc.function?.name;
        const argsStr = tc.function?.arguments || "{}";
        let args = {};
        let parseError = null;
        try {
          args = JSON.parse(argsStr);
        } catch (e) {
          parseError = e?.message || "invalid json";
          args = {};
        }

        if (toolValidationEnabled()) {
          const v = validateToolCall(name, args, { parseError });
          if (!v.valid) {
            toolCallsLog.push({ name, args, iteration, validationError: true });
            return {
              tc,
              result: {
                content: JSON.stringify({
                  _tool_validation_error: true,
                  errors: v.errors,
                  repairHint: v.repairHint,
                  message: "Correct the tool call; the server did not execute invalid arguments.",
                }),
              },
            };
          }
        }

        toolCallsLog.push({ name, args, iteration });
        const result = await runTool(name, args, toolCtx);
        return { tc, result };
      })
    );

    for (const { tc, result } of results) {
      currentMessages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: result.content,
      });
    }

    totalToolCalls += toolCalls.length;
    if (MAX_AGENT_TOOL_CALLS_SWARM > 0 && totalToolCalls >= MAX_AGENT_TOOL_CALLS_SWARM) {
      lastContent = "(Specialist stopped: tool call budget reached)";
      break;
    }

    if (stagnationDetectionEnabled() && detectStagnation(toolCallsLog)) {
      lastContent = "(Agent stopped: repeated identical tool calls with no progress)";
      break;
    }
  }

  return { content: lastContent };
}

/**
 * Run swarm: detect intent, run eligible specialists in parallel, synthesize.
 * Same return shape as runAgentLoop: { content, iteration } for SSE.
 *
 * @param {object} req - Express request (body.messages, body.agentOptions)
 * @param {object} res - Express response (for headers)
 * @param {object} config - { baseUrl, path, headers }
 * @param {string} model - Model name
 * @param {object} options - { backendFetch, maxIterations }
 * @returns {Promise<{ content: string, iteration: number }>}
 */
export async function runSwarm(req, res, config, model, options = {}) {
  const backendFetch = options.backendFetch || fetch;
  const maxIterations = options.maxIterations ?? 5;
  res.setHeader("X-Agent-Max-Iterations", String(maxIterations));
  const allowExecution = req.body?.agentOptions?.allowExecution === true;
  const workspace = req.body?.agentOptions?.workspace || "default";
  const storageUserId = await resolveStorageUserId(req.userId || "anonymous", workspace);
  const wsAgentSettings = await loadWorkspaceAgentSettings(storageUserId, workspace);
  const workspaceAllowedTools =
    wsAgentSettings.allowedTools?.length > 0 ? new Set(wsAgentSettings.allowedTools) : null;

  const toolCtx = {
    allowExecution: options.allowRecipeExecution && allowExecution,
    projectDir: process.env.PROJECT_DIR || process.cwd(),
    vercelToken: process.env.VERCEL_TOKEN,
    workspace,
    workspaceUserId: storageUserId,
    workspaceAllowedTools,
    workspaceAllowedToolNames: wsAgentSettings.allowedTools?.length ? wsAgentSettings.allowedTools : undefined,
  };

  const messages = Array.isArray(req.body?.messages) ? [...req.body.messages] : [];
  const lastUser = messages.filter((m) => m.role === "user").pop();
  const userMessage = typeof lastUser?.content === "string" ? lastUser.content : "";

  const intent = await detectIntentForSwarm(userMessage);
  const agentOpts = req.body?.agentOptions || {};
  const { specialistNames, parallelFanOut, rosterSource } = resolveSwarmSpecialistNames(intent, agentOpts);

  const runId = randomUUID();
  const startMs = Date.now();

  await emitEvent(
    "swarm_started",
    {
      runId,
      specialists: specialistNames,
      parallelFanOut,
      rosterSource,
      intentMode: intent.mode || "keyword",
      userMessage: userMessage?.slice(0, 200),
    },
    { workspaceId: workspace, userId: req.userId }
  );

  // Run specialists in parallel (researcher + executor when parallelFanOut or both intent flags)

  const specialistResults = await Promise.all(
    specialistNames.map(async (name) => {
      const t0 = Date.now();
      try {
        const { content } = await runSpecialistLoop(name, messages, {
          url: `${config.baseUrl}${config.path}`,
          config,
          model,
          toolCtx,
          backendFetch,
          maxIterations,
          storageUserId,
          workspace,
          agentOptions: agentOpts,
          swarmRunStartedMs: startMs,
        });
        const latencyMs = Date.now() - t0;
        await emitEvent(
          "swarm_specialist_completed",
          { runId, specialist: name, success: true, latencyMs },
          { workspaceId: workspace, userId: req.userId }
        );
        return { specialist: name, content, success: true, latencyMs };
      } catch (err) {
        const latencyMs = Date.now() - t0;
        console.warn(`[swarm] specialist ${name} threw:`, err?.message || err);
        await emitEvent(
          "swarm_specialist_completed",
          { runId, specialist: name, success: false, latencyMs, error: err?.message },
          { workspaceId: workspace, userId: req.userId }
        );
        return {
          specialist: name,
          content: `Error: ${err?.message || String(err)}`,
          success: false,
          latencyMs,
        };
      }
    })
  );

  const durationMs = Date.now() - startMs;
  await emitEvent(
    "swarm_completed",
    {
      runId,
      specialistCount: specialistResults.length,
      durationMs,
      specialists: specialistResults.map((r) => ({
        name: r.specialist,
        success: r.success,
        latencyMs: r.latencyMs,
      })),
    },
    { workspaceId: workspace, userId: req.userId }
  );

  const successCount = specialistResults.filter((r) => r.success).length;
  recordSwarm(specialistResults.length, successCount, durationMs);
  recordAgentPhaseMs("swarm", "specialists_wall", durationMs);

  // Synthesizer: single LLM call with no tools to combine outputs
  const synthesizer = getSpecialist("synthesizer");
  const aggregateText = specialistResults
    .map((r) => `## ${r.specialist}\n${r.content}`)
    .join("\n\n");

  const synthMessages = await augmentMessagesWithWorkspaceAgent(
    augmentMessagesWithDefaultSystem([
      {
        role: "system",
        content:
          synthesizer?.systemPrompt ||
          "Combine the specialist outputs into a clear, helpful response. Do not use tools.",
      },
      {
        role: "user",
        content: `User asked: ${userMessage}\n\nSpecialist outputs:\n\n${aggregateText}\n\nProvide a coherent final answer.`,
      },
    ]),
    storageUserId,
    workspace
  );

  const url = `${config.baseUrl}${config.path}`;
  const synthModel = getModelForSpecialist("synthesizer", model);
  const synthBody = {
    model: synthModel,
    messages: synthMessages,
    stream: false,
  };

  const STREAM_SWARM_SYNTH = process.env.STREAM_SWARM_SYNTH === "1";
  let finalContent = "";
  /** @type {{ url: string, config: object, synthBody: object } | null} */
  let synthesisDeferred = null;

  if (STREAM_SWARM_SYNTH) {
    synthesisDeferred = { url, config, synthBody };
  } else {
    const synthT0 = Date.now();
    try {
      const synthResponse = await backendFetch(url, {
        method: "POST",
        headers: config.headers,
        body: JSON.stringify(synthBody),
      });

      if (!synthResponse.ok) {
        const err = await synthResponse.text();
        finalContent = `Synthesis failed: ${err?.slice(0, 200)}. Raw outputs:\n\n${aggregateText}`;
      } else {
        const data = await synthResponse.json().catch(() => ({}));
        const msg = data.choices?.[0]?.message;
        finalContent = typeof msg?.content === "string" ? msg.content : aggregateText;
      }
    } catch (err) {
      finalContent = `Synthesis error: ${err?.message}. Raw outputs:\n\n${aggregateText}`;
    }
    recordAgentPhaseMs("swarm", "synthesis", Date.now() - synthT0);
  }

  res.setHeader("X-Swarm-Agents", String(specialistResults.length));
  res.setHeader("X-Swarm-Duration-Ms", String(durationMs));
  if (parallelFanOut) res.setHeader("X-Swarm-Parallel", "1");
  res.setHeader("X-Swarm-Roster-Source", String(rosterSource || "intent"));
  res.setHeader("X-Swarm-Intent-Mode", String(intent.mode || "keyword"));

  const swarmSteps = specialistResults.map((r) => ({
    specialist: r.specialist,
    success: r.success,
    latencyMs: r.latencyMs,
  }));

  recordAgentRunSummary("swarm", STREAM_SWARM_SYNTH ? "synthesis_deferred" : "complete");

  return {
    content: finalContent,
    iteration: specialistResults.length + 1,
    swarmSteps,
    synthesisDeferred,
    fallbackAggregate: aggregateText,
  };
}

/**
 * Legacy swarm for /v1/swarm: run specialists with direct tool execution (no LLM).
 * Returns { aggregation, metrics } for backward compatibility.
 */
async function runSpecialistWithTolerance(specialistName, query, toolCtx, runId) {
  const start = Date.now();
  const specialist = getSpecialist(specialistName);
  let output = "";
  let success = false;
  let error = null;

  try {
    if (!specialist) {
      throw new Error(`Unknown specialist: ${specialistName}`);
    }
    const toolNames = specialist.tools || [];
    const q = (query || "").trim();

    if (specialistName === "researcher") {
      const parts = await fetchResearcherToolPartsParallel(toolNames, q, toolCtx);
      output = JSON.stringify(parts);
      success = Object.keys(parts).length > 0;
    } else if (specialistName === "executor") {
      const parts = await fetchExecutorToolPartsParallel(toolNames, q, toolCtx);
      output = JSON.stringify(parts);
      success = Object.keys(parts).length > 0;
    } else if (toolNames.includes("search_context")) {
      const r = await runTool("search_context", { query: query || "general" }, toolCtx);
      output = r.content;
      success = true;
    } else if (toolNames.includes("list_context")) {
      const r = await runTool("list_context", {}, toolCtx);
      output = r.content;
      success = true;
    } else if (toolNames.includes("get_recipe")) {
      const r = await runTool("get_recipe", { name: query || "default" }, toolCtx);
      output = r.content;
      success = !output.includes('"error"');
    } else {
      output = JSON.stringify({ error: `No runnable tools for specialist ${specialistName}` });
    }
  } catch (e) {
    error = e;
    output = JSON.stringify({ ok: false, error: String(e?.message || e) });
  }

  const latencyMs = Date.now() - start;
  await emitEvent(
    "swarm_specialist_completed",
    { runId, specialist: specialistName, success: success || !error, latencyMs, error: error?.message },
    { workspaceId: toolCtx.workspace || WORKSPACE }
  );

  return { specialist: specialistName, output, success: success || !error, latencyMs, error };
}

/**
 * Legacy runSwarm for POST /v1/swarm: specialists + query, returns aggregation.
 * Uses direct tool execution (no LLM per specialist).
 */
export async function runSwarmLegacy(specialistNames, query, opts = {}) {
  const runId = randomUUID();
  const workspace = opts.workspace || WORKSPACE;
  const toolCtx = {
    allowExecution: opts.allowExecution === true,
    projectDir: opts.projectDir || process.env.PROJECT_DIR || process.cwd(),
    vercelToken: opts.vercelToken || process.env.VERCEL_TOKEN,
    workspace,
  };

  await emitEvent("swarm_started", { runId, specialists: specialistNames, query }, { workspaceId: workspace });
  const startMs = Date.now();

  const results = await Promise.all(
    specialistNames.map((name) => runSpecialistWithTolerance(name, query, toolCtx, runId))
  );

  const durationMs = Date.now() - startMs;
  await emitEvent(
    "swarm_completed",
    {
      runId,
      specialistCount: results.length,
      successCount: results.filter((r) => r.success).length,
      durationMs,
      specialists: results.map((r) => ({ name: r.specialist, success: r.success, latencyMs: r.latencyMs })),
    },
    { workspaceId: workspace }
  );

  const aggregation = results.map((r) => ({
    specialist: r.specialist,
    output: r.output,
    success: r.success,
    latencyMs: r.latencyMs,
    error: r.error?.message,
  }));

  return {
    aggregation,
    metrics: { agentCount: results.length, durationMs },
  };
}

export { getSpecialists } from "./specialists.js";
