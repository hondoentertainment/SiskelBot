/**
 * Phase 40.4: SiskelBot edge AI worker (Cloudflare).
 *
 * Runs small models at the edge using Cloudflare Workers AI to absorb
 * latency-sensitive, simple chat and embedding traffic. Anything that
 * looks "complex" (long prompts, multi-turn, tool use, code) is forwarded
 * to the origin SiskelBot Express server.
 *
 * Routes handled at edge:
 *   POST /v1/chat/completions/edge       chat with @cf/meta/llama-3-8b-instruct
 *   POST /api/v1/embeddings/edge         embeddings with @cf/baai/bge-base-en-v1.5
 *
 * Everything else is proxied to ORIGIN_URL unchanged. The worker tags
 * every response with `X-Edge: cloudflare` and `X-Edge-AI: hit|miss|skip`
 * so dashboards can track the edge-vs-origin split.
 */

const DEFAULT_CHAT_MODEL = "@cf/meta/llama-3-8b-instruct";
const FALLBACK_CHAT_MODEL = "@cf/mistral/mistral-7b-instruct-v0.2";
const DEFAULT_EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

// Tunables — keep generous defaults so the worker is conservative about
// taking traffic away from the origin.
export const EDGE_AI_LIMITS = {
  maxMessages: 6,
  maxTotalChars: 2000,
  maxSingleMessageChars: 1500,
  complexityThreshold: 0.7,
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = (env && env.ORIGIN_URL) || "https://api.siskelbot.example.com";

    if (url.pathname === "/v1/chat/completions/edge" && request.method === "POST") {
      return handleEdgeChat(request, env, origin);
    }

    if (url.pathname === "/api/v1/embeddings/edge" && request.method === "POST") {
      return handleEdgeEmbedding(request, env, origin);
    }

    // Fallback: passthrough to origin without modification.
    return passthrough(request, origin, url);
  },
};

/**
 * Handle a chat completion at the edge if the prompt looks simple.
 * Falls back to the origin for anything that exceeds the complexity
 * threshold or that the edge runtime cannot service.
 */
