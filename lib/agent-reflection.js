// @ts-check
/**
 * Phase 32.1: Agent reflection loop.
 *
 * Self-critique and optional correction applied after the agent produces its
 * final text response. The reflector re-prompts the backend with the proposed
 * response and a strict reviewer system prompt, then parses a JSON verdict.
 * If the verdict calls for revision, a second pass produces the revised text.
 *
 * All operations are best-effort: any failure (network, bad JSON, timeout)
 * returns a safe fallback so the agent loop keeps working unchanged.
 *
 * @module agent-reflection
 */

export const REFLECTION_PROMPT = `You are a careful self-reviewer. Below is a proposed response to a user request.
Evaluate it for:
1. Accuracy — does it correctly address the request?
2. Completeness — are there missing details or unanswered parts?
3. Grounding — is it supported by the context/tools used?
4. Clarity — is it easy to understand?

Return JSON: { "needsRevision": boolean, "issues": ["..."], "suggestedFix": "..." }
Only suggest revision if there's a meaningful improvement.`;

const DEFAULT_MIN_RESPONSE_LEN = 80;
const DEFAULT_REFLECTION_TIMEOUT_MS = 15000;

const UNCERTAINTY_PATTERNS = [
  /\bi['’]?m not sure\b/i,
  /\bi am not sure\b/i,
  /\bnot certain\b/i,
  /\bmight be\b/i,
  /\bmay be (?:wrong|incorrect|outdated)\b/i,
  /\bi think\b/i,
  /\bi believe\b/i,
  /\bpossibly\b/i,
  /\bperhaps\b/i,
  /\bunclear\b/i,
  /\bcannot confirm\b/i,
  /\bcan['’]?t confirm\b/i,
];

/**
 * Extract the last assistant content from messages for context, if any.
 * @param {any[]} messages
 * @returns {string}
 */
function lastUserRequest(messages) {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "user" && typeof m.content === "string") {
      return m.content;
    }
  }
  return "";
}

/**
 * Attempt to parse a JSON object from a possibly noisy LLM text response.
 * Strips common code fences and extracts the first balanced JSON object.
 * @param {string} text
 * @returns {any}
 */
function parseReflectionJson(text) {
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("empty reflection content");
  }
  let s = text.trim();
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  try {
    return JSON.parse(s);
  } catch (_) {
    // Fall through to brace scan
  }
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const candidate = s.slice(start, end + 1);
    return JSON.parse(candidate);
  }
  throw new Error("no JSON object found in reflection output");
}

/**
 * Normalize a parsed reflection verdict.
 * @param {any} parsed
 * @returns {{ needsRevision: boolean, issues: string[], suggestedFix: string }}
 */
function normalizeVerdict(parsed) {
  const needsRevision = Boolean(parsed && parsed.needsRevision === true);
  const rawIssues = Array.isArray(parsed?.issues) ? parsed.issues : [];
  const issues = rawIssues
    .map((x) => (typeof x === "string" ? x : String(x ?? "")))
    .filter(Boolean)
    .slice(0, 20);
  const suggestedFix =
    typeof parsed?.suggestedFix === "string" ? parsed.suggestedFix : "";
  return { needsRevision, issues, suggestedFix };
}

/**
 * Call the backend with a fetch and a timeout. Returns parsed JSON or throws.
 * @param {typeof globalThis.fetch} backendFetch
 * @param {string} url
 * @param {Record<string,string>} headers
 * @param {any} body
 * @param {number} timeoutMs
 * @returns {Promise<any>}
 */
async function callBackend(backendFetch, url, headers, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    try {
      controller.abort();
    } catch (_) {}
  }, Math.max(1, timeoutMs));
  try {
    const r = await backendFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!r || !r.ok) {
      const status = r ? r.status : "no_response";
      throw new Error(`reflection backend error: ${status}`);
    }
    return await r.json().catch(() => ({}));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Decide whether a reflection pass is worthwhile.
 *
 * @param {any[]} messages - the conversation messages (used for length signals)
 * @param {{ agentMode?: boolean, response?: string, minResponseLen?: number }} [config]
 * @returns {boolean}
 */
export function shouldReflect(messages, config) {
  if (process.env.AGENT_REFLECTION !== "1") return false;
  const cfg = config || {};
  const response = typeof cfg.response === "string" ? cfg.response : "";
  const minLen = Number.isFinite(cfg.minResponseLen)
    ? Number(cfg.minResponseLen)
    : DEFAULT_MIN_RESPONSE_LEN;

  // Always reflect in explicit agent mode, as long as we have *some* content.
  if (cfg.agentMode === true) {
    return typeof response === "string" && response.trim().length > 0;
  }

  if (!response || !response.trim()) return false;

  // Uncertainty markers short-circuit the length check.
  for (const re of UNCERTAINTY_PATTERNS) {
    if (re.test(response)) return true;
  }

  if (response.trim().length < minLen) return false;

  // For long responses, reflect by default when the env flag is on.
  if (response.length >= minLen * 2) return true;

  // Otherwise only reflect if there is actually a user message to evaluate.
  return lastUserRequest(messages).length > 0;
}

