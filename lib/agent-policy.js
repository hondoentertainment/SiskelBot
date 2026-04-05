/**
 * Runtime policy limits for agent/specialist tool execution.
 * Adds optional per-workspace and deployment caps for tool categories,
 * network fetches, and cumulative tool latency.
 */

import { recordPolicyDenial } from "./metrics.js";

const TOOL_CATEGORY_MAP = {
  search_context: "read",
  list_context: "read",
  semantic_search_context: "read",
  get_context_document: "read",
  list_recipes: "read",
  get_recipe: "read",
  list_workspace_memory: "read",
  remember_workspace_fact: "write",
  execute_step: "write",
  update_agent_session_plan: "write",
  fetch_allowed_url: "network",
  workspace_list_dir: "read",
  workspace_read_file: "read",
  workspace_search_text: "read",
  workspace_git_status: "read",
  workspace_git_log: "read",
  workspace_git_diff: "read",
  workspace_write_file: "write",
  workspace_git_commit: "write",
  workspace_run_command: "write",
  browser_open_extract_text: "network",
  browser_capture_screenshot: "network",
};

/**
 * Tools that count toward maxExternalFetches / externalFetches (shared egress budget with fetch_allowed_url).
 * @param {string} toolName
 */
export function toolConsumesExternalFetchBudget(toolName) {
  const n = String(toolName || "").trim();
  return (
    n === "fetch_allowed_url" || n === "browser_open_extract_text" || n === "browser_capture_screenshot"
  );
}

/**
 * @param {string} name
 * @returns {"read"|"write"|"network"}
 */
export function getToolCategory(name) {
  const n = String(name || "").trim();
  return TOOL_CATEGORY_MAP[n] || "read";
}

/**
 * Parse AGENT_TOOL_CATEGORY_CAPS=read:20,write:5,network:3
 * @returns {{ read?: number, write?: number, network?: number }}
 */
export function parseEnvCategoryCaps() {
  const raw = String(process.env.AGENT_TOOL_CATEGORY_CAPS || "").trim();
  if (!raw) return {};
  const out = {};
  for (const part of raw.split(",")) {
    const [k0, v0] = String(part || "").split(":");
    const k = String(k0 || "").trim().toLowerCase();
    const v = Number(v0);
    if (!Number.isFinite(v) || v <= 0) continue;
    if (k === "read" || k === "write" || k === "network") out[k] = Math.floor(v);
  }
  return out;
}

/**
 * Merge deployment defaults with optional workspace policy.
 * Workspace values are clamped to deployment ceilings when both are present.
 *
 * @param {object} workspacePolicy
 */
export function resolveEffectivePolicy(workspacePolicy = {}) {
  const envCaps = parseEnvCategoryCaps();
  const envMaxExternalFetches = Number(process.env.AGENT_MAX_EXTERNAL_FETCHES) || 0;
  const envMaxTotalToolMs = Number(process.env.AGENT_MAX_TOTAL_TOOL_MS) || 0;
  const wsCaps = workspacePolicy && typeof workspacePolicy === "object" ? workspacePolicy.toolCategoryCaps || {} : {};
  const outCaps = {};
  for (const k of ["read", "write", "network"]) {
    const envV = Number(envCaps[k]) || 0;
    const wsV = Number(wsCaps[k]) || 0;
    if (envV > 0 && wsV > 0) outCaps[k] = Math.min(envV, wsV);
    else if (envV > 0) outCaps[k] = envV;
    else if (wsV > 0) outCaps[k] = wsV;
  }
  const wsFetch = Number(workspacePolicy?.maxExternalFetches) || 0;
  const wsToolMs = Number(workspacePolicy?.maxTotalToolMs) || 0;
  const maxExternalFetches =
    envMaxExternalFetches > 0 && wsFetch > 0
      ? Math.min(envMaxExternalFetches, wsFetch)
      : envMaxExternalFetches > 0
        ? envMaxExternalFetches
        : wsFetch > 0
          ? wsFetch
          : 0;
  const maxTotalToolMs =
    envMaxTotalToolMs > 0 && wsToolMs > 0
      ? Math.min(envMaxTotalToolMs, wsToolMs)
      : envMaxTotalToolMs > 0
        ? envMaxTotalToolMs
        : wsToolMs > 0
          ? wsToolMs
          : 0;
  return { toolCategoryCaps: outCaps, maxExternalFetches, maxTotalToolMs };
}

