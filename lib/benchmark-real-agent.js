/**
 * Real-model agent adapter for the benchmark harness.
 *
 * Responsibilities:
 *   - Turn a backend configuration (openai / anthropic / ollama / vllm /
 *     siskelbot-proxy) into an async agentFn(prompt) => string that is
 *     compatible with runBenchmarkSuite.
 *   - Enforce a strict per-request timeout via AbortController.
 *   - Parse provider-specific response shapes and extract the generated code
 *     (stripping fenced blocks when present).
 *   - NEVER log the API key.
 *
 * @module lib/benchmark-real-agent
 */

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_TOKENS = 2048;
const DEFAULT_TEMPERATURE = 0;

const DEFAULT_BASE_URLS = {
  openai: "https://api.openai.com",
  anthropic: "https://api.anthropic.com",
  ollama: "http://localhost:11434",
  vllm: "http://localhost:8000",
  "siskelbot-proxy": "http://localhost:3000",
};

const SYSTEM_PROMPT =
  "You are a code generation assistant. Return ONLY a single JavaScript ES " +
  "module wrapped in a ```javascript fenced code block. Do not include any " +
  "commentary, explanation, or prose outside the fence. The module must use " +
  "named `export` declarations as the task requires.";

/**
 * Extract a fenced code block from an LLM response. Prefers fences tagged with
 * the requested language, falls back to bare ``` fences, then to the full
 * response. Throws when the response is empty or completely unusable.
 *
 * @param {string} raw
 * @param {string} [language="javascript"]
 * @returns {string}
 */
export function extractCode(raw, language = "javascript") {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error("no code block");
  }
  const text = raw.trim();
  if (text.length === 0) throw new Error("no code block");

  const langAliases = {
    javascript: ["javascript", "js", "mjs", "node"],
    typescript: ["typescript", "ts"],
    python: ["python", "py"],
  };
  const aliases = langAliases[language] || [language];
  const langPattern = aliases.map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");

  // 1) Fences tagged with the requested language.
  const langFenceRe = new RegExp(
    "```(?:" + langPattern + ")\\s*\\n([\\s\\S]*?)\\n```",
    "gi"
  );
  const langBlocks = [];
  let m;
  while ((m = langFenceRe.exec(text)) !== null) langBlocks.push(m[1]);
  if (langBlocks.length > 0) {
    langBlocks.sort((a, b) => b.length - a.length);
    return langBlocks[0].trim();
  }

  // 2) Bare ``` fences (no language tag).
  const bareFenceRe = /```\s*\n([\s\S]*?)\n```/g;
  const bareBlocks = [];
  while ((m = bareFenceRe.exec(text)) !== null) bareBlocks.push(m[1]);
  if (bareBlocks.length > 0) {
    bareBlocks.sort((a, b) => b.length - a.length);
    return bareBlocks[0].trim();
  }

  // 3) No fence at all — assume the whole response is code only if it looks
  //    plausibly like code. Heuristic: must contain a keyword that suggests a
  //    module (export / function / const / return / =>). Otherwise throw.
  if (/\b(export|function|const|let|var|return|=>)\b/.test(text)) {
    return text;
  }
  throw new Error("no code block");
}

/**
 * Compose the system + user prompt for a benchmark task.
 *
 * @param {{prompt: string, starterCode?: string, entry?: string}} task
 * @returns {{system: string, user: string}}
 */
export function composeBenchmarkPrompt(task) {
  if (!task || typeof task !== "object" || typeof task.prompt !== "string") {
    throw new Error("composeBenchmarkPrompt: task.prompt required");
  }
  const parts = [task.prompt];
  if (typeof task.starterCode === "string" && task.starterCode.length > 0) {
    parts.push("\nStarter code:\n```javascript\n" + task.starterCode + "\n```");
  }
  parts.push(
    "\nRespond with ONLY a JavaScript code block. Do not include prose, " +
    "explanations, or markdown outside the single ```javascript fence."
  );
  return { system: SYSTEM_PROMPT, user: parts.join("\n") };
}

function resolveApiKey(backend, explicit) {
  if (typeof explicit === "string" && explicit.length > 0) return explicit;
  if (backend === "openai") return process.env.OPENAI_API_KEY || "";
  if (backend === "anthropic") return process.env.ANTHROPIC_API_KEY || "";
  if (backend === "siskelbot-proxy") return process.env.API_KEY || "";
  // ollama / vllm usually need no key but may use one when proxied
  if (backend === "vllm") return process.env.VLLM_API_KEY || "";
  return "";
}