export async function handleEdgeChat(request, env, originUrl) {
  let body;
  try {
    body = await request.clone().json();
  } catch (err) {
    return jsonError(400, "INVALID_JSON", "Request body must be valid JSON");
  }

  const messages = Array.isArray(body && body.messages) ? body.messages : null;
  if (!messages || messages.length === 0) {
    return jsonError(400, "INVALID_INPUT", "messages array is required");
  }

  const complexityScore = analyzeComplexity(messages, body);
  const force = (body && body.complexity) || "auto";

  if (force === "origin" || (force !== "edge" && complexityScore > EDGE_AI_LIMITS.complexityThreshold)) {
    const upstream = await proxyToOrigin(request, originUrl, "/v1/chat/completions");
    return tagResponse(upstream, "skip", { complexity: complexityScore });
  }

  // No AI binding — bail out and proxy.
  if (!env || !env.AI || typeof env.AI.run !== "function") {
    const upstream = await proxyToOrigin(request, originUrl, "/v1/chat/completions");
    return tagResponse(upstream, "skip", { reason: "no_ai_binding" });
  }

  const model = (body && body.edgeModel) || DEFAULT_CHAT_MODEL;

  let aiResponse;
  try {
    aiResponse = await env.AI.run(model, { messages });
  } catch (err) {
    // First fallback: try the secondary model.
    try {
      aiResponse = await env.AI.run(FALLBACK_CHAT_MODEL, { messages });
    } catch (err2) {
      // Second fallback: origin.
      const upstream = await proxyToOrigin(request, originUrl, "/v1/chat/completions");
      return tagResponse(upstream, "skip", { reason: "edge_ai_error" });
    }
  }

  const text = (aiResponse && (aiResponse.response || aiResponse.text)) || "";
  const payload = {
    id: `edge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    edge: true,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: estimateTokens(messages),
      completion_tokens: Math.ceil(text.length / 4),
      total_tokens: estimateTokens(messages) + Math.ceil(text.length / 4),
    },
  };

  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "X-Edge": "cloudflare",
      "X-Edge-AI": "hit",
      "X-Edge-Model": model,
      "X-Edge-Complexity": complexityScore.toFixed(3),
    },
  });
}

/**
 * Handle an embedding request at the edge. Embeddings are short, mostly
 * deterministic, and cheap to run on the edge runtime, so we always try
 * the edge model first and only fall back to origin on error.
 */
export async function handleEdgeEmbedding(request, env, originUrl) {
  let body;
  try {
    body = await request.clone().json();
  } catch (err) {
    return jsonError(400, "INVALID_JSON", "Request body must be valid JSON");
  }

  const input = body && body.input;
  if (!input || (typeof input !== "string" && !Array.isArray(input))) {
    return jsonError(400, "INVALID_INPUT", "input must be a string or array of strings");
  }

  if (!env || !env.AI || typeof env.AI.run !== "function") {
    const upstream = await proxyToOrigin(request, originUrl, "/api/v1/embeddings");
    return tagResponse(upstream, "skip", { reason: "no_ai_binding" });
  }

  const model = (body && body.edgeModel) || DEFAULT_EMBEDDING_MODEL;
  const inputs = Array.isArray(input) ? input : [input];

  let result;
  try {
    result = await env.AI.run(model, { text: inputs });
  } catch (err) {
    const upstream = await proxyToOrigin(request, originUrl, "/api/v1/embeddings");
    return tagResponse(upstream, "skip", { reason: "edge_ai_error" });
  }

  const vectors = Array.isArray(result && result.data) ? result.data : [];
  const payload = {
    object: "list",
    model,
    edge: true,
    data: vectors.map((embedding, index) => ({
      object: "embedding",
      index,
      embedding,
    })),
    usage: {
      prompt_tokens: inputs.reduce((acc, s) => acc + Math.ceil(String(s).length / 4), 0),
      total_tokens: inputs.reduce((acc, s) => acc + Math.ceil(String(s).length / 4), 0),
    },
  };

  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "X-Edge": "cloudflare",
      "X-Edge-AI": "hit",
      "X-Edge-Model": model,
    },
  });
}

/**
 * Score how "complex" a chat request is. Returns a number in [0, 1] where
 * higher means harder for a small edge model. Anything above
 * EDGE_AI_LIMITS.complexityThreshold is forwarded to the origin.
 *
 * Heuristics (additive, capped at 1):
 *   - long total prompt (>= maxTotalChars)
 *   - any single message above maxSingleMessageChars
 *   - too many turns (>= maxMessages)
 *   - presence of tool / function calls in the body
 *   - presence of code fences or `$ ` shell prompts
 *   - explicit JSON-mode / function-mode hints
 */
export function analyzeComplexity(messages, body) {
  if (!Array.isArray(messages) || messages.length === 0) return 1;

  let score = 0;
  const totalChars = messages.reduce((acc, m) => acc + (typeof m?.content === "string" ? m.content.length : 0), 0);
  const longest = messages.reduce((acc, m) => Math.max(acc, typeof m?.content === "string" ? m.content.length : 0), 0);

  if (totalChars >= EDGE_AI_LIMITS.maxTotalChars) score += 0.4;
  else score += (totalChars / EDGE_AI_LIMITS.maxTotalChars) * 0.2;

  if (longest >= EDGE_AI_LIMITS.maxSingleMessageChars) score += 0.2;

  if (messages.length >= EDGE_AI_LIMITS.maxMessages) score += 0.2;
  else if (messages.length >= 4) score += 0.1;

  // Body-level signals from the OpenAI-compatible payload.
  if (body) {
    if (Array.isArray(body.tools) && body.tools.length > 0) score += 0.3;
    if (Array.isArray(body.functions) && body.functions.length > 0) score += 0.3;
    if (body.tool_choice && body.tool_choice !== "none") score += 0.1;
    if (body.response_format && body.response_format.type === "json_object") score += 0.1;
    if (body.stream === true) score += 0.05;
  }

  // Per-message signals: tool calls, code, very technical content.
  for (const m of messages) {
    if (m && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      score += 0.3;
      break;
    }
  }

  for (const m of messages) {
    const c = typeof m?.content === "string" ? m.content : "";
    if (!c) continue;
    if (c.includes("```")) { score += 0.15; break; }
  }

  for (const m of messages) {
    const c = typeof m?.content === "string" ? m.content : "";
    if (/\b(SELECT|INSERT|UPDATE|DELETE|CREATE TABLE)\b/i.test(c)) {
      score += 0.1;
      break;
    }
  }

  return Math.max(0, Math.min(1, score));
}

function estimateTokens(messages) {
  let total = 0;
  for (const m of messages) {
    if (m && typeof m.content === "string") total += Math.ceil(m.content.length / 4);
  }
  return total;
}

function jsonError(status, code, message) {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: {
      "Content-Type": "application/json",
      "X-Edge": "cloudflare",
      "X-Edge-AI": "error",
    },
  });
}

function tagResponse(response, aiStatus, extra) {
  const headers = new Headers(response.headers);
  headers.set("X-Edge", "cloudflare");
  headers.set("X-Edge-AI", aiStatus);
  if (extra && extra.complexity != null) headers.set("X-Edge-Complexity", String(extra.complexity));
  if (extra && extra.reason) headers.set("X-Edge-AI-Reason", extra.reason);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function proxyToOrigin(request, origin, pathname) {
  const init = {
    method: request.method,
    headers: filterRequestHeaders(request.headers),
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = await request.clone().arrayBuffer();
  }
  return fetch(`${origin}${pathname}`, init);
}

function passthrough(request, origin, url) {
  return fetch(`${origin}${url.pathname}${url.search}`, {
    method: request.method,
    headers: filterRequestHeaders(request.headers),
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    redirect: "manual",
  });
}

function filterRequestHeaders(headers) {
  const out = new Headers();
  for (const [k, v] of headers.entries()) {
    const lower = k.toLowerCase();
    if (
      lower === "host" ||
      lower === "connection" ||
      lower === "keep-alive" ||
      lower === "proxy-authenticate" ||
      lower === "proxy-authorization" ||
      lower === "te" ||
      lower === "trailers" ||
      lower === "transfer-encoding" ||
      lower === "upgrade"
    ) {
      continue;
    }
    out.set(k, v);
  }
  return out;
}

export {
  DEFAULT_CHAT_MODEL,
  FALLBACK_CHAT_MODEL,
  DEFAULT_EMBEDDING_MODEL,
};
