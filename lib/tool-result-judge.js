/**
 * Post-execution tool-result judge.
 *
 * Pre-execution validators (tool-validation.js, tool-semantic-validators.js)
 * only check that the arguments handed TO a tool are well-formed. They cannot
 * catch the case where a tool returns technically-valid-but-semantically-wrong
 * data (empty result when a result is expected, misleading summary, stale
 * cached data). This module asks a cheap LLM to assess whether the tool's
 * returned content substantively addresses the user's original intent.
 *
 * The judge is ADVISORY. On any internal failure (timeout, malformed LLM
 * response, thrown error) it fails OPEN — returning satisfactory: true — so
 * the agent loop is never blocked by a flaky judge.
 *
 * Env gates:
 *   AGENT_TOOL_RESULT_JUDGE=1   enables judging (default OFF — costs LLM call)
 *   JUDGE_SKIP_TOOLS=a,b,c      comma-separated tools to skip judging for
 *
 * The judge is callFn-based (no direct HTTP) so unit tests can stub the LLM.
 *
 * @module tool-result-judge
 */

const RESULT_TRUNCATE_CHARS = 2000;

const DEFAULT_SKIP_TOOLS = [
  "list_context",
  "list_recipes",
  "list_workspace_memory",
  "workspace_git_status",
  "workspace_git_log",
  "workspace_list_dir",
];

/**
 * @typedef {object} JudgeVerdict
 * @property {boolean} satisfactory
 * @property {number} confidence
 * @property {string} [issue]
 * @property {string} [suggestion]
 * @property {string} rawResponse
 */

/**
 * Safe JSON stringify that falls back to String() on circular refs.
 * @param {*} value
 * @returns {string}
 */
function safeStringify(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value ?? null, null, 2);
  } catch {
    try {
      return String(value);
    } catch {
      return "[unserializable]";
    }
  }
}

/**
 * Truncate a string to at most `max` characters, appending an ellipsis marker
 * when truncation occurs. Preserves original content exactly when short enough.
 * @param {string} s
 * @param {number} max
 * @returns {string}
 */
function truncate(s, max) {
  if (typeof s !== "string") s = String(s ?? "");
  if (s.length <= max) return s;
  return s.slice(0, max) + `... [truncated ${s.length - max} chars]`;
}

/**
 * Build the judge prompt asking the LLM to assess intent-satisfaction.
 *
 * Deliberately phrased so the judge assesses whether the result addresses
 * the user's intent (not whether it is technically correct). Uncertain cases
 * should bias toward satisfactory: true with low confidence to avoid blocking
 * the agent on vague concerns.
 *
 * @param {{ toolName: string, toolArgs: * , toolResult: *, userIntent: string }} params
 * @returns {string}
 */
export function buildJudgePrompt({ toolName, toolArgs, toolResult, userIntent }) {
  const argsText = safeStringify(toolArgs ?? {});
  const resultText = truncate(safeStringify(toolResult ?? ""), RESULT_TRUNCATE_CHARS);
  const intentText = typeof userIntent === "string" ? userIntent : String(userIntent ?? "");
  return [
    `The user asked: "${intentText}"`,
    `An agent called tool '${toolName}' with args: ${argsText}`,
    `The tool returned: ${resultText}`,
    "",
    "Answer STRICT JSON only:",
    '{"satisfactory": true|false, "confidence": 0-1, "issue": "<one sentence>", "suggestion": "<one sentence>"}',
    "",
    "Rules:",
    '- "satisfactory" = does the result substantively address what the user asked?',
    "- A result can be correct but off-topic (not satisfactory) or partially-correct (rate confidence < 0.7)",
    "- If uncertain, prefer satisfactory: true with low confidence — do not block the agent on vague concerns",
    '- Suggestion should be actionable ("try a different search query", "the response was empty; retry with broader terms")',
  ].join("\n");
}

/**
 * Strip markdown code fences (```json ... ``` or ``` ... ```) from LLM text.
 * @param {string} text
 * @returns {string}
 */
function stripFences(text) {
  if (typeof text !== "string") return "";
  const trimmed = text.trim();
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  if (fence) return fence[1].trim();
  return trimmed;
}

