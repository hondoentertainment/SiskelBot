/**
 * Agent swarm coordinator: specialist agents (researcher, executor, synthesizer),
 * intent detection, parallel specialist execution, and aggregation.
 * Observability: tracks specialists, latency, success/failure; emits webhook events; provides header metadata.
 */
import { randomUUID } from "crypto";
import { emitEvent } from "./webhooks.js";
import { getSpecialist, getSpecialists, getModelForSpecialist } from "./specialists.js";
import { recordSwarm } from "./metrics.js";
import { getToolsForNames, runTool } from "./agent-tools.js";
import { validateToolCall, toolValidationEnabled } from "./tool-validation.js";
import { detectStagnation, stagnationDetectionEnabled } from "./agent-stagnation.js";
import { augmentMessagesForGrounding } from "./grounding.js";

const WORKSPACE = "default";

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

  emitEvent("swarm_started", { runId, specialists: specialistNames, query }, { workspaceId: workspace });
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
        if (tools.includes("search_context")) {
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
      emitEvent(
        "swarm_specialist_completed",
        { runId, specialist: name, success, latencyMs, error: error?.message },
        { workspaceId: workspace }
      );
      return { specialist: name, output, success, latencyMs, error };
    })
  );

  const durationMs = Date.now() - startMs;
  emitEvent(
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

/** Keywords for intent detection: researcher vs executor. */
const RESEARCH_KEYWORDS = [
  "search", "find", "look up", "list", "context", "document", "knowledge",
  "index", "what is", "where is", "how to", "info", "information", "explain",
];
const EXECUTE_KEYWORDS = [
  "run", "execute", "build", "deploy", "recipe", "step", "command", "do",
  "run recipe", "execute step", "npm", "vercel",
];

/**
 * Detect intent from user message to pick eligible specialists.
 * @param {string} message - Last user message
 * @returns {{ researcher: boolean, executor: boolean }}
 */
export function detectIntent(message) {
  const text = (message || "").toLowerCase();
  const researcher = RESEARCH_KEYWORDS.some((k) => text.includes(k));
  const executor = EXECUTE_KEYWORDS.some((k) => text.includes(k));
  return {
    researcher: researcher || (!researcher && !executor), // default to researcher if unclear
    executor: executor,
  };
}

/**
 * Run a specialist's agent loop (LLM + tools) until no more tool_calls.
 * @param {string} specialistName - researcher | executor
 * @param {object[]} messages - Chat messages (will be prefixed with system prompt)
 * @param {object} opts - { url, config, model, toolCtx, backendFetch, maxIterations }
 * @returns {Promise<{ content: string }>}
 */
async function runSpecialistLoop(specialistName, messages, opts) {
  const specialist = getSpecialist(specialistName);
  if (!specialist) {
    return { content: JSON.stringify({ error: `Unknown specialist: ${specialistName}` }) };
  }

  const { url, config, model, toolCtx, backendFetch, maxIterations = 5 } = opts;
  const specialistModel = getModelForSpecialist(specialistName, model);
  const tools = specialist.tools?.length ? getToolsForNames(specialist.tools) : [];
  const systemMsg = { role: "system", content: specialist.systemPrompt };
  let currentMessages = augmentMessagesForGrounding([systemMsg, ...messages]);
  let lastContent = "";
  const toolCallsLog = [];

  for (let i = 0; i < maxIterations; i++) {
    const body = {
      model: specialistModel,
      messages: currentMessages,
      stream: false,
      ...(tools.length > 0 && {
        tools,
        tool_choice: "auto",
      }),
    };

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
  const allowExecution = req.body?.agentOptions?.allowExecution === true;
  const workspace = req.body?.agentOptions?.workspace || "default";

  const toolCtx = {
    allowExecution: options.allowRecipeExecution && allowExecution,
    projectDir: process.env.PROJECT_DIR || process.cwd(),
    vercelToken: process.env.VERCEL_TOKEN,
    workspace,
  };

  const messages = Array.isArray(req.body?.messages) ? [...req.body.messages] : [];
  const lastUser = messages.filter((m) => m.role === "user").pop();
  const userMessage = typeof lastUser?.content === "string" ? lastUser.content : "";

  const intent = detectIntent(userMessage);
  const eligible = [];
  if (intent.researcher) eligible.push("researcher");
  if (intent.executor) eligible.push("executor");

  const runId = randomUUID();
  const startMs = Date.now();

  emitEvent(
    "swarm_started",
    { runId, specialists: eligible, userMessage: userMessage?.slice(0, 200) },
    { workspaceId: workspace, userId: req.userId }
  );

  // Run eligible specialists in parallel (or just researcher if none)
  const specialistNames = eligible.length > 0 ? eligible : ["researcher"];

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
        });
        const latencyMs = Date.now() - t0;
        emitEvent(
          "swarm_specialist_completed",
          { runId, specialist: name, success: true, latencyMs },
          { workspaceId: workspace, userId: req.userId }
        );
        return { specialist: name, content, success: true, latencyMs };
      } catch (err) {
        const latencyMs = Date.now() - t0;
        console.warn(`[swarm] specialist ${name} threw:`, err?.message || err);
        emitEvent(
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
  emitEvent(
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

  // Synthesizer: single LLM call with no tools to combine outputs
  const synthesizer = getSpecialist("synthesizer");
  const aggregateText = specialistResults
    .map((r) => `## ${r.specialist}\n${r.content}`)
    .join("\n\n");

  const synthMessages = [
    { role: "system", content: synthesizer?.systemPrompt || "Combine the specialist outputs into a clear, helpful response. Do not use tools." },
    { role: "user", content: `User asked: ${userMessage}\n\nSpecialist outputs:\n\n${aggregateText}\n\nProvide a coherent final answer.` },
  ];

  const url = `${config.baseUrl}${config.path}`;
  const synthModel = getModelForSpecialist("synthesizer", model);
  const synthBody = {
    model: synthModel,
    messages: synthMessages,
    stream: false,
  };

  let finalContent = "";
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

  res.setHeader("X-Swarm-Agents", String(specialistResults.length));
  res.setHeader("X-Swarm-Duration-Ms", String(durationMs));

  const swarmSteps = specialistResults.map((r) => ({
    specialist: r.specialist,
    success: r.success,
    latencyMs: r.latencyMs,
  }));

  return {
    content: finalContent,
    iteration: specialistResults.length + 1,
    swarmSteps,
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
    if (toolNames.includes("search_context")) {
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
  emitEvent(
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

  emitEvent("swarm_started", { runId, specialists: specialistNames, query }, { workspaceId: workspace });
  const startMs = Date.now();

  const results = await Promise.all(
    specialistNames.map((name) => runSpecialistWithTolerance(name, query, toolCtx, runId))
  );

  const durationMs = Date.now() - startMs;
  emitEvent(
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
