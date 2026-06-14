/**
 * Semantic tool-argument validators.
 *
 * Runs AFTER JSON-schema / type checks pass. Catches LLM arguments that are
 * technically valid (right type, right shape) but semantically broken:
 *   - too-short search queries
 *   - non-https URLs when https is required
 *   - relative paths where absolute is required
 *   - empty arrays / whitespace-only strings
 *
 * Registry-based so new tools can register rules without touching the core.
 * Returns LLM-facing repair hints that slot into the re-plan analyzer.
 *
 * @module tool-semantic-validators
 */

/**
 * @typedef {object} SemanticIssue
 * @property {string} path  - dot path to the offending field (e.g. "url", "filters.0")
 * @property {string} message - human + LLM-readable reason
 * @property {string} hint - repair guidance
 */

/**
 * @typedef {object} SemanticResult
 * @property {boolean} ok
 * @property {SemanticIssue[]} issues
 * @property {string} repairHint - joined hint suitable for a tool result 'error' field
 */

/** @type {Map<string, Array<(args: any) => SemanticIssue[] | null>>} */
const registry = new Map();

/**
 * Register one or more semantic rule functions for a tool name.
 * @param {string} toolName
 * @param {Array<(args: any) => SemanticIssue[] | null>} rules
 */
export function registerSemanticRules(toolName, rules) {
  if (!toolName || !Array.isArray(rules)) return;
  const existing = registry.get(toolName) || [];
  registry.set(toolName, [...existing, ...rules]);
}

/**
 * Remove all semantic rules for a tool (mainly for tests).
 * @param {string} toolName
 */
export function clearSemanticRules(toolName) {
  if (toolName) registry.delete(toolName);
  else registry.clear();
}

/**
 * Apply all registered semantic rules for a tool call.
 * @param {string} toolName
 * @param {unknown} args
 * @returns {SemanticResult}
 */
export function validateSemantic(toolName, args) {
  const rules = registry.get(toolName);
  if (!rules || rules.length === 0) return { ok: true, issues: [], repairHint: "" };
  /** @type {SemanticIssue[]} */
  const issues = [];
  for (const rule of rules) {
    try {
      const out = rule(args);
      if (out && Array.isArray(out) && out.length > 0) issues.push(...out);
    } catch {
      // Semantic rule errors are non-fatal; skip the rule rather than
      // breaking the tool call.
    }
  }
  return {
    ok: issues.length === 0,
    issues,
    repairHint: issues.map((i) => `${i.path}: ${i.hint}`).join("; "),
  };
}

/**
 * Whether semantic validation is enabled (default on; disable with
 * TOOL_SEMANTIC_VALIDATION=0).
 */
export function semanticValidationEnabled() {
  return process.env.TOOL_SEMANTIC_VALIDATION !== "0";
}

/* -------------------------------------------------------------------------- */
/* Common rule builders                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Require a string field to be >= min characters after trim.
 * @param {string} field
 * @param {number} min
 */
export function minStringLength(field, min) {
  return (args) => {
    if (!args || typeof args !== "object") return null;
    const v = args[field];
    if (typeof v !== "string") return null;
    const trimmed = v.trim();
    if (trimmed.length >= min) return null;
    return [
      {
        path: field,
        message: `${field} is ${trimmed.length} chars, need at least ${min}`,
        hint: `Use at least ${min} characters of specific terms from the user's request for '${field}'`,
      },
    ];
  };
}

/**
 * Require a URL field to use the https:// scheme.
 * @param {string} field
 */
export function httpsUrlRequired(field) {
  return (args) => {
    if (!args || typeof args !== "object") return null;
    const v = args[field];
    if (typeof v !== "string" || v.length === 0) return null;
    let url;
    try { url = new URL(v); } catch {
      return [{ path: field, message: `${field} is not a valid URL`, hint: `Pass a full URL including scheme, e.g. https://example.com` }];
    }
    if (url.protocol !== "https:") {
      return [{ path: field, message: `${field} uses ${url.protocol}//`, hint: `Use https:// scheme; ${url.protocol}// is not allowed` }];
    }
    return null;
  };
}

/**
 * Require an array field to be non-empty when present.
 * @param {string} field
 */
export function nonEmptyArray(field) {
  return (args) => {
    if (!args || typeof args !== "object") return null;
    const v = args[field];
    if (v === undefined) return null;
    if (!Array.isArray(v)) return null;
    if (v.length > 0) return null;
    return [{
      path: field,
      message: `${field} is an empty array`,
      hint: `Provide at least one entry for '${field}'`,
    }];
  };
}

/**
 * Require a path field (when provided) to be absolute (starts with "/" or a
 * drive letter on win32). Cross-platform safe.
 * @param {string} field
 */
export function absolutePath(field) {
  return (args) => {
    if (!args || typeof args !== "object") return null;
    const v = args[field];
    if (typeof v !== "string" || v.length === 0) return null;
    // POSIX absolute: starts with "/"
    // Windows absolute: starts with drive letter + ":" (e.g. C:\)
    const isPosixAbs = v.startsWith("/");
    const isWinAbs = /^[A-Za-z]:[\\/]/.test(v);
    if (isPosixAbs || isWinAbs) return null;
    return [{
      path: field,
      message: `${field} is not an absolute path ('${v}')`,
      hint: `Pass an absolute path for '${field}' (starting with '/' or a drive letter)`,
    }];
  };
}

/**
 * Reject a string field that looks like a placeholder / fill-me-in value.
 * @param {string} field
 */
export function rejectPlaceholder(field) {
  const pattern = /^(xxx+|todo|placeholder|example|your[_-]?[a-z]*|replace[_-]?me|<[^>]+>|\.\.\.|n\/a)$/i;
  return (args) => {
    if (!args || typeof args !== "object") return null;
    const v = args[field];
    if (typeof v !== "string") return null;
    if (!pattern.test(v.trim())) return null;
    return [{
      path: field,
      message: `${field} looks like a placeholder: '${v}'`,
      hint: `Replace placeholder '${v}' in '${field}' with a real value drawn from the conversation`,
    }];
  };
}

/* -------------------------------------------------------------------------- */
/* Default rules for built-in tools                                           */
/* -------------------------------------------------------------------------- */

registerDefaultRules();

function registerDefaultRules() {
  registerSemanticRules("search_context", [
    minStringLength("query", 3),
    rejectPlaceholder("query"),
  ]);
  registerSemanticRules("semantic_search_context", [
    minStringLength("query", 3),
    rejectPlaceholder("query"),
  ]);
  registerSemanticRules("search_knowledge_graph", [
    minStringLength("query", 3),
  ]);
  registerSemanticRules("web_search", [
    minStringLength("query", 2),
    rejectPlaceholder("query"),
  ]);
  registerSemanticRules("fetch_allowed_url", [
    httpsUrlRequired("url"),
    rejectPlaceholder("url"),
  ]);
  registerSemanticRules("browser_open_extract_text", [
    httpsUrlRequired("url"),
  ]);
  registerSemanticRules("browser_capture_screenshot", [
    httpsUrlRequired("url"),
  ]);
  registerSemanticRules("workspace_read_file", [
    absolutePath("path"),
    rejectPlaceholder("path"),
  ]);
  registerSemanticRules("remember_workspace_fact", [
    minStringLength("fact", 4),
    rejectPlaceholder("fact"),
  ]);
  registerSemanticRules("create_document", [
    minStringLength("title", 3),
    rejectPlaceholder("title"),
    rejectPlaceholder("content"),
  ]);
}