function resolveBaseUrl(backend, explicit) {
  if (typeof explicit === "string" && explicit.length > 0) {
    return explicit.replace(/\/$/, "");
  }
  return (DEFAULT_BASE_URLS[backend] || "").replace(/\/$/, "");
}

function safeErrMessage(res, bodyText) {
  const trimmed = typeof bodyText === "string" ? bodyText.slice(0, 500) : "";
  return `HTTP ${res.status} ${res.statusText || ""}`.trim() +
    (trimmed ? `: ${trimmed}` : "");
}

async function readBodyText(res) {
  try { return await res.text(); } catch { return ""; }
}

async function withTimeout(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (e) {
    if (e && (e.name === "AbortError" || /aborted/i.test(String(e.message)))) {
      throw new Error(`request timed out after ${timeoutMs}ms`, { cause: e });
    }
    throw e;
  } finally {
    clearTimeout(t);
  }
}

/* ─── OpenAI / vLLM / siskelbot-proxy (OpenAI-compatible) ────────────────── */

function buildOpenAICompatibleAgent(kind, cfg) {
  const baseUrl = resolveBaseUrl(kind, cfg.baseUrl);
  const apiKey = resolveApiKey(kind, cfg.apiKey);
  const model = cfg.model;
  const timeoutMs = cfg.timeoutMs || DEFAULT_TIMEOUT_MS;
  const maxTokens = cfg.maxTokens || DEFAULT_MAX_TOKENS;
  const temperature = cfg.temperature != null ? cfg.temperature : DEFAULT_TEMPERATURE;
  const fetchImpl = cfg.fetchImpl || globalThis.fetch;

  return async function agent(prompt, ctx = {}) {
    const task = ctx && ctx.task ? ctx.task : { prompt };
    const { system, user } = composeBenchmarkPrompt({
      prompt,
      starterCode: task && task.starterCode,
    });
    const headers = {
      "content-type": "application/json",
      accept: "application/json",
      ...(cfg.headers || {}),
    };
    if (apiKey) headers["authorization"] = "Bearer " + apiKey;

    const body = {
      model,
      stream: false,
      max_tokens: maxTokens,
      temperature,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    };

    const url = baseUrl + "/v1/chat/completions";
    const res = await withTimeout(
      fetchImpl,
      url,
      { method: "POST", headers, body: JSON.stringify(body) },
      timeoutMs
    );
    if (!res.ok) {
      throw new Error(safeErrMessage(res, await readBodyText(res)));
    }
    let data;
    try { data = await res.json(); }
    catch (e) { throw new Error(`invalid JSON from ${kind}: ${e.message}`, { cause: e }); }

    const content = data && data.choices && data.choices[0] &&
      data.choices[0].message && typeof data.choices[0].message.content === "string"
        ? data.choices[0].message.content
        : null;
    if (content === null) {
      throw new Error(`unexpected ${kind} response shape (missing choices[0].message.content)`);
    }
    return extractCode(content, "javascript");
  };
}

/* ─── Anthropic /v1/messages ─────────────────────────────────────────────── */