/**
 * @param {object} effectivePolicy
 * @param {{ deniedTools?: Set<string>|string[] }} [opts]
 */
export function createPolicyState(effectivePolicy, opts = {}) {
  let deniedTools = new Set();
  if (opts.deniedTools instanceof Set) deniedTools = opts.deniedTools;
  else if (Array.isArray(opts.deniedTools)) {
    deniedTools = new Set(opts.deniedTools.map((x) => String(x).trim()).filter(Boolean));
  }
  return {
    policy: effectivePolicy || { toolCategoryCaps: {}, maxExternalFetches: 0, maxTotalToolMs: 0 },
    deniedTools,
    categoryCounts: { read: 0, write: 0, network: 0 },
    externalFetches: 0,
    totalToolMs: 0,
  };
}

/**
 * Check limits before executing one tool call.
 * @param {ReturnType<typeof createPolicyState>} state
 * @param {string} toolName
 * @returns {{ ok: true } | { ok: false, code: string, reason: string }}
 */
export function checkPolicyBeforeTool(state, toolName) {
  const name = String(toolName || "").trim();
  if (state.deniedTools instanceof Set && state.deniedTools.size > 0 && state.deniedTools.has(name)) {
    recordPolicyDenial("POLICY_TOOL_DENIED");
    return {
      ok: false,
      code: "POLICY_TOOL_DENIED",
      reason: `tool ${name} is denied by workspace policy`,
    };
  }
  const category = getToolCategory(toolName);
  const cap = Number(state.policy?.toolCategoryCaps?.[category]) || 0;
  const nextCategoryCount = (Number(state.categoryCounts?.[category]) || 0) + 1;
  if (cap > 0 && nextCategoryCount > cap) {
    recordPolicyDenial("POLICY_CATEGORY_CAP");
    return {
      ok: false,
      code: "POLICY_CATEGORY_CAP",
      reason: `category ${category} cap reached (${cap})`,
    };
  }
  if (toolConsumesExternalFetchBudget(toolName)) {
    const capFetch = Number(state.policy?.maxExternalFetches) || 0;
    if (capFetch > 0 && state.externalFetches + 1 > capFetch) {
      recordPolicyDenial("POLICY_EXTERNAL_FETCH_CAP");
      return {
        ok: false,
        code: "POLICY_EXTERNAL_FETCH_CAP",
        reason: `external fetch cap reached (${capFetch})`,
      };
    }
  }
  return { ok: true };
}

/**
 * Update counters after a tool call finishes.
 * @param {ReturnType<typeof createPolicyState>} state
 * @param {string} toolName
 * @param {number} durationMs
 */
export function recordPolicyToolCompletion(state, toolName, durationMs) {
  const category = getToolCategory(toolName);
  state.categoryCounts[category] = (Number(state.categoryCounts[category]) || 0) + 1;
  if (toolConsumesExternalFetchBudget(toolName)) {
    state.externalFetches += 1;
  }
  state.totalToolMs += Math.max(0, Number(durationMs) || 0);
}

/**
 * Check cumulative tool latency budget after one round.
 * @param {ReturnType<typeof createPolicyState>} state
 * @returns {{ ok: true } | { ok: false, code: string, reason: string }}
 */
export function checkPolicyAfterRound(state) {
  const maxMs = Number(state.policy?.maxTotalToolMs) || 0;
  if (maxMs > 0 && state.totalToolMs > maxMs) {
    return {
      ok: false,
      code: "POLICY_TOOL_MS_CAP",
      reason: `cumulative tool latency exceeded (${state.totalToolMs}ms > ${maxMs}ms)`,
    };
  }
  return { ok: true };
}
