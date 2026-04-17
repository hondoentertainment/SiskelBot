/**
 * Lightweight token estimation utilities for context-window management.
 *
 * Uses a heuristic (text.length / 3.5) by default. When the env var
 * TIKTOKEN_AVAILABLE is set and a tiktoken module is importable, exact
 * counts are used instead.
 */

let tiktokenEncode = null;

if (process.env.TIKTOKEN_AVAILABLE) {
  try {
    // Try js-tiktoken first, then tiktoken
    const mod = await import("js-tiktoken").catch(() => import("tiktoken").catch(() => null));
    if (mod && typeof mod.encoding_for_model === "function") {
      const enc = mod.encoding_for_model("gpt-4o");
      tiktokenEncode = (text) => enc.encode(text).length;
    } else if (mod && typeof mod.get_encoding === "function") {
      const enc = mod.get_encoding("cl100k_base");
      tiktokenEncode = (text) => enc.encode(text).length;
    }
  } catch {
    // Fall back to heuristic silently
  }
}

/**
 * Estimate the number of tokens in a string.
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  if (typeof text !== "string" || text.length === 0) return 0;
  if (tiktokenEncode) {
    try {
      return tiktokenEncode(text);
    } catch {
      // Fall through to heuristic
    }
  }
  return Math.ceil(text.length / 3.5);
}

/** Per-message framing overhead (role, separators, etc.) */
const MESSAGE_OVERHEAD_TOKENS = 4;

/**
 * Estimate the total token count for an array of chat messages.
 * Each message adds ~4 tokens of framing overhead on top of its content.
 * @param {Array<{ role?: string; content?: string; tool_calls?: any }>} messages
 * @returns {number}
 */
export function estimateMessagesTokens(messages) {
  if (!Array.isArray(messages)) return 0;
  let total = 0;
  for (const msg of messages) {
    if (!msg) continue;
    const role = typeof msg.role === "string" ? msg.role : "";
    const content = typeof msg.content === "string" ? msg.content : "";
    const toolCalls = msg.tool_calls ? JSON.stringify(msg.tool_calls) : "";
    total += estimateTokens(role + content + toolCalls) + MESSAGE_OVERHEAD_TOKENS;
  }
  return total;
}

/**
 * Built-in model context window sizes (in tokens).
 * @type {Record<string, number>}
 */
const MODEL_CONTEXT_WINDOWS = {
  "gpt-4o": 128_000,
  "gpt-4o-mini": 128_000,
  "gpt-4": 8192,
  "gpt-3.5-turbo": 16_384,
  "llama3.1": 131_072,
  "claude-3-sonnet": 200_000,
};

const DEFAULT_CONTEXT_WINDOW = 8192;

/** @type {Record<string, number> | null} */
let envOverrides = null;

function loadEnvOverrides() {
  if (envOverrides !== null) return envOverrides;
  envOverrides = {};
  const raw = process.env.MODEL_CONTEXT_WINDOWS;
  if (typeof raw === "string" && raw.trim()) {
    for (const pair of raw.split(",")) {
      const [model, sizeStr] = pair.split(":");
      if (model && sizeStr) {
        const size = Number(sizeStr.trim());
        if (Number.isFinite(size) && size > 0) {
          envOverrides[model.trim()] = Math.floor(size);
        }
      }
    }
  }
  return envOverrides;
}

/**
 * Return the context window size (in tokens) for a given model.
 * Checks env override MODEL_CONTEXT_WINDOWS first, then the built-in table,
 * then falls back to DEFAULT_CONTEXT_WINDOW (8192).
 * @param {string} model
 * @returns {number}
 */
export function getModelContextWindow(model) {
  const m = typeof model === "string" ? model.trim() : "";
  const overrides = loadEnvOverrides();
  if (m && overrides[m] != null) return overrides[m];
  if (m && MODEL_CONTEXT_WINDOWS[m] != null) return MODEL_CONTEXT_WINDOWS[m];
  return DEFAULT_CONTEXT_WINDOW;
}

/**
 * Reset cached env overrides — exposed for tests only.
 */
export function __resetEnvOverridesForTests() {
  envOverrides = null;
}
