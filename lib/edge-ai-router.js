/**
 * Phase 40.4: Edge AI router (server-side).
 *
 * Decides whether an incoming chat or embedding request should be
 * delegated to an edge AI worker (Cloudflare Workers AI, Fastly Compute)
 * before falling through to the origin backend.
 *
 * The routing decision is intentionally conservative: only short, simple,
 * latency-sensitive prompts are sent to the edge. Anything that involves
 * tool use, large prompts, multi-turn conversations, or structured output
 * stays on the origin where richer model support is available.
 *
 * Configuration (env):
 *   EDGE_AI_PROVIDER       cloudflare | fastly | none   (default: auto)
 *   EDGE_AI_URL            base URL of the edge worker
 *   EDGE_AI_ENABLED        "1" to enable, "0" to force-disable
 *   EDGE_AI_CHAT_PATH      override default chat path (/v1/chat/completions/edge)
 *   EDGE_AI_EMBED_PATH     override default embedding path (/api/v1/embeddings/edge)
 *   EDGE_AI_TIMEOUT_MS     fetch timeout when calling the edge (default 5000)
 */

export const EDGE_MODELS = {
  cloudflare: {
    chat: [
      "@cf/meta/llama-3-8b-instruct",
      "@cf/mistral/mistral-7b-instruct-v0.2",
      "@cf/google/gemma-7b-it",
      "@cf/qwen/qwen1.5-7b-chat-awq",
    ],
    embedding: [
      "@cf/baai/bge-base-en-v1.5",
      "@cf/baai/bge-small-en-v1.5",
      "@cf/baai/bge-large-en-v1.5",
    ],
  },
  fastly: {
    // Fastly Compute@Edge does not currently expose first-party model
    // hosting equivalent to Cloudflare Workers AI. The router instead
    // forwards through Fastly to a configured inference origin (e.g.
    // a regional Ollama or vLLM cluster) using the same API shape.
    chat: [
      "fastly/llama-3-8b-instruct",
      "fastly/mistral-7b-instruct",
    ],
    embedding: [
      "fastly/bge-base-en-v1.5",
      "fastly/bge-small-en-v1.5",
    ],
  },
};

export const EDGE_AI_DEFAULTS = {
  maxMessages: 6,
  maxTotalChars: 2000,
  maxSingleMessageChars: 1500,
  complexityThreshold: 0.7,
  timeoutMs: 5000,
  chatPath: "/v1/chat/completions/edge",
  embeddingPath: "/api/v1/embeddings/edge",
};

/**
 * Read the configured edge provider. Returns "none" when nothing is set.
 */
export function getEdgeAIProvider() {
  const explicit = String(process.env.EDGE_AI_PROVIDER || "").toLowerCase().trim();
  if (explicit === "cloudflare" || explicit === "fastly" || explicit === "none") return explicit;
  if (process.env.EDGE_AI_URL && process.env.EDGE_AI_ENABLED !== "0") {
    // Auto-detect from URL host.
    if (/cloudflare|workers\.dev/i.test(process.env.EDGE_AI_URL)) return "cloudflare";
    if (/fastly/i.test(process.env.EDGE_AI_URL)) return "fastly";
    return "cloudflare";
  }
  return "none";
}

/**
 * Returns true when the edge AI feature is configured AND the request
 * looks like a good candidate for the edge. The decision is based on
 * the same complexity heuristics the worker uses, so the server and
 * worker stay in sync.
 *
 * @param {object} request    Parsed OpenAI-compatible request body
 * @param {object} [opts]     Optional overrides
 * @param {string} [opts.kind="chat"]   "chat" | "embedding"
 * @param {string} [opts.provider]      override env detection
 * @returns {{ route: boolean, reason: string, score?: number, provider: string }}
 */
export function shouldUseEdgeAI(request, opts = {}) {
  const provider = opts.provider || getEdgeAIProvider();
  if (provider === "none") {
    return { route: false, reason: "provider_none", provider };
  }
  if (process.env.EDGE_AI_ENABLED === "0") {
    return { route: false, reason: "disabled", provider };
  }
  if (!process.env.EDGE_AI_URL && !opts.edgeUrl) {
    return { route: false, reason: "no_edge_url", provider };
  }

  const kind = opts.kind || "chat";
  if (kind === "embedding") {
    // Embeddings are always cheap to run at edge — only block if explicitly
    // disabled or if the input is huge.
    const input = request && request.input;
    if (!input) return { route: false, reason: "no_input", provider };
    const len = Array.isArray(input)
      ? input.reduce((a, s) => a + String(s || "").length, 0)
      : String(input).length;
    if (len > EDGE_AI_DEFAULTS.maxTotalChars * 4) {
      return { route: false, reason: "input_too_large", provider };
    }
    return { route: true, reason: "ok", provider };
  }

  // Chat: respect explicit hint, otherwise score complexity.
  if (request && request.complexity === "origin") {
    return { route: false, reason: "forced_origin", provider };
  }
  if (request && request.complexity === "edge") {
    return { route: true, reason: "forced_edge", provider, score: 0 };
  }

  const messages = Array.isArray(request && request.messages) ? request.messages : null;
  if (!messages || messages.length === 0) {
    return { route: false, reason: "no_messages", provider };
  }

  // Streaming chat is not currently supported through the edge worker
  // because Workers AI does not return SSE in a way that round-trips
  // cleanly through `fetch`.
  if (request && request.stream === true) {
    return { route: false, reason: "streaming", provider };
  }

  const score = analyzeComplexity(messages, request);
  if (score > EDGE_AI_DEFAULTS.complexityThreshold) {
    return { route: false, reason: "too_complex", provider, score };
  }
  return { route: true, reason: "ok", provider, score };
}

