/**
 * Workspace-level subagent spawn quota enforcement with optional HITL approval gate.
 *
 * Called by the spawn_subagent tool BEFORE starting a child agent loop.
 *
 * ## Call convention
 *
 * ```js
 * import { checkSubagentQuota, recordSubagentSpawn } from "../lib/subagent-quota.js";
 *
 * // Before spawning:
 * const result = await checkSubagentQuota({
 *   workspace,
 *   userId,
 *   parentSessionId,
 *   depth,
 *   estimatedCostUsd,
 * });
 *
 * if (result.allowed === false) {
 *   // Hard deny — return error to agent with result.reason and result.code
 *   return { error: result.reason, code: result.code };
 * }
 *
 * if (result.allowed === "hitl_required") {
 *   // Pause and await human approval via the existing HITL flow.
 *   // The approvalId can be polled/consumed via peekHitlState / takeHitlState
 *   // from lib/agent-hitl-store.js. The caller must NOT proceed until the
 *   // approval is granted. If denied, abort the spawn.
 *   return { hitl_required: true, approvalId: result.approvalId, reason: result.reason };
 * }
 *
 * // result.allowed === true — proceed with spawn
 * recordSubagentSpawn(workspace);
 * ```
 *
 * ## Configuration
 *
 * Reads from environment variables with per-workspace overrides via
 * workspace agent settings (subagentQuota field from getWorkspaceAgentAccess).
 *
 * | Variable                          | Default | Description                              |
 * |-----------------------------------|---------|------------------------------------------|
 * | SUBAGENT_MAX_SPAWNS_PER_HOUR      | 100     | 0 = unlimited                            |
 * | SUBAGENT_MAX_DEPTH                | 3       | Maximum nesting depth                    |
 * | SUBAGENT_HITL_COST_THRESHOLD_USD  | 5.00    | 0 = disabled                             |
 * | SUBAGENT_HITL_SPAWN_THRESHOLD     | 10      | 0 = disabled                             |
 */

import { saveHitlState } from "./agent-hitl-store.js";

// ---------------------------------------------------------------------------
// Configuration defaults (env)
// ---------------------------------------------------------------------------

function envInt(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}

