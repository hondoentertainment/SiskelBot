/**
 * Phase 40.4: SiskelBot edge AI worker (Fastly Compute@Edge).
 *
 * Fastly Compute@Edge does NOT currently expose first-party model hosting
 * comparable to Cloudflare Workers AI. There is no `env.AI` binding and no
 * `@cf/...` model namespace. The pragmatic equivalent on Fastly is to:
 *
 *   1. Use the Compute@Edge runtime (JavaScript or Rust) to terminate
 *      the request at the POP and apply the same complexity heuristics
 *      we use elsewhere.
 *   2. For "simple" requests, forward them to a small, regional inference
 *      backend (Ollama, vLLM, or a managed model API) declared as a
 *      Fastly backend named `inference_origin`. Fastly's POP will pick
 *      the geographically closest replica.
 *   3. For "complex" requests, forward to the main `siskelbot_origin`
 *      backend, identical behaviour to the Cloudflare worker's fallback.
 *
 * This file documents the intended runtime entry point and provides a
 * pure-JS reference implementation that mirrors the Cloudflare worker.
 * It can be deployed via `fastly compute build` once the matching
 * `fastly.toml` (sibling file in this directory) is filled in for the
 * target service.
 *
 * NOTE: this module is intentionally importable in plain Node.js so the
 * shared complexity heuristics can be unit-tested with the same harness
 * as the Cloudflare worker. Imports of `fastly:*` are dynamic so they do
 * not blow up under Node.
 */

const DEFAULT_CHAT_MODEL = "fastly/llama-3-8b-instruct";
const DEFAULT_EMBEDDING_MODEL = "fastly/bge-base-en-v1.5";

export const FASTLY_AI_LIMITS = {
  maxMessages: 6,
  maxTotalChars: 2000,
  maxSingleMessageChars: 1500,
  complexityThreshold: 0.7,
};

/**
 * Compute@Edge entry point. The Fastly JS runtime calls this on every
 * incoming request via `addEventListener("fetch", ...)`.
 */
export async function handleRequest(event) {
  const request = event.request;
  const url = new URL(request.url);

  if (url.pathname === "/v1/chat/completions/edge" && request.method === "POST") {
    return handleEdgeChat(request);
  }

  if (url.pathname === "/api/v1/embeddings/edge" && request.method === "POST") {
    return handleEdgeEmbedding(request);
  }

  // Anything else: forward to the configured siskelbot origin.
  return forwardToBackend(request, "siskelbot_origin");
}

/**
 * Handle a chat completion at the edge. Decides whether to forward to the
 * inference backend or to the siskelbot origin based on complexity.
 */
export async function handleEdgeChat(request) {
  let body;
  try {
    body = await request.clone().json();
  } catch {
    return jsonError(400, "INVALID_JSON", "Request body must be valid JSON");
  }

  const messages = Array.isArray(body && body.messages) ? body.messages : null;
  if (!messages || messages.length === 0) {
    return jsonError(400, "INVALID_INPUT", "messages array is required");
  }

  const complexityScore = analyzeComplexity(messages, body);
  const force = (body && body.complexity) || "auto";

  if (force === "origin" || (force !== "edge" && complexityScore > FASTLY_AI_LIMITS.complexityThreshold)) {
    const upstream = await forwardToBackend(request, "siskelbot_origin");
    return tagResponse(upstream, "skip", { complexity: complexityScore });
  }

  // Forward to the regional inference backend with the OpenAI-compatible
  // payload. The backend is declared in fastly.toml as `inference_origin`.
  const upstream = await forwardToBackend(
    new Request(request.url.replace("/edge", ""), {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify({
        ...body,
        model: (body && body.edgeModel) || DEFAULT_CHAT_MODEL,
      }),
    }),
    "inference_origin",
  );
  return tagResponse(upstream, "hit", { model: DEFAULT_CHAT_MODEL, complexity: complexityScore });
}

/**
 * Handle an embedding request at the edge. Always tries the inference
 * backend first; falls back to origin on error.
 */