function buildAnthropicAgent(cfg) {
  const baseUrl = resolveBaseUrl("anthropic", cfg.baseUrl);
  const apiKey = resolveApiKey("anthropic", cfg.apiKey);
  const model = cfg.model;
  const timeoutMs = cfg.timeoutMs || DEFAULT_TIMEOUT_MS;
  const maxTokens = cfg.maxTokens || DEFAULT_MAX_TOKENS;
  const temperature = cfg.temperature != null ? cfg.temperature : DEFAULT_TEMPERATURE;
  const fetchImpl = cfg.fetchImpl || globalThis.fetch;

  return async function agent(prompt, ctx = {}) {
    const task = ctx && ctx.task ? ctx.task : { prompt };
    const { system, user } = composeBenchmarkPrompt({
      prompt,
      starterCode: task && task.starterCode,
    });
    const headers = {
      "content-type": "application/json",
      accept: "application/json",
      "anthropic-version": "2023-06-01",
      ...(cfg.headers || {}),
    };
    if (apiKey) headers["x-api-key"] = apiKey;

    const body = {
      model,
      max_tokens: maxTokens,
      temperature,
      system,
      messages: [
        { role: "user", content: user },
      ],
    };

    const url = baseUrl + "/v1/messages";
    const res = await withTimeout(
      fetchImpl,
      url,
      { method: "POST", headers, body: JSON.stringify(body) },
      timeoutMs
    );
    if (!res.ok) {
      throw new Error(safeErrMessage(res, await readBodyText(res)));
    }
    let data;
    try { data = await res.json(); }
    catch (e) { throw new Error(`invalid JSON from anthropic: ${e.message}`, { cause: e }); }

    // Anthropic: content is an array of blocks [{type:"text", text:"..."}]
    let content = null;
    if (data && Array.isArray(data.content)) {
      const texts = data.content
        .filter((b) => b && b.type === "text" && typeof b.text === "string")
        .map((b) => b.text);
      if (texts.length > 0) content = texts.join("\n");
    }
    if (content === null) {
      throw new Error("unexpected anthropic response shape (missing content[])");
    }
    return extractCode(content, "javascript");
  };
}

/* ─── Ollama /api/chat ───────────────────────────────────────────────────── */

function buildOllamaAgent(cfg) {
  const baseUrl = resolveBaseUrl("ollama", cfg.baseUrl);
  const model = cfg.model;
  const timeoutMs = cfg.timeoutMs || DEFAULT_TIMEOUT_MS;
  const temperature = cfg.temperature != null ? cfg.temperature : DEFAULT_TEMPERATURE;
  const fetchImpl = cfg.fetchImpl || globalThis.fetch;

  return async function agent(prompt, ctx = {}) {
    const task = ctx && ctx.task ? ctx.task : { prompt };
    const { system, user } = composeBenchmarkPrompt({
      prompt,
      starterCode: task && task.starterCode,
    });
    const headers = {
      "content-type": "application/json",
      accept: "application/json",
      ...(cfg.headers || {}),
    };

    const body = {
      model,
      stream: false,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      options: { temperature },
    };

    const url = baseUrl + "/api/chat";
    const res = await withTimeout(
      fetchImpl,
      url,
      { method: "POST", headers, body: JSON.stringify(body) },
      timeoutMs
    );
    if (!res.ok) {
      throw new Error(safeErrMessage(res, await readBodyText(res)));
    }
    let data;
    try { data = await res.json(); }
    catch (e) { throw new Error(`invalid JSON from ollama: ${e.message}`, { cause: e }); }

    const content = data && data.message && typeof data.message.content === "string"
      ? data.message.content
      : null;
    if (content === null) {
      throw new Error("unexpected ollama response shape (missing message.content)");
    }
    return extractCode(content, "javascript");
  };
}

/**
 * Build an agentFn compatible with runBenchmarkSuite.
 *
 * @param {object} config
 * @param {"openai"|"anthropic"|"ollama"|"vllm"|"siskelbot-proxy"} config.backend
 * @param {string} [config.baseUrl]
 * @param {string} [config.apiKey]
 * @param {string} config.model
 * @param {number} [config.timeoutMs=60000]
 * @param {number} [config.maxTokens=2048]
 * @param {number} [config.temperature=0]
 * @param {Record<string,string>} [config.headers]
 * @param {function} [config.fetchImpl]
 * @returns {(prompt: string) => Promise<string>}
 */
export function buildRealAgent(config) {
  if (!config || typeof config !== "object") {
    throw new Error("buildRealAgent: config required");
  }
  if (typeof config.backend !== "string") {
    throw new Error("buildRealAgent: config.backend required");
  }
  if (typeof config.model !== "string" || config.model.length === 0) {
    throw new Error("buildRealAgent: config.model required");
  }
  const fetchImpl = config.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("buildRealAgent: no fetch implementation available");
  }

  switch (config.backend) {
    case "openai":
    case "vllm":
    case "siskelbot-proxy":
      return buildOpenAICompatibleAgent(config.backend, config);
    case "anthropic":
      return buildAnthropicAgent(config);
    case "ollama":
      return buildOllamaAgent(config);
    default:
      throw new Error(`buildRealAgent: unsupported backend "${config.backend}"`);
  }
}
