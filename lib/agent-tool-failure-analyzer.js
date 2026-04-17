/**
 * Tool failure analyzer.
 *
 * Classifies tool-call failures into a taxonomy and produces LLM-friendly
 * recovery hints for the re-plan nudge. Tracks per-(tool, category, argsKey)
 * repetition so the agent can be told to stop repeating the same broken call.
 *
 * @module agent-tool-failure-analyzer
 */

/**
 * @typedef {"validation"
 *   | "unknown_tool"
 *   | "not_allowed"
 *   | "permission"
 *   | "not_found"
 *   | "rate_limit"
 *   | "timeout"
 *   | "network"
 *   | "backend_error"
 *   | "semantic"
 *   | "cancelled"
 *   | "unknown"} FailureCategory
 */

/**
 * @typedef {object} ClassifiedFailure
 * @property {FailureCategory} category
 * @property {"low" | "medium" | "high"} severity
 * @property {boolean} terminal - true when retrying is pointless in principle
 * @property {string} hint - LLM-facing recovery guidance
 * @property {string} message - short human-readable error summary
 */

/**
 * @typedef {object} FailureTracker
 * @property {Map<string, number>} counts - key: `${tool}|${category}|${argsKey}`
 * @property {Map<string, number>} toolCounts - key: tool name
 * @property {Map<string, FailureCategory>} lastCategory - key: tool name
 */

const LOW_QUERY_RE = /query|q|search|term/i;

/**
 * Create a fresh failure tracker for one agent run.
 * @returns {FailureTracker}
 */
export function createTracker() {
  return {
    counts: new Map(),
    toolCounts: new Map(),
    lastCategory: new Map(),
  };
}

/**
 * Produce a stable, size-bounded key for a tool-call arg object.
 * @param {unknown} args
 * @returns {string}
 */
export function argsFingerprint(args) {
  if (args == null) return "∅";
  if (typeof args !== "object") return String(args).slice(0, 64);
  try {
    const keys = Object.keys(args).sort();
    const parts = [];
    for (const k of keys) {
      // @ts-ignore - dynamic indexing of unknown
      const v = args[k];
      const vs = typeof v === "string" ? v.slice(0, 48) : JSON.stringify(v);
      parts.push(`${k}=${vs}`);
    }
    return parts.join("&").slice(0, 240);
  } catch {
    return "∅";
  }
}

/**
 * Classify a parsed failing tool result into a category with recovery hint.
 *
 * @param {string} toolName
 * @param {Record<string, unknown>} parsed - parsed tool result body (ok:false or _tool_validation_error:true)
 * @param {unknown} [args]
 * @returns {ClassifiedFailure}
 */