/**
 * Best-effort extraction of a JSON object from free-form LLM output.
 * Strategy:
 *   1) Strip ``` fences and JSON.parse.
 *   2) Regex-extract a {...} block and JSON.parse it.
 * Returns null if nothing parses.
 * @param {string} text
 * @returns {object | null}
 */
function extractJsonObject(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  const inner = stripFences(text);
  try {
    const parsed = JSON.parse(inner);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    // fall through to regex extraction
  }
  // Find the first balanced-looking {...} that contains "satisfactory"
  const re = /\{[\s\S]*?"satisfactory"[\s\S]*?\}/;
  const match = inner.match(re) || text.match(re);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // ignore
    }
  }
  return null;
}

/**
 * Coerce a parsed judge object into a normalized JudgeVerdict.
 * Invalid/missing fields fall back to safe defaults (satisfactory:true).
 * @param {*} parsed
 * @param {string} rawResponse
 * @returns {JudgeVerdict}
 */
function normalizeVerdict(parsed, rawResponse) {
  if (!parsed || typeof parsed !== "object") {
    return { satisfactory: true, confidence: 0, rawResponse };
  }
  const satisfactory = parsed.satisfactory === false ? false : Boolean(parsed.satisfactory ?? true);
  let confidence = 0;
  if (typeof parsed.confidence === "number" && !Number.isNaN(parsed.confidence)) {
    confidence = Math.max(0, Math.min(1, parsed.confidence));
  }
  /** @type {JudgeVerdict} */
  const verdict = { satisfactory, confidence, rawResponse };
  if (!satisfactory) {
    if (typeof parsed.issue === "string" && parsed.issue.trim()) {
      verdict.issue = parsed.issue.trim();
    } else {
      verdict.issue = "result did not substantively address user intent";
    }
    if (typeof parsed.suggestion === "string" && parsed.suggestion.trim()) {
      verdict.suggestion = parsed.suggestion.trim();
    }
  }
  return verdict;
}

/**
 * Race callFn(prompt) against a timeout. Cleans up the timer in both branches.
 * @param {(prompt: string) => Promise<string>} callFn
 * @param {string} prompt
 * @param {number} timeoutMs
 * @returns {Promise<string>}
 */
