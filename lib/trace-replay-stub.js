/**
 * Wave-2: Stub-backend trace replay. Provides a fake `backendFetch` function
 * that serves pre-recorded LLM responses from a trace record, letting CI
 * exercise the full agent loop (plan → tool → critique → synthesis) without
 * any live model. Deterministic: identical inputs produce identical outputs.
 *
 * Complements trace-replay.js (which validates recorded traces without
 * re-running them). This module *re-runs* the loop against a stub model so
 * code changes in the loop itself can be regression-tested end-to-end.
 */

/**
 * Build a stub `backendFetch` from a list of recorded LLM responses. Each
 * call consumes the next response in order. Tool-call turns must be
 * represented with an object that contains `{ tool_calls: [...] }`; terminal
 * turns have `{ content: "..." }`.
 *
 * @param {Array<{ content?: string, tool_calls?: Array<{id?:string,name:string,arguments?:object|string}> }>} turns
 * @returns {{
 *   fetch: Function,
 *   calls: Array<{ url: string, body: object }>,
 *   exhausted: () => boolean,
 * }}
 */
export function buildStubBackend(turns) {
  if (!Array.isArray(turns)) throw new Error("turns must be an array");
  let i = 0;
  const calls = [];

  const fetchFn = async (url, init = {}) => {
    let body = {};
    try { body = JSON.parse(init.body || "{}"); } catch { /* ignore parse errors */ }
    calls.push({ url, body });

    if (i >= turns.length) {
      return buildResponse({ content: "(stub: responses exhausted)" });
    }
    const turn = turns[i++];
    return buildResponse(turn);
  };
  return {
    fetch: fetchFn,
    calls,
    exhausted: () => i >= turns.length,
  };
}

function buildResponse(turn) {
  const message = normalizeTurn(turn);
  const data = {
    id: `stub-${Math.random().toString(36).slice(2, 10)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    choices: [{ index: 0, message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  };
  return {
    ok: true,
    status: 200,
    headers: new Map([["content-type", "application/json"]]),
    async json() { return data; },
    async text() { return JSON.stringify(data); },
  };
}

function normalizeTurn(turn) {
  if (!turn || typeof turn !== "object") {
    return { role: "assistant", content: "(stub: empty turn)" };
  }
  if (Array.isArray(turn.tool_calls) && turn.tool_calls.length > 0) {
    return {
      role: "assistant",
      content: turn.content || "",
      tool_calls: turn.tool_calls.map((tc, idx) => ({
        id: tc.id || `call_${idx}`,
        type: "function",
        function: {
          name: String(tc.name || "unknown"),
          arguments: typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments || {}),
        },
      })),
    };
  }
  return {
    role: "assistant",
    content: typeof turn.content === "string" ? turn.content : JSON.stringify(turn),
  };
}

/**
 * Convert a recorded trace (from trace-recorder.js) into the turns array
 * expected by buildStubBackend. Reads tool calls from the trace's
 * goldenTrace or steps arrays; appends a final text turn from the recorded
 * final answer if present.
 *
 * @param {object} trace
 * @returns {Array<{ tool_calls?: object[], content?: string }>}
 */
export function turnsFromTrace(trace) {
  if (!trace || typeof trace !== "object") return [];
  const turns = [];
  const steps = Array.isArray(trace.steps) ? trace.steps : [];
  const golden = Array.isArray(trace.goldenTrace) ? trace.goldenTrace : [];

  // Prefer steps when present (richer structure); fall back to golden.
  const source = steps.length > 0 ? steps : golden;
  if (source.length === 0) return [];
  let batch = [];
  const flush = () => {
    if (batch.length > 0) {
      turns.push({ tool_calls: batch });
      batch = [];
    }
  };

  for (const s of source) {
    if (!s || typeof s !== "object") continue;
    const type = s.type || s.kind;
    if (type === "tool_call" || s.name || s.tool) {
      batch.push({
        id: s.id || s.callId,
        name: s.name || s.tool,
        arguments: s.args || s.arguments || {},
      });
    } else if (type === "assistant_message" || type === "final_answer") {
      flush();
      turns.push({ content: typeof s.content === "string" ? s.content : "" });
    }
  }
  flush();

  // Ensure we end with a terminal message so the loop can exit cleanly.
  const last = turns[turns.length - 1];
  if (!last || (Array.isArray(last.tool_calls) && last.tool_calls.length > 0)) {
    const fa = trace.finalAnswer || trace.final || "";
    turns.push({ content: typeof fa === "string" ? fa : "(stub: trace complete)" });
  }
  return turns;
}