export function classifyFailure(toolName, parsed, args) {
  const message = pickMessage(parsed);
  const lower = message.toLowerCase();
  const status = Number(parsed?.status ?? parsed?.statusCode ?? 0) || 0;
  const code = typeof parsed?.code === "string" ? parsed.code : "";
  const errCode = typeof parsed?.error === "string" ? parsed.error : "";

  if (parsed?._tool_validation_error === true) {
    return {
      category: "validation",
      severity: "high",
      terminal: true,
      message,
      hint:
        "Arguments did not match the tool's JSON schema. Re-read the tool definition, fix the specific fields named in the error, and submit once. Do not resubmit the same arguments.",
    };
  }

  if (/unknown tool|tool not found|no such tool/i.test(message) || code === "UNKNOWN_TOOL") {
    return {
      category: "unknown_tool",
      severity: "high",
      terminal: true,
      message,
      hint:
        "This tool name is not available. Choose a tool from the registered tool list. Do not call this name again.",
    };
  }

  if (code === "TOOL_NOT_ALLOWED" || code === "TOOL_NOT_ALLOWED_WORKSPACE" || /not allowed/i.test(lower)) {
    return {
      category: "not_allowed",
      severity: "high",
      terminal: true,
      message,
      hint:
        "This tool is disabled for this workspace or policy. Pick a different tool or ask the user to enable it; do not retry this tool.",
    };
  }

  if (status === 401 || status === 403 || code.includes("DENIED") || code.includes("FORBIDDEN") || /unauthori[sz]ed|forbidden|permission/i.test(lower)) {
    return {
      category: "permission",
      severity: "high",
      terminal: true,
      message,
      hint:
        "Permission denied. Retrying with the same credentials will fail again. Use a different tool, a different resource, or ask the user for credentials.",
    };
  }

  if (status === 404 || /not ?found|does not exist|no such/i.test(lower) || code === "NOT_FOUND") {
    return {
      category: "not_found",
      severity: "medium",
      terminal: false,
      message,
      hint:
        "The requested resource does not exist. Do not retry with the same identifier. Use a list or search tool to discover valid identifiers first.",
    };
  }

  if (status === 429 || /rate[- ]?limit|too many requests/i.test(lower) || code === "RATE_LIMIT") {
    return {
      category: "rate_limit",
      severity: "medium",
      terminal: false,
      message,
      hint:
        "Rate limited by upstream. Wait briefly and prefer a cached alternative tool or reduce the frequency of calls.",
    };
  }

  if (/timed? ?out|timeout|deadline/i.test(lower) || code === "ETIMEDOUT" || code === "TIMEOUT") {
    return {
      category: "timeout",
      severity: "medium",
      terminal: false,
      message,
      hint:
        "Request timed out. Retry once with a narrower scope (smaller query, fewer items) or switch to a faster alternative.",
    };
  }

  if (/econn|fetch failed|network|dns|enotfound|eai_again/i.test(lower) || isNetworkCode(code)) {
    return {
      category: "network",
      severity: "medium",
      terminal: false,
      message,
      hint:
        "Transient network error. Retry may succeed, but prefer a different tool or cached path if the error repeats.",
    };
  }

  if (status >= 500 && status < 600) {
    return {
      category: "backend_error",
      severity: "medium",
      terminal: false,
      message,
      hint:
        "Upstream service error. Retry at most once. If it fails again, switch to a different tool or report the failure to the user.",
    };
  }

  const semantic = detectSemantic(toolName, args, lower, errCode);
  if (semantic) return semantic;

  if (code === "CANCELLED" || /cancel+ed/i.test(lower)) {
    return {
      category: "cancelled",
      severity: "low",
      terminal: true,
      message,
      hint: "The call was cancelled. Do not retry; the user or a budget limit stopped it.",
    };
  }

  return {
    category: "unknown",
    severity: "low",
    terminal: false,
    message,
    hint:
      "The cause is unclear. Re-read the tool result, inspect your arguments, and try a different approach or tool.",
  };
}

/**
 * Record a failure in the tracker and return repetition metadata.
 *
 * @param {FailureTracker} tracker
 * @param {string} toolName
 * @param {unknown} args
 * @param {FailureCategory} category
 * @returns {{ repeat: number; toolRepeat: number; sameCategoryAsLast: boolean }}
 */
export function trackFailure(tracker, toolName, args, category) {
  const argKey = argsFingerprint(args);
  const key = `${toolName}|${category}|${argKey}`;
  const prev = tracker.counts.get(key) || 0;
  const next = prev + 1;
  tracker.counts.set(key, next);

  const toolPrev = tracker.toolCounts.get(toolName) || 0;
  tracker.toolCounts.set(toolName, toolPrev + 1);

  const sameCategoryAsLast = tracker.lastCategory.get(toolName) === category;
  tracker.lastCategory.set(toolName, category);

  return { repeat: next, toolRepeat: toolPrev + 1, sameCategoryAsLast };
}

/**
 * Compose the re-plan system message for a classified failure, enriched with
 * repetition context. The message is intentionally phrased for the LLM.
 *
 * @param {object} params
 * @param {string} params.toolName
 * @param {ClassifiedFailure} params.failure
 * @param {{ repeat: number; toolRepeat: number; sameCategoryAsLast: boolean }} params.history
 * @param {number} [params.attempt] - 1-based replan attempt
 * @param {number} [params.maxAttempts]
 * @returns {string}
 */