function envFloat(name, fallback) {
  const v = parseFloat(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}

function getEnvDefaults() {
  return {
    maxSpawnsPerHour: envInt("SUBAGENT_MAX_SPAWNS_PER_HOUR", 100),
    maxDepth: envInt("SUBAGENT_MAX_DEPTH", 3),
    hitlCostThresholdUsd: envFloat("SUBAGENT_HITL_COST_THRESHOLD_USD", 5.0),
    hitlSpawnThreshold: envInt("SUBAGENT_HITL_SPAWN_THRESHOLD", 10),
  };
}

/**
 * Merge env defaults with optional per-workspace overrides.
 * Workspace overrides come from the `subagentQuota` field returned by
 * `getWorkspaceAgentAccess(userId, workspace)` in lib/workspace-agent-settings.js.
 *
 * @param {object} [wsOverrides] — subagentQuota object from workspace settings
 * @returns {{ maxSpawnsPerHour: number, maxDepth: number, hitlCostThresholdUsd: number, hitlSpawnThreshold: number }}
 */
function resolveConfig(wsOverrides) {
  const env = getEnvDefaults();
  if (!wsOverrides || typeof wsOverrides !== "object") return env;

  const pick = (key, envVal) => {
    const wsVal = Number(wsOverrides[key]);
    return Number.isFinite(wsVal) && wsVal >= 0 ? wsVal : envVal;
  };

  return {
    maxSpawnsPerHour: pick("maxSpawnsPerHour", env.maxSpawnsPerHour),
    maxDepth: pick("maxDepth", env.maxDepth),
    hitlCostThresholdUsd: pick("hitlCostThresholdUsd", env.hitlCostThresholdUsd),
    hitlSpawnThreshold: pick("hitlSpawnThreshold", env.hitlSpawnThreshold),
  };
}

// ---------------------------------------------------------------------------
// Hourly window counters — Map<workspace, { count, windowStart }>
// ---------------------------------------------------------------------------

/** @type {Map<string, { count: number, windowStart: number }>} */
const hourlyCounters = new Map();

const HOUR_MS = 3_600_000;

/**
 * Get or create the counter for a workspace, rotating the window if stale.
 * @param {string} workspace
 * @returns {{ count: number, windowStart: number }}
 */
function getCounter(workspace) {
  const ws = String(workspace || "default");
  let entry = hourlyCounters.get(ws);
  const now = Date.now();
  if (!entry || now - entry.windowStart > HOUR_MS) {
    entry = { count: 0, windowStart: now };
    hourlyCounters.set(ws, entry);
  }
  return entry;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/**
 * Check whether a subagent spawn is allowed for the given workspace.
 *
 * @param {object} opts
 * @param {string} opts.workspace
 * @param {string} opts.userId
 * @param {string} [opts.parentSessionId] — parent agent session id (used for HITL state)
 * @param {number} opts.depth — current nesting depth of the spawn request
 * @param {number} [opts.estimatedCostUsd] — estimated cost of the subagent run in USD
 * @param {object} [opts.workspaceQuotaOverrides] — per-workspace subagentQuota overrides
 * @returns {Promise<{ allowed: true } | { allowed: false, reason: string, code: string } | { allowed: "hitl_required", approvalId: string, reason: string }>}
 */
export async function checkSubagentQuota({
  workspace,
  userId,
  parentSessionId,
  depth,
  estimatedCostUsd,
  workspaceQuotaOverrides,
} = {}) {
  const cfg = resolveConfig(workspaceQuotaOverrides);
  const ws = String(workspace || "default");

  // 1. Depth check
  if (cfg.maxDepth > 0 && Number(depth) >= cfg.maxDepth) {
    return {
      allowed: false,
      reason: "Maximum subagent depth exceeded",
      code: "SUBAGENT_DEPTH_EXCEEDED",
    };
  }

  // 2. Hourly rate check
  const counter = getCounter(ws);
  if (cfg.maxSpawnsPerHour > 0 && counter.count >= cfg.maxSpawnsPerHour) {
    return {
      allowed: false,
      reason: "Hourly subagent quota exhausted",
      code: "SUBAGENT_QUOTA_EXHAUSTED",
    };
  }

  // 3. HITL cost gate
  const cost = Number(estimatedCostUsd) || 0;
  if (cfg.hitlCostThresholdUsd > 0 && cost > cfg.hitlCostThresholdUsd) {
    const approvalId = saveHitlState({
      tool: "spawn_subagent",
      workspace: ws,
      userId,
      sessionId: parentSessionId || null,
      estimatedCostUsd: cost,
      depth: Number(depth) || 0,
      reason: `Estimated cost $${cost.toFixed(2)} exceeds threshold $${cfg.hitlCostThresholdUsd.toFixed(2)}`,
    });
    return {
      allowed: "hitl_required",
      approvalId,
      reason: `Estimated cost $${cost.toFixed(2)} exceeds HITL threshold $${cfg.hitlCostThresholdUsd.toFixed(2)}; human approval required`,
    };
  }

  // 4. HITL spawn-count gate
  if (cfg.hitlSpawnThreshold > 0 && counter.count >= cfg.hitlSpawnThreshold) {
    const approvalId = saveHitlState({
      tool: "spawn_subagent",
      workspace: ws,
      userId,
      sessionId: parentSessionId || null,
      spawnsThisHour: counter.count,
      threshold: cfg.hitlSpawnThreshold,
      depth: Number(depth) || 0,
      reason: `Spawn count (${counter.count}) reached HITL threshold (${cfg.hitlSpawnThreshold})`,
    });
    return {
      allowed: "hitl_required",
      approvalId,
      reason: `Subagent spawn count (${counter.count}) reached HITL threshold (${cfg.hitlSpawnThreshold}); human approval required`,
    };
  }

  // 5. Allowed
  return { allowed: true };
}

/**
 * Record a successful subagent spawn. Call AFTER the spawn succeeds.
 * Increments the hourly counter for the workspace.
 *
 * @param {string} workspace
 */
export function recordSubagentSpawn(workspace) {
  const counter = getCounter(String(workspace || "default"));
  counter.count += 1;
}

/**
 * Get current quota stats for a workspace.
 *
 * @param {string} workspace
 * @param {object} [workspaceQuotaOverrides] — per-workspace subagentQuota overrides
 * @returns {{ spawnsThisHour: number, maxPerHour: number, maxDepth: number }}
 */
export function getSubagentQuotaStats(workspace, workspaceQuotaOverrides) {
  const cfg = resolveConfig(workspaceQuotaOverrides);
  const counter = getCounter(String(workspace || "default"));
  return {
    spawnsThisHour: counter.count,
    maxPerHour: cfg.maxSpawnsPerHour,
    maxDepth: cfg.maxDepth,
  };
}

/**
 * Reset all quota counters. For test use only.
 */
export function __resetQuotaCountersForTests() {
  hourlyCounters.clear();
}

/**
 * Expose the internal counters map for advanced test scenarios (e.g., clock
 * manipulation). For test use only.
 */
export const __internals = { hourlyCounters };
