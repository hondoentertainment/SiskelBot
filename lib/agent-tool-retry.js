/**
 * Phase 9 (I9.1): Transient retries for allowlisted read/network tools (agent loop + swarm).
 * Default off; enable with AGENT_TOOL_RETRY_MAX. Workspace can lower or disable via agentPolicy.transientToolRetryLimit.
 */
import { checkPolicyBeforeTool, recordPolicyToolCompletion } from "./agent-policy.js";
import { recordToolRetry } from "./metrics.js";

const MAX_RETRY_CAP = 5;
const DEFAULT_DELAY_MS = Math.min(60_000, Math.max(200, Number(process.env.AGENT_TOOL_RETRY_DELAY_MS) || 1500));

function parseRetryToolSet() {
  const raw = String(
    process.env.AGENT_TOOL_RETRY_TOOLS ||
      "fetch_allowed_url,browser_open_extract_text,browser_capture_screenshot,search_context,semantic_search_context",
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return new Set(raw);
}

const RETRY_TOOLS = parseRetryToolSet();

/** HTTP / browser / upstream failures that may succeed on retry (not auth/allowlist). */
const TRANSIENT_CODES = new Set([
  "FETCH_FAILED",
  "BROWSER_ERROR",
  "DOC_TOO_LARGE",
  "FS_ERROR",
  "SEARCH_FAILED",
  "INTERNAL_ERROR",
]);

/**
 * Deployment ceiling for **extra** attempts after the first (0 = feature disabled).
 */
export function getDeployToolRetryExtraMax() {
  return Math.min(MAX_RETRY_CAP, Math.max(0, Number(process.env.AGENT_TOOL_RETRY_MAX) || 0));
}

/**
 * @param {object|null|undefined} agentPolicy
 * @returns {number} extra retries allowed (0–5), after merging deploy + workspace.
 */
export function resolveEffectiveMaxTransientRetries(agentPolicy) {
  const deploy = getDeployToolRetryExtraMax();
  if (deploy <= 0) return 0;
  const raw = agentPolicy?.transientToolRetryLimit;
  if (raw === undefined || raw === null) return deploy;
  const ws = Math.min(MAX_RETRY_CAP, Math.max(0, Number(raw) || 0));
  if (ws === 0) return 0;
  return Math.min(deploy, ws);
}

export function toolEligibleForTransientRetry(toolName) {
  return RETRY_TOOLS.has(String(toolName || "").trim());
}

export function parseToolResultJson(content) {
  if (typeof content !== "string" || !content.trim()) return null;
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function errorLooksTransient(msg) {
  const m = String(msg || "").toLowerCase();
  if (!m) return false;
  return (
    m.includes("timeout") ||
    m.includes("timed out") ||
    m.includes("econnreset") ||
    m.includes("socket hang up") ||
    m.includes("econnrefused") ||
    m.includes("network") ||
    m.includes("503") ||
    m.includes("502") ||
    m.includes("504")
  );
}

/**
 * @param {string} toolName
 * @param {object|null} parsed - JSON from tool result
 * @param {{ content?: string, ok?: boolean }} rawResult
 */
export function isTransientToolFailure(toolName, parsed, rawResult) {
  if (!toolEligibleForTransientRetry(toolName)) return false;
  if (rawResult?.ok === true) return false;
  if (parsed && typeof parsed === "object" && parsed.ok === true) return false;
  const code = parsed && typeof parsed.code === "string" ? parsed.code : "";
  if (code === "PLAYWRIGHT_UNAVAILABLE" || code === "ALLOWLIST_REQUIRED" || code === "URL_NOT_ALLOWED") {
    return false;
  }
  if (code === "POLICY_TOOL_DENIED" || code === "POLICY_CATEGORY_CAP" || code === "POLICY_EXTERNAL_FETCH_CAP") {
    return false;
  }
  if (code === "TOOL_EXCEPTION") return errorLooksTransient(parsed?.error);
  if (TRANSIENT_CODES.has(code)) return true;
  const err = parsed && typeof parsed.error === "string" ? parsed.error : "";
  if (errorLooksTransient(err)) return true;
  if (parsed && parsed.ok === false && !code && err) return errorLooksTransient(err);
  return false;
}

function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Run invoke() one or more times on transient failures. Each attempt records policy completion (budget accurate).
 *
 * @param {object} opts
 * @param {string} opts.toolName
 * @param {() => Promise<{ content: string, ok?: boolean }>} opts.invoke
 * @param {object} opts.policyState - Policy state from createPolicyState()
 * @param {number} opts.maxExtraRetries
 * @returns {Promise<{ content: string, ok?: boolean, totalDurationMs: number, retryCount: number, policyBlockedOnRetry?: boolean }>}
 */
export async function runToolWithTransientRetries(opts) {
  const { toolName, invoke, policyState, maxExtraRetries } = opts;
  const name = String(toolName || "").trim();
  const extra = Math.min(MAX_RETRY_CAP, Math.max(0, Number(maxExtraRetries) || 0));
  const maxAttempts = 1 + extra;
  let totalDurationMs = 0;
  let retryCount = 0;
  /** @type {{ content: string, ok?: boolean } | null} */
  let last = null;

  for (let i = 0; i < maxAttempts; i++) {
    if (i > 0) {
      const pre = checkPolicyBeforeTool(policyState, name);
      if (!pre.ok) {
        return {
          content: JSON.stringify({
            ok: false,
            error: `Policy blocked retry of "${name}": ${pre.reason}`,
            code: pre.code,
            retryCount,
          }),
          ok: false,
          totalDurationMs,
          retryCount,
          policyBlockedOnRetry: true,
        };
      }
      await sleepMs(Math.min(60_000, DEFAULT_DELAY_MS * i));
      recordToolRetry(name);
      retryCount++;
    }

    const t0 = Date.now();
    try {
      last = await invoke();
    } catch (e) {
      last = {
        content: JSON.stringify({ ok: false, error: String(e?.message || e), code: "TOOL_EXCEPTION" }),
        ok: false,
      };
    }
    const elapsed = Date.now() - t0;
    totalDurationMs += elapsed;
    recordPolicyToolCompletion(policyState, name, elapsed);

    const parsed = parseToolResultJson(last.content);
    const failed = last.ok === false || (parsed && parsed.ok === false);
    if (!failed) {
      return { ...last, totalDurationMs, retryCount };
    }
    if (i + 1 >= maxAttempts) break;
    if (!isTransientToolFailure(name, parsed, last)) break;
  }

  return {
    content: last?.content ?? "{}",
    ok: last?.ok,
    totalDurationMs,
    retryCount,
  };
}