export function buildReplanMessage({ toolName, failure, history, attempt, maxAttempts }) {
  const parts = [];
  parts.push(`Tool '${toolName}' failed (${failure.category}): ${failure.message}`);
  parts.push(failure.hint);

  if (history.repeat >= 2) {
    parts.push(
      `You have already received this exact error from '${toolName}' ${history.repeat} times with the same arguments. Do not repeat this call; pick a different tool or different arguments.`,
    );
  } else if (history.sameCategoryAsLast && history.toolRepeat >= 2) {
    parts.push(
      `'${toolName}' has failed ${history.toolRepeat} times in this run with similar errors. Prefer a different tool.`,
    );
  }

  if (failure.terminal) {
    parts.push("This error is not self-resolving; do not retry the same call.");
  }

  if (attempt && maxAttempts) {
    parts.push(`Re-plan attempt ${attempt} of ${maxAttempts}.`);
  }

  return parts.join(" ");
}

/**
 * Convenience: classify + track + build in one call.
 *
 * @param {object} params
 * @param {string} params.toolName
 * @param {Record<string, unknown>} params.parsed
 * @param {unknown} [params.args]
 * @param {FailureTracker} params.tracker
 * @param {number} [params.attempt]
 * @param {number} [params.maxAttempts]
 * @returns {{ classified: ClassifiedFailure; history: ReturnType<typeof trackFailure>; message: string }}
 */
export function analyzeAndBuildReplan(params) {
  const classified = classifyFailure(params.toolName, params.parsed, params.args);
  const history = trackFailure(params.tracker, params.toolName, params.args, classified.category);
  const message = buildReplanMessage({
    toolName: params.toolName,
    failure: classified,
    history,
    attempt: params.attempt,
    maxAttempts: params.maxAttempts,
  });
  return { classified, history, message };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function pickMessage(parsed) {
  if (!parsed || typeof parsed !== "object") return "unknown error";
  if (typeof parsed.error === "string" && parsed.error.trim()) return parsed.error.slice(0, 300);
  if (typeof parsed.message === "string" && parsed.message.trim()) return parsed.message.slice(0, 300);
  if (Array.isArray(parsed.errors) && parsed.errors.length) {
    return parsed.errors.map(String).join("; ").slice(0, 300);
  }
  return "unknown error";
}

function isNetworkCode(code) {
  if (!code) return false;
  return (
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "ENOTFOUND" ||
    code === "ETIMEDOUT" ||
    code === "EPIPE" ||
    code === "EAI_AGAIN" ||
    code === "FETCH_ERROR" ||
    code.startsWith("UND_ERR_")
  );
}

/**
 * Detect common semantic failures: too-short queries, empty required fields.
 *
 * @param {string} toolName
 * @param {unknown} args
 * @param {string} lowerMsg
 * @param {string} errCode
 * @returns {ClassifiedFailure | null}
 */
function detectSemantic(toolName, args, lowerMsg, errCode) {
  if (args && typeof args === "object") {
    for (const [k, v] of Object.entries(args)) {
      if (typeof v === "string" && LOW_QUERY_RE.test(k) && v.trim().length > 0 && v.trim().length < 3) {
        return {
          category: "semantic",
          severity: "medium",
          terminal: true,
          message: `query '${k}' is too short (${v.trim().length} chars)`,
          hint: `The '${k}' argument is too short to be meaningful. Use at least 3 characters of specific terms drawn from the user's request.`,
        };
      }
    }
  }
  if (/empty|no results|required|missing/i.test(lowerMsg) || errCode === "EMPTY") {
    return {
      category: "semantic",
      severity: "low",
      terminal: false,
      message: lowerMsg.slice(0, 300) || "empty result or missing field",
      hint:
        "The call returned nothing useful or a required field was missing. Broaden or rephrase the query, or populate the missing argument explicitly.",
    };
  }
  return null;
}