/**
 * Score how complex a chat request is. Identical algorithm to the
 * worker's analyzeComplexity so the routing decision is symmetric.
 *
 * @returns {number} score in [0, 1]
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

  if (totalChars >= EDGE_AI_DEFAULTS.maxTotalChars) score += 0.4;
  else score += (totalChars / EDGE_AI_DEFAULTS.maxTotalChars) * 0.2;

  if (longest >= EDGE_AI_DEFAULTS.maxSingleMessageChars) score += 0.2;

  if (messages.length >= EDGE_AI_DEFAULTS.maxMessages) score += 0.2;
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
 * Pick a default model name for the chosen provider/kind. Honours an
 * explicit preference if it is in the supported list.
 *
 * @param {string} provider   "cloudflare" | "fastly"
 * @param {string} kind       "chat" | "embedding"
 * @param {string} [preferred] preferred model id
 */
export function selectEdgeModel(provider, kind, preferred) {
  const set = EDGE_MODELS[provider];
  if (!set) return null;
  const list = set[kind];
  if (!Array.isArray(list) || list.length === 0) return null;
  if (preferred && list.includes(preferred)) return preferred;
  return list[0];
}

/**
 * Forward a request body to the configured edge AI worker. Returns the
 * parsed JSON response, or throws on timeout / non-2xx. Callers should
 * wrap this in try/catch and fall through to the origin on failure.
 *
 * @param {object} body            request body to forward
 * @param {object} [opts]
 * @param {string} [opts.edgeUrl]  override base edge URL
 * @param {string} [opts.kind]     "chat" | "embedding"
 * @param {number} [opts.timeoutMs]
 * @param {Function} [opts.fetchImpl] custom fetch implementation (tests)
 * @param {object} [opts.headers]  extra headers to forward
 */
export async function routeToEdgeAI(body, opts = {}) {
  const edgeUrl = opts.edgeUrl || process.env.EDGE_AI_URL;
  if (!edgeUrl) {
    const err = new Error("EDGE_AI_URL is not configured");
    err.code = "EDGE_AI_NOT_CONFIGURED";
    throw err;
  }

  const kind = opts.kind || "chat";
  const path =
    kind === "embedding"
      ? process.env.EDGE_AI_EMBED_PATH || EDGE_AI_DEFAULTS.embeddingPath
      : process.env.EDGE_AI_CHAT_PATH || EDGE_AI_DEFAULTS.chatPath;
  const url = `${edgeUrl.replace(/\/+$/, "")}${path}`;

  const timeoutMs = Number(opts.timeoutMs || process.env.EDGE_AI_TIMEOUT_MS || EDGE_AI_DEFAULTS.timeoutMs);
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    const err = new Error("No fetch implementation available");
    err.code = "EDGE_AI_NO_FETCH";
    throw err;
  }

  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(opts.headers || {}),
      },
      body: JSON.stringify(body),
      signal: controller ? controller.signal : undefined,
    });

    if (!res || !res.ok) {
      const err = new Error(`Edge AI returned status ${res ? res.status : "?"}`);
      err.code = "EDGE_AI_BAD_STATUS";
      err.status = res ? res.status : 0;
      throw err;
    }

    const data = await res.json();
    return {
      ok: true,
      data,
      provider: getEdgeAIProvider(),
      headers: extractEdgeHeaders(res),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function extractEdgeHeaders(res) {
  const out = {};
  if (!res || !res.headers || typeof res.headers.get !== "function") return out;
  const keys = ["X-Edge", "X-Edge-AI", "X-Edge-Model", "X-Edge-Complexity"];
  for (const k of keys) {
    const v = res.headers.get(k);
    if (v != null) out[k] = v;
  }
  return out;
}

/**
 * Returns a small, JSON-serialisable summary of the current edge AI
 * configuration. Used by the admin UI and `/api/v1/edge/providers`.
 */
export function describeEdgeAI() {
  const provider = getEdgeAIProvider();
  return {
    provider,
    enabled: provider !== "none" && process.env.EDGE_AI_ENABLED !== "0",
    url: process.env.EDGE_AI_URL || null,
    timeoutMs: Number(process.env.EDGE_AI_TIMEOUT_MS || EDGE_AI_DEFAULTS.timeoutMs),
    chatPath: process.env.EDGE_AI_CHAT_PATH || EDGE_AI_DEFAULTS.chatPath,
    embeddingPath: process.env.EDGE_AI_EMBED_PATH || EDGE_AI_DEFAULTS.embeddingPath,
    models: EDGE_MODELS[provider] || { chat: [], embedding: [] },
  };
}