export async function handleEdgeEmbedding(request) {
  let body;
  try {
    body = await request.clone().json();
  } catch {
    return jsonError(400, "INVALID_JSON", "Request body must be valid JSON");
  }

  const input = body && body.input;
  if (!input || (typeof input !== "string" && !Array.isArray(input))) {
    return jsonError(400, "INVALID_INPUT", "input must be a string or array of strings");
  }

  try {
    const upstream = await forwardToBackend(
      new Request(request.url.replace("/edge", ""), {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify({
          ...body,
          model: (body && body.edgeModel) || DEFAULT_EMBEDDING_MODEL,
        }),
      }),
      "inference_origin",
    );
    return tagResponse(upstream, "hit", { model: DEFAULT_EMBEDDING_MODEL });
  } catch {
    const upstream = await forwardToBackend(request, "siskelbot_origin");
    return tagResponse(upstream, "skip", { reason: "edge_error" });
  }
}

/**
 * Same complexity scorer as the Cloudflare worker and the Node-side
 * router. Keep these three implementations in sync — drift here causes
 * inconsistent routing decisions between the server and the edge.
 */
export function analyzeComplexity(messages, body) {
  if (!Array.isArray(messages) || messages.length === 0) return 1;

  let score = 0;
  const totalChars = messages.reduce(
    (acc, m) => acc + (typeof m?.content === "string" ? m.content.length : 0),
    0,
  );
  const longest = messages.reduce(
    (acc, m) => Math.max(acc, typeof m?.content === "string" ? m.content.length : 0),
    0,
  );

  if (totalChars >= FASTLY_AI_LIMITS.maxTotalChars) score += 0.4;
  else score += (totalChars / FASTLY_AI_LIMITS.maxTotalChars) * 0.2;

  if (longest >= FASTLY_AI_LIMITS.maxSingleMessageChars) score += 0.2;

  if (messages.length >= FASTLY_AI_LIMITS.maxMessages) score += 0.2;
  else if (messages.length >= 4) score += 0.1;

  if (body) {
    if (Array.isArray(body.tools) && body.tools.length > 0) score += 0.3;
    if (Array.isArray(body.functions) && body.functions.length > 0) score += 0.3;
    if (body.tool_choice && body.tool_choice !== "none") score += 0.1;
    if (body.response_format && body.response_format.type === "json_object") score += 0.1;
    if (body.stream === true) score += 0.05;
  }

  for (const m of messages) {
    if (m && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      score += 0.3;
      break;
    }
  }

  for (const m of messages) {
    const c = typeof m?.content === "string" ? m.content : "";
    if (c.includes("```")) {
      score += 0.15;
      break;
    }
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

/**
 * Forward a request to a Fastly backend by name. In the Compute@Edge JS
 * runtime, the second argument to `fetch` accepts `{ backend: "name" }`
 * to select a configured backend. We dynamically import this so the file
 * stays loadable under plain Node for unit testing.
 */
async function forwardToBackend(request, backendName) {
  if (typeof fetch === "function") {
    try {
      return await fetch(request, { backend: backendName });
    } catch (err) {
      // Plain Node fallback for tests: return a synthetic 503.
      return new Response(JSON.stringify({ error: { code: "EDGE_FORWARD_FAILED", message: String(err && err.message) } }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }
  }
  return new Response("no fetch", { status: 500 });
}

function jsonError(status, code, message) {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: {
      "Content-Type": "application/json",
      "X-Edge": "fastly",
      "X-Edge-AI": "error",
    },
  });
}

function tagResponse(response, aiStatus, extra) {
  const headers = new Headers(response.headers);
  headers.set("X-Edge", "fastly");
  headers.set("X-Edge-AI", aiStatus);
  if (extra && extra.complexity != null) headers.set("X-Edge-Complexity", String(extra.complexity));
  if (extra && extra.model) headers.set("X-Edge-Model", String(extra.model));
  if (extra && extra.reason) headers.set("X-Edge-AI-Reason", extra.reason);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// Compute@Edge runtime registration. Wrapped in a guard so this file is
// safe to import under Node.js for unit tests.
if (typeof addEventListener === "function") {
  try {
    addEventListener("fetch", (event) => event.respondWith(handleRequest(event)));
  } catch {
    // ignore — non-Fastly runtime
  }
}

export { DEFAULT_CHAT_MODEL, DEFAULT_EMBEDDING_MODEL };
