/**
 * Per-tool circuit breaker: when a tool accumulates N terminal failures
 * (permission, not_allowed, unknown_tool, validation) for a workspace, put it
 * in cooldown for a window. Consumers (agent-tools.js) filter cooling-down
 * tools out of the schema presented to the LLM.
 *
 * Storage is in-memory (cooldowns are short-lived). Lazy cleanup on read.
 *
 * @module tool-cooldown-store
 */
import { loadFailureStats } from "./agent-failure-store.js";
import { recordCooldownStart } from "./metrics.js";

const TERMINAL_CATEGORIES = new Set([
  "permission",
  "not_allowed",
  "unknown_tool",
  "validation",
]);

const DEFAULT_TERMINAL_THRESHOLD = 5;
const DEFAULT_DURATION_MS = 30 * 60 * 1000; // 30 minutes

/** @type {Map<string, Map<string, { reason: string, expiresAt: number }>>} */
const cooldowns = new Map();

function wsKey(workspace) {
  return typeof workspace === "string" && workspace.length > 0 ? workspace : "default";
}

/**
 * @returns {boolean}
 */
export function cooldownEnabled() {
  return process.env.TOOL_COOLDOWN_ENABLED !== "0";
}

function getThreshold() {
  const raw = Number(process.env.COOLDOWN_TERMINAL_THRESHOLD);
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return DEFAULT_TERMINAL_THRESHOLD;
}

function getDefaultDurationMs() {
  const raw = Number(process.env.COOLDOWN_DURATION_MS);
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return DEFAULT_DURATION_MS;
}

function getWsMap(workspace, createIfMissing = false) {
  const key = wsKey(workspace);
  let m = cooldowns.get(key);
  if (!m && createIfMissing) {
    m = new Map();
    cooldowns.set(key, m);
  }
  return m || null;
}

/**
 * Prune expired entries for a workspace; delete the ws map if empty.
 * @param {string} workspace
 */
function pruneExpired(workspace) {
  const m = getWsMap(workspace);
  if (!m) return;
  const now = Date.now();
  for (const [tool, entry] of m) {
    if (!entry || typeof entry.expiresAt !== "number" || entry.expiresAt <= now) {
      m.delete(tool);
    }
  }
  if (m.size === 0) cooldowns.delete(wsKey(workspace));
}

/**
 * Start (or refresh) a cooldown for a tool.
 * @param {string} workspace
 * @param {string} toolName
 * @param {string} reason
 * @param {number} [durationMs]
 * @returns {{ reason: string, expiresAt: number }}
 */
export function startCooldown(workspace, toolName, reason, durationMs) {
  if (!toolName || typeof toolName !== "string") {
    throw new Error("toolName is required");
  }
  const dur = Number.isFinite(durationMs) && durationMs > 0
    ? Math.floor(durationMs)
    : getDefaultDurationMs();
  const m = getWsMap(workspace, true);
  const entry = {
    reason: reason ? String(reason) : "threshold_exceeded",
    expiresAt: Date.now() + dur,
  };
  m.set(toolName, entry);
  try {
    recordCooldownStart(toolName, entry.reason);
  } catch (_) {
    /* metrics are best-effort */
  }
  return { ...entry };
}

/**
 * @param {string} workspace
 * @param {string} toolName
 * @returns {boolean}
 */
export function isToolInCooldown(workspace, toolName) {
  const m = getWsMap(workspace);
  if (!m) return false;
  const entry = m.get(toolName);
  if (!entry) return false;
  if (entry.expiresAt <= Date.now()) {
    m.delete(toolName);
    if (m.size === 0) cooldowns.delete(wsKey(workspace));
    return false;
  }
  return true;
}

/**
 * @param {string} workspace
 * @returns {Array<{ tool: string, reason: string, expiresAt: number }>}
 */
export function listActiveCooldowns(workspace) {
  pruneExpired(workspace);
  const m = getWsMap(workspace);
  if (!m) return [];
  const out = [];
  for (const [tool, entry] of m) {
    out.push({ tool, reason: entry.reason, expiresAt: entry.expiresAt });
  }
  return out;
}

/**
 * @param {string} workspace
 * @param {string} toolName
 */
export function clearCooldown(workspace, toolName) {
  const m = getWsMap(workspace);
  if (!m) return;
  m.delete(toolName);
  if (m.size === 0) cooldowns.delete(wsKey(workspace));
}

/**
 * @param {string} workspace
 */
export function clearAllCooldowns(workspace) {
  cooldowns.delete(wsKey(workspace));
}

/**
 * Inspect the persisted failure stats for this workspace/tool. If the total
 * count of failures in terminal categories meets or exceeds the configured
 * threshold, start a cooldown. Idempotent — if the tool is already cooling
 * down, this is a no-op.
 *
 * @param {string} workspace
 * @param {string} toolName
 * @returns {Promise<{ started: boolean, alreadyActive?: boolean, terminalCount?: number, threshold?: number, reason?: string, expiresAt?: number }>}
 */
export async function maybeStartCooldownFromFailures(workspace, toolName) {
  if (!toolName || typeof toolName !== "string") {
    return { started: false };
  }
  if (isToolInCooldown(workspace, toolName)) {
    return { started: false, alreadyActive: true };
  }
  const stats = await loadFailureStats(workspace);
  const toolStats = stats?.tools?.[toolName];
  if (!toolStats || !toolStats.byCategory) {
    return { started: false, terminalCount: 0 };
  }
  let terminalCount = 0;
  let dominant = null;
  let dominantCount = 0;
  for (const [cat, count] of Object.entries(toolStats.byCategory)) {
    if (TERMINAL_CATEGORIES.has(cat)) {
      terminalCount += count;
      if (count > dominantCount) {
        dominant = cat;
        dominantCount = count;
      }
    }
  }
  const threshold = getThreshold();
  if (terminalCount < threshold) {
    return { started: false, terminalCount, threshold };
  }
  const reason = dominant
    ? `terminal_failures:${dominant}:${terminalCount}`
    : `terminal_failures:${terminalCount}`;
  const entry = startCooldown(workspace, toolName, reason, getDefaultDurationMs());
  return {
    started: true,
    terminalCount,
    threshold,
    reason: entry.reason,
    expiresAt: entry.expiresAt,
  };
}

/**
 * Test helper: drop all cooldowns everywhere.
 */
export function __resetAllCooldownsForTests() {
  cooldowns.clear();
}