/**
 * Run a self-critique of the proposed response.
 *
 * @param {string} response - the proposed final response text
 * @param {{ messages?: any[] }} context - conversation context (uses messages)
 * @param {typeof globalThis.fetch} backendFetch
 * @param {{ baseUrl: string, path: string, headers: Record<string,string> }} config
 * @param {string} model
 * @returns {Promise<{ needsRevision: boolean, issues: string[], suggestedFix: string, reflectionDurationMs: number, error?: string }>}
 */
export async function reflectOnResponse(response, context, backendFetch, config, model) {
  const started = Date.now();
  const safeResponse = typeof response === "string" ? response : "";
  const userRequest = lastUserRequest(context?.messages);
  const url = `${config.baseUrl}${config.path}`;
  const timeoutMs =
    Number(process.env.AGENT_REFLECTION_TIMEOUT_MS) || DEFAULT_REFLECTION_TIMEOUT_MS;

  const reflectMessages = [
    { role: "system", content: REFLECTION_PROMPT },
    {
      role: "user",
      content:
        `Original user request:\n${userRequest || "(not captured)"}\n\n` +
        `Proposed response:\n${safeResponse}\n\n` +
        `Return only the JSON verdict.`,
    },
  ];

  try {
    const data = await callBackend(
      backendFetch,
      url,
      config.headers,
      {
        model,
        messages: reflectMessages,
        stream: false,
        temperature: 0,
      },
      timeoutMs
    );
    const content = data?.choices?.[0]?.message?.content;
    const parsed = parseReflectionJson(typeof content === "string" ? content : "");
    const verdict = normalizeVerdict(parsed);
    return { ...verdict, reflectionDurationMs: Date.now() - started };
  } catch (err) {
    return {
      needsRevision: false,
      issues: [],
      suggestedFix: "",
      reflectionDurationMs: Date.now() - started,
      error: String(err?.message || err),
    };
  }
}

/**
 * Produce a revised response given the original response and the reflection verdict.
 *
 * @param {string} originalResponse
 * @param {{ needsRevision: boolean, issues: string[], suggestedFix: string }} reflection
 * @param {{ messages?: any[] }} context
 * @param {typeof globalThis.fetch} backendFetch
 * @param {{ baseUrl: string, path: string, headers: Record<string,string> }} config
 * @param {string} model
 * @returns {Promise<{ revised: string, improvementSummary: string, error?: string }>}
 */
export async function reviseResponse(originalResponse, reflection, context, backendFetch, config, model) {
  const safeOriginal = typeof originalResponse === "string" ? originalResponse : "";
  const issues = Array.isArray(reflection?.issues) ? reflection.issues : [];
  const suggestedFix = typeof reflection?.suggestedFix === "string" ? reflection.suggestedFix : "";
  const userRequest = lastUserRequest(context?.messages);
  const url = `${config.baseUrl}${config.path}`;
  const timeoutMs =
    Number(process.env.AGENT_REFLECTION_TIMEOUT_MS) || DEFAULT_REFLECTION_TIMEOUT_MS;

  const reviseMessages = [
    {
      role: "system",
      content:
        "You revise a prior assistant response based on reviewer feedback. " +
        "Produce the improved response text only; do not call tools, do not add meta commentary, " +
        "do not announce that it is a revision. Keep the tone consistent with the original.",
    },
    {
      role: "user",
      content:
        `Original user request:\n${userRequest || "(not captured)"}\n\n` +
        `Original response:\n${safeOriginal}\n\n` +
        `Reviewer issues:\n${issues.length ? issues.map((i) => `- ${i}`).join("\n") : "(none specified)"}\n\n` +
        `Suggested fix:\n${suggestedFix || "(none specified)"}\n\n` +
        `Return only the revised response text.`,
    },
  ];

  try {
    const data = await callBackend(
      backendFetch,
      url,
      config.headers,
      {
        model,
        messages: reviseMessages,
        stream: false,
      },
      timeoutMs
    );
    const content = data?.choices?.[0]?.message?.content;
    const revisedRaw = typeof content === "string" ? content.trim() : "";
    if (!revisedRaw) {
      return {
        revised: safeOriginal,
        improvementSummary: "",
        error: "empty revision",
      };
    }
    const improvementSummary = issues.slice(0, 3).join("; ");
    return { revised: revisedRaw, improvementSummary };
  } catch (err) {
    return {
      revised: safeOriginal,
      improvementSummary: "",
      error: String(err?.message || err),
    };
  }
}

// Expose for tests that want to assert parse behavior directly.
export const _internals = { parseReflectionJson, normalizeVerdict, UNCERTAINTY_PATTERNS };