function callWithTimeout(callFn, prompt, timeoutMs) {
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`judge call timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    if (typeof timer?.unref === "function") timer.unref();
  });
  return Promise.race([
    Promise.resolve().then(() => callFn(prompt)).finally(() => {
      if (timer) clearTimeout(timer);
    }),
    timeoutPromise,
  ]);
}

/**
 * Detect tool names that imply the call should return a collection.
 * Used by the empty-result fast path to flag suspicious empty responses
 * without spending an LLM call.
 * @param {string} toolName
 * @returns {boolean}
 */
function toolImpliesCollection(toolName) {
  if (typeof toolName !== "string") return false;
  return (
    toolName.startsWith("list_") ||
    toolName.startsWith("search_") ||
    toolName.endsWith("_list") ||
    toolName.endsWith("_search") ||
    toolName === "semantic_search_context" ||
    toolName === "search_knowledge_graph" ||
    toolName === "web_search" ||
    toolName === "conversation_search"
  );
}

/**
 * True when the parsed tool result is structurally empty: empty array, empty
 * object, empty string, or a wrapper object whose primary collection field
 * (`results`, `items`, `matches`, `documents`, `data`) is empty.
 * @param {*} result
 * @returns {boolean}
 */
function isEmptyResult(result) {
  if (result == null) return true;
  if (typeof result === "string") return result.trim() === "";
  if (Array.isArray(result)) return result.length === 0;
  if (typeof result !== "object") return false;
  const keys = Object.keys(result);
  if (keys.length === 0) return true;
  const collectionKeys = ["results", "items", "matches", "documents", "data", "entries"];
  for (const k of collectionKeys) {
    if (Array.isArray(result[k]) && result[k].length === 0) return true;
  }
  return false;
}

/**
 * Parse a string result into a JS value when it looks like JSON; otherwise
 * return it as-is. Never throws.
 * @param {*} result
 * @returns {*}
 */
function coerceResultForInspection(result) {
  if (typeof result !== "string") return result;
  const trimmed = result.trim();
  if (!trimmed) return result;
  if (trimmed[0] !== "{" && trimmed[0] !== "[") return result;
  try {
    return JSON.parse(trimmed);
  } catch {
    return result;
  }
}

/**
 * Judge a single tool call's result against the user's intent.
 *
 * Fast-path shortcuts (save LLM calls):
 *   - If result has `ok: false`, return satisfactory:false immediately
 *     (issue: "tool reported failure"). callFn is NOT invoked.
 *   - If userIntent is empty, return satisfactory:true, confidence:0.
 *     callFn is NOT invoked.
 *   - If result is empty and the tool name implies a collection
 *     (list_/search_/etc.), flag satisfactory:false without calling LLM.
 *
 * @param {{
 *   toolName: string,
 *   toolArgs: object,
 *   toolResult: *,
 *   userIntent: string,
 *   callFn: (prompt: string) => Promise<string>,
 *   timeoutMs?: number,
 * }} params
 * @returns {Promise<JudgeVerdict>}
 */
export async function judgeToolResult({
  toolName,
  toolArgs,
  toolResult,
  userIntent,
  callFn,
  timeoutMs = 8000,
}) {
  // Shortcut: missing user intent → cannot meaningfully judge, pass.
  if (typeof userIntent !== "string" || !userIntent.trim()) {
    return { satisfactory: true, confidence: 0, rawResponse: "" };
  }

  const inspect = coerceResultForInspection(toolResult);

  // Shortcut: tool explicitly reported failure.
  if (inspect && typeof inspect === "object" && !Array.isArray(inspect) && inspect.ok === false) {
    const errMsg = typeof inspect.error === "string" && inspect.error.trim()
      ? inspect.error.trim()
      : "tool reported failure";
    return {
      satisfactory: false,
      confidence: 1,
      issue: `tool reported failure: ${errMsg}`,
      suggestion: "retry with adjusted arguments, or select a different tool",
      rawResponse: "",
    };
  }

  // Shortcut: empty collection when one was expected.
  if (toolImpliesCollection(toolName) && isEmptyResult(inspect)) {
    return {
      satisfactory: false,
      confidence: 0.8,
      issue: `${toolName} returned an empty result`,
      suggestion: "retry with broader or differently-worded query terms",
      rawResponse: "",
    };
  }

  if (typeof callFn !== "function") {
    // No judge available — fail open.
    return { satisfactory: true, confidence: 0, rawResponse: "" };
  }

  const prompt = buildJudgePrompt({ toolName, toolArgs, toolResult, userIntent });

  let rawResponse;
  try {
    const result = await callWithTimeout(callFn, prompt, timeoutMs);
    rawResponse = typeof result === "string" ? result : safeStringify(result);
  } catch {
    // Timeout or callFn threw — fail open.
    return { satisfactory: true, confidence: 0, rawResponse: "" };
  }

  if (!rawResponse.trim()) {
    return { satisfactory: true, confidence: 0, rawResponse };
  }

  const parsed = extractJsonObject(rawResponse);
  if (!parsed) {
    // Unparseable — fail open.
    return { satisfactory: true, confidence: 0, rawResponse };
  }

  return normalizeVerdict(parsed, rawResponse);
}

/**
 * Whether the post-execution result judge is enabled.
 * Defaults to OFF — judging costs an extra LLM call per tool call.
 * @returns {boolean}
 */
export function toolResultJudgeEnabled() {
  return process.env.AGENT_TOOL_RESULT_JUDGE === "1";
}

/**
 * Parse the JUDGE_SKIP_TOOLS env var into a set of tool names.
 * Empty/unset env returns the default skip list.
 * @returns {Set<string>}
 */
function resolveSkipSet() {
  const env = process.env.JUDGE_SKIP_TOOLS;
  if (typeof env === "string" && env.trim()) {
    const parts = env
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return new Set(parts);
  }
  return new Set(DEFAULT_SKIP_TOOLS);
}

/**
 * Whether judging should be skipped for the given tool name. Cheap tools like
 * list_* are skipped because judging would cost more than the tool itself.
 * Configurable via JUDGE_SKIP_TOOLS env.
 * @param {string} toolName
 * @returns {boolean}
 */
export function shouldSkipJudge(toolName) {
  if (typeof toolName !== "string" || !toolName) return false;
  return resolveSkipSet().has(toolName);
}
